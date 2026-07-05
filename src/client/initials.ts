/**
 * First-run onboarding gates (Story #71, Epic #69).
 *
 * Two blocking surfaces the brand-new user meets before the app proper:
 *
 *  1. The **initials gate** — identity is initials-only (no auth): a 1-3
 *     character tag stored in the `st_initials` cookie. On the first visit the
 *     modal also carries the Welcome/ConOps copy and spotlights the initials
 *     field with a coach mark (the #70 engine, surfaceKey `initials`).
 *
 *  2. The **empty-system first-list gate** — once initials are set, if the whole
 *     instance still has zero lists, the user must name a first list before
 *     proceeding. This keys off the live global count (`getLists()`), never a
 *     per-browser flag, so it re-arms if the system is ever emptied and never
 *     fires for a user joining a populated instance.
 */
import type { List } from "../server/types.ts";
import { createList, getLists } from "./api.ts";
import { resetSeen, runTour } from "./coachmarks.ts";
import { getCookie, setCookie } from "./cookies.ts";

export const INITIALS_COOKIE = "st_initials";

/** Coach-mark surface key for the initials field (its localStorage seen-flag). */
export const INITIALS_COACH_SURFACE = "initials";

/** Long expiry — effectively "remember me" until the cookie is cleared. */
const COOKIE_DAYS = 365 * 5;

/** Welcome / ConOps copy shown alongside the initials prompt on first run. */
export const WELCOME_COPY =
  "Squawkie-Talkie — a shared scratchpad for whatever's bugging you. " +
  "No accounts, no tickets, no standup. And it's keyboard-first on purpose: " +
  "the mouse is like disk access — death to efficiency. Hands on the keys " +
  "and you'll fly.";

/** Coach-mark copy anchored to the initials input. */
export const INITIALS_COACH_COPY =
  "Drop your initials — a name tag, not a login. No password, nobody's " +
  "checking; it just rides along on the squawks you record so folks know " +
  "who flagged what.";

/** Heading + sub for the empty-system first-list gate. */
export const FIRST_LIST_TITLE = "What are you squawkin' about?";
export const FIRST_LIST_SUB = "(name your first list)";

/** Uppercase, strip non-alphanumerics, cap at 3 characters. */
export function normalizeInitials(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

/**
 * Resolve the viewer's initials. Returns the stored value immediately when the
 * cookie is present; otherwise renders a blocking modal that requires 1-3
 * characters, persists the normalized value, and resolves with it.
 */
export function ensureInitials(): Promise<string> {
  const existing = getCookie(INITIALS_COOKIE);
  if (existing) {
    const normalized = normalizeInitials(existing);
    if (normalized.length >= 1) {
      return Promise.resolve(normalized);
    }
  }
  return promptForInitials();
}

function promptForInitials(): Promise<string> {
  return new Promise((resolve) => {
    // A new / re-identifying user is (re)onboarding: clear any stale coach
    // seen-flags so the whole progressive tour re-arms coherently — never a
    // partial 2-of-3 from flags that drifted across builds or a cookie clear (#93).
    resetSeen();

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const form = document.createElement("form");
    form.className = "modal";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    form.setAttribute("aria-labelledby", "initials-title");

    const title = document.createElement("h2");
    title.className = "modal__title";
    title.id = "initials-title";
    title.textContent = "Who's squawking?";

    // Welcome / ConOps copy — shown only here, i.e. only when the cookie is
    // unset (ensureInitials never calls this when it is set).
    const welcome = document.createElement("p");
    welcome.className = "modal__welcome";
    welcome.textContent = WELCOME_COPY;

    const hint = document.createElement("p");
    hint.className = "modal__hint";
    hint.textContent = "Enter your initials (1-3 characters).";

    const input = document.createElement("input");
    input.className = "modal__input";
    input.type = "text";
    input.maxLength = 3;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Your initials");

    const button = document.createElement("button");
    button.className = "modal__button";
    button.type = "submit";
    button.textContent = "Enter";
    button.disabled = true;

    input.addEventListener("input", () => {
      const normalized = normalizeInitials(input.value);
      if (input.value !== normalized) {
        input.value = normalized;
      }
      button.disabled = normalized.length < 1;
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = normalizeInitials(input.value);
      if (value.length < 1) {
        return;
      }
      // Tear down any live coach tour so its overlay never outlives the modal
      // (Escape is the engine's own dismiss trigger; a no-op if already gone).
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      setCookie(INITIALS_COOKIE, value, COOKIE_DAYS);
      backdrop.remove();
      resolve(value);
    });

    form.append(title, welcome, hint, input, button);
    backdrop.append(form);
    document.body.append(backdrop);
    input.focus();

    // Spotlight the initials field with the field-coach copy. Suppressed by the
    // engine once seen, so it never re-triggers on a device that has seen it.
    runTour(INITIALS_COACH_SURFACE, [
      {
        target: () => input,
        body: INITIALS_COACH_COPY,
        placement: "bottom",
        // The real field stays live under the coach: type your tag and hit
        // Enter to submit (the form's submit handler tears the tour down).
        interactive: true,
      },
    ]);
  });
}

/**
 * Empty-system bootstrap. If the whole instance has zero lists, block the user
 * behind a required "name your first list" step until one exists; otherwise
 * (a populated instance) resolve immediately. Driven by the live global count,
 * so it never persists a seen-flag and re-arms if the system is emptied.
 */
export async function ensureFirstList(): Promise<void> {
  let lists: List[];
  try {
    lists = await getLists();
  } catch {
    // If the count cannot be read we cannot know the system is empty; don't
    // trap the user behind a gate we have no way to clear.
    return;
  }
  if (lists.length > 0) {
    return;
  }
  await promptForFirstList();
}

function promptForFirstList(): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "first-list-backdrop";

    const form = document.createElement("form");
    form.className = "modal first-list-gate";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    form.setAttribute("aria-labelledby", "first-list-title");

    const title = document.createElement("h2");
    title.className = "modal__title";
    title.id = "first-list-title";
    title.textContent = FIRST_LIST_TITLE;

    const sub = document.createElement("p");
    sub.className = "modal__hint";
    sub.textContent = FIRST_LIST_SUB;

    const error = document.createElement("p");
    error.className = "first-list-gate__error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const input = document.createElement("input");
    input.className = "first-list-gate__input";
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "New list name";
    input.setAttribute("aria-label", "First list name");

    const button = document.createElement("button");
    button.className = "modal__button";
    button.type = "submit";
    button.textContent = "Create";
    button.disabled = true;

    input.addEventListener("input", () => {
      button.disabled = input.value.trim().length === 0;
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        return;
      }
      button.disabled = true;
      error.hidden = true;
      error.textContent = "";
      void createList(name)
        .then(() => {
          // A list now exists (getLists() would return >= 1): clear the gate.
          backdrop.remove();
          resolve();
        })
        .catch(() => {
          error.textContent = `Could not create "${name}". Try again.`;
          error.hidden = false;
          button.disabled = input.value.trim().length === 0;
        });
    });

    form.append(title, sub, error, input, button);
    backdrop.append(form);
    document.body.append(backdrop);
    input.focus();
  });
}
