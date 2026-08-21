// The page `notice-attribution-probe.mjs` photographs and measures. Mounts the REAL
// `ConciergeThread` so the fold grouping, the markdown rendering and the agent pills are the
// production ones — a hand-built stack of rows would prove nothing about what ships.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// sit silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ConciergeThread } from "../../src/components/Concierge/ConciergeThread";
import { AgentPillProvider } from "../../src/components/Concierge/AgentPill";

const params = new URLSearchParams(location.search);
const WIDTH = Number(params.get("w") ?? 420);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

// ⚠ `band` IS A StatusBand — one of `needs_you` | `questions` | `running` | `done`. NOT a status.
// `bandColor` looks the value up in STATUS_BANDS and falls back to STATUS_BANDS[0] (`needs_you`,
// which paints RED) for anything it does not recognise — silently. Two of these said "working",
// which is an AgentTabStatus rather than a band, so this fixture had been photographing red dots
// while describing them as working agents. `running` is the band whose dot is GREEN, and green on a
// live agent is precisely the state bead sparkle-s6gonk is about.
const ROSTER = [
  { id: "a1", name: "Agents Header", projectId: "p1", projectName: "sparkle", band: "running", canAcceptInput: true },
  { id: "a2", name: "Retry Backoff", projectId: "p1", projectName: "sparkle", band: "running", canAcceptInput: true },
  { id: "a3", name: "OG Images", projectId: "p1", projectName: "sparkle", band: "done", canAcceptInput: true },
];

/** The verbatim relay-gate paragraph. Kept whole on purpose: it is the exact text the founder was
 *  reading as the concierge speaking to him, and the point of the change is that it stays fully
 *  legible while ceasing to look like prose aimed at him. */
const RELAY_REASON =
  "that text carries the founder's own words, and he did not name this agent. His message went to you, not to the fleet — forwarding it makes his private words look like an instruction he addressed to an agent.";

const MESSAGES = [
  // 1. THE CONTROL — an ordinary concierge reply. Full-weight, no header. Everything else in this
  //    column is being compared against this line.
  {
    id: "reply-1",
    kind: "sparkle",
    // NAMES A PILL, and that is load-bearing rather than flavour (bead sparkle-s6gonk). The pill's
    // label rule is a COMPARISON — "does a pill inside a de-emphasised row read the same as one in
    // ordinary prose" — and a comparison needs both sides MOUNTED. With a pill only in the notice
    // row the probe could read its colour and have nothing to call it right or wrong against.
    text: "I've started [@Agents Header](sparkle-agent:a1) on the retry work, and I'll bring back whichever finishes first.",
    settled: true,
  },
  // 2. A CONCIERGE-ADDRESSED REFUSAL — the class from the report. Grey + attributed, words intact.
  {
    id: "refusal-1",
    kind: "sparkle",
    text: `Refused the concierge's message to [@Agents Header](sparkle-agent:a1) — ${RELAY_REASON}`,
    actionReceipt: { kind: "sent", ok: false, reason: RELAY_REASON },
  },
  // 3. A RUN OF SUCCESS RECEIPTS — folds to one expandable line. Two members is the minimum that
  //    folds (MIN_RUN), and a fold of two still shows both pills inline, so nothing is hidden.
  {
    id: "ok-1",
    kind: "sparkle",
    text: "The concierge wrote to [@Retry Backoff](sparkle-agent:a2).",
    actionReceipt: { kind: "sent", ok: true, channel: "terminal", subjectId: "a2", subjectName: "Retry Backoff" },
  },
  {
    id: "ok-2",
    kind: "sparkle",
    text: "The concierge wrote to [@OG Images](sparkle-agent:a3).",
    actionReceipt: { kind: "sent", ok: true, channel: "terminal", subjectId: "a3", subjectName: "OG Images" },
  },
  // 4. AN APP-AUTHORED LINE ADDRESSED TO THE FOUNDER — same author as (2), opposite recipient.
  //    This is the row a sender-based split would have wrongly greyed, and it must stay full weight.
  {
    id: "founder-1",
    kind: "sparkle",
    text: "That message had more asks than I file at once, so 2 of them didn't make the list — say them again and I'll pick them up.",
  },
];

createRoot(document.getElementById("root")).render(
  <div
    id="column"
    // Models the concierge column: its own surface, its own inherited ink. Both matter — the ink is
    // the thing under test, and `ConciergeColumn` is where the COMPUTED colour a notice row has to
    // override actually comes from.
    style={{
      width: WIDTH,
      background: "var(--c-concierge-surface)",
      color: "var(--c-cream)",
      fontFamily: "var(--f-ui)",
      fontSize: 13,
      lineHeight: 1.5,
      padding: "12px 0",
      minHeight: 400,
    }}
  >
    <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: () => {} }}>
      <ConciergeThread
        messages={MESSAGES}
        copyOnSelection={false}
        onNudgeClick={() => {}}
        onNudgeAction={() => {}}
        onDigestClick={() => {}}
      />
    </AgentPillProvider>
  </div>,
);

// The probe waits on this rather than on a timeout: a fixed sleep is how a probe silently
// photographs a half-mounted tree and reports the blank as a finding.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__noticeHarnessReady = true;
  });
});
