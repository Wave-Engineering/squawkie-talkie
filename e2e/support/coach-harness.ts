/**
 * E2E harness entry for the coach-mark engine (#70).
 *
 * Story #70 ships only the engine — no product surface consumes it yet (those
 * are the follow-on surface stories). To exercise the *real* compiled engine in
 * a real browser without wiring it into a surface, the e2e spec bun-builds this
 * tiny entry and injects the bundle, which hangs the engine's public API off
 * `window.__coach`. This file is intentionally not a `*.spec.ts`, so Playwright
 * does not pick it up as a test.
 */
import * as coach from "../../src/client/coachmarks.ts";

(window as unknown as { __coach: typeof coach }).__coach = coach;
