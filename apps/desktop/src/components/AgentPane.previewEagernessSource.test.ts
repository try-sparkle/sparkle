// `[preview].agent_eagerness` REACHES THE PROMPT ONLY THROUGH THIS PANE — and that was the one
// part with no test (roborev 65670, Medium).
//
// The knob is an OPTIONAL option on all three prompt builders and each defaults to
// `DEFAULT_PREVIEW_EAGERNESS` internally, so every existing test can — and does — call those
// builders directly with a literal. That is the exact defaulted-seam shape AGENTS.md names
// (`sparkle-lgbwf`): the persona tests prove the builders READ the option, and nothing proved the
// spawn PASSES it. Delete or typo any of the three lines below and the whole suite stays green
// while a project configured `[preview].agent_eagerness = "never"` silently ships the preview
// fragment into every brief anyway — the defect the knob exists to prevent, with no failing test.
//
// ALL THREE CALL SITES, NOT ONE. AGENTS.md's `sparkle-50m03` note is precisely this: a fix wired
// into N call sites and checked at one goes green the moment any single site is covered, and the
// uncovered siblings carry the identical hole while reporting as verified. The knob has three
// consumers — worker, orchestrator, generic — so all three are pinned here.
//
// ASSERTED OVER THE SOURCE, for the reason `AgentPane.briefSource.test.ts` and
// `AgentPane.blueprintSource.test.ts` both state: the pane pulls the spawn / worktree / preflight
// tree and needs the Tauri runtime, so the root cannot be mounted. A source assertion is blunt and
// is used here only because the property is structural — WHICH call the pane makes and WHAT it
// passes — while the BEHAVIOUR of each builder is asserted for real in `services/buildAgent.test.ts`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./AgentPane.tsx", import.meta.url)), "utf8");

// Comments stripped: the pane's own prose explains this wiring at length and names both the option
// and the store getter, so matching raw text would pass on the EXPLANATION rather than on the code.
// That is not hypothetical here — each of the three call sites carries a paragraph above it
// mentioning `[preview].agent_eagerness`.
const code = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
  .join("\n");

/** The one expression that carries the knob from the store into a prompt builder. Written once
 *  because all three sites must pass the SAME thing — a site that hand-rolled a different source
 *  (a prop, a stale local, a literal) would satisfy a looser per-site regex. */
const READS_KNOB = String.raw`previewEagerness:\s*useSettingsStore\.getState\(\)\.previewEagerness`;

/** Everything from a builder's opening paren to the knob, non-greedy and newline-tolerant, but
 *  never crossing into the NEXT builder call — otherwise one wired site would satisfy the assertion
 *  for an unwired one several hundred lines away, which is the whole failure this guards. */
function passesKnobTo(builder: string): RegExp {
  return new RegExp(String.raw`${builder}\(\{(?:(?!Persona\(|Protocol\()[\s\S])*?${READS_KNOB}`);
}

describe("AgentPane — [preview].agent_eagerness is wired into every prompt it builds", () => {
  it("passes it to the WORKER persona", () => {
    // The site the tier change made load-bearing: a worker may now call `preview`
    // (`CONTROL_OP_TIERS.preview` is `free`), so it is briefed on the tool, and this is the only
    // thing that lets a human's "never" withhold that brief.
    expect(code).toMatch(passesKnobTo("workerPersona"));
  });

  it("passes it to the ORCHESTRATION persona", () => {
    expect(code).toMatch(passesKnobTo("orchestrationPersona"));
  });

  it("passes it to the GENERIC agent protocol", () => {
    expect(code).toMatch(passesKnobTo("genericAgentProtocol"));
  });

  it("never binds the knob at render scope, so every read is a compose-time read", () => {
    // Read at COMPOSE time is the documented contract: changing the knob briefs the NEXT agent
    // launched, not one already running on the old prompt.
    //
    // THIS ASSERTION WAS WRONG THE FIRST TIME, and the correction is the interesting part (roborev
    // 65674). It used to pin the COUNT of inline reads at exactly 3 and claim that caught a hoist
    // to render scope. It could not: the three assertions above already require the inline
    // `previewEagerness: useSettingsStore.getState().previewEagerness` shape at each call site, so
    // a hoist turns THOSE red first and this one could never fail alone for that reason. What it
    // did instead was ratchet an exact count — adding a legitimate fourth correctly-wired builder
    // would have failed the suite for a correct change, while a maintainer read a comment
    // describing a defect that was not being guarded.
    //
    // So it now asserts the thing that is actually independent: that the getter is never BOUND to a
    // name. A render-scope `const eagerness = useSettingsStore.getState().previewEagerness` is what
    // freezes the value at mount, and it is invisible to the shape assertions above because those
    // only look at the call sites.
    //
    // DELIBERATELY STRICTER THAN "no RENDER-SCOPE binding", and the over-reach is stated rather
    // than hidden: a source match cannot see scope, so this also bans a binding inside a spawn
    // handler that would in fact be a correct compose-time read. That trade is taken knowingly —
    // the freeze-at-mount defect is silent and ships to every agent, while the cost here is that a
    // future refactor which genuinely wants a local must update this test and say why.
    // BOTH FORMS, because the first version of this guard missed the idiomatic one (roborev
    // 65689): its regex required the right-hand side to END in `.previewEagerness`, so
    // `const { previewEagerness } = useSettingsStore.getState()` — the way anyone actually writes
    // a hoist against a zustand store — sailed straight through, and the comment once again
    // described a guard that was not there.
    expect(code).not.toMatch(
      /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*useSettingsStore\.getState\(\)\.previewEagerness/,
    );
    expect(code).not.toMatch(
      /\b(?:const|let|var)\s*\{[^}]*\bpreviewEagerness\b[^}]*\}\s*=\s*useSettingsStore\.getState\(\)/,
    );
    // …and the wiring is still there at least three times. `toBeGreaterThanOrEqual`, not an exact
    // count, so a new correctly-wired call site is not a spurious failure.
    const reads = code.match(new RegExp(READS_KNOB, "g")) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });
});
