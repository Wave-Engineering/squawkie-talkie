import { expect, test } from "bun:test";
import { routeRequest } from "../src/server/index.ts";

test("healthz returns ok", async () => {
  const res = await routeRequest(new Request("http://x/healthz"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
