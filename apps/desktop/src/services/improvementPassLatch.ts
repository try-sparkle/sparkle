// THE IN-FLIGHT LATCH FOR THE HOURLY IMPROVEMENT PASS — a LEAF, deliberately.
//
// WHY IT IS ITS OWN FILE AND NOT A `let` INSIDE improvementPass. The latch has two kinds of reader,
// and they sit at opposite ends of the app:
//
//   • the pass itself (services/improvementPass) — which owns the child process, and is a heavy
//     module: it reaches the worktree/park stack, the transcript registry, and through that
//     `conciergeTools/terminal`; and
//   • the SHARED busy rule (services/sparkleBusy) — which sits under an ordinary composer
//     component. The measured chain (see improvementPassLatch.test.ts, which asserts it) is
//     `components/Composer -> components/composer/ApprovalNudge -> services/configActions
//     -> conciergeTools/policy -> conciergeTools/lifecycle -> services/sparkleBusy`.
//
// When the second reader imported the FIRST module for this one boolean, every component in that
// slice pulled the entire pass stack in behind it. That is not a theoretical cost:
// it broke `Composer.suggestionDeadPty.test.tsx` at COLLECTION, because the newly-reachable
// `conciergeTools/terminal` reads `SNAPSHOT_MAX_LINES` at module scope from a `terminalScrollback`
// that the Composer test mocks with one export. The failure named a file the change never touched
// and a symbol it never mentions — the module graph was the only link. Keeping the latch in a leaf
// with NO imports of its own means a reader of the boolean can never acquire the pass's dependencies.
//
// It is module state rather than store state for the reason the pass always gave: it guards a real
// child process in THIS webview, and must reset with the page.

let passRunning = false;

/** True while a headless improvement pass is in flight. */
export function isPassRunning(): boolean {
  return passRunning;
}

/** Claim the latch. Returns false when a pass already holds it, so the caller can bail — the check
 *  and the set are ONE operation here on purpose: two statements at the call site is the shape that
 *  lets a second pass slip between them. */
export function claimPass(): boolean {
  if (passRunning) return false;
  passRunning = true;
  return true;
}

/** Release the latch. Safe to call when it is already clear. */
export function releasePass(): void {
  passRunning = false;
}
