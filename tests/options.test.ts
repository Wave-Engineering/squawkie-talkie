import { expect, test } from "bun:test";

import { OptionsError, validateOptions } from "../src/server/options.ts";

test("validateOptions accepts and normalises", () => {
  expect(validateOptions([])).toEqual([]);
  expect(validateOptions(["Ship it", "Hold", "Ask the vendor"])).toEqual([
    "Ship it",
    "Hold",
    "Ask the vendor",
  ]);
  // Trimmed, order kept.
  expect(validateOptions(["  Ship it ", "Hold"])).toEqual(["Ship it", "Hold"]);
  // The cap on the count and on the length are inclusive.
  const eight = Array.from({ length: 8 }, (_, i) => `choice ${i}`);
  expect(validateOptions(eight)).toEqual(eight);
  const forty = "x".repeat(40);
  expect(validateOptions([forty])).toEqual([forty]);
  // Case differs from a state name only by containing it: "Open the door" is fine.
  expect(validateOptions(["Open the door"])).toEqual(["Open the door"]);
});

test("validateOptions rejects what is not a clean option list", () => {
  const bad = (input: unknown): string => {
    try {
      validateOptions(input);
    } catch (err) {
      expect(err).toBeInstanceOf(OptionsError);
      return (err as Error).message;
    }
    throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
  };

  expect(bad("Ship it")).toMatch(/array/);
  expect(bad({ 0: "a" })).toMatch(/array/);
  expect(bad(null)).toMatch(/array/);
  expect(bad(["a", 2])).toMatch(/string/);
  expect(bad([""])).toMatch(/empty/);
  expect(bad(["   "])).toMatch(/empty/);
  expect(bad(["x".repeat(41)])).toMatch(/40/);
  expect(bad(Array.from({ length: 9 }, (_, i) => `c${i}`))).toMatch(/8/);
  // Case-insensitive duplicates.
  expect(bad(["Hold", "hold"])).toMatch(/duplicate/);
  // A state name, any case: an option must not shadow a state.
  for (const s of ["open", "Confirmed", "REJECTED", "retired", " recorded "]) {
    expect(bad([s])).toMatch(/state name/);
  }
  // Control characters, including a trailing newline that trim() would hide.
  expect(bad(["a\nb"])).toMatch(/control/);
  expect(bad(["Hold\n"])).toMatch(/control/);
  expect(bad(["a\u0000b"])).toMatch(/control/);
  expect(bad(["a\u007fb"])).toMatch(/control/);
});
