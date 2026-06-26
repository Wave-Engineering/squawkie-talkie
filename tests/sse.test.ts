import { expect, test } from "bun:test";

// Point the data layer at an in-memory database BEFORE importing anything that
// imports db.ts, so this test file gets its own throwaway connection.
process.env.SQUAWK_DB = ":memory:";
const { routeRequest } = await import("../src/server/index.ts");
const { subscribe, broadcast, subscriberCount } = await import(
  "../src/server/sse.ts"
);

const decoder = new TextDecoder();

/** Open an SSE subscription and return a reader over its body. */
function open() {
  const res = subscribe();
  const reader = res.body!.getReader();
  return { res, reader };
}

/**
 * Read framed SSE chunks until a `data:` event arrives (skipping heartbeat
 * comment lines), and return the parsed JSON payload.
 */
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed before an event arrived");
    const line = decoder
      .decode(value)
      .split("\n")
      .find((l) => l.startsWith("data:"));
    if (line) {
      return JSON.parse(line.slice("data:".length).trim());
    }
    // Heartbeat / comment line — keep reading.
  }
}

/** Build a JSON request. Omits the body (and header) when `body` is undefined. */
function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// --- endpoint + headers ------------------------------------------------------

test("GET /api/stream returns a text/event-stream response with SSE headers", async () => {
  const res = await routeRequest(req("GET", "/api/stream"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  expect(res.headers.get("Cache-Control")).toBe("no-cache");
  expect(res.headers.get("Connection")).toBe("keep-alive");
  await res.body!.cancel();
});

// --- broadcast framing -------------------------------------------------------

test("subscriber receives mutation event", async () => {
  const { reader } = open();
  broadcast({ type: "list.created", list: { id: 7, name: "X" } });
  const event = await readEvent(reader);
  expect(event.type).toBe("list.created");
  expect((event.list as { id: number }).id).toBe(7);
  await reader.cancel();
});

// --- no leak on disconnect ---------------------------------------------------

test("cancelled subscriber is removed (no leak)", async () => {
  const before = subscriberCount();
  const { reader } = open();
  expect(subscriberCount()).toBe(before + 1);

  await reader.cancel();
  expect(subscriberCount()).toBe(before);

  // A broadcast after everyone disconnected must not throw.
  expect(() => broadcast({ type: "noop" })).not.toThrow();
});

// --- end-to-end: a real mutation reaches a subscriber ------------------------

test("mutation triggers broadcast", async () => {
  // Create the list BEFORE subscribing so only the squawk event reaches us.
  const list = await (
    await routeRequest(req("POST", "/api/lists", { name: "Realtime" }))
  ).json();

  const { reader } = open();
  const res = await routeRequest(
    req("POST", `/api/lists/${list.id}/squawks`, {
      text: "gear up",
      initials: "BJ",
    }),
  );
  expect(res.status).toBe(201);

  const event = await readEvent(reader);
  expect(event.type).toBe("squawk.created");
  const squawk = event.squawk as { list_id: number; text: string };
  expect(squawk.list_id).toBe(list.id);
  expect(squawk.text).toBe("gear up");
  await reader.cancel();
});
