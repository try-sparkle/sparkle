// The pill a PULL REQUEST NUMBER draws as, and the click that opens it on GitHub. The founder's
// complaint, recorded verbatim in `actionReceiptLine.ts`'s header and answered here: "You said it's
// up. But I can't actually click on it." (bead `sparkle-e9ziie`.)
//
// The fourth sibling of `AgentPill` / `BeadPill` / `ResearchPill`, built to the same three rules so
// every kind of reference reads as ONE vocabulary in a sentence:
//
//   1. IT RE-READS LIVE STATE ON EVERY RENDER. Never a snapshot. Which repository a bare `#2164`
//      belongs to is a fact about the reader's selected project, and it changes when they switch.
//   2. EVERY CLICK PRODUCES A VISIBLE RESULT. A reference that cannot do anything is not a control;
//      it is prose, and it renders as prose. `AgentPill.deadEnd.test.tsx` exists to forbid the
//      alternative and this component is held to it — an unresolvable number is plain text, never a
//      button that opens nothing.
//   3. INLINE ELEMENTS ONLY. This renders inside `<Markdown>`, i.e. inside a `<p>`, where a `<div>`
//      is invalid nesting the browser silently reparents.
//
// ══ WHY IT LOOKS LIKE THE HEADER CHICLET AND NOT LIKE ITS THREE SIBLINGS ═══════════════════════
// The other three take `MENTION_PILL_FILL`'s teal wash, because what they open lives INSIDE Sparkle
// and the wash is the app's own mention vocabulary. A PR is the one referent that leaves the app, and
// the founder named the shape he wanted for it by pointing at something already on screen: the PR
// chiclet in the concierge column header, one violet-edged box per pull request. So this spreads the
// SAME `pillStyle` helper that chiclet spreads, rather than re-typing its geometry — see
// `pillStyle.ts`'s own header for why two hand-copied literals is how the two drift.
//
// ══ WHY THE SLUG IS NOT A CONTEXT (UNLIKE AgentPill AND BeadPill) ══════════════════════════════
// Those two travel their live roster by CONTEXT to avoid defeating `<Markdown>`'s `memo` (which is
// keyed on `text` alone). A zustand hook does not go through props or context, so it defeats nothing
// — `ResearchPill` reads its store directly for exactly this reason. The repo slug is a module-level
// cache (`conciergeTools/repoSlug`) plus the project store, and neither is a prop.
import { useEffect, useState, type CSSProperties } from "react";

import { C } from "../../theme/colors";
import { pillStyle } from "./pillStyle";
import { prRefLabel, prWebUrl } from "./prRefs";
import { primeRepoSlug, slugForRoot } from "../../services/conciergeTools/repoSlug";
import { launch } from "../../services/sparkleApi";
import { useProjectStore } from "../../stores/projectStore";

/** How often, and how many times, an UNRESOLVED slug re-asks the cache after priming it.
 *
 *  `slugForRoot` is a synchronous read of a module-level `Map` — deliberately, because the tool
 *  policy that first needed it is synchronous — so nothing NOTIFIES a component when a prime lands.
 *  App hydration primes every project root, so the cache is warm long before a human is reading a
 *  thread and this loop almost never runs. It exists for the cold case (a project added this
 *  session, a first paint that beat hydration), where the alternative is a number that stays prose
 *  for the rest of the session because the one render that could have shown a pill happened 40ms too
 *  early. Bounded, so a root with genuinely no GitHub remote costs a few timers and then stops. */
const SLUG_RETRY_MS = 300;
const SLUG_RETRY_LIMIT = 10;

/** The label span. `whiteSpace: nowrap` because a pill broken across two lines stops reading as one
 *  object; `verticalAlign: baseline` so a 19px box sits on the text's baseline rather than riding
 *  above it. Neither is part of `pillStyle`'s box contract — see its docstring for what may not be
 *  overridden, and note that nothing here restates height, padding, radius, border or type. */
const inlineSeat: CSSProperties = {
  verticalAlign: "baseline",
  whiteSpace: "nowrap",
};

/**
 * One pull-request reference.
 *
 * `slug` is `owner/repo` when the WRITER knew it — the app-written path, where `mergePrTool` reported
 * the very url it merged, so there is nothing to infer. It is null when the reference was recovered
 * from prose by `remarkPrRefs`, and then the repository is resolved HERE, live, against the project
 * the reader currently has selected. See `prRefs.ts`'s header for why that split exists.
 */
export function PrPill({ number, slug: written }: { number: number; slug: string | null }) {
  // RE-READ EVERY RENDER — rule 1. Selecting the ROOT rather than the project object keeps the
  // subscription to a string, so switching between two projects in the same repo repaints nothing.
  const root = useProjectStore((s) =>
    s.selectedProjectId === null
      ? null
      : (s.projects.find((p) => p.id === s.selectedProjectId)?.rootPath ?? null),
  );
  const [, bump] = useState(0);
  const resolved = written ?? (root ? slugForRoot(root) : null);

  useEffect(() => {
    // Nothing to wait for: the writer told us, or there is no project to ask, or it is already known.
    if (written !== null || root === null || root === "" || slugForRoot(root) !== null) return;
    primeRepoSlug(root);
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (slugForRoot(root) !== null) {
        clearInterval(timer);
        bump((n) => n + 1);
        return;
      }
      if (tries >= SLUG_RETRY_LIMIT) clearInterval(timer);
    }, SLUG_RETRY_MS);
    return () => clearInterval(timer);
  }, [written, root]);

  const label = prRefLabel(number);

  // ── IT DOES NOT RESOLVE TO A REPOSITORY ───────────────────────────────────────────────────────
  // Plain text, no wrapper — rule 2. A project with no GitHub remote, a cold cache, or no project
  // selected at all all fall here: there is nothing to open, so the reference is the prose it was.
  if (resolved === null) return <>{label}</>;

  const url = prWebUrl(resolved, number);
  return (
    <button
      type="button"
      data-testid="concierge-pr-pill"
      data-pr-number={number}
      data-pr-slug={resolved}
      // THE DESTINATION IS NAMED BEFORE IT IS OPENED. An UNQUALIFIED reference is resolved against
      // the SELECTED project, so a number written about one repository while another is selected
      // would open the wrong page — the one failure mode this feature can have. Saying where the
      // click lands turns that from a surprise into something the reader can see first.
      title={`${resolved}#${number} — open on GitHub`}
      aria-label={`Pull request ${number} in ${resolved} — open on GitHub`}
      onClick={() => void launch(url)}
      style={{
        // THE BOX IS THE HELPER'S, NOT OURS — the same chiclet the concierge column header draws.
        ...pillStyle(C.violet),
        // Colour says state, which `pillStyle`'s docstring explicitly permits. `violetInk`, not the
        // brand literal: this is 10px bold text and the fill tier does not clear AA on the light
        // column — the same ink/stroke split `OpenPrMenu` makes for the chip and the row button.
        color: C.violetInk,
        ...inlineSeat,
      }}
    >
      {label}
    </button>
  );
}
