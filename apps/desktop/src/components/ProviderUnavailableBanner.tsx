// ProviderUnavailableBanner — names WHY AI enhancement is unavailable, so a total outage is never
// silent again.
//
// It reads aiProviderStore, which since the Claude Code migration holds reasons about the USER'S own
// CLI (missing, not signed in, at its usage limit) rather than Sparkle's retired vendor account. The
// consequence for copy is the whole point: every reason now has an action attached, where the old
// ones could only say "this is ours to fix". See the WARNING map below.
import { useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_UI } from "../theme/scale";
import {
  isOutageActive,
  useAiProviderStore,
  type AiProviderOutageReason,
} from "../stores/aiProviderStore";
import { currentUsageLimit, USAGE_LIMIT_RECHECK_MS } from "../engine/usageLimit";
import { getUsage, type Usage } from "../services/accountStore";

/** The full-width bar's hook, so a real-layout test can measure the element the user sees. */
export const PROVIDER_UNAVAILABLE_BAR_TESTID = "provider-unavailable-bar";

/**
 * The sentence for each reason.
 *
 * REWRITTEN with the transport. These used to say "this is ours to fix" and told the user to do
 * nothing, because the cause was Sparkle's own unfunded vendor account. AI enhancement now runs on
 * the USER'S Claude Code subscription, so every remaining cause is one they CAN fix — and the copy
 * has to say how. Each line names the cause and the next action, and none of them mentions Sparkle
 * credits, which are no longer involved in these features at all.
 *
 * Deliberately NOT dismissible, unlike ZeroCreditBanner. It clears itself the moment any AI call
 * succeeds (aiProviderStore.noteHealthy), so a ✕ would only re-hide the kind of outage that went
 * unnoticed for 12 hours in the first place.
 */
const WARNING: Record<AiProviderOutageReason, string> = {
  cli_missing:
    "Sparkle's AI features need the Claude Code CLI, and it isn't installed. Install it and they'll turn back on",
  cli_not_authenticated:
    "Claude Code isn't signed in, so Sparkle's AI features are paused. Run `claude` in a terminal and sign in",
  usage_limit:
    "Your Claude usage limit has been reached, so Sparkle's AI features are paused. They'll resume when it resets",
};

/**
 * The usage-limit sentence, which is built rather than looked up because it NAMES THE RESET TIME.
 *
 * "They'll resume when it resets" is unfalsifiable: a reader cannot tell a live claim from a stuck
 * one, which is exactly how the stale banner survived unnoticed (bead drodio-website-229f.4). A
 * real clock time makes the banner checkable at a glance.
 *
 * It also says AGENTS KEEP RUNNING. The founder read "Sparkle's AI features are paused" while his
 * fleet was visibly working and concluded the banner was broken. He was right that it was stale,
 * but the confusion is independent and worth closing: agent turns run on the Claude Code CLI, and
 * the paused features are Sparkle's own (suggestions, summaries).
 */
export function usageLimitSentence(until: number): string {
  const at = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    `Your Claude usage limit has been reached, so Sparkle's AI features are paused until ${at}. ` +
    `Your agents keep running`
  );
}

// Brand amber is the caution fill and is theme-CONSTANT, so it needs an ink legible on it in both
// themes — the constant brand navy, not the themed `C.cream`. Matches ZeroCreditBanner exactly.
const INK = ON_BRAND_FILL_DARK;

/**
 * ── BANNER_BAR_TOP_ANCHOR — why these bars align to `flex-start`, not `center` ────────────────
 *
 * Reported as bead sparkle-kk9dg.2: the usage-limit banner showed only the MIDDLE of its own
 * sentence — "…been reached, so Sparkle's AI features are paused." — with the SUBJECT ("Your
 * Claude usage limit has") and the tail both gone. A banner that hides the subject of its own
 * sentence is worse than no banner, because the reader cannot tell WHAT limit was reached.
 *
 * HONESTY FIRST: the exact mechanism was NOT reproduced. Measured in real Chrome (see
 * BannerStack.layout.test.ts) at 900/700/560/460/380/300/220 CSS px wide against a 600px viewport,
 * with three bars stacked, this bar never clips: every in-flow child's rect stays inside the bar's
 * padding box on all four edges, the first text line always sits at the bar's top, and the shell's
 * `flex: 0 0 auto` reading holds — the bar cannot be squashed by the column. So what follows is
 * HARDENING against the two shapes that can produce the reported fragment, not a fix for a
 * demonstrated one.
 *
 * That evidence is stated as RECTS on purpose. An earlier version of this paragraph cited
 * `scrollHeight === clientHeight`, which cannot support it: the CSS overflow spec excludes
 * *unreachable* overflow — anything past the block-start or inline-start edge — from the scrollable
 * region, so those metrics read 0 for exactly the upward clipping the bead reported. Citing them
 * as proof of no upward clip was the same class of mistake as a vacuous test. (roborev 58696)
 *
 * WHAT `center` COSTS, on both axes, and why `flex-start` is strictly safer:
 *
 *   • VERTICALLY. `align-items: center` is the ONLY thing that can place content ABOVE this box's
 *     top edge: a flex item centred in a box shorter than itself overflows EQUALLY at both ends,
 *     and the top half is then clipped by any ancestor that hides overflow (`body` does). Anchored
 *     to `flex-start` the first line's top is fixed at the padding edge and is independent of the
 *     bar's height, so overflow can only ever go DOWN — the subject of the sentence becomes the one
 *     part that cannot go missing. Nothing centred vertically is gained: a single-line bar renders
 *     identically (the icon carries the 1px nudge that centring used to supply).
 *
 *   • HORIZONTALLY. `justify-content: center` is kept — a centred bar is the design — but it has
 *     the same both-ends property, so a sentence wider than the bar loses its head AND its tail and
 *     leaves exactly the middle. That is measurable here: at 100px the sibling bar already reports
 *     `scrollWidth > clientWidth`, and by 60px the sentence's left edge is off the box. The cause is
 *     a flex item's default `min-width: auto` (= min-content), which stops the span shrinking and
 *     makes it overflow instead of wrap. {@link sentence} removes that floor and lets a long word
 *     break, so the copy WRAPS — taller, always whole — instead of spilling off both edges.
 *
 * Duplicated verbatim in ZeroCreditBanner and AiServiceBanner rather than shared, because those two
 * carry extra furniture (a Refill link, an out-of-flow ✕) and the three `bar` objects have always
 * been read side by side. They share the shape, so a fix that left them centred would be half a fix.
 */
const sentence: CSSProperties = {
  // Overrides a flex item's `min-width: auto` floor — see BANNER_BAR_TOP_ANCHOR.
  minWidth: 0,
  overflowWrap: "break-word",
};

const bar: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  // TOP-ANCHORED, not centred — see BANNER_BAR_TOP_ANCHOR.
  alignItems: "flex-start",
  justifyContent: "center",
  gap: 8,
  background: C.amber,
  color: INK,
  // Symmetric, and narrower than ZeroCreditBanner's because there is no out-of-flow ✕ to reserve a
  // lane for (see the non-dismissible note above).
  padding: "6px 16px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
  letterSpacing: 0.2,
};

const inlineStrip: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  color: C.amber,
  fontSize: 12,
  margin: 0,
  maxWidth: 420,
};

/**
 * @param inline Render the compact Settings → Credits variant instead of the full-width top bar.
 *               It belongs on that pane for the same reason ZeroCreditBanner's inline variant does:
 *               someone staring at a healthy balance while every AI feature is dark needs to be told
 *               their balance is not the reason.
 */
export function ProviderUnavailableBanner({ inline = false }: { inline?: boolean } = {}) {
  const outage = useAiProviderStore((s) => s.outage);
  // Re-evaluate periodically so an EXPIRING observation retires on its own. Without this the banner
  // would keep asserting a stale outage until some unrelated render happened to run — and since it
  // has no dismiss control by design, "until the next render" can mean "forever" on an idle screen.
  // A minute is far finer than the 10-minute expiry, so the retirement looks prompt without polling
  // hard. The interval is unconditional (not gated on `outage`) so the hook order never changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // LIVE ACCOUNT TRUTH for the usage-limit reason (bead drodio-website-229f.4).
  //
  // The store's `usage_limit` record is LATCHED when one of Sparkle's own AI calls sees the limit,
  // and its only clear path is a LATER Sparkle AI call SUCCEEDING. Agent turns run on the Claude
  // Code CLI and never travel that path, so a whole fleet can work for hours without retiring the
  // banner — the founder watched exactly that happen. The accounts' own `exhaustedUntil` flags are
  // the current state instead: they carry a real reset instant and lapse by the clock on their own.
  //
  // Only polled while a usage limit is actually being claimed, so a healthy machine pays nothing.
  // The OTHER two reasons are genuinely local to the CLI install (missing, signed out) and have no
  // account-level truth to consult, so they keep the observed-and-expiring behaviour unchanged.
  const claimsUsageLimit = outage?.reason === "usage_limit";
  const [usage, setUsage] = useState<Usage[] | null>(null);
  useEffect(() => {
    if (!claimsUsageLimit) {
      setUsage(null);
      return;
    }
    let alive = true;
    const check = () => {
      getUsage()
        .then((u) => {
          if (alive) setUsage(u);
        })
        // A failed read is NOT evidence the limit lifted, so leave the previous answer standing and
        // try again next tick. The store's own expiry still bounds how long a stale claim can last.
        .catch(() => {});
    };
    check();
    const id = window.setInterval(check, USAGE_LIMIT_RECHECK_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [claimsUsageLimit]);

  if (!isOutageActive(outage, now)) return null;

  // Derived state WINS over the latched observation once we have read the accounts. Before the
  // first read `usage` is null and the observed claim stands, so a real limit is never hidden by a
  // slow fetch.
  const live = claimsUsageLimit && usage !== null ? currentUsageLimit(usage, now) : null;
  if (claimsUsageLimit && usage !== null && live === null) return null;

  const warning = live ? usageLimitSentence(live.until) : WARNING[outage.reason];

  if (inline) {
    return (
      <p style={inlineStrip} role="status">
        <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} aria-hidden />
        <span>{warning}.</span>
      </p>
    );
  }

  return (
    <div style={bar} data-testid={PROVIDER_UNAVAILABLE_BAR_TESTID}>
      {/* `marginTop: 1` is the 1px the removed `align-items: center` used to supply on a
          single-line bar (14px glyph inside a ~16px line box), so top-anchoring costs no visible
          change at the common width — and on a WRAPPED bar the icon now stays beside the first
          line instead of floating to the vertical middle of the block. */}
      <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 1 }} aria-hidden />
      <span role="status" aria-live="polite" style={sentence}>
        {warning}.
      </span>
    </div>
  );
}
