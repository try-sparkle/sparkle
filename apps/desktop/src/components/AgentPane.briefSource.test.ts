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

  it("no longer routes the opening brief through the PTY paste that lost the submit", () => {
    // `flushPendingSends` stays — it serves free-text sends typed at a starting agent — but the pane
    // must not gain a `submitPrompt`/`pasteIntoPty` call for the BRIEF. That path writes on
    // `ptyReady`, i.e. when `pty_spawn` returned and claude's TUI is not reading stdin yet, which is
    // exactly how the Enter was swallowed on five of five spawns.
    expect(code).not.toMatch(/submitPrompt\(\s*agent\.id\s*,\s*launchBrief/);
    expect(code).not.toMatch(/queuePendingSend\(/);
  });
});
