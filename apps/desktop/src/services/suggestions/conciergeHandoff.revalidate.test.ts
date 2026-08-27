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
// raise → delivery. Here the reader is mocked so the predicate's inputs are controllable; the paired
// assertion is that ONE captured predicate returns true while its menu is unchanged and false once it
// has resolved or been replaced — driven only by the live read, nothing else.
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
/** The menu is gone — the agent answered and is working again. */
function gone(): FakeRead {
  return { agentId: "a1", options: [], present: false, fingerprint: "", blind: "no-menu" };
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
  it("KEEPS the notice while its menu is unchanged, DROPS it once resolved or replaced", () => {
    listen();
    // At raise time the menu is on screen with a readable fingerprint.
    reads = () => present("fp-menu-1");
    expect(handOffToConcierge("a1", PLAN_PICKER)).toBe(true);
    expect(captured).toHaveLength(1);
    const revalidate = captured[0]!.revalidate;
    expect(revalidate).toBeTypeOf("function");

    // STILL LIVE — the same menu is on screen at delivery, so the notice survives.
    reads = () => present("fp-menu-1");
    expect(revalidate!()).toBe(true);

    // RESOLVED — the agent answered and is working again; the notice is dropped unsaid.
    reads = () => gone();
    expect(revalidate!()).toBe(false);

    // MOVED ON — a DIFFERENT question is up now (new fingerprint). Also dropped: the concierge must
    // not be sent to answer a menu that has been replaced by another. A fresh escalation covers the
    // new one.
    reads = () => present("fp-menu-2");
    expect(revalidate!()).toBe(false);
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
