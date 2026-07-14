/**
 * Server-Sent Events broadcast layer for Squawkie-Talkie.
 *
 * The server half of the realtime spine: a single module-level set of active
 * stream controllers, an endpoint that hands each viewer a long-lived
 * `text/event-stream` body, and a `broadcast()` that pushes the changed
 * resource to every connected viewer.
 *
 *   subscribe()  -> a streaming Response; registers its controller on stream
 *                   start and removes it on cancel (client disconnect).
 *   broadcast(e) -> writes `data: ${JSON.stringify(e)}\n\n` to every subscriber,
 *                   dropping any controller that throws.
 *
 * The broadcast is deliberately dumb — it just emits the mutated resource, which
 * preserves the API's last-write-wins semantics. A ~25s heartbeat comment keeps
 * idle connections from being reaped by proxies/load balancers.
 */

/** A live SSE connection's stream controller. */
type Controller = ReadableStreamDefaultController<Uint8Array>;

/** SSE event payload: a `type` discriminator plus arbitrary resource fields. */
export interface SseEvent {
  type: string;
  [k: string]: unknown;
}

const encoder = new TextEncoder();

/** Active subscribers. Module-level so every importer shares one broadcast fan-out. */
const subscribers = new Set<Controller>();

/** Number of currently-connected subscribers (exposed for tests/observability). */
export function subscriberCount(): number {
  return subscribers.size;
}

/** Write a raw chunk to one controller, dropping it from the set on failure. */
function write(controller: Controller, chunk: string): void {
  try {
    controller.enqueue(encoder.encode(chunk));
  } catch {
    // Controller is closed/errored (client gone) — stop tracking it.
    subscribers.delete(controller);
  }
}

/**
 * Build a `text/event-stream` Response. The stream's `start` registers the
 * controller while the connection is open; `cancel` (client disconnect) removes
 * it so the subscriber set never leaks.
 */
export function subscribe(): Response {
  let self: Controller;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      subscribers.add(controller);
      // Flush an initial comment immediately. Bun doesn't send the response
      // headers until the first byte is written, so without this the client's
      // EventSource wouldn't fire `open` until the first real event or the ~25s
      // heartbeat — leaving the connection-status indicator stuck on "connecting"
      // on an idle stream. A `:` comment is ignored by EventSource. (#116)
      write(controller, ": connected\n\n");
    },
    cancel() {
      subscribers.delete(self);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Emit an event to every subscriber as a framed SSE `data:` line. */
export function broadcast(event: SseEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  // Snapshot to a local array: `write` may mutate the set when dropping a dead
  // controller, and mutating a Set while iterating it is undefined behavior.
  for (const controller of [...subscribers]) {
    write(controller, frame);
  }
}

// Heartbeat: a periodic comment line keeps idle connections open through
// intermediaries that would otherwise close a silent stream.
// MUST stay below the server's Bun.serve `idleTimeout` (index.ts) — the heartbeat
// resets that idle timer; if it fires slower than the timeout, Bun kills the
// stream before it can heartbeat and realtime events are dropped (#115).
const HEARTBEAT_MS = 25_000;
const heartbeat = setInterval(() => {
  for (const controller of [...subscribers]) {
    write(controller, ": ping\n\n");
  }
}, HEARTBEAT_MS);
// In Bun, timers expose unref(); don't let the heartbeat alone hold the process
// (or a test runner) open.
(heartbeat as unknown as { unref?: () => void }).unref?.();

/**
 * Graceful teardown: stop the heartbeat and close every open stream. Wire this
 * into the server's shutdown signal so connections and the interval don't dangle
 * (the `unref()` above keeps them from blocking exit, but this closes cleanly).
 */
export function shutdown(): void {
  clearInterval(heartbeat);
  for (const controller of [...subscribers]) {
    try {
      controller.close();
    } catch {
      // Already closed/errored — nothing to do.
    }
    subscribers.delete(controller);
  }
}
