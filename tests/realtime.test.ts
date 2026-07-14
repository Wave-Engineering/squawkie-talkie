import { expect, test } from "bun:test";
import {
  type ApplyContext,
  type DetailViewBinding,
  type ListsViewBinding,
  type RealtimeEvent,
  activeSquawkId,
  applyEvent,
  connect,
  connectionStatus,
  onConnectionStatus,
  shouldApplyToInput,
} from "../src/client/realtime.ts";
import type { List, Squawk } from "../src/server/types.ts";

// --- fixtures ----------------------------------------------------------------

function squawk(over: Partial<Squawk> = {}): Squawk {
  return {
    id: 5,
    list_id: 1,
    seq: 1,
    text: "gear up",
    state: "open",
    initials: "BJ",
    created_at: "t",
    updated_at: "t",
    has_image: false,
    ...over,
  };
}

function list(over: Partial<List> = {}): List {
  return { id: 1, name: "Realtime", next_seq: 1, created_at: "t", ...over };
}

/** A fake focused element whose enclosing squawk row has `id` (null = no row). */
function focusedOn(id: number | null): Element {
  return {
    closest: () => (id === null ? null : { dataset: { squawkId: String(id) } }),
  } as unknown as Element;
}

/** A lists binding that records the calls realtime makes against it. */
function listsSink(): ListsViewBinding & { upserts: List[]; removes: number[] } {
  const upserts: List[] = [];
  const removes: number[] = [];
  return {
    kind: "lists",
    upserts,
    removes,
    upsertList: (l) => upserts.push(l),
    removeList: (id) => removes.push(id),
  };
}

/** A detail binding that records the calls realtime makes against it. */
function detailSink(
  listId: number,
): DetailViewBinding & {
  inserts: Squawk[];
  patches: { squawk: Squawk; applyToInput: boolean }[];
} {
  const inserts: Squawk[] = [];
  const patches: { squawk: Squawk; applyToInput: boolean }[] = [];
  return {
    kind: "detail",
    listId,
    inserts,
    patches,
    upsertSquawk: (s) => inserts.push(s),
    patchSquawk: (s, applyToInput) => patches.push({ squawk: s, applyToInput }),
    removeSquawk: () => {},
  };
}

function ctx(over: Partial<ApplyContext>): ApplyContext {
  return { view: null, activeElement: null, ...over };
}

// --- shouldApplyToInput (the load-bearing, spec-named cases) ------------------

test("skip update for focused squawk", () => {
  expect(shouldApplyToInput(5, 5)).toBe(false);
});

test("apply update for other squawk", () => {
  expect(shouldApplyToInput(5, 6)).toBe(true);
});

test("apply when nothing focused", () => {
  expect(shouldApplyToInput(null, 6)).toBe(true);
});

// --- activeSquawkId ----------------------------------------------------------

test("activeSquawkId reads data-squawk-id off the focused row", () => {
  expect(activeSquawkId(focusedOn(42))).toBe(42);
});

test("activeSquawkId is null when nothing is focused", () => {
  expect(activeSquawkId(null)).toBeNull();
});

test("activeSquawkId is null when the focus is not inside a squawk row", () => {
  expect(activeSquawkId(focusedOn(null))).toBeNull();
});

// --- applyEvent: squawk.updated focused-box protection -----------------------

test("squawk.updated does NOT overwrite the currently-focused input", () => {
  const view = detailSink(1);
  applyEvent(
    { type: "squawk.updated", squawk: squawk({ id: 5 }) },
    ctx({ view, activeElement: focusedOn(5) }),
  );
  expect(view.patches).toHaveLength(1);
  expect(view.patches[0]!.applyToInput).toBe(false);
});

test("squawk.updated overwrites a row whose input is not focused", () => {
  const view = detailSink(1);
  applyEvent(
    { type: "squawk.updated", squawk: squawk({ id: 5 }) },
    ctx({ view, activeElement: focusedOn(6) }),
  );
  expect(view.patches[0]!.applyToInput).toBe(true);
});

test("squawk.updated overwrites when nothing is focused", () => {
  const view = detailSink(1);
  applyEvent(
    { type: "squawk.updated", squawk: squawk({ id: 5 }) },
    ctx({ view, activeElement: null }),
  );
  expect(view.patches[0]!.applyToInput).toBe(true);
});

test("squawk.updated for a different list is ignored", () => {
  const view = detailSink(99);
  applyEvent(
    { type: "squawk.updated", squawk: squawk({ list_id: 1 }) },
    ctx({ view }),
  );
  expect(view.patches).toHaveLength(0);
});

// --- applyEvent: squawk.created ----------------------------------------------

test("squawk.created on the viewed list inserts the row", () => {
  const view = detailSink(1);
  applyEvent(
    { type: "squawk.created", squawk: squawk({ id: 7, list_id: 1 }) },
    ctx({ view }),
  );
  expect(view.inserts.map((s) => s.id)).toEqual([7]);
});

test("squawk.created on another list is ignored", () => {
  const view = detailSink(1);
  applyEvent(
    { type: "squawk.created", squawk: squawk({ id: 7, list_id: 2 }) },
    ctx({ view }),
  );
  expect(view.inserts).toHaveLength(0);
});

test("squawk.created is ignored on the lists screen", () => {
  const view = listsSink();
  applyEvent(
    { type: "squawk.created", squawk: squawk({ list_id: 1 }) },
    ctx({ view }),
  );
  expect(view.upserts).toHaveLength(0);
});

// --- applyEvent: list.created / list.deleted ---------------------------------

test("list.created updates the Lists screen", () => {
  const view = listsSink();
  applyEvent({ type: "list.created", list: list({ id: 3 }) }, ctx({ view }));
  expect(view.upserts.map((l) => l.id)).toEqual([3]);
});

test("list.deleted updates the Lists screen", () => {
  const view = listsSink();
  applyEvent({ type: "list.deleted", id: 3 }, ctx({ view }));
  expect(view.removes).toEqual([3]);
});

test("list events are ignored while viewing a list detail", () => {
  const view = detailSink(1);
  applyEvent({ type: "list.created", list: list({ id: 3 }) }, ctx({ view }));
  expect(view.inserts).toHaveLength(0);
});

test("applyEvent with no active view is a no-op (does not throw)", () => {
  expect(() =>
    applyEvent({ type: "list.created", list: list() }, ctx({ view: null })),
  ).not.toThrow();
});

test("an unknown event type is ignored", () => {
  const view = detailSink(1);
  applyEvent({ type: "mystery.event" } as RealtimeEvent, ctx({ view }));
  expect(view.inserts).toHaveLength(0);
  expect(view.patches).toHaveLength(0);
});

// --- connect(): EventSource subscription -------------------------------------

/** Minimal stand-in for the browser EventSource (absent in the test runtime). */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev);
    }
  }
  close(): void {}
}

function withFakeEventSource<T>(run: () => T): T {
  const original = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  try {
    return run();
  } finally {
    (globalThis as { EventSource?: unknown }).EventSource = original;
  }
}

test("connect subscribes to /api/stream and dispatches parsed messages", () => {
  withFakeEventSource(() => {
    const received: RealtimeEvent[] = [];
    connect((event) => received.push(event));

    const source = FakeEventSource.last!;
    expect(source.url).toBe("/api/stream");

    const event = { type: "squawk.updated", squawk: squawk({ id: 5 }) };
    source.emit("message", { data: JSON.stringify(event) });

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("squawk.updated");
  });
});

test("connect swallows a non-JSON frame without dispatching", () => {
  withFakeEventSource(() => {
    const received: RealtimeEvent[] = [];
    connect((event) => received.push(event));
    expect(() =>
      FakeEventSource.last!.emit("message", { data: ": heartbeat" }),
    ).not.toThrow();
    expect(received).toHaveLength(0);
  });
});

// --- connection status (#116) ------------------------------------------------

test("an `open` frame flips connectionStatus to online", () => {
  withFakeEventSource(() => {
    connect();
    FakeEventSource.last!.emit("open", {});
    expect(connectionStatus()).toBe("online");
  });
});

test("onConnectionStatus emits the current status immediately and on change", () => {
  withFakeEventSource(() => {
    connect();
    FakeEventSource.last!.emit("open", {}); // ensure a known starting point

    const seen: string[] = [];
    const off = onConnectionStatus((s) => seen.push(s));
    expect(seen).toEqual(["online"]); // immediate emit of the current status

    // A duplicate status is not re-emitted; a real change is.
    FakeEventSource.last!.emit("open", {});
    expect(seen).toEqual(["online"]);

    off();
  });
});
