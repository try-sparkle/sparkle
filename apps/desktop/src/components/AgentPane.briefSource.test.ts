// THE PANE IS WHERE THE BRIEF FIX ACTUALLY HAPPENS, AND IT WAS THE ONE PART WITH NO TEST.
//
// `services/agentBrief` and `services/buildAgentSpawn` are unit-tested in isolation, and
// `registry.test.ts`'s `spawnWithPane` helper only SIMULATES the pane's half by calling
// `noteBriefLaunched` / `noteBriefFailed` itself. So the four-step join that makes a briefed spawn
// work — `briefForLaunch` → `initialPrompt` in the assembled spawn → `noteBriefLaunched` on ready →
// `recordPromptSideEffects` — lived entirely in `AgentPane.tsx` with nothing covering it. Drop the
// `initialPrompt` line, or never call `noteBriefLaunched`, and the whole suite stays green while
// every real briefed spawn launches briefless or reports `unconfirmed`. That is the same
// upstream-only blind spot that let this bug survive two rounds of tests, so it gets a guard.
//
// Asserted over the SOURCE for the reason `AgentPane.blueprintSource.test.ts` states: the pane pulls
// the spawn / worktree / preflight tree and needs the Tauri runtime, so the root cannot be mounted.
// A source assertion is blunt, and it is used here only because the property is structural — which
// call the pane makes, and where — while the BEHAVIOUR of each piece is asserted for real in
// `services/agentBrief.test.ts`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./AgentPane.tsx", import.meta.url)), "utf8");

// Comments stripped: this file's guards are about what the component DECLARES, and the pane's own
// prose discusses `submitPrompt`, pasting and the old queue at length — matching raw text would pass
// or fail on the explanation rather than on the code.
const code = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
  .join("\n");

describe("AgentPane — the opening brief is delivered as launch argv", () => {
  it("reads the held brief for the launch, honouring resume", () => {
    // `resume` is load-bearing: `briefForLaunch` returns undefined on a resume so a reopen never
    // re-runs the mission. Passing a bare `true`, or omitting the arg, would re-submit the brief on
    // every relaunch.
    expect(code).toMatch(/briefForLaunch\(\s*agent\.id\s*,\s*resume\s*\)/);
  });

  it("puts it in the assembled spawn as claude's positional prompt", () => {
    // The single line that carries the entire fix. Without it the brief is attached and never sent.
    expect(code).toMatch(/initialPrompt:\s*launchBrief\b/);
  });

  it("reports the delivery observation only for a launch that CARRIED the brief", () => {
    // Guarded by the ref, not called unconditionally: a later relaunch resumes and emits no
    // positional prompt, so reporting `submitted` there would re-introduce the very lie this change
    // removes — `briefed: true` for a brief that never went out.
    expect(code).toMatch(/launchBriefRef\.current\s*\?\s*noteBriefLaunched\(agent\.id\)/);
    // …and the ref is set from the same value that went into the argv, in prepare().
    expect(code).toMatch(/launchBriefRef\.current\s*=\s*launchBrief\b/);
  });

  it("records the prompt side-effects an argv brief bypasses", () => {
    // An argv brief never passes through `submitPrompt`, so nothing else moves `lastPrompt` /
    // `promptHistory`. Without this the row reads as briefless to `newAgentAttention.isBriefless`
    // while the agent is actively working on the brief.
    expect(code).toMatch(/recordPromptSideEffects\(agent\.id,\s*delivered\)/);
  });

  it("tells the waiting caller when the pane will never launch it", () => {
    // The pane giving up is the only signal the concierge's `awaitBriefDelivery` can get for a
    // spawn that errored or found no claude; without it the op waits out its whole bound and
    // reports `unconfirmed` for something already known to have failed.
    expect(code).toMatch(/noteBriefFailed\(agent\.id/);
  });

  it("retracts the in-flight mark when the run ends without reaching the PTY", () => {
    // THE OTHER HALF OF THE SAME JOIN, and the one with no runtime test at all: `inFlight` is set by
    // `briefForLaunch` and has exactly two ways back down — `noteBriefFailed` (spawn error /
    // no-claude) and this. Delete this call and a pane that unmounts between reading the brief and
    // `pty_spawn` leaves the flag stuck true, so a wait that times out afterwards answers `launching`
    // — "give it a moment rather than re-sending" — about a launch that is not happening. The
    // service's own behaviour is asserted in `services/agentBrief.test.ts`; nothing but this pins the
    // CALL, and the service is inert without it.
    //
    // Pinned INSIDE the prepare effect's cleanup, not file-wide: the defect is that nothing ran on an
    // abandoned launch, so the same call in any other effect would satisfy a bare grep and still
    // never fire for the case it exists for. The capture is bounded by that effect's own dep array,
    // so it cannot quietly swallow a later effect.
    const cleanup = code.match(
      /void prepare\(\);[\s\S]*?return \(\) => \{([\s\S]*?)\n {2}\}, \[agent\.id, agent\.runtime\]/,
    );
    expect(cleanup).not.toBeNull();
    // Gated on the ref — `ptyReady` clears it, so a launch that DID reach the pty (and already
    // reported `submitted`) must not be retracted — and the ref is cleared with it, so a second
    // cleanup pass cannot re-retract a brief a remount has since taken.
    expect(cleanup![1]).toMatch(
      /if \(launchBriefRef\.current\) \{[^}]*launchBriefRef\.current = undefined;[^}]*noteBriefLaunchAbandoned\(agent\.id\);/,
    );
  });

  it("reports a REJECTED spawn to the brief, not just to the terminal's own overlay", () => {
    // THE THIRD WAY A LAUNCH CAN END, and the one that reached nobody. `Terminal` catches a rejected
    // spawn chain and sets its OWN "Couldn't start the agent" state; that never touches this pane's
    // `phase`, so the phase-driven `noteBriefFailed` below never fired and the brief stayed marked
    // in-flight. `spawn_build_agent` then answered `launching` — "give it a moment" — 45s after the
    // pane had already told the user the agent could not start: two surfaces contradicting each other
    // about one launch.
    //
    // BOUNDED TO THE ARROW BODY (`[^{}]*`), not `[\s\S]*?`. The unbounded form could run past the
    // callback's closing brace to ANY later `noteBriefFailed(agent.id` in the file, so emptying this
    // callback while such a call existed below would still pass — non-vacuous only by the accident
    // that no later occurrence exists today. The sibling guard above bounds its capture for the same
    // reason; verify this one by emptying the BODY, not by deleting the prop.
    expect(code).toMatch(/onSpawnFailed=\{\(\) => \{[^{}]*giveUpOnLaunch\(/);
  });

  it("gives up through ONE helper, so no path can report a subset of the three consequences", () => {
    // Giving up must publish `setPaneFailed` (or paneReadiness stays "starting" forever and every
    // later send is queued against a delivery nobody can make), `abandonPendingSends` (or text typed
    // while starting dangles — nothing ages a hold out), and `noteBriefFailed`. This shipped once
    // with the terminal-rejection path wired to `noteBriefFailed` ALONE, so the brief was told and
    // the other two waiters were stranded. Pinned as: the helper does all three, and it is what both
    // give-up paths call — a future path that picks a subset has to route around this to do it.
    const helper = code.match(/const giveUpOnLaunch = useCallback\(\s*\(reason: string\) => \{([^}]*)\}/);
    expect(helper).not.toBeNull();
    expect(helper![1]).toMatch(/setGaveUp\(true\)/);
    expect(helper![1]).toMatch(/abandonPendingSends\(agent\.id\)/);
    expect(helper![1]).toMatch(/noteBriefFailed\(agent\.id, reason\)/);
    // …and the phase-driven path uses it too, rather than keeping its own copy of the three.
    expect(code).toMatch(/giveUpOnLaunch\(\s*phase === "no-claude"/);
    // THE REGISTRY VALUE STAYS DERIVED. `paneReadiness`'s contract is that the pane republishes
    // through its guard; writing `setPaneFailed` straight from the terminal path broke it BOTH ways —
    // reverted to "starting" by any later re-run, and able to STICK on `failed` through a successful
    // retry (ptyReady is already true, so React bails and the effect never re-runs). So the helper
    // must set pane STATE, and the publish effect must read it.
    expect(helper![1]).not.toMatch(/setPaneFailed\(/);
    expect(code).toMatch(/if \(gaveUp \|\| phase === "error"/);
    // AND IT MUST BE CLEARED ON `onReady`, not only in `prepare()`. Terminal's own "Start again" is
    // an internal attempt bump that re-runs ITS spawn effect and never re-enters `prepare()`, so a
    // prepare-only clear made the latch PERMANENT for the exact path that sets it: rejected spawn
    // publishes `failed`, the next attempt succeeds, and the pane stays `failed` for the rest of its
    // mount — every send to a healthy agent answering "agent-failed", strictly worse than the
    // self-healing bug the latch replaced. `prepare()`'s clear also sits below its think/shell early
    // returns. Ready is the honest inverse of gave-up, so ready is where it must clear.
    const onReadyBody = code.match(/onReady=\{\(\) => \{([^{}]*)\}\}/);
    expect(onReadyBody).not.toBeNull();
    expect(onReadyBody![1]).toMatch(/setGaveUp\(false\)/);
    // KEPT ALONGSIDE, not replaced by the line above: `prepare()`'s clear is belt-and-braces for the
    // paths that DO re-enter it, and swapping one assertion for the other left it unpinned and
    // silently deletable. Both clears are load-bearing for different paths.
    expect(code).toMatch(/setPhase\("preparing"\);\s*setGaveUp\(false\)/);
  });

  it("no longer routes the opening brief through the PTY paste that lost the submit", () => {
    // `flushPendingSends` stays — it serves free-text sends typed at a starting agent — but the pane
    // must not gain a `submitPrompt`/`pasteIntoPty` call for the BRIEF. That path writes on
    // `ptyReady`, i.e. when `pty_spawn` returned and claude's TUI is not reading stdin yet, which is
    // exactly how the Enter was swallowed on five of five spawns.
    expect(code).not.toMatch(/submitPrompt\(\s*agent\.id\s*,\s*launchBrief/);
    expect(code).not.toMatch(/queuePendingSend\(/);
  });
});
