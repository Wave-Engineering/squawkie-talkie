/**
 * Client bootstrap.
 *
 * 1. Resolve the viewer's initials (cookie gate; prompts on first visit).
 * 2. Paint the initials into the header slot.
 * 3. On an empty instance, require a first list before proceeding (#71).
 * 4. Register the real view renderers, then start the hash router.
 */
import { ensureFirstList, ensureInitials } from "./initials.ts";
import { renderLists } from "./lists.ts";
import { connect } from "./realtime.ts";
import { registerView, startRouter } from "./router.ts";
// Side-effect import: registers the list-detail view renderer (#8).
import "./detail.ts";

async function main(): Promise<void> {
  const initials = await ensureInitials();

  const slot = document.getElementById("initials-slot");
  if (slot) {
    slot.textContent = initials;
  }

  // Empty-system bootstrap (#71): block on naming a first list while the whole
  // instance has zero lists, so every later coach mark has something to anchor
  // to. A no-op the moment any list exists.
  await ensureFirstList();

  // #7 wires the Lists screen; #8 self-registers the "detail" view via the
  // side-effect import above.
  registerView("lists", renderLists);

  // Mount the current view first so it registers its realtime sink, then open
  // the SSE stream (#9): changes by other viewers now arrive live.
  startRouter();
  connect();
}

void main();
