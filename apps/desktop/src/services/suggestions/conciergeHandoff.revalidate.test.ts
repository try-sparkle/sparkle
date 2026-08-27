// @vitest-environment jsdom
//
// THE PICKER NOTICE CARRIES ITS OWN DELIVERY-TIME LIVENESS TEST (bead sparkle-st06sq).
//
// `handOffToConcierge` raises a "needs you" notice the instant a build agent stops at a menu, but the
// concierge does not receive it for seconds-to-a-minute — longer than the multi-question wizards that
// raise these stay on any one question. Measured: 20 of 20 picker notices across three concierge
// turns described a menu that had already resolved. So the notice must ride with a predicate that
// re-reads the LIVE screen at delivery and drops itself when the menu it described is gone.
//
// These tests pin exactly what the hand-off ATTACHES — the other half (the scheduler dropping a
// notice whose predicate returns false) is proven in `conciergeProactive.test.ts`. Together they span
// raise → delivery. Here the reader is mocked so the predicate's inputs are controllable.
//
// THE PREDICATE DROPS ON EXACTLY ONE READING and keeps on every other (roborev 69361, 69362, both
// High). `present:false` has three causes and only `blind:"no-menu"` means the menu resolved; the
// other two are the reader being BLIND — an unmounted pane, or a footer whose option block did not
// parse — and reading blindness as resolution suppressed a live escalation PERMANENTLY, since the
// `seen.has(sig)` early return means no later pass ever raises a replacement. A changed fingerprint
// on a LIVE menu is likewise kept: a wizard's next question usually shares the pickerSignature, so
// dropping for mismatch left the agent stopped at a menu with nothing owed. Each case below is
// PAIRED — the same captured predicate, re-run against a different live read — so one assertion
// cannot pass for a predicate that returns a constant.
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeRead {
  agentId: string;
  options: { index: number; label: string }[];
  present: boolean;
  fingerprint: string;
  blind?: string;
}

// The one seam under control: what `read_picker_options` reports at each call. Swapped per case, and
// per call within a case, so a single captured predicate can be re-run against a changed screen.
let reads: (agentId: string) => FakeRead;
vi.mock("../pickerRead", () => ({
  readPickerOptions: (agentId: string) => reads(agentId),
}));
vi.mock("../../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handOffToConcierge, resetConciergeHandoffForTests } from "./conciergeHandoff";
import {
  setConciergeNotifier,
  _resetConciergeNotifierForTests,
  type ConciergeNotifier,
} from "../conciergeNotifier";
import type { NoticeRevalidator } from "../conciergeProactive";
import { useSettingsStore } from "../../stores/settingsStore";
import { useProjectStore } from "../../stores/projectStore";

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

/** A four-option plan picker — the local classifier cannot read it, so it routes to the concierge.
 *  Same shape as the founder's report in `conciergeHandoff.test.ts`. */
const PLAN_PICKER = [
  "How many re-arms should the watcher allow before it escalates?",
  "❯ 1. 2, progress-gated",
  "  2. 3, progress-gated",
  "  3. Unlimited, but logged",
  "  4. 1 — one re-arm only",
  "",
  FOOTER,
].join("\n");

/** A live menu whose question reads, so `read_picker_options` returns a non-empty fingerprint. */
function present(fingerprint: string): FakeRead {
  return { agentId: "a1", options: [{ index: 0, label: "1" }], present: true, fingerprint };
}
/** The menu is gone — the agent answered and is working again. The ONE reading that drops. */
function gone(): FakeRead {
  return { agentId: "a1", options: [], present: false, fingerprint: "", blind: "no-menu" };
}
/** The pane is not mounted, so the live xterm buffer is null and the reader can see NOTHING. Says
 *  nothing about whether a menu is up — on a real fleet most agents are unmounted most of the time. */
function paneUnmounted(): FakeRead {
  return { agentId: "a1", options: [], present: false, fingerprint: "", blind: "pane-not-mounted" };
}
/** A footer IS on screen and the option block above it did not parse — the sparkle-99o9a blind
 *  shape. A RED row with a menu the reader cannot enumerate, not an empty screen. */
function footerOnly(): FakeRead {
  return {
    agentId: "a1",
    options: [],
    present: false,
    fingerprint: "",
    blind: "footer-without-options",
  };
}

/** Every notice handed to the concierge this case, with the predicate it rode in on. */
let captured: { text: string; revalidate?: NoticeRevalidator }[] = [];
function listen(): void {
  const sink: ConciergeNotifier = (text, _kind, revalidate) => {
    captured.push({ text, revalidate });
    return true;
  };
  setConciergeNotifier(sink);
}

beforeEach(() => {
  resetConciergeHandoffForTests();
  _resetConciergeNotifierForTests();
  captured = [];
  reads = () => gone(); // default: no menu unless a case sets one
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "sparkle", rootPath: "/repo", agents: [{ id: "a1", name: "Watcher" }] },
    ] as never,
  });
  useSettingsStore.setState({ approvals: {}, resumeRule: "ask", conciergeAnswers: true } as never);
});

describe("the hand-off attaches a delivery-time predicate (bead sparkle-st06sq)", () => {
  /** Raise a notice against a live, readable menu and hand back the predicate it rode in on. */
  function raiseAndCapture(): NoticeRevalidator {
    listen();
    reads = () => present("fp-menu-1");
    expect(handOffToConcierge("a1", PLAN_PICKER)).toBe(true);
    expect(captured).toHaveLength(1);
    const revalidate = captured[0]!.revalidate;
    expect(revalidate).toBeTypeOf("function");
    return revalidate!;
  }

  it("KEEPS the notice while its menu is unchanged, DROPS it once the screen positively has none", () => {
    const revalidate = raiseAndCapture();

    // STILL LIVE — the same menu is on screen at delivery, so the notice survives.
    reads = () => present("fp-menu-1");
    expect(revalidate()).toBe(true);

    // RESOLVED — the reader looked and there is no menu. The only reading that drops.
    reads = () => gone();
    expect(revalidate()).toBe(false);
  });

  it("KEEPS it when the menu MOVED ON — a different live question is still a needs-you", () => {
    // roborev 69361. `pickerFingerprint` hashes options + question block; the `offered` de-dupe in
    // conciergeHandoff hashes option LABELS + keystrokes. A wizard's next question commonly shares
    // the signature and changes the fingerprint (`1. Yes / 2. Yes, don't ask again / 3. No`), so
    // dropping here meant question 1's notice died and question 2 could never raise one — the agent
    // sat at a live menu with nothing owed. The notice text tells the concierge to re-read before
    // pressing, so delivering it against the new question answers the right menu.
    const revalidate = raiseAndCapture();

    reads = () => present("fp-menu-2");
    expect(revalidate()).toBe(true);

    // THE PAIR: the same predicate still drops on a positively-empty screen, so this is not a
    // predicate that has simply become `() => true`.
    reads = () => gone();
    expect(revalidate()).toBe(false);
  });

  it("KEEPS it when the pane is UNMOUNTED — blindness is not resolution", () => {
    // roborev 69361/69362, the shared High. `readPickerOptions` -> `liveOptionsFor` reads the live
    // xterm buffer, which is null whenever the pane is not mounted — and per conciergeTools/terminal's
    // own header, most agents are unmounted most of the time. Clicking to another agent between raise
    // and delivery used to read as "the menu resolved", losing the escalation permanently.
    const revalidate = raiseAndCapture();

    reads = () => paneUnmounted();
    expect(revalidate()).toBe(true);

    reads = () => gone();
    expect(revalidate()).toBe(false);
  });

  it("KEEPS it on a FOOTER-WITHOUT-OPTIONS read — the blind-reader shape the raise gate already distrusts", () => {
    // sparkle-99o9a: a footer is on screen and the option block did not parse. That is a RED row with
    // a menu on it, not an empty screen — and the raise-time gate below refuses to trust this same
    // reading, so trusting it at delivery contradicted the guard three lines above it.
    const revalidate = raiseAndCapture();

    reads = () => footerOnly();
    expect(revalidate()).toBe(true);

    reads = () => gone();
    expect(revalidate()).toBe(false);
  });

  it("attaches NO predicate when the reader is BLIND to the menu at raise (bead sparkle-99o9a stays out of scope)", () => {
    listen();
    // present:false with an empty fingerprint IS the blind-reader defect — the menu is genuinely on
    // screen but read_picker_options cannot see it. That is a DIFFERENT bug; attaching a predicate
    // that re-read through the same blind reader would drop a legitimate escalation on the spot.
    reads = () => gone();
    expect(handOffToConcierge("a1", PLAN_PICKER)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.revalidate).toBeUndefined();
  });

  it("attaches NO predicate when the live menu has no readable fingerprint", () => {
    listen();
    // A menu is present but its question could not be located, so there is nothing that distinguishes
    // it from any other with the same option shape — the same "" sentinel select_picker_option
    // refuses on. Re-validating against a global-constant fingerprint would be worthless, so we don't.
    reads = () => present("");
    expect(handOffToConcierge("a1", PLAN_PICKER)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.revalidate).toBeUndefined();
  });
});
