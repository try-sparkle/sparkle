// @vitest-environment jsdom
//
// THE PROMPT THAT REACHED THE FOUNDER BECAUSE NOTHING ASKED THE CONCIERGE.
//
// Four reports in one morning, all the same end state — an agent stopped at a menu, the row red on
// the founder, and nobody but him able to clear it. Two different upstream causes:
//
//   • a FOUR-OPTION plan picker the local classifier cannot read at all (`classifyApproval` demands
//     a Yes/No pair), and
//   • three ordinary prompts it read PERFECTLY and refused for want of an `always` rule.
//
// These tests drive the REAL wire end to end — a real registered concierge sink, the real
// `maybeAutoApprove`, the real grace ledger — because the defect was never in any one of those
// pieces. Every piece worked. What did not exist was the connection between them, and only a test
// that spans them can tell that the connection is there.
//
// WHAT MAKES EACH CASE NON-VACUOUS: against the code as it was, `notified` is empty and the reported
// outcome is `declined` (or `undefined`) in every single case below. The escalation assertions all
// fail. That is the point — delete the wiring and this file goes red, rather than passing because it
// only ever checked a precondition.
import { describe, it, expect, vi, beforeEach } from "vitest";

const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({
  writePtyChainedStrict: (id: string, data: string) => writePty(id, data),
}));

const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({ aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key) }));

vi.mock("../../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { maybeAutoApprove } from "./approvalsRuntime";
import { resetConciergeHandoffForTests } from "./conciergeHandoff";
import { setConciergeNotifier, _resetConciergeNotifierForTests } from "../conciergeNotifier";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptAnswerOutcome,
} from "../../engine/blockedPromptGrace";

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

// ── THE FOUNDER'S OWN SCREENS, AS HE REPORTED THEM ──────────────────────────────────────────────

/** Report 1: the plan picker on "Sparkle Watcher Pusher Enforcement". FOUR options, no "Yes", no
 *  "No" — `classifyApproval` returns null on it, which is why nothing happened at all before.
 *
 *  WRITTEN IN THE RAW TERMINAL FORM (`1. label`), NOT the form the founder quoted. He reported the
 *  options as "1 · 2, progress-gated", but that middot is SPARKLE'S OWN RENDERING — `heuristics.ts`
 *  builds each button label as `${n} · ${label}` when it parses the screen. The detector's
 *  `MENU_LINE` only matches `1.` / `1)` / `[1]`, so a fixture copied from the rendered UI parses as
 *  no menu at all and silently tests nothing. Worth the paragraph: the first draft of this file made
 *  exactly that mistake and four cases failed for a reason that had nothing to do with the code. */
const PLAN_PICKER = [
  "How many re-arms should the watcher allow before it escalates?",
  "❯ 1. 2, progress-gated",
  "  2. 3, progress-gated",
  "  3. Unlimited, but logged",
  "  4. 1 — one re-arm only",
  "",
  FOOTER,
].join("\n");

/** Report 2: a read-only `gh pr view`. A textbook Yes/No pair — classified `bash`, keystroke known —
 *  refused only because no `always` rule authorised the press. */
const GH_PR_VIEW_PROMPT = [
  "Bash command",
  "  gh pr view 1777 --json number,state,mergeable,mergeStateStatus",
  "Read PR 1777 mergeable and CI state",
  "This command requires approval",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for similar commands",
  "  3. No",
  "",
  FOOTER,
].join("\n");

/** The denied-tool veto's screen. `spawn_worker` is in `DENIED_TOOL_PATTERNS`, so it is refused even
 *  under `mcp = "always"` — and must NEVER be handed onward either. */
const DENIED_TOOL_PROMPT = [
  'sparkle-orchestrator - spawn_worker(task: "run the build command")',
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

/** A menu whose OPTIONS parse but whose QUESTION does not — nothing above the option run. The
 *  safety case: two different asks offering "Alpha/Beta" are indistinguishable, so this must be
 *  refused rather than answered by anyone. */
const UNREADABLE_PICKER = ["❯ 1. Alpha", "  2. Beta", "", FOOTER].join("\n");

/** A spend decision — on the founder's explicit deny-list, so it stays his however readable it is. */
const SPEND_PROMPT = [
  "Your API credit balance is exhausted. How should we proceed?",
  "❯ 1. Upgrade to the $200/mo plan and continue",
  "  2. Purchase 500k additional credits",
  "  3. Stop here and wait",
  "",
  FOOTER,
].join("\n");

/** Not a prompt at all. The overwhelmingly common screen this code runs against. */
const BUILD_LOG = "Compiling sparkle v0.61.0\n   Finished in 12.4s\n$ ";

/** Everything the concierge was handed this case, in order. */
let notified: string[] = [];

/** THE SIDE EFFECT UNDER TEST — what the grace window was told, which is what decides whether the
 *  founder sees this row. `escalated` holds it back; `declined` puts it in front of him at once. */
const reported = (agentId: string): PromptAnswerOutcome | undefined =>
  windowPromptGraceLedger().outcome.get(agentId)?.outcome;

/** Register a concierge that ACCEPTS everything — the normal state when a window is open. */
function conciergeListening(): void {
  setConciergeNotifier((text) => {
    notified.push(text);
    return true;
  });
}

beforeEach(() => {
  resetPromptGraceLedgerForTests();
  resetConciergeHandoffForTests();
  _resetConciergeNotifierForTests();
  notified = [];
  writePty.mockReset();
  writePty.mockResolvedValue(undefined);
  aiFeatureVisibleNow.mockReturnValue(true);
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        rootPath: "/repo",
        agents: [{ id: "a1", name: "Watcher Pusher Enforcement" }],
      },
    ] as never,
  });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {} });
  // No `always` rule anywhere — the founder's actual configuration, and the one that produced three
  // of his four reports.
  useSettingsStore.setState({ approvals: {}, resumeRule: "ask", conciergeAnswers: true });
});

// ── THE HEADLINE: THE PROMPT GOES TO THE CONCIERGE, NOT TO THE HUMAN ────────────────────────────
describe("an unanswerable prompt is routed to the concierge instead of the founder", () => {
  // THE FOUNDER'S ORIGINAL REPORT, as a test. Before this change: nothing was notified and nothing
  // was even reported, so the row surfaced when the 30s ceiling lapsed.
  it("the four-option plan picker is handed over, and is NOT reported as declined", () => {
    conciergeListening();
    expect(maybeAutoApprove("a1", PLAN_PICKER, new Set())).toBeNull();

    expect(notified).toHaveLength(1);
    // `escalated` is what holds the row back from the needs-you band. `declined` is what would put
    // it in front of him — assert the distinction, not merely that something was recorded.
    expect(reported("a1")).toBe("escalated");
    expect(reported("a1")).not.toBe("declined");
    expect(writePty).not.toHaveBeenCalled(); // handed over ≠ pressed
  });

  it("…and the notice carries the QUESTION and every option, not just an alert", () => {
    conciergeListening();
    maybeAutoApprove("a1", PLAN_PICKER, new Set());

    const text = notified[0];
    expect(text).toContain("How many re-arms should the watcher allow");
    for (const opt of ["2, progress-gated", "3, progress-gated", "Unlimited, but logged", "one re-arm only"]) {
      expect(text).toContain(opt);
    }
    expect(text).toContain("Watcher Pusher Enforcement"); // it names the agent that is stopped
  });

  it("…and it tells the concierge to re-read the menu itself rather than press an index we parsed", () => {
    // THE FINGERPRINT GUARANTEE. Our parsed indices are context; `select_picker_option` refuses if
    // the menu moved underneath, and that protection only holds if the concierge takes the options
    // from the tool rather than from our prose.
    conciergeListening();
    maybeAutoApprove("a1", PLAN_PICKER, new Set());

    expect(notified[0]).toContain("read_picker_options");
    expect(notified[0]).toContain("select_picker_option");
  });

  // REPORTS 2, 3 AND 4 — the arm that produced three of the four. Fully classified, refused only
  // for want of a rule. This is the case a fix aimed solely at "unclassifiable" would have missed.
  it("a prompt the classifier READ but had no `always` rule for is also handed over", () => {
    conciergeListening();
    expect(maybeAutoApprove("a1", GH_PR_VIEW_PROMPT, new Set())).toBeNull();

    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("gh pr view 1777");
    expect(reported("a1")).toBe("escalated");
    expect(writePty).not.toHaveBeenCalled();
  });

  // The de-dupe. An unanswered prompt stays on screen, so the Watcher re-decides it every few
  // seconds; without this the concierge is re-notified for minutes.
  it("the same picker is offered ONCE, but stays held on every re-read", () => {
    conciergeListening();
    maybeAutoApprove("a1", PLAN_PICKER, new Set());
    maybeAutoApprove("a1", PLAN_PICKER, new Set());
    maybeAutoApprove("a1", PLAN_PICKER, new Set());

    expect(notified).toHaveLength(1);
    // Re-reported deliberately: the hold is compared against the CURRENT episode's start, so an
    // outcome recorded only on the first sighting would predate a redraw and the hold would lapse.
    expect(reported("a1")).toBe("escalated");
  });
});

// ── THE SAFETY PROPERTIES THAT MUST SURVIVE THE ROUTING ─────────────────────────────────────────
describe("what is still refused, and still reaches the founder", () => {
  // THE SECOND GOAL TEST. Routing to the concierge must not become a way to press a button whose
  // question nobody could read — the same property `select_picker_option` enforces with its
  // empty-fingerprint refusal. It has to hold at BOTH ends or it holds at neither.
  it("a menu whose QUESTION could not be read is refused, not handed on and not pressed", () => {
    conciergeListening();
    expect(maybeAutoApprove("a1", UNREADABLE_PICKER, new Set())).toBeNull();

    expect(notified).toHaveLength(0); // nobody was asked to answer an unreadable ask...
    expect(writePty).not.toHaveBeenCalled(); // ...and nothing was pressed
  });

  it("a denied MCP tool is never handed on, even with a concierge listening and `mcp = always`", () => {
    conciergeListening();
    useSettingsStore.setState({ approvals: { mcp: "always" } });

    expect(maybeAutoApprove("a1", DENIED_TOOL_PROMPT, new Set())).toBeNull();
    expect(notified).toHaveLength(0);
    expect(reported("a1")).toBe("declined"); // straight to the founder, as before
    expect(writePty).not.toHaveBeenCalled();
  });

  it("a SPEND decision stays the founder's, however readable it is", () => {
    conciergeListening();
    expect(maybeAutoApprove("a1", SPEND_PROMPT, new Set())).toBeNull();

    expect(notified).toHaveLength(0); // the concierge is never asked to spend his money
    expect(writePty).not.toHaveBeenCalled();
    // AND NOTHING IS REPORTED, which is the correct outcome rather than a gap. This screen has no
    // Yes/No pair, so it takes the `!classification` arm — the one arm that must stay silent,
    // because it also runs against every build log and idle shell, and stamping an outcome there
    // would end the hold for whatever prompt the agent draws NEXT. So a founder-only prompt that is
    // also unclassifiable surfaces on the ordinary 30s ceiling, exactly as it does today. What must
    // never happen is the ESCALATED hold, which would keep it from him for four minutes.
    expect(reported("a1")).not.toBe("escalated");
    expect(reported("a1")).toBeUndefined();
  });

  it("an ordinary build log is not a prompt: nobody is notified and nothing is reported", () => {
    conciergeListening();
    expect(maybeAutoApprove("a1", BUILD_LOG, new Set())).toBeNull();

    expect(notified).toHaveLength(0);
    // Reporting here would stamp an outcome on every idle screen, ending the hold for whatever
    // prompt the agent draws NEXT — the feature switched off while looking wired up.
    expect(reported("a1")).toBeUndefined();
  });
});

// ── THE SWITCH, AND THE HONEST FAILURE ──────────────────────────────────────────────────────────
describe("the switch and the undelivered push", () => {
  it("`concierge_answers = false` restores today's behaviour exactly", () => {
    conciergeListening();
    useSettingsStore.setState({ conciergeAnswers: false });

    expect(maybeAutoApprove("a1", PLAN_PICKER, new Set())).toBeNull();
    expect(notified).toHaveLength(0);
  });

  // THE POINT OF `notifyConcierge` RETURNING A BOOLEAN. No window open, host unmounted, scheduler
  // disposed or refusing at its ceiling — all mean this prompt has no answerer but the founder.
  // Treating an unaccepted push as an escalation would hide it for the full ceiling on the strength
  // of a message that went nowhere.
  it("a concierge that REFUSES the push does not hide the prompt", () => {
    setConciergeNotifier(() => false);

    expect(maybeAutoApprove("a1", GH_PR_VIEW_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
    expect(reported("a1")).not.toBe("escalated");
  });

  it("no concierge registered at all falls back to declining, unchanged", () => {
    // Nothing registered in this case — the satellite-window / no-host state.
    expect(maybeAutoApprove("a1", GH_PR_VIEW_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });

  // The master toggle governs the BLIND press; it does not govern a reasoning agent reading the
  // question first. The founder chose this split explicitly.
  it("auto-approve switched off still lets the concierge be asked", () => {
    conciergeListening();
    aiFeatureVisibleNow.mockReturnValue(false);

    expect(maybeAutoApprove("a1", GH_PR_VIEW_PROMPT, new Set())).toBeNull();
    expect(notified).toHaveLength(1);
    expect(reported("a1")).toBe("escalated");
  });
});
