// @vitest-environment jsdom
//
// "[ESC] TO UNMOUNT" — the way out, shown only while there is something to get out of.
//
// Mounted, everything the human types goes to a build agent's terminal instead of to the concierge.
// That is a big change in where their words land, and Escape is the only gesture that undoes it —
// so the affordance has to be ON SCREEN while the state is live, not learned once and remembered.
// The founder's placement: the row directly above the composer (the one carrying the `>_ …`
// activity line), right-justified.
//
// AND IT MUST GO AWAY ON UNMOUNT. A hint offering an exit from a state you are no longer in is
// worse than no hint: it says the cable is still patched when it isn't, which is exactly the stale
// signal the unmount work exists to prevent. Both directions are asserted here for that reason —
// a presence-only test would pass against a hint that is simply always rendered.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { CONCIERGE_UNMOUNT_HINT_TESTID, ConciergeColumn } from "./ConciergeColumn";
import type { ConciergeController, ConciergeViewModel, ConciergeWired } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { CONCIERGE_AI_FIELD } from "./conciergeAiLock";
import { useSettingsStore } from "../../stores/settingsStore";

beforeEach(() => {
  enableAiEnhancementsForTests();
  // The AI-locked case below turns this field OFF, and the settings store is a persisted singleton
  // shared across every case in the file — so the flag is restored HERE rather than in that case's
  // teardown. Otherwise it leaks into whatever runs next and darkens a column that expected a
  // composer, which fails a case that has nothing to do with the lock (observed exactly that way).
  useSettingsStore.setState({ [CONCIERGE_AI_FIELD]: true } as never);
});
afterEach(cleanup);

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, running: 0, done: 0 },
  messages: [{ id: "m1", kind: "you", text: "Retry the failing one" }],
};

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

function mount(wired?: ConciergeWired) {
  render(
    <ConciergeColumn
      model={model}
      controller={controller()}
      {...(wired === undefined ? {} : { wired })}
    />,
  );
}

const hint = () => screen.queryByTestId(CONCIERGE_UNMOUNT_HINT_TESTID);

describe("mounted — the way out is on screen", () => {
  it.each(["left", "right"] as const)("shows the hint when mounted %s", (side) => {
    mount(side);
    expect(hint()).not.toBeNull();
    // ESC and the verb, so the row says which key and what it does. Asserted on the text rather
    // than a class so a restyle cannot quietly empty it.
    expect(hint()!.textContent).toMatch(/esc/i);
    expect(hint()!.textContent).toMatch(/unmount/i);
  });

  it("is right-justified on its row, as the founder placed it", () => {
    mount("right");
    // The hint sits at the END of its row — the founder's "right justified". Read off the row that
    // owns the alignment rather than the text node inside it.
    const row = hint()!.parentElement!;
    expect(row.style.justifyContent).toBe("flex-end");
  });

  // PLACEMENT IS THE REQUIREMENT, and `justify-content` alone does not express it: a row aligned
  // flex-end at the TOP of the column would satisfy the case above while sitting nowhere near the
  // composer the founder anchored it to ("directly above the composer").
  //
  // ADJACENCY, NOT MERE PRECEDENCE. A first cut asserted `DOCUMENT_POSITION_FOLLOWING`, which is
  // true for ANY earlier position in the tree — so moving the block to the top of the column, the
  // exact scenario that comment cited, still passed. The assertion recorded confidence in a
  // guarantee it did not enforce, which is the "passes for the wrong reason" shape the rest of this
  // file is guarding against (roborev 55694). So: walk the column root's children and require
  // nothing rendered between the hint's row and the composer's block except the visually-hidden
  // announcer, which is allowed to sit there and carries no visual weight.
  it("sits DIRECTLY above the composer, with nothing rendered in between", () => {
    mount("right");
    const composer = screen.getByRole("textbox");
    const hintRow = hint()!.parentElement!;
    const root = hintRow.parentElement!;
    const kids = Array.from(root.children);
    const composerBlock = kids.find((el) => el.contains(composer));
    expect(composerBlock).toBeDefined();
    const between = kids.slice(kids.indexOf(hintRow) + 1, kids.indexOf(composerBlock!));
    expect(between.map((el) => el.getAttribute("data-testid"))).toEqual(["concierge-announcer"]);
  });

  // The ink has to be READABLE, and this hint only ever renders on the FLOODED plane where the
  // column's tightest contrast already sits at 4.76:1 with 0.26 of margin. An inline `opacity` on
  // the one glyph naming the key spends more than that margin (measured ~3.93:1, under the repo's
  // 4.5 floor) and chromeContrast.test.ts cannot see it, because it measures token pairs and has no
  // visibility into inline opacity. So it is pinned HERE, where the element exists (roborev 55535).
  it("does not thin the [ESC] glyph with an opacity the contrast suite cannot see", () => {
    mount("right");
    const kbd = hint()!.querySelector("kbd");
    expect(kbd).not.toBeNull();
    // Empty string = no inline opacity declared, which is the whole assertion. `1` would also be
    // safe, so both pass; anything below it is the regression.
    const declared = kbd!.style.opacity;
    expect(declared === "" || Number(declared) === 1).toBe(true);
  });
});

// aiLock && isWired IS REACHABLE — the cable is patched by a sidebar row click, a gesture that knows
// nothing about the concierge AI entitlement. In that state the thread is replaced by
// ConciergeAiLocked and there is NO COMPOSER AT ALL, so a hint offering "the way out" points at an
// input surface that does not exist. Its two neighbours (ConciergeUnavailable, ComposeBox) both
// carry the `!aiLock` gate; this is the case proving the hint does too (roborev 55535).
//
// Note this suite's OTHER cases all run under `enableAiEnhancementsForTests`, which forces
// `aiLock` to null — which is exactly why none of them could have caught this.
describe("AI-locked — nothing to get out of, and nowhere to type", () => {
  it("renders no hint when the column is locked, even mounted", () => {
    // Engage the lock through the real rule rather than by mocking the hook: `aiConcierge: false`
    // is `conciergeAiLockReason`'s `flag_off` branch, so this exercises the production path the
    // founder could actually land in. `beforeEach` already granted entitlement + credits, so this
    // one field is the only thing separating this case from every other case in the file.
    useSettingsStore.setState({ [CONCIERGE_AI_FIELD]: false } as never);
    mount("right");
    // THE PRECONDITION THAT MAKES THIS CASE MEAN ANYTHING: the lock really is engaged, so there is
    // no composer. Without it, a null hint could just as well mean the column failed to render —
    // which would be a test that passes for the wrong reason, the exact shape AGENTS.md warns about.
    expect(screen.getByTestId("concierge-ai-locked")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(hint()).toBeNull();
  });
});

describe("unmounted — no exit offered from a state you are not in", () => {
  it("renders nothing at rest", () => {
    mount();
    expect(hint()).toBeNull();
  });

  it("renders nothing when explicitly off", () => {
    mount("off");
    expect(hint()).toBeNull();
  });

  // THE SIDE EFFECT, not the precondition: the hint must DISAPPEAR on the transition, not merely be
  // absent in a column that was never mounted. A hint rendered unconditionally passes the two cases
  // above only if the default prop happens to be off — this one fails it outright.
  it("goes away when the cable is unpatched", () => {
    const { rerender } = render(
      <ConciergeColumn model={model} controller={controller()} wired="right" />,
    );
    expect(hint()).not.toBeNull();
    rerender(<ConciergeColumn model={model} controller={controller()} wired="off" />);
    expect(hint()).toBeNull();
  });
});
