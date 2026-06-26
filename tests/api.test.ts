import { expect, test } from "bun:test";

// Point the data layer at an in-memory database BEFORE importing anything that
// imports db.ts, so this test file gets its own throwaway connection.
process.env.SQUAWK_DB = ":memory:";
const { routeRequest } = await import("../src/server/index.ts");
const { handleApi } = await import("../src/server/api.ts");

/** Build a JSON request. Omits the body (and header) when `body` is undefined. */
function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createList(name: string) {
  const res = await routeRequest(req("POST", "/api/lists", { name }));
  expect(res.status).toBe(201);
  return res.json();
}

// --- routing contract --------------------------------------------------------

test("handleApi returns null for non-/api paths", () => {
  expect(handleApi(new Request("http://x/"), new URL("http://x/"))).toBeNull();
  expect(
    handleApi(new Request("http://x/styles.css"), new URL("http://x/styles.css")),
  ).toBeNull();
  expect(
    handleApi(new Request("http://x/healthz"), new URL("http://x/healthz")),
  ).toBeNull();
});

// --- lists -------------------------------------------------------------------

test("POST then GET lists", async () => {
  const created = await createList("Preflight");
  expect(created.name).toBe("Preflight");
  expect(created.id).toBeGreaterThan(0);

  const res = await routeRequest(req("GET", "/api/lists"));
  expect(res.status).toBe(200);
  const lists = await res.json();
  expect(lists.some((l: { id: number }) => l.id === created.id)).toBe(true);
});

test("GET list includes its squawks; DELETE removes it", async () => {
  const list = await createList("Detail");
  await routeRequest(
    req("POST", `/api/lists/${list.id}/squawks`, { text: "a", initials: "AA" }),
  );

  const detailRes = await routeRequest(req("GET", `/api/lists/${list.id}`));
  expect(detailRes.status).toBe(200);
  const detail = await detailRes.json();
  expect(detail.id).toBe(list.id);
  expect(detail.squawks).toHaveLength(1);

  const delRes = await routeRequest(req("DELETE", `/api/lists/${list.id}`));
  expect(delRes.status).toBe(200);
  expect(await delRes.json()).toEqual({ ok: true });

  // Now gone.
  expect((await routeRequest(req("GET", `/api/lists/${list.id}`))).status).toBe(
    404,
  );
});

// --- squawks -----------------------------------------------------------------

test("POST squawk returns 201 + body", async () => {
  const list = await createList("Climb");
  const res = await routeRequest(
    req("POST", `/api/lists/${list.id}/squawks`, {
      text: "gear up",
      initials: "bj", // lowercase -> normalized
    }),
  );
  expect(res.status).toBe(201);
  const sq = await res.json();
  expect(sq.text).toBe("gear up");
  expect(sq.initials).toBe("BJ"); // normalized server-side
  expect(sq.state).toBe("open");
  expect(sq.list_id).toBe(list.id);

  // Nested squawks listing.
  const listed = await routeRequest(req("GET", `/api/lists/${list.id}/squawks`));
  expect(listed.status).toBe(200);
  expect(await listed.json()).toHaveLength(1);
});

test("initials are normalized to <=3 uppercase characters", async () => {
  const list = await createList("Normalize");
  const res = await routeRequest(
    req("POST", `/api/lists/${list.id}/squawks`, {
      text: "x",
      initials: "a.b-c9z",
    }),
  );
  const sq = await res.json();
  expect(sq.initials).toBe("ABC"); // uppercased, stripped, capped at 3
});

test("PATCH squawk updates state", async () => {
  const list = await createList("Update");
  const sq = await (
    await routeRequest(
      req("POST", `/api/lists/${list.id}/squawks`, { text: "x", initials: "AA" }),
    )
  ).json();

  const res = await routeRequest(
    req("PATCH", `/api/squawks/${sq.id}`, { state: "retired", initials: "zz" }),
  );
  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.state).toBe("retired");
  expect(updated.initials).toBe("ZZ");
});

// --- validation --------------------------------------------------------------

test("invalid input -> 400", async () => {
  // Empty / whitespace name.
  const r1 = await routeRequest(req("POST", "/api/lists", { name: "   " }));
  expect(r1.status).toBe(400);
  expect((await r1.json()).error).toBeTruthy();

  const list = await createList("Bad");
  const sq = await (
    await routeRequest(
      req("POST", `/api/lists/${list.id}/squawks`, { text: "x", initials: "AA" }),
    )
  ).json();

  // Bad state.
  const r2 = await routeRequest(
    req("PATCH", `/api/squawks/${sq.id}`, { state: "explode" }),
  );
  expect(r2.status).toBe(400);

  // Missing initials on squawk create.
  const r3 = await routeRequest(
    req("POST", `/api/lists/${list.id}/squawks`, { text: "x" }),
  );
  expect(r3.status).toBe(400);
});

// --- not found ---------------------------------------------------------------

test("missing list -> 404", async () => {
  expect((await routeRequest(req("GET", "/api/lists/999999"))).status).toBe(404);
  expect((await routeRequest(req("DELETE", "/api/lists/999999"))).status).toBe(
    404,
  );
  // Unknown squawk on PATCH.
  expect(
    (await routeRequest(req("PATCH", "/api/squawks/999999", { state: "open" })))
      .status,
  ).toBe(404);
  // Squawk routes under an unknown list.
  expect(
    (await routeRequest(req("GET", "/api/lists/999999/squawks"))).status,
  ).toBe(404);
});
