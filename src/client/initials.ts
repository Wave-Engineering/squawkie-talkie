/**
 * Initials cookie gate.
 *
 * Identity is initials-only (no auth): a 1-3 character tag stored in the
 * `st_initials` cookie. `ensureInitials` resolves the value, prompting on the
 * first visit and persisting the answer for a long time.
 */
import { getCookie, setCookie } from "./cookies.ts";

export const INITIALS_COOKIE = "st_initials";

/** Long expiry — effectively "remember me" until the cookie is cleared. */
const COOKIE_DAYS = 365 * 5;

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
      setCookie(INITIALS_COOKIE, value, COOKIE_DAYS);
      backdrop.remove();
      resolve(value);
    });

    form.append(title, hint, input, button);
    backdrop.append(form);
    document.body.append(backdrop);
    input.focus();
  });
}
