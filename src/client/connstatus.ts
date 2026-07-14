/**
 * Connection-status indicator (#116) — the on-air / off-air pill in the app
 * header. Subscribes to realtime.ts's connection status and reflects it on theme
 * (a walkie-talkie is all about signal): subtle when live, an amber and honest
 * warning when the stream is down.
 *
 * The failure it surfaces has two shades the indicator deliberately does not try
 * to distinguish (SSE state alone can't): an SSE-only drop, where writes still
 * persist but you stop seeing others live; and a whole-server outage, where
 * writes fail too. So the offline copy is worst-case honest — "changes may not
 * be saved" — rather than the optimistic "you're just not syncing".
 */
import { onConnectionStatus, type ConnStatus } from "./realtime.ts";

/** Steady-state copy for each status. Pure — unit-tested. */
export function connCopy(status: ConnStatus): { label: string; title: string } {
  switch (status) {
    case "online":
      return { label: "on air", title: "Live — syncing with other viewers." };
    case "offline":
      return {
        label: "off air · reconnecting…",
        title:
          "Connection lost — live updates are paused and your changes may not be saved until it's back.",
      };
    default:
      return { label: "connecting…", title: "Connecting to the live channel…" };
  }
}

/** How long the "back on air" confirmation flashes before settling to on-air. */
const RECOVERED_FLASH_MS = 2_500;

/**
 * Build the indicator and wire it to connection status. `before` (optional) is a
 * sibling node to insert ahead of, so the pill can sit left of the initials badge.
 */
export function mountConnStatus(host: HTMLElement, before?: Node | null): void {
  const el = document.createElement("div");
  el.className = "conn-status";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.dataset.state = "connecting";

  const dot = document.createElement("span");
  dot.className = "conn-status__dot";
  dot.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "conn-status__label";

  el.append(dot, label);
  host.insertBefore(el, before ?? null);

  let prev: ConnStatus | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (state: string, label_: string, title: string): void => {
    el.dataset.state = state;
    label.textContent = label_;
    el.title = title;
  };

  onConnectionStatus((status) => {
    if (flashTimer !== null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }

    // Coming back from offline → flash "back on air", then settle to on-air.
    if (status === "online" && prev === "offline") {
      settle("recovered", "back on air", "Reconnected — resyncing.");
      flashTimer = setTimeout(() => {
        flashTimer = null;
        const c = connCopy("online");
        settle("online", c.label, c.title);
      }, RECOVERED_FLASH_MS);
    } else {
      const c = connCopy(status);
      settle(status, c.label, c.title);
    }

    prev = status;
  });
}
