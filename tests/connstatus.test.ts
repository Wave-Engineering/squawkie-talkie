/**
 * Unit tests for the connection-status indicator's pure copy mapping (#116).
 * The DOM wiring (mountConnStatus) and the online/offline lifecycle are covered
 * by tests/realtime.test.ts (status store) and e2e/20-connection-status.spec.ts.
 */
import { expect, test } from "bun:test";
import { connCopy } from "../src/client/connstatus.ts";

test("connCopy: online is reassuring and low-key", () => {
  const c = connCopy("online");
  expect(c.label).toBe("on air");
  expect(c.title.toLowerCase()).toContain("live");
});

test("connCopy: offline is worst-case honest (writes may be lost)", () => {
  const c = connCopy("offline");
  expect(c.label).toContain("off air");
  expect(c.label).toContain("reconnecting");
  // Must not under-promise: a whole-server outage means writes fail too.
  expect(c.title.toLowerCase()).toContain("may not be saved");
});

test("connCopy: connecting is neutral", () => {
  const c = connCopy("connecting");
  expect(c.label).toContain("connecting");
});
