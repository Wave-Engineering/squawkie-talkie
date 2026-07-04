import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  ensureFirstList,
  ensureInitials,
  FIRST_LIST_SUB,
  FIRST_LIST_TITLE,
  INITIALS_COACH_COPY,
  normalizeInitials,
  WELCOME_COPY,
} from "../src/client/initials.ts";
import { getCookie, setCookie } from "../src/client/cookies.ts";

// --- normalizeInitials -------------------------------------------------------
// Pure — needs no DOM.

describe("normalizeInitials", () => {
  test("caps at 3 uppercase", () => {
    expect(normalizeInitials("bjx9")).toBe("BJX");
    expect(normalizeInitials("a")).toBe("A");
  });

  test("strips non-alphanumerics", () => {
    expect(normalizeInitials("b.j")).toBe("BJ");
    expect(normalizeInitials("  z-9 !")).toBe("Z9");
  });
});

// --- cookie round-trip -------------------------------------------------------
// Bun's test runtime has no DOM, so install a minimal `document.cookie` jar
// that mirrors the browser's accumulate-on-set / read-all-on-get semantics.

describe("cookie jar", () => {
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
});

// --- onboarding surfaces (welcome + coach + first-list gate) ------------------
// These need a real DOM: happy-dom is registered for this block only so the
// server suite keeps Bun's native globals.

describe("onboarding surfaces", () => {
  // happy-dom only honours document.cookie against a real origin, so register
  // with a URL (about:blank silently drops every Set-Cookie).
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost:7701/" });
  });
  afterAll(() => {
    GlobalRegistrator.unregister();
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    // Clear any st_initials cookie between tests.
    document.cookie = "st_initials=; Max-Age=0; Path=/";
  });

  afterEach(() => {
    // Scrub any coach overlay a tour left mounted so it never leaks forward.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelectorAll(".coach-overlay").forEach((n) => n.remove());
    document.body.innerHTML = "";
  });

  test("welcome shown only when st_initials unset", () => {
    // Unset cookie -> the prompt (and its Welcome copy) renders.
    void ensureInitials();
    const welcome = document.querySelector(".modal__welcome");
    expect(welcome).not.toBeNull();
    expect(welcome?.textContent).toBe(WELCOME_COPY);

    // Tear down the modal + its coach tour, then set the cookie.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.body.innerHTML = "";
    setCookie("st_initials", "BJ", 365);

    // With the cookie set, ensureInitials resolves without a modal.
    void ensureInitials();
    expect(document.querySelector(".modal__welcome")).toBeNull();
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });

  test("a coach mark anchors to the initials input with the field copy", () => {
    void ensureInitials();

    const overlay = document.querySelector(".coach-overlay");
    expect(overlay).not.toBeNull();
    expect(document.querySelector(".coach-callout__body")?.textContent).toBe(
      INITIALS_COACH_COPY,
    );
  });

  // --- first-list gate -------------------------------------------------------

  describe("first-list gate", () => {
    let restoreFetch: () => void;

    /** Stub `fetch` so getLists/createList resolve against an in-memory list set. */
    function stubApi(initial: Array<{ id: number; name: string }>): {
      lists: Array<{ id: number; name: string }>;
    } {
      const lists = [...initial];
      let nextId = lists.reduce((m, l) => Math.max(m, l.id), 0) + 1;
      const prev = globalThis.fetch;
      globalThis.fetch = (async (path: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (path === "/api/lists" && method === "GET") {
          return jsonResponse(lists);
        }
        if (path === "/api/lists" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            name: string;
          };
          const created = { id: nextId++, name: body.name };
          lists.push(created);
          return jsonResponse(created);
        }
        return jsonResponse({ error: "unexpected" }, 404);
      }) as typeof fetch;
      restoreFetch = () => {
        globalThis.fetch = prev;
      };
      return { lists };
    }

    afterEach(() => restoreFetch?.());

    test("blocks on an empty system and resolves once a list is created", async () => {
      stubApi([]);

      let resolved = false;
      const done = ensureFirstList().then(() => {
        resolved = true;
      });

      // Let the getLists() microtask settle so the gate mounts.
      await flush();
      const form = document.querySelector<HTMLFormElement>(".first-list-gate");
      expect(form).not.toBeNull();
      expect(document.querySelector(".modal__title")?.textContent).toBe(
        FIRST_LIST_TITLE,
      );
      expect(document.querySelector(".modal__hint")?.textContent).toBe(
        FIRST_LIST_SUB,
      );
      // Not resolved while the gate is up.
      expect(resolved).toBe(false);

      const input = form!.querySelector<HTMLInputElement>(
        ".first-list-gate__input",
      )!;
      input.value = "Bugs";
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );

      await done;
      expect(resolved).toBe(true);
      expect(document.querySelector(".first-list-gate")).toBeNull();
    });

    test("does not gate when a list already exists", async () => {
      stubApi([{ id: 1, name: "Existing" }]);

      await ensureFirstList();
      expect(document.querySelector(".first-list-gate")).toBeNull();
    });
  });
});

/** A minimal ok/`json()` Response stand-in for the fetch stub. */
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

/** Resolve after pending microtasks (a couple of awaited fetch hops). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
