/**
 * Minimal cookie helpers.
 *
 * The only client-persisted state in Squawkie-Talkie is the viewer's initials,
 * so these stay deliberately tiny. They read/write `document.cookie` directly.
 */

/** Return the decoded value of `name`, or null if the cookie is not set. */
export function getCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const parts = document.cookie ? document.cookie.split("; ") : [];
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

/** Persist `name=value` for `days` (path=/, Lax). Use a large `days` for "forever". */
export function setCookie(name: string, value: string, days: number): void {
  const maxAge = Math.max(0, Math.floor(days * 24 * 60 * 60));
  const encoded = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  document.cookie = `${encoded}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}
