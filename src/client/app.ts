/**
 * Client bootstrap.
 *
 * 1. Resolve the viewer's initials (cookie gate; prompts on first visit).
 * 2. Paint the initials into the header slot.
 * 3. Start the hash router (lists / list-detail).
 */
import { ensureInitials } from "./initials.ts";
import { startRouter } from "./router.ts";

async function main(): Promise<void> {
  const initials = await ensureInitials();

  const slot = document.getElementById("initials-slot");
  if (slot) {
    slot.textContent = initials;
  }

  startRouter();
}

void main();
