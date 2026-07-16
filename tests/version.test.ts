/**
 * Version-drift guard (#131): keep `package.json`'s version in lockstep with the
 * newest released `CHANGELOG.md` entry.
 *
 * Why this exists: the version lives in two places — `package.json` and the
 * CHANGELOG (the git release tag is cut as `v<that version>`) — and they can
 * silently disagree. `package.json` sat at a placeholder `0.0.0` all the way
 * through v0.6.0 because nothing forced the two to match. This runs on every
 * `bun test` (a required check), so a mismatch fails the build instead of
 * riding along until someone notices. Same spirit as the doc-drift guard
 * (`doc-drift.test.ts`) that keeps `architecture.md` honest against the code.
 *
 * Release convention this enforces: the `chore(release)` commit bumps
 * `package.json` alongside rolling `CHANGELOG.md` `[Unreleased]` → `[X.Y.Z]`,
 * and the tag `vX.Y.Z` is cut on that commit — so all three agree.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url).pathname, "utf8");
}

test("package.json version matches the newest CHANGELOG release entry", () => {
  const pkg = JSON.parse(read("../package.json")) as { version: string };

  // First `## [X.Y.Z...]` heading — the newest released section. `## [Unreleased]`
  // has no semver in its brackets, so this skips it by construction. The trailing
  // `[^\]]*` captures any pre-release/build suffix (e.g. `0.8.0-rc.1`) rather than
  // skipping such a heading, so the guard stays honest if we ever tag a pre-release.
  const match = read("../CHANGELOG.md").match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m);
  expect(
    match,
    "no `## [X.Y.Z]` release heading found in CHANGELOG.md",
  ).not.toBeNull();
  const latestReleased = match![1];

  expect(pkg.version).toBe(latestReleased);
});
