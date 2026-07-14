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

test("GET /api/lists/by-name returns the list (with squawks) or 400/404", async () => {
  const list = await createList("Findable");
  await routeRequest(
    req("POST", `/api/lists/${list.id}/squawks`, { text: "x", initials: "AA" }),
  );

  const ok = await routeRequest(req("GET", "/api/lists/by-name?name=Findable"));
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.id).toBe(list.id);
  expect(body.squawks).toHaveLength(1);
  expect("next_seq" in body).toBe(false);

  // Missing name -> 400; unknown name -> 404.
  expect((await routeRequest(req("GET", "/api/lists/by-name"))).status).toBe(400);
  expect(
    (await routeRequest(req("GET", "/api/lists/by-name?name=Nope"))).status,
  ).toBe(404);
});

test("list responses do not expose the internal next_seq counter", async () => {
  const created = await createList("Hygiene");
  expect("next_seq" in created).toBe(false);

  const list = (await (await routeRequest(req("GET", "/api/lists"))).json()).find(
    (l: { id: number }) => l.id === created.id,
  );
  expect("next_seq" in list).toBe(false);

  const detail = await (
    await routeRequest(req("GET", `/api/lists/${created.id}`))
  ).json();
  expect("next_seq" in detail).toBe(false);
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

test("PATCH with no text or state is rejected (no silent updated_at bump)", async () => {
  const list = await createList("NoOp");
  const sq = await (
    await routeRequest(
      req("POST", `/api/lists/${list.id}/squawks`, { text: "x", initials: "AA" }),
    )
  ).json();

  // Empty body, and a body carrying only initials, are both no-ops -> 400.
  expect(
    (await routeRequest(req("PATCH", `/api/squawks/${sq.id}`, {}))).status,
  ).toBe(400);
  expect(
    (
      await routeRequest(
        req("PATCH", `/api/squawks/${sq.id}`, { initials: "ZZ" }),
      )
    ).status,
  ).toBe(400);

  // The squawk is untouched.
  const after = await (
    await routeRequest(req("GET", `/api/lists/${list.id}`))
  ).json();
  expect(after.squawks[0].updated_at).toBe(sq.updated_at);
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

// --- quick-add (POST /api/squawks) -------------------------------------------

test("POST /api/squawks creates squawk on existing list", async () => {
  const list = await createList("QuickExisting");
  const res = await routeRequest(
    req("POST", "/api/squawks", {
      list_name: "QuickExisting",
      text: "hello",
      initials: "bj",
    }),
  );
  expect(res.status).toBe(201);
  const sq = await res.json();
  expect(sq.list_id).toBe(list.id);
  expect(sq.text).toBe("hello");
  expect(sq.initials).toBe("BJ");
  expect(sq.state).toBe("open");
});

test("POST /api/squawks auto-creates list when it does not exist", async () => {
  const res = await routeRequest(
    req("POST", "/api/squawks", {
      list_name: "BrandNew",
      text: "first squawk",
      initials: "XY",
    }),
  );
  expect(res.status).toBe(201);
  const sq = await res.json();
  expect(sq.text).toBe("first squawk");

  // Verify the list was created.
  const listRes = await routeRequest(
    req("GET", "/api/lists/by-name?name=BrandNew"),
  );
  expect(listRes.status).toBe(200);
  const list = await listRes.json();
  expect(list.id).toBe(sq.list_id);
  expect(list.squawks).toHaveLength(1);
});

test("POST /api/squawks allows empty initials", async () => {
  const res = await routeRequest(
    req("POST", "/api/squawks", {
      list_name: "EmptyInit",
      text: "no one",
      initials: "",
    }),
  );
  expect(res.status).toBe(201);
  const sq = await res.json();
  expect(sq.initials).toBe("");
});

test("POST /api/squawks validates required fields", async () => {
  // Missing list_name.
  expect(
    (await routeRequest(req("POST", "/api/squawks", { text: "x", initials: "A" }))).status,
  ).toBe(400);
  // Missing initials key entirely.
  expect(
    (await routeRequest(req("POST", "/api/squawks", { list_name: "X", text: "x" }))).status,
  ).toBe(400);
  // Empty list_name (whitespace only).
  expect(
    (
      await routeRequest(
        req("POST", "/api/squawks", { list_name: "   ", text: "x", initials: "" }),
      )
    ).status,
  ).toBe(400);
});

// --- delete squawk (undo) ----------------------------------------------------

test("DELETE /api/squawks/:id removes the squawk", async () => {
  const list = await createList("UndoTest");
  const sq = await (
    await routeRequest(
      req("POST", `/api/lists/${list.id}/squawks`, { text: "oops", initials: "BJ" }),
    )
  ).json();

  const res = await routeRequest(req("DELETE", `/api/squawks/${sq.id}`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  // Squawk is gone from the list
  const detail = await (
    await routeRequest(req("GET", `/api/lists/${list.id}`))
  ).json();
  expect(detail.squawks).toHaveLength(0);
});

test("DELETE /api/squawks/:id returns 404 for unknown squawk", async () => {
  expect(
    (await routeRequest(req("DELETE", "/api/squawks/999999"))).status,
  ).toBe(404);
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

// --- squawk images (#113) ----------------------------------------------------

/** Build a raw-bytes image request (not JSON — the image API takes the body verbatim). */
function imgReq(
  method: string,
  path: string,
  mime?: string,
  bytes?: Uint8Array,
): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: mime ? { "content-type": mime } : {},
    body: bytes as BodyInit | undefined,
  });
}

/** Create a list + one squawk, returning the squawk JSON. */
async function seedSquawk(listName: string) {
  const list = await createList(listName);
  return (
    await routeRequest(
      req("POST", `/api/lists/${list.id}/squawks`, { text: "x", initials: "BJ" }),
    )
  ).json();
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("a fresh squawk has has_image=false", async () => {
  const sq = await seedSquawk("ImgFresh");
  expect(sq.has_image).toBe(false);
});

test("POST image attaches, flips has_image, and GET returns the same bytes + mime", async () => {
  const sq = await seedSquawk("ImgAttach");

  const post = await routeRequest(
    imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", PNG),
  );
  expect(post.status).toBe(200);
  expect((await post.json()).has_image).toBe(true);

  // has_image is visible on the list-detail projection too.
  const detail = await (
    await routeRequest(req("GET", `/api/lists/${sq.list_id}`))
  ).json();
  expect(detail.squawks[0].has_image).toBe(true);

  const get = await routeRequest(req("GET", `/api/squawks/${sq.id}/image`));
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("image/png");
  expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);
});

test("POST image replaces an existing image (upsert, still 1:1)", async () => {
  const sq = await seedSquawk("ImgReplace");
  await routeRequest(imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", PNG));

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const res = await routeRequest(
    imgReq("POST", `/api/squawks/${sq.id}/image`, "image/jpeg", jpeg),
  );
  expect(res.status).toBe(200);

  const get = await routeRequest(req("GET", `/api/squawks/${sq.id}/image`));
  expect(get.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await get.arrayBuffer())).toEqual(jpeg);
});

test("GET image is 404 when the squawk has none", async () => {
  const sq = await seedSquawk("ImgNone");
  expect(
    (await routeRequest(req("GET", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(404);
});

test("POST image rejects a non-allowlisted mime (SVG/HTML) with 415", async () => {
  const sq = await seedSquawk("ImgMime");
  const svg = new Uint8Array([0x3c, 0x73, 0x76, 0x67]); // "<svg"
  expect(
    (
      await routeRequest(
        imgReq("POST", `/api/squawks/${sq.id}/image`, "image/svg+xml", svg),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await routeRequest(
        imgReq("POST", `/api/squawks/${sq.id}/image`, "text/html", svg),
      )
    ).status,
  ).toBe(415);
});

test("POST image rejects an oversize body with 413", async () => {
  const sq = await seedSquawk("ImgBig");
  const tooBig = new Uint8Array(2 * 1024 * 1024 + 1); // one byte over the 2 MB cap
  expect(
    (
      await routeRequest(
        imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", tooBig),
      )
    ).status,
  ).toBe(413);
});

test("POST image rejects an empty body with 400", async () => {
  const sq = await seedSquawk("ImgEmpty");
  expect(
    (
      await routeRequest(
        imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", new Uint8Array()),
      )
    ).status,
  ).toBe(400);
});

test("POST image to an unknown squawk is 404", async () => {
  expect(
    (
      await routeRequest(
        imgReq("POST", "/api/squawks/999999/image", "image/png", PNG),
      )
    ).status,
  ).toBe(404);
});

test("DELETE image clears has_image and 404s a subsequent GET", async () => {
  const sq = await seedSquawk("ImgDelete");
  await routeRequest(imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", PNG));

  const del = await routeRequest(req("DELETE", `/api/squawks/${sq.id}/image`));
  expect(del.status).toBe(200);
  expect(await del.json()).toEqual({ ok: true });

  expect(
    (await routeRequest(req("GET", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(404);
  const detail = await (
    await routeRequest(req("GET", `/api/lists/${sq.list_id}`))
  ).json();
  expect(detail.squawks[0].has_image).toBe(false);
});

test("DELETE image on a squawk without one is 404", async () => {
  const sq = await seedSquawk("ImgDeleteNone");
  expect(
    (await routeRequest(req("DELETE", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(404);
});

test("deleting the squawk cascades its image (no orphan row)", async () => {
  const sq = await seedSquawk("ImgCascadeSquawk");
  await routeRequest(imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", PNG));

  expect((await routeRequest(req("DELETE", `/api/squawks/${sq.id}`))).status).toBe(
    200,
  );
  // The image row is gone with the squawk.
  expect(
    (await routeRequest(req("GET", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(404);
});

test("deleting the list cascades its squawks' images", async () => {
  const sq = await seedSquawk("ImgCascadeList");
  await routeRequest(imgReq("POST", `/api/squawks/${sq.id}/image`, "image/png", PNG));

  expect(
    (await routeRequest(req("DELETE", `/api/lists/${sq.list_id}`))).status,
  ).toBe(200);
  expect(
    (await routeRequest(req("GET", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(404);
});

test("undocumented methods on the image route are 405", async () => {
  const sq = await seedSquawk("ImgMethods");
  expect(
    (await routeRequest(req("PUT", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(405);
  expect(
    (await routeRequest(req("PATCH", `/api/squawks/${sq.id}/image`))).status,
  ).toBe(405);
});
