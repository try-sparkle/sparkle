// PLAN MODE REACHES THE BRIEF ONLY THROUGH THIS PANE — bead `sparkle-dlrqb8.3`, epic
// `sparkle-dlrqb8` (the founder asked for the localhost preview to be "part of the instructions in
// planning mode").
//
// THE SEAM THIS EXISTS FOR, stated plainly because it is the same defaulted-seam shape AGENTS.md
// names (`sparkle-lgbwf`): `planning` is an OPTIONAL option on the prompt builders and defaults to
// "not planning" internally, so every test in `services/buildAgent.test.ts` can — and does — call
// those builders with a literal `planning: true`. Those tests prove the builders READ the option.
// Nothing there proves the pane PASSES it. Delete either line asserted below and the whole suite
// stays green while a plan-mode agent silently gets the ordinary build brief again — which is the
// exact state this bead was filed against, and it is invisible from the builder side.
//
// AND IT IS INVISIBLE FROM THE BRIEF SIDE TOO, which is why the bug survived weeks of the fragment
// being present. A plan-mode agent is spawned `kind: "build"` (`buildAgentSpawn` is the only writer
// of `permissionMode`), so it ALREADY received the whole preview fragment. Grepping a plan-mode
// brief for "preview" returns a hit. The fragment was simply inert for it: the WHEN clause is
// written for an agent that has BUILT something, and a plan-mode agent is forbidden to edit.
//
// BOTH CALL SITES, NOT ONE. `AgentPane` forwards `permissionMode` to claude on the build branch AND
// on the generic branch, so both kinds can be in plan mode. A fix wired into N call sites and
// checked at one goes green the moment any single site is covered, reporting the uncovered sibling
// as verified (`sparkle-50m03`). `workerPersona` is deliberately absent — see the last test.
//
// ASSERTED OVER THE SOURCE, for the reason `AgentPane.previewEagernessSource.test.ts` states: the
// pane pulls the spawn / worktree / preflight tree and needs the Tauri runtime, so the root cannot
// be mounted. The assertion is blunt and is used only because the property is structural — WHICH
// call the pane makes and WHAT it passes — while the BEHAVIOUR of each builder is asserted for real
// in `services/buildAgent.test.ts`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./AgentPane.tsx", import.meta.url)), "utf8");

// Comments stripped. Each call site carries a paragraph above it naming `permissionMode` and plan
// mode at length, so matching raw text would pass on the EXPLANATION rather than on the code — and
// here that is not hypothetical, it is certain.
const code = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
  .join("\n");

/** The one expression that turns the spawn-time flag into the brief's option. Written once because
 *  both sites must pass the SAME thing: a site that hand-rolled a different source (a prop, a
 *  stale local, a bare truthiness check on a field that could grow other values) would satisfy a
 *  looser per-site regex while briefing the wrong agents.
 *
 *  `!resume` IS PART OF THE EXPRESSION, not incidental — see the dedicated test below for why a
 *  version of this without it is a live defect rather than a style question. */
const DERIVES_PLANNING = String.raw`planning:\s*!resume\s*&&\s*agent\.permissionMode\s*===\s*"plan"`;

/** Everything from a builder's opening paren to the flag, non-greedy and newline-tolerant, but
 *  never crossing into the NEXT builder call — otherwise one wired site would satisfy the
 *  assertion for an unwired one several hundred lines away, which is the whole failure guarded. */
function passesPlanningTo(builder: string): RegExp {
  return new RegExp(String.raw`${builder}\(\{(?:(?!Persona\(|Protocol\()[\s\S])*?${DERIVES_PLANNING}`);
}

describe("AgentPane — plan mode is wired into the briefs it builds, not just into claude's flag", () => {
  it("passes it to the ORCHESTRATION persona", () => {
    // The load-bearing site: plan mode implies `kind: "build"`, so this is the builder essentially
    // every plan-mode agent in the app goes through.
    expect(code).toMatch(passesPlanningTo("orchestrationPersona"));
  });

  it("passes it to the GENERIC agent protocol", () => {
    // This branch forwards `permissionMode` to claude too (a human can also reach plan mode with
    // shift+tab inside a running session), so a generic pane can be planning and needs the clause.
    expect(code).toMatch(passesPlanningTo("genericAgentProtocol"));
  });

  it("does NOT pass it to the worker persona, because a worker can never be in plan mode", () => {
    // Not a gap to close later. `permissionMode` is written only by `buildAgentSpawn`, which always
    // creates `kind: "build"`, so a `planning` option on `workerPersona` would be one nothing could
    // ever set — an unactionable instruction of the kind the preview fragment's own header forbids.
    //
    // This assertion is the PAIRED negative for the two above. One test proving a clause is absent
    // is ambiguous on its own — it stays absent when the wiring is keyed to the wrong side
    // entirely — so it is only meaningful beside sites proven to be wired (`sparkle-rvf6n`).
    expect(code).not.toMatch(passesPlanningTo("workerPersona"));
  });

  it("gates the brief on !resume, the SAME fact the --permission-mode flag is gated on", () => {
    // THE DEFECT THIS PINS, caught by review before it shipped. `buildClaudeExec` emits the flag
    // only on a fresh launch — `if (!resume && opts.permissionMode)` — deliberately, so a human who
    // leaves plan mode with shift+tab is not dragged back into it on every relaunch. And
    // `agent.permissionMode` is NEVER CLEARED once stored: `projectStore` is its only writer and
    // nothing unsets it.
    //
    // `--append-system-prompt` carries no such gate. So deriving `planning` from `permissionMode`
    // alone relocates the exact failure the flag's gate prevents, from the CLI flag into the BRIEF:
    // every reopen of an agent created with `mode: "plan"` — the normal post-approval flow — runs
    // WITHOUT plan mode while its prompt asserts "YOU ARE IN PLANNING MODE, so you cannot edit",
    // tells it to preview "the app AS IT IS", and instructs it to label its own post-change preview
    // as the current state. A build agent told not to build the plan it was just approved to build.
    //
    // This assertion is deliberately SEPARATE from the two site assertions above even though
    // `DERIVES_PLANNING` already contains `!resume`. Those two are about WHICH BUILDERS are wired
    // and would be satisfied by any expression the shared constant happens to hold; a maintainer
    // loosening the constant would turn them green again with the defect restored. This one names
    // the fact, so it fails with a message that says what was lost.
    expect(code).toMatch(/planning:\s*!resume\s*&&/);
    expect(code).not.toMatch(/planning:\s*agent\.permissionMode/);

    // …and the flag it must agree with really is gated that way. Read from the OTHER file, so this
    // pair cannot both drift in the same direction: if the flag's gate is ever removed, the reason
    // for `!resume` here is gone and this test is what says so rather than silently agreeing.
    const spawnSource = readFileSync(
      fileURLToPath(new URL("../services/claudeSpawn.ts", import.meta.url)),
      "utf8",
    );
    expect(spawnSource).toMatch(/if\s*\(!resume\s*&&\s*opts\.permissionMode\)/);
  });

  it("reads the flag from the agent record, never from a value bound at render scope", () => {
    // Read at COMPOSE time is the contract the surrounding wiring already keeps for
    // `previewEagerness`: the flag briefs the agent being launched now, and an agent a human takes
    // out of plan mode with shift+tab is not dragged back into it by a stale binding.
    //
    // Asserting the thing that is INDEPENDENT of the two site assertions above, rather than a count
    // of matches — an exact count would fail the suite for a correct change (a legitimate third
    // wired builder) while guarding nothing the site regexes do not already require.
    const hoisted = /const\s+\w+\s*=\s*agent\.permissionMode\s*===\s*"plan"\s*;/;
    expect(code).not.toMatch(hoisted);
  });
});
