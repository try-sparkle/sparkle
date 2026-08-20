// The page `reply-quote-shot.mjs` photographs and measures: HIS QUESTION, QUOTED ONCE.
//
// The founder sent a screenshot on 2026-08-17 (bead sparkle-y3ptuf) of one question quoted back at
// him twice — the app's own gray `ReplyAnchorStubs` line, and directly under it the concierge's own
// markdown blockquote with the blue rule and the copy glyph. *"I want it to be the blue bar that has
// the copy next to it."*
//
// ── WHY A BROWSER, GIVEN THERE IS ALREADY A UNIT SUITE ─────────────────────────────────────────
// `Concierge/ConciergeThread.quoteOnce.test.tsx` pins the STRUCTURE — one blockquote, no stub, the
// jump on the right element — and that is the guard. What it cannot do is answer the question he
// actually asked, which is about paint: the bar's colour is `C.tealInk`, i.e. `var(--c-teal-ink)`,
// and jsdom loads no stylesheet, so a custom property there resolves to nothing at all. "Is it the
// blue one" is unanswerable in the unit suite by construction, in exactly the way the neighbouring
// `quote-surface-harness` documents for floats.
//
// So this reads the RENDERED colour and photographs the result, in both themes, and it renders the
// real `ConciergeThread` rather than a reconstruction of its markup — the suppression decision lives
// in `ConciergeMessageRow`, so a harness that rebuilt the row by hand would be photographing a shape
// nothing ships.
//
// ── THE THREE CASES, AND WHY THE LAST TWO ARE HERE ─────────────────────────────────────────────
// A screenshot of the fixed case alone is a screenshot of a suppression that fires. The interesting
// failure of a suppression is that it fires too OFTEN, so the page also shows the reply that opens
// by quoting agent scrollback — where both bars are correct and must both be visible — and a burst
// quoted in full, which is where the merge folds three quotes into one bar.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Same note as its siblings.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ConciergeThread } from "../../src/components/Concierge/ConciergeThread";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

const HIS_QUESTION = "What did you find out about Epic versus tasks?";
const ANSWER =
  "The sweep came back. They're one system, not two — a plan **is** an epic bead, and the Plan board is just a rendering of `bd list`.";

const noop = () => {};

/**
 * THE REPORTED CASE. One question, one settled reply that opens by quoting it.
 *
 * `settled: true` because only a finished turn anchors anything (see replyAnchors.answeredByIndex),
 * and `receipt.target: "sparkle"` because only a message that reached the brain may be claimed as
 * answered. Both are load-bearing: without them there are no anchors, so there would be no stub to
 * suppress and the page would photograph a pass it did not earn.
 */
const FIXED = [
  { id: "you-1", kind: "you", text: HIS_QUESTION, receipt: { target: "sparkle" } },
  {
    id: "brain-1",
    kind: "sparkle",
    settled: true,
    text: `> ${HIS_QUESTION}\n\n${ANSWER}`,
    answers: [{ id: "you-1", quote: HIS_QUESTION }],
  },
];

/** THE CASE THAT MUST STILL SHOW BOTH. The reply opens by quoting an agent's scrollback, which says
 *  nothing about what he asked — so his question keeps its gray stub and the scrollback keeps its
 *  blue bar. Two quotes, two different subjects, correctly two bars. */
const FOREIGN = [
  { id: "you-2", kind: "you", text: "why is CI red?", receipt: { target: "sparkle" } },
  {
    id: "brain-2",
    kind: "sparkle",
    settled: true,
    text: "> ok 47 passed | 2 failed\n\nCI is failing on a payment block, not on your tests.",
    answers: [{ id: "you-2", quote: "why is CI red?" }],
  },
];

/** A BURST, QUOTED IN FULL. Three sends, one reply, and `remarkMergeQuotes` folds the three opening
 *  quotes into a single bar — his own call, made twice. */
const BURST = [
  { id: "you-3", kind: "you", text: "check the retry logic", receipt: { target: "sparkle" } },
  { id: "you-4", kind: "you", text: "also the timeout", receipt: { target: "sparkle" } },
  { id: "you-5", kind: "you", text: "and is CI green", receipt: { target: "sparkle" } },
  {
    id: "brain-3",
    kind: "sparkle",
    settled: true,
    text:
      "> check the retry logic\n\n> also the timeout\n\n> and is CI green\n\nRetry is fine, the timeout was 3s, CI is green.",
    answers: [
      { id: "you-3", quote: "check the retry logic" },
      { id: "you-4", quote: "also the timeout" },
      { id: "you-5", quote: "and is CI green" },
    ],
  },
];

function Case({ id, label, messages }) {
  return (
    <section data-case={id} style={{ marginBottom: 26 }}>
      <div
        style={{
          font: "600 11px/1.4 ui-sans-serif, system-ui",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.45,
          color: "var(--c-cream)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <ConciergeThread messages={messages} onNudgeClick={noop} onNudgeAction={noop} />
    </section>
  );
}

function Harness() {
  return (
    <div
      id="page"
      style={{
        padding: 24,
        width: 520,
        background: "var(--c-concierge-surface)",
        color: "var(--c-cream)",
      }}
    >
      <Case id="fixed" label="His question — quoted once, blue bar + copy" messages={FIXED} />
      <Case id="foreign" label="Reply quotes AGENT OUTPUT — both bars, correctly" messages={FOREIGN} />
      <Case id="burst" label="Burst quoted in full — one merged blue bar" messages={BURST} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__replyQuoteHarnessReady = true;
  });
});
