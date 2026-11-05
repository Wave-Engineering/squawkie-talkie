import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

// Point the data layer at an in-memory database BEFORE importing anything that
// imports db.ts, so this test file gets its own throwaway connection.
process.env.SQUAWK_DB = ":memory:";
const { routeRequest } = await import("../src/server/index.ts");
const { forEvent } = await import("../src/server/api.ts");
const { subscribe } = await import("../src/server/sse.ts");
const { migrateSquawkColumns } = await import("../src/server/db.ts");

const decoder = new TextDecoder();

/** Build a JSON request, with optional extra headers. */
function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createList(name: string): Promise<{ id: number }> {
  const res = await routeRequest(req("POST", "/api/lists", { name }));
  expect(res.status).toBe(201);
  return res.json();
}

/** Which list each created squawk is on: the API has no GET for one squawk. */
const listOf = new Map<number, number>();

/** Create a squawk with optional options; returns the response (status and body). */
async function post(listId: number, extra: Record<string, unknown> = {}) {
  const res = await routeRequest(
    req("POST", `/api/lists/${listId}/squawks`, { text: "ship?", initials: "AA", ...extra }),
  );
  const body = await res.json();
  if (res.status === 201) listOf.set(body.id, listId);
  return { status: res.status, body };
}

async function patch(id: number, body: unknown, headers: Record<string, string> = {}) {
  const res = await routeRequest(req("PATCH", `/api/squawks/${id}`, body, headers));
  return { status: res.status, body: await res.json() };
}

/** One squawk as GET returns it, found in its list's detail. */
async function get(id: number) {
  const res = await routeRequest(req("GET", `/api/lists/${listOf.get(id)}`));
  const detail = (await res.json()) as { squawks: Array<{ id: number }> };
  return detail.squawks.find((s) => s.id === id) as Record<string, any>;
}

/** Read framed SSE chunks until a `data:` event arrives, and parse it. */
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, any>> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed before an event arrived");
    const line = decoder
      .decode(value)
      .split("\n")
      .find((l) => l.startsWith("data:"));
    if (line) return JSON.parse(line.slice("data:".length).trim());
  }
}

// --- options (Part A) --------------------------------------------------------

test("create with options stores them, normalised, and a plain squawk has none", async () => {
  const list = await createList("Options");
  const created = await post(list.id, { options: [" Ship it ", "Hold"] });
  expect(created.status).toBe(201);
  expect(created.body.options).toEqual(["Ship it", "Hold"]);
  expect(created.body.choice).toBeNull();
  expect(created.body.note).toBe("");

  // They round-trip through the list view the client loads.
  const detail = await (await routeRequest(req("GET", `/api/lists/${list.id}`))).json();
  expect(detail.squawks[0].options).toEqual(["Ship it", "Hold"]);

  const plain = await post(list.id);
  expect(plain.body.options).toEqual([]);

  // The quick-add route takes them too.
  const quick = await routeRequest(
    req("POST", "/api/squawks", {
      list_name: "Options",
      text: "quick",
      initials: "AA",
      options: ["Yes", "No"],
    }),
  );
  expect(quick.status).toBe(201);
  expect((await quick.json()).options).toEqual(["Yes", "No"]);
});

test("create rejects bad options with the reason, and creates nothing", async () => {
  const list = await createList("BadOptions");
  for (const options of ["Ship it", ["open"], ["a", "A"], [""], Array(9).fill("x").map((x, i) => x + i)]) {
    const res = await post(list.id, { options });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  }
  const detail = await (await routeRequest(req("GET", `/api/lists/${list.id}`))).json();
  expect(detail.squawks).toHaveLength(0);

  // Quick-add must not leave a new list behind on a bad request.
  const quick = await routeRequest(
    req("POST", "/api/squawks", {
      list_name: "NeverMade",
      text: "x",
      initials: "AA",
      options: ["open"],
    }),
  );
  expect(quick.status).toBe(400);
  const lists = (await (await routeRequest(req("GET", "/api/lists"))).json()) as Array<{ name: string }>;
  expect(lists.some((l) => l.name === "NeverMade")).toBe(false);
});

test("choosing an option resolves the squawk as confirmed and moves the counts", async () => {
  const list = await createList("Choose");
  const sq = (await post(list.id, { options: ["Ship it", "Hold"] })).body;

  const res = await patch(sq.id, { choice: "Hold" });
  expect(res.status).toBe(200);
  expect(res.body.state).toBe("confirmed");
  expect(res.body.choice).toBe("Hold");

  const lists = (await (await routeRequest(req("GET", "/api/lists"))).json()) as Array<{
    id: number;
    counts: Record<string, number>;
  }>;
  const counts = lists.find((l) => l.id === list.id)!.counts;
  expect(counts.confirmed).toBe(1);
  expect(counts.open).toBe(0);
});

test("a choice must be one of the item's options", async () => {
  const list = await createList("BadChoice");
  const withOpts = (await post(list.id, { options: ["Ship it"] })).body;
  const without = (await post(list.id)).body;

  expect((await patch(withOpts.id, { choice: "Hold" })).status).toBe(400);
  // Exact label, not a near match.
  expect((await patch(withOpts.id, { choice: "ship it" })).status).toBe(400);
  expect((await patch(without.id, { choice: "Ship it" })).status).toBe(400);
  expect((await patch(withOpts.id, { choice: 3 })).status).toBe(400);
  // State or choice, not both.
  expect((await patch(withOpts.id, { choice: "Ship it", state: "rejected" })).status).toBe(400);
  // None of those changed the item.
  const after = await get(withOpts.id);
  expect(after.state).toBe("open");
  expect(after.choice).toBeNull();
});

test("any plain state change clears the choice", async () => {
  const list = await createList("ClearChoice");
  const sq = (await post(list.id, { options: ["Ship it"] })).body;
  await patch(sq.id, { choice: "Ship it" });

  const rejected = await patch(sq.id, { state: "rejected" });
  expect(rejected.body.state).toBe("rejected");
  expect(rejected.body.choice).toBeNull();

  // Reopening a chosen item clears it too.
  await patch(sq.id, { choice: "Ship it" });
  const reopened = await patch(sq.id, { state: "open" });
  expect(reopened.body.choice).toBeNull();
  // And the option is still there to choose again.
  expect(reopened.body.options).toEqual(["Ship it"]);
});

test("options are immutable after create: a PATCH carrying them is a 400", async () => {
  const list = await createList("Immutable");
  const sq = (await post(list.id, { options: ["Ship it"] })).body;

  const res = await patch(sq.id, { options: ["Different"], text: "edited" });
  expect(res.status).toBe(400);
  const after = await get(sq.id);
  expect(after.options).toEqual(["Ship it"]);
  expect(after.text).toBe("ship?"); // the rest of that patch did not apply either
});

// --- note (Part B) -----------------------------------------------------------

test("a note is saved, returned by GET, and capped at 4000 characters", async () => {
  const list = await createList("Notes");
  const sq = (await post(list.id)).body;

  const saved = await patch(sq.id, { note: "need the vendor's answer first" });
  expect(saved.status).toBe(200);
  expect(saved.body.note).toBe("need the vendor's answer first");
  expect((await get(sq.id)).note).toBe("need the vendor's answer first");

  const exact = "n".repeat(4000);
  expect((await patch(sq.id, { note: exact })).status).toBe(200);
  expect((await patch(sq.id, { note: exact + "n" })).status).toBe(400);
  expect((await get(sq.id)).note).toBe(exact);
  expect((await patch(sq.id, { note: 5 })).status).toBe(400);
  // A note can be cleared.
  expect((await patch(sq.id, { note: "" })).body.note).toBe("");
});

test("a note-only patch leaves updated_at alone; a state change moves it", async () => {
  const list = await createList("NoteStamp");
  const sq = (await post(list.id)).body;
  await new Promise((r) => setTimeout(r, 5));

  const noted = await patch(sq.id, { note: "draft" });
  expect(noted.body.updated_at).toBe(sq.updated_at);

  await new Promise((r) => setTimeout(r, 5));
  const moved = await patch(sq.id, { state: "confirmed" });
  expect(moved.body.updated_at > sq.updated_at).toBe(true);
});

test("create requests refuse a note", async () => {
  const list = await createList("NoNoteOnCreate");
  const res = await post(list.id, { note: "sneaky" });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/UI/);
  const quick = await routeRequest(
    req("POST", "/api/squawks", { list_name: "NoNoteOnCreate", text: "x", initials: "AA", note: "n" }),
  );
  expect(quick.status).toBe(400);
});

test("a note from a client with an Authorization header is a 403 when a token is configured", async () => {
  const list = await createList("NoteGuard");
  const sq = (await post(list.id)).body;
  const saved = process.env.SQUAWK_API_TOKEN;
  process.env.SQUAWK_API_TOKEN = "s3cret";
  try {
    // The right token gets past auth, and is then refused the note.
    const machine = await patch(sq.id, { note: "from a script" }, { authorization: "Bearer s3cret" });
    expect(machine.status).toBe(403);
    expect(machine.body.error).toMatch(/UI/);
    // The browser sends no header: the note goes through.
    const browser = await patch(sq.id, { note: "from the UI" });
    expect(browser.status).toBe(200);
    expect(browser.body.note).toBe("from the UI");
    // The same client may still change the state, and read the note.
    const state = await patch(sq.id, { state: "confirmed" }, { authorization: "Bearer s3cret" });
    expect(state.status).toBe(200);
  } finally {
    if (saved === undefined) delete process.env.SQUAWK_API_TOKEN;
    else process.env.SQUAWK_API_TOKEN = saved;
  }
  expect((await get(sq.id)).note).toBe("from the UI");
});

// --- the note is locked once the item leaves open (#173) ----------------------

test("a note on a squawk that is not open is a 409; on an open one it saves", async () => {
  const list = await createList("NoteLock");
  const sq = (await post(list.id)).body;
  expect((await patch(sq.id, { note: "while open" })).status).toBe(200);

  expect((await patch(sq.id, { state: "retired" })).status).toBe(200);
  const late = await patch(sq.id, { note: "too late" });
  expect(late.status).toBe(409);
  expect(late.body.error).toMatch(/locked/);
  expect((await get(sq.id)).note).toBe("while open"); // untouched

  // Every settled state locks it, not only retired.
  for (const state of ["confirmed", "rejected", "recorded"]) {
    expect((await patch(sq.id, { state })).status).toBe(200);
    expect((await patch(sq.id, { note: `in ${state}` })).status).toBe(409);
  }
  expect((await get(sq.id)).note).toBe("while open");
});

test("the same note as the stored one on a settled squawk is a no-op that does not bump updated_at", async () => {
  const list = await createList("NoteLockRepeat");
  const sq = (await post(list.id)).body;
  expect((await patch(sq.id, { note: "kept" })).status).toBe(200);
  expect((await patch(sq.id, { state: "confirmed" })).status).toBe(200);
  const before = await get(sq.id);

  const again = await patch(sq.id, { note: "kept" });
  expect(again.status).toBe(200);
  expect(again.body.note).toBe("kept");
  expect((await get(sq.id)).updated_at).toBe(before.updated_at);
});

test("one PATCH with a note and a state on an open squawk saves both", async () => {
  const list = await createList("NoteWithState");
  const sq = (await post(list.id)).body;
  const res = await patch(sq.id, { note: "with the verdict", state: "confirmed" });
  expect(res.status).toBe(200);
  expect(res.body.state).toBe("confirmed");
  expect(res.body.note).toBe("with the verdict");
});

test("one PATCH with a note and a choice on an open squawk saves both", async () => {
  const list = await createList("NoteWithChoice");
  const sq = (await post(list.id, { options: ["Ship it", "Hold"] })).body;
  const res = await patch(sq.id, { note: "with the answer", choice: "Hold" });
  expect(res.status).toBe(200);
  expect(res.body.state).toBe("confirmed");
  expect(res.body.choice).toBe("Hold");
  expect(res.body.note).toBe("with the answer");
});

test("a note with a text edit on a settled squawk is a 409 and applies neither", async () => {
  const list = await createList("NoteLockText");
  const sq = (await post(list.id)).body;
  expect((await patch(sq.id, { state: "confirmed" })).status).toBe(200);
  const res = await patch(sq.id, { note: "late", text: "edited" });
  expect(res.status).toBe(409);
  const stored = await get(sq.id);
  expect(stored.note).toBe("");
  expect(stored.text).not.toBe("edited");
});

test("reopening a settled squawk unlocks the note and keeps what was stored", async () => {
  const list = await createList("NoteReopen");
  const sq = (await post(list.id)).body;
  expect((await patch(sq.id, { note: "first thoughts" })).status).toBe(200);
  expect((await patch(sq.id, { state: "confirmed" })).status).toBe(200);
  expect((await patch(sq.id, { note: "locked" })).status).toBe(409);

  expect((await patch(sq.id, { state: "open" })).status).toBe(200);
  expect((await get(sq.id)).note).toBe("first thoughts");
  const edited = await patch(sq.id, { note: "second thoughts" });
  expect(edited.status).toBe(200);
  expect((await get(sq.id)).note).toBe("second thoughts");
});

test("a note for a squawk that does not exist is a 404", async () => {
  const res = await patch(999999, { note: "nobody home" });
  expect(res.status).toBe(404);
});

test("with no token configured the Authorization guard does not apply", async () => {
  const list = await createList("NoTokenNoGuard");
  const sq = (await post(list.id)).body;
  expect(process.env.SQUAWK_API_TOKEN).toBeUndefined();
  const res = await patch(sq.id, { note: "ok" }, { authorization: "Bearer anything" });
  expect(res.status).toBe(200);
});

// --- event redaction ---------------------------------------------------------

test("forEvent empties the note while open and keeps it for every other state", () => {
  const base = {
    id: 1,
    list_id: 1,
    seq: 1,
    text: "t",
    initials: "AA",
    created_at: "t",
    updated_at: "t",
    has_image: false,
    image_ids: [],
    options: [],
    choice: null,
    note: "private draft",
  };
  expect(forEvent({ ...base, state: "open" }).note).toBe("");
  for (const state of ["confirmed", "rejected", "retired", "recorded"] as const) {
    expect(forEvent({ ...base, state }).note).toBe("private draft");
  }
  // The input is not mutated.
  const open = { ...base, state: "open" as const };
  forEvent(open);
  expect(open.note).toBe("private draft");
});

test("SSE frames carry a note only once the item is disposed", async () => {
  const list = await createList("Frames");
  const sq = (await post(list.id, { options: ["Ship it"] })).body;
  const res = subscribe();
  const reader = res.body!.getReader();
  try {
    // A note on an open item is saved but not broadcast.
    await patch(sq.id, { note: "half-written" });
    const open = await readEvent(reader);
    expect(open.type).toBe("squawk.updated");
    expect(open.squawk.id).toBe(sq.id);
    expect(open.squawk.state).toBe("open");
    expect(open.squawk.note).toBe("");
    expect((await get(sq.id)).note).toBe("half-written"); // stored all the same

    // Disposing the item sends the stored note, and the choice.
    await patch(sq.id, { choice: "Ship it" });
    const disposed = await readEvent(reader);
    expect(disposed.squawk.state).toBe("confirmed");
    expect(disposed.squawk.choice).toBe("Ship it");
    expect(disposed.squawk.note).toBe("half-written");

    // Reopening hides it again.
    await patch(sq.id, { state: "open" });
    const reopened = await readEvent(reader);
    expect(reopened.squawk.state).toBe("open");
    expect(reopened.squawk.note).toBe("");

    // A new squawk's created frame has no note to leak either.
    await post(list.id, { options: ["A", "B"] });
    const created = await readEvent(reader);
    expect(created.type).toBe("squawk.created");
    expect(created.squawk.options).toEqual(["A", "B"]);
    expect(created.squawk.note).toBe("");
  } finally {
    await reader.cancel();
  }
});

test("an image change on an open item does not leak its note either", async () => {
  const list = await createList("ImageFrames");
  const sq = (await post(list.id)).body;
  await patch(sq.id, { note: "draft" });
  const res = subscribe();
  const reader = res.body!.getReader();
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const upload = await routeRequest(
      new Request(`http://x/api/squawks/${sq.id}/images`, {
        method: "POST",
        headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
        body: png,
      }),
    );
    expect(upload.status).toBe(200);
    const frame = await readEvent(reader);
    expect(frame.squawk.image_ids).toHaveLength(1);
    expect(frame.squawk.note).toBe("");
  } finally {
    await reader.cancel();
  }
});

// --- migration ---------------------------------------------------------------

test("migrateSquawkColumns adds the #168 columns to a pre-existing table without touching its rows", () => {
  const db = new Database(":memory:");
  // squawks exactly as it was after #137 and before #168.
  db.exec(`
    CREATE TABLE lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE squawks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','confirmed','rejected','retired','recorded')),
      initials TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO lists (id, name, next_seq, created_at) VALUES (1, 'L', 3, 't');
    INSERT INTO squawks (id, list_id, seq, text, state, initials, created_at, updated_at) VALUES
      (1, 1, 1, 'one', 'open', 'AA', 't1', 'u1'),
      (2, 1, 2, 'two', 'confirmed', 'BB', 't2', 'u2');
  `);
  const legacy = "id, list_id, seq, text, state, initials, created_at, updated_at";
  const before = db.query(`SELECT ${legacy} FROM squawks ORDER BY id`).all();

  migrateSquawkColumns(db);

  expect(db.query(`SELECT ${legacy} FROM squawks ORDER BY id`).all()).toEqual(before);
  expect(
    db.query("SELECT DISTINCT options_json, choice, note FROM squawks").all(),
  ).toEqual([{ options_json: null, choice: null, note: "" }]);
  // The new columns accept data.
  db.query("UPDATE squawks SET options_json = ?, choice = ?, note = ? WHERE id = 2").run(
    '["Ship it"]',
    "Ship it",
    "n",
  );

  // Idempotent: a second run changes nothing and does not throw.
  migrateSquawkColumns(db);
  expect(db.query("SELECT note FROM squawks WHERE id = 2").get()).toEqual({ note: "n" });
});

test("migrateSquawkColumns leaves a database with no squawks table alone", () => {
  const db = new Database(":memory:");
  expect(() => migrateSquawkColumns(db)).not.toThrow();
});
