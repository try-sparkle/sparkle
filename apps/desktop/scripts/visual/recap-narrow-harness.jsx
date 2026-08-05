// The page `recap-narrow-probe.mjs` measures. Mounts the REAL `RecapCard` at a real width, with the
// app's own stylesheet, in a real browser — the only place `text-overflow`, `flex-wrap` and an
// element's actual right edge exist at all (jsdom has none of them).
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { RecapCard } from "../../src/components/Concierge/RecapCard";
import { AgentPill, AgentPillProvider } from "../../src/components/Concierge/AgentPill";

const params = new URLSearchParams(location.search);
/** The concierge column width to model. The probe drives this; 280 is the default it uses. */
const WIDTH = Number(params.get("w") ?? 280);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/** Long enough that the pill ALONE overruns a narrow column — the case the founder saw clipped. */
const LONG_NAME = "Concierge Says What It Is Doing";

const ROSTER = [
  { id: "a", name: LONG_NAME, projectId: "p1", projectName: "sparkle", band: "needs_you", canAcceptInput: true },
  { id: "b", name: "OG Images", projectId: "p2", projectName: "drodio-website", band: "done", canAcceptInput: true },
];

const RECAP = {
  id: "recap-1",
  kind: "recap",
  awayMs: 12 * 60_000,
  needsYou: [
    {
      agentId: "a",
      agentName: LONG_NAME,
      projectName: "sparkle",
      status: "waiting",
      // The exact label that stacked one word per line before the reflow.
      statusLabel: "Done — your turn",
    },
  ],
  finished: [
    {
      agentId: "b",
      agentName: "OG Images",
      projectName: "drodio-website",
      status: "done",
      statusLabel: "Done",
    },
  ],
  decisions: [
    {
      id: "d1",
      kind: "queued",
      agentName: LONG_NAME,
      agentId: "a",
      summary: "Delete the staging database",
      at: 1,
    },
  ],
};

/** Records clicks so the probe can prove a truncated pill is still an activatable control. */
window.__recapClicks = [];

/**
 * Every baseline-control paragraph, so none of them can drift apart from the others — the
 * comparison is only meaningful if they are typeset identically.
 *
 * A FIXED WIDE WIDTH, NOT THE COLUMN WIDTH UNDER TEST, and this is a measurement correction rather
 * than a convenience. Where a pill sits on its sentence's baseline is a property of the pill's box;
 * it does not depend on how wide the paragraph is. But a paragraph narrow enough to WRAP puts the
 * reference word and the pill on DIFFERENT LINES, and the probe then reports the line-height
 * between them — a 17-18px "baseline shift" that is nothing of the kind. That is not hypothetical:
 * these paragraphs were first written at the column width and every one of them failed at 200px and
 * below for exactly that reason, on code whose baselines are all Δ0.00 when they share a line.
 *
 * 600 is wide enough that the longest control ("Reference @Ghost Of A Closed Agent tail") stays on
 * one line at every width the probe sweeps. The CARD is still rendered at the width under test —
 * that is the thing being measured, and it is in `#column`, not here.
 */
const PROSE = { width: "600px", fontSize: 13, color: "var(--c-cream)" };

function Harness() {
  return (
    <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: () => "revealed" }}>
      {/* The concierge column's content box, at the width under test. `overflow: visible` is
          deliberate — a scroll container would HIDE the very overflow this page exists to catch. */}
      <div
        id="column"
        style={{
          width: `${WIDTH}px`,
          display: "flex",
          flexDirection: "column",
          fontSize: 13,
          background: "var(--c-concierge-surface)",
        }}
      >
        <RecapCard recap={RECAP} onRevealAgent={(id) => window.__recapClicks.push(id)} />
      </div>

      {/* ── THE BASELINE CONTROL ──────────────────────────────────────────────────────────────────
          A pill inside ordinary prose, beside a reference word in the same line box. This is where
          the `overflow`-on-the-outer-box trap would show itself: an inline-level box whose overflow
          is not `visible` takes its BOTTOM MARGIN EDGE as its baseline, which lifts the pill's text
          off the sentence's baseline. The probe compares the two text runs' boxes directly. */}
      {/* Moved off the column width onto the shared `PROSE` box — see the note there. It read as a
          per-width canary, but the property it measures is width-independent, and at 200px and
          below the paragraph wrapped and the check started reporting a line-height as a baseline
          shift. */}
      <p id="prose" style={PROSE}>
        <span id="prose-ref">Reference</span>{" "}
        <AgentPill agentId="b" fallbackName="@OG Images" />{" "}
        <span id="prose-tail">tail</span>
      </p>

      {/* ── THE DOT-LESS FORMS, WHICH ARE THE ONES THE BASELINE RULE ACTUALLY BITES ───────────────
          The paragraph above measures the LIVE pill, and the live pill's first flex item is the 6px
          status dot — which donates the container's baseline and therefore SHIELDS it from
          everything the name span does. That is why "adding overflow:hidden moved nothing" was true
          and still not evidence of safety (roborev 58698/58699).

          These three forms have NO dot, so the name span IS the first flex item: if it is made a
          scroll container (`overflow: hidden`), the pill's baseline is synthesised from that span's
          border box instead of its text, and the pill drops relative to the sentence it sits in.
          Each one gets its own reference word in the same line box so the probe can compare the two
          text runs directly.

          Every one is reachable in production: `-unwired` is what SupportModal and agent replies
          render (no provider at all), and both `-closed` forms are what a wired surface draws for an
          id its roster no longer holds. */}
      <p id="prose-closed-inert" style={PROSE} data-dotless="closed-inert">
        <span className="prose-ref">Reference</span>{" "}
        <AgentPill agentId="no-such-agent" fallbackName="@Ghost Of A Closed Agent" />{" "}
        <span>tail</span>
      </p>

      <AgentPillProvider
        value={{ agents: [], onOpenAgent: () => "gone", onSeeHistory: () => {} }}
      >
        <p id="prose-closed-button" style={PROSE} data-dotless="closed-button">
          <span className="prose-ref">Reference</span>{" "}
          <AgentPill agentId="no-such-agent" fallbackName="@Ghost Of A Closed Agent" />{" "}
          <span>tail</span>
        </p>
      </AgentPillProvider>

      {/* NO opener AND NO ROSTER — which together are exactly what SupportModal and agent replies
          hand a pill: they render `<Markdown>` with no provider at all, so it gets the module's
          `EMPTY` default. An unwired pill DOES draw a dot when its id resolves, so the dot-less
          unwired form is precisely this one: unwired and unresolved. */}
      <AgentPillProvider value={{ agents: [] }}>
        <p id="prose-unwired" style={PROSE} data-dotless="unwired">
          <span className="prose-ref">Reference</span>{" "}
          <AgentPill agentId="b" fallbackName="@OG Images" />{" "}
          <span>tail</span>
        </p>
      </AgentPillProvider>

      {/* THE FOURTH DOT-LESS FORM, and the only one that needs an interaction to reach: a pill whose
          id RESOLVES but whose reveal came back "gone". `showClosed` then suppresses the dot while
          keeping the button, so the name span becomes the first flex item on a pill that was dotted
          a moment earlier. The probe clicks this one and re-measures. */}
      <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: () => "gone" }}>
        <p id="prose-showclosed" style={PROSE} data-dotless="showclosed">
          <span className="prose-ref">Reference</span>{" "}
          <AgentPill agentId="b" fallbackName="@OG Images" />{" "}
          <span>tail</span>
        </p>
      </AgentPillProvider>
    </AgentPillProvider>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
// Nothing here is async, but the probe waits on this rather than on a selector so it cannot read a
// half-committed tree.
requestAnimationFrame(() => requestAnimationFrame(() => (window.__recapHarnessReady = true)));
