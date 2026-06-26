import { afterEach, beforeEach, expect, test } from "bun:test";
import { normalizeInitials } from "../src/client/initials.ts";
import { getCookie, setCookie } from "../src/client/cookies.ts";

// --- normalizeInitials -------------------------------------------------------

test("normalizeInitials caps at 3 uppercase", () => {
  expect(normalizeInitials("bjx9")).toBe("BJX");
  expect(normalizeInitials("a")).toBe("A");
});

test("normalizeInitials strips non-alphanumerics", () => {
  expect(normalizeInitials("b.j")).toBe("BJ");
  expect(normalizeInitials("  z-9 !")).toBe("Z9");
});

// --- cookie round-trip -------------------------------------------------------
// Bun's test runtime has no DOM, so install a minimal `document.cookie` jar
// that mirrors the browser's accumulate-on-set / read-all-on-get semantics.

let restoreDocument: () => void;

beforeEach(() => {
  const store = new Map<string, string>();
  const prev = Object.getOwnPropertyDescriptor(globalThis, "document");
  const doc = {
    get cookie(): string {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(str: string) {
      const pair = str.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq < 0) {
        return;
      }
      store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: doc,
  });
  restoreDocument = () => {
    if (prev) {
      Object.defineProperty(globalThis, "document", prev);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  };
});

afterEach(() => restoreDocument());

test("cookie round-trip", () => {
  setCookie("st_initials", "BJ", 365);
  expect(getCookie("st_initials")).toBe("BJ");
});

test("getCookie returns null for an unset cookie", () => {
  expect(getCookie("nope")).toBeNull();
});
