// Driven by tests/migration-api.test.ts in its own process: db.ts keeps one
// connection per process, so a file-backed database cannot share the test runner's.
// Opens the database named by SQUAWK_DB through the routes and prints what it saw.
import { routeRequest } from "../../src/server/index.ts";

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function rows(): Promise<unknown[]> {
  const res = await routeRequest(req("GET", "/api/lists/1"));
  return ((await res.json()) as { squawks: unknown[] }).squawks;
}

const before = await rows();
const noted = await routeRequest(req("PATCH", "/api/squawks/1", { note: "from the old row" }));
const created = await routeRequest(
  req("POST", "/api/lists/1/squawks", { text: "Which way?", initials: "CC", options: ["Left", "Right"] }),
);
const newId = ((await created.json()) as { id: number }).id;
const answered = await routeRequest(req("PATCH", `/api/squawks/${newId}`, { choice: "Right" }));
const after = await rows();

console.log(
  JSON.stringify({
    before,
    statuses: [noted.status, created.status, answered.status],
    newId,
    after,
  }),
);
