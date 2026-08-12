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
import { act, cleanup, render, screen } from "@testing-library/react";
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
import { C } from "../../theme/colors";
import { SHORTCUT_DEFAULTS, useKeybindingsStore } from "../../stores/keybindingsStore";
import { formatBinding } from "../../keyboardHints/keybindings";

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
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
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

/** `#rrggbb` → the `rgb(r, g, b)` form jsdom serialises a style colour into. Asserted against a
 *  TOKEN put through this, never a hard-coded string, so retuning the palette retunes the test. */
function asRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`asRgb expects #rrggbb, got "${hex}"`);
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgb(${r}, ${g}, ${b})`;
}

describe("mounted — the way out is on screen", () => {
  it.each(["left", "right"] as const)("shows the hint when mounted %s", (side) => {
    mount(side);
    expect(hint()).not.toBeNull();
    // ESC and the verb, so the row says which key and what it does. Asserted on the text rather
    // than a class so a restyle cannot quietly empty it.
    expect(hint()!.textContent).toMatch(/esc/i);
    expect(hint()!.textContent).toMatch(/unmount/i);
  });

  it("is last on its row, as the founder placed it", () => {
    mount("right");
    const row = hint()!.parentElement!;
    // ══ ASSERTED AS POSITION, NOT AS A CSS VALUE (bead sparkle-wj3ya) ══════════════════════════
    // This read `justifyContent === "flex-end"`, which was the right requirement expressed through
    // the wrong fact. The row now also carries the "Chatting with ● <Agent>" chip on its LEFT — the
    // founder's placement, *"to the LEFT of where it says escape click to unmount"* — so it is laid
    // out `space-between` and the hint is held at the right edge by being the LAST child rather
    // than by the container pushing a lone item over.
    //
    // The founder's requirement never changed: the hint is hard right. So assert THAT — it survives
    // any future occupant arriving on this row, where a literal `flex-end` would have to be
    // rewritten again and would go red for a layout that still satisfies him.
    expect(row.lastElementChild).toBe(hint());
    // And the row really is a row that spreads its children, not a stack that happens to end here.
    expect(row.style.display).toBe("flex");
    expect(row.style.justifyContent).toBe("space-between");
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
  // ESC IS A DRAWN KEY, NOT BRACKETED TEXT. The hint used to render `[ESC]` inside a borderless
  // <kbd> — square brackets doing the job of a keycap the app had no way to draw. These assert the
  // SIDE EFFECT of that fix (a bordered pill exists, and the brackets are gone from the copy), not
  // the precondition: both fail against the previous markup, which had no border and did contain
  // "[". The tone comes from the palette token the open-PR badge uses, so a retune moves both.
  it("draws ESC as a bordered key pill instead of wrapping it in square brackets", () => {
    mount("right");
    const kbd = hint()!.querySelector("kbd")!;
    expect(kbd.textContent).toBe("ESC");
    expect(kbd.style.border).toContain("1px solid");
    // The literal brackets are the thing being replaced — anywhere in the hint, not just the kbd.
    expect(hint()!.textContent).not.toContain("[");
    expect(hint()!.textContent).not.toContain("]");
  });

  it("paints the PILL purple and leaves the trailing copy alone", () => {
    mount("right");
    const kbd = hint()!.querySelector("kbd")!;
    // BRAND.violet — the open-PR badge's edge (OpenPrMenu). Read off the token rather than a hex so
    // this test retunes with the palette instead of pinning a colour the design may move. jsdom
    // serialises a hex border colour as rgb(), so the TOKEN is normalised the same way rather than
    // the expectation being loosened to "has some border".
    expect(kbd.style.border).toContain(asRgb(C.violet));
    expect(kbd.style.color).toBe(C.violetInk);
    // "to unmount" is NOT purple: the founder asked for the pills only. The row's own muted ink is
    // set on the wrapper, so the assertion is that the KEY PILLS are the only violet-inked nodes in
    // there — expressed against the live set of `<kbd>`s rather than a hard-coded one, since the
    // hint now names two keys (see the second-key cases below) and would grow a third the same way.
    const pills = Array.from(hint()!.querySelectorAll<HTMLElement>("kbd"));
    const violetNodes = Array.from(hint()!.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.style.color === C.violetInk || el.style.color === C.violet,
    );
    expect(violetNodes).toEqual(pills);
    expect(pills[0]).toBe(kbd);
    expect(hint()!.style.color).not.toBe(C.violet);
    expect(hint()!.style.color).not.toBe(C.violetInk);
  });

  it("does not thin the ESC glyph with an opacity the contrast suite cannot see", () => {
    mount("right");
    const kbd = hint()!.querySelector("kbd");
    expect(kbd).not.toBeNull();
    // Empty string = no inline opacity declared, which is the whole assertion. `1` would also be
    // safe, so both pass; anything below it is the regression.
    const declared = kbd!.style.opacity;
    expect(declared === "" || Number(declared) === 1).toBe(true);
  });

  // ══ THE SECOND KEY (bead sparkle-thm9o) ═══════════════════════════════════════════════════════
  // The founder's app wedged with "I could not unmount the concierge". Escape had been disabled
  // app-wide by a leaked hidden dialog node; `unmountCable` still worked; and this hint — the only
  // affordance on screen — named exclusively the key that no longer did anything. Copy offering a
  // remedy that cannot work, while a working one exists unmentioned, is the failure AGENTS.md names
  // under "user-facing copy is code". The probe bug is fixed; naming both keys is what makes the
  // hint survive the NEXT way Escape dies.
  describe("names a second way out, because the first one can be dead", () => {
    afterEach(() => {
      // The keybindings store is a persisted module singleton shared across every case in this file.
      useKeybindingsStore.getState().resetBinding("unmountCable");
    });

    it("names the unmountCable chord alongside ESC", () => {
      mount("right");
      const pills = Array.from(hint()!.querySelectorAll("kbd")).map((k) => k.textContent);
      expect(pills[0]).toBe("ESC"); // still first — the primary gesture and the founder's ask
      expect(pills).toContain(formatBinding(SHORTCUT_DEFAULTS.unmountCable));
      expect(pills).toHaveLength(2);
      expect(hint()!.textContent).toMatch(/unmount/i); // one sentence, shared verb
    });

    // THE ASSERTION THAT MAKES THE ONE ABOVE MEAN SOMETHING. A hard-coded "⌘⇧U" satisfies it and is
    // WRONG: `unmountCable` is rebindable in ⋯ Settings → Shortcuts, so a literal sends a user who
    // has changed it to a key that does nothing — the same defect, one level along.
    it("follows a REBOUND unmountCable rather than printing a hard-coded chord", () => {
      useKeybindingsStore.getState().setBinding("unmountCable", {
        kind: "chord",
        meta: true,
        ctrl: false,
        alt: true,
        shift: false,
        key: "k",
      });
      mount("right");
      const pills = Array.from(hint()!.querySelectorAll("kbd")).map((k) => k.textContent);
      expect(pills).toContain("⌥⌘K");
      // The old default must be GONE, not merely joined by the new one.
      expect(pills).not.toContain(formatBinding(SHORTCUT_DEFAULTS.unmountCable));
    });

    // …AND IT REPAINTS ON A LIVE REBIND, which is the property the SUBSCRIPTION exists for and the
    // case above cannot see (roborev 60345). Setting the binding before `mount` only proves the hint
    // reads the store at render time — a non-subscribing
    // `useKeybindingsStore.getState().bindings.unmountCable` satisfies it just as well. But the user
    // rebinds this in ⋯ Settings → Shortcuts while the cable is patched and the hint is on screen,
    // and with a `getState()` read the pill would keep advertising the old chord until some
    // unrelated re-render — copy naming a key that does nothing, which is the whole defect this
    // change closes. So: mount FIRST, rebind after, and require the paint to follow.
    //
    // (`ConciergeHost`'s notice needs no equivalent — its `getState()` read is correctly
    // snapshot-at-send, since the sentence is composed once when the message goes out.)
    it("repaints when the chord is rebound while the hint is already on screen", () => {
      mount("right");
      expect(Array.from(hint()!.querySelectorAll("kbd")).map((k) => k.textContent)).toContain(
        formatBinding(SHORTCUT_DEFAULTS.unmountCable),
      );

      act(() => {
        useKeybindingsStore.getState().setBinding("unmountCable", {
          kind: "chord",
          meta: true,
          ctrl: false,
          alt: true,
          shift: false,
          key: "k",
        });
      });

      // No remount between the two reads — the same mounted tree has to have re-rendered.
      const pills = Array.from(hint()!.querySelectorAll("kbd")).map((k) => k.textContent);
      expect(pills).toContain("⌥⌘K");
      expect(pills).not.toContain(formatBinding(SHORTCUT_DEFAULTS.unmountCable));
    });
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
