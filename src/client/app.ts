/**
 * Client bootstrap.
 *
 * 1. Resolve the viewer's initials (cookie gate; prompts on first visit).
 * 2. Paint the initials into the header slot.
 * 3. Register the real view renderers, then start the hash router.
 */
import { ensureInitials } from "./initials.ts";
import { renderLists } from "./lists.ts";
import { registerView, startRouter } from "./router.ts";

async function main(): Promise<void> {
  const initials = await ensureInitials();

  const slot = document.getElementById("initials-slot");
  if (slot) {
    slot.textContent = initials;
  }

  // #7 wires the Lists screen; #8 will register the "detail" view.
  registerView("lists", renderLists);

  startRouter();
}

void main();
