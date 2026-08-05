#!/usr/bin/env node
// recap-narrow-probe — read the REAL GEOMETRY of the recap card at a narrow concierge width and say
// whether anything overflows.
//
//   pnpm --filter @sparkle/desktop visual:recap-narrow
//   pnpm --filter @sparkle/desktop visual:recap-narrow -- --json
//   pnpm --filter @sparkle/desktop visual:recap-narrow -- --widths=520,280,200
//
// (or `node scripts/visual/recap-narrow-probe.mjs` from apps/desktop). The package script exists
// because for its whole first life this file was reachable by NOTHING — no npm script beside its
// `visual:*` siblings, no entry in scripts/tests/run.sh, and no import of any of its exports, so
// the only way to run the one instrument that can see a real overflow was to already know its path
// (roborev 58700).
//
// ── WHY THIS EXISTS (bead sparkle-kk9dg.1) ──────────────────────────────────────────────────────
// The recap row shipped overflowing its own card and the unit suite stayed green, because **jsdom
// has no layout engine**: `getBoundingClientRect` returns zeros, `scrollWidth`/`clientWidth` are 0,
// and `text-overflow` / `flex-wrap` never evaluate. A jsdom test that claimed to observe the
// overflow would be measuring nothing — the vacuous shape this repo's #1 fleet-wide finding is
// about (docs/jsdom-test-caveats.md). The style-shape half is pinned in
// `src/components/Concierge/RecapCard.narrow.test.tsx`; THIS is the half that can actually fail on
// the geometry.
//
// It is a probe (like `seam-probe.mjs`) rather than a `.test.mjs`, deliberately: it needs Chrome on
// the machine and a vite dev server, neither of which the unit suite should depend on. Run it when
// you touch `RecapCard.tsx` or `AgentPill.tsx`. Exit 0 = every check passed; exit 1 = a real
// overflow; exit 2 = the probe could not run (no Chrome, no server).
//
// ── WHAT IT ASSERTS, AND WHICH HALF OF THE FOUNDER'S HYBRID EACH ONE IS ─────────────────────────
//   WIDE (520)        every change row is ONE line — the reflow must not fire when there is room.
//   NARROW (280)      no row's content passes the card's content edge; no row exceeds ~2.5 lines;
//                     the STATUS is a single line (it used to stack one word per line, ~150px tall).
//   VERY NARROW (200) still no overflow; the pill's name is genuinely TRUNCATED (its own
//                     scrollWidth exceeds its clientWidth, which only happens when the clip and the
//                     ellipsis are both really applied); and the truncated pill is still clickable.
//   EXTREME (135-50)  CONTAINMENT ONLY, and that limit is a decision rather than an omission — see
//                     `HYBRID_MIN_WIDTH`. The card must still not overflow or scroll at any width
//                     the column can actually be dragged to.
//   EVERY WIDTH       a pill in ordinary prose sits on the sentence's baseline — measured for the
//                     LIVE pill and, since roborev 58698/58699, for every DOT-LESS form too. This is
//                     the scroll-container baseline trap: a box whose `overflow` makes it a scroll
//                     container has its alignment baseline SYNTHESISED from its border box, and a
//                     flex container takes its first baseline from its first flex item — so a clip
//                     at the wrong level lifts every pill in every concierge reply off its own line.
//                     The live pill's first item is its 6px status dot, which shields it; the
//                     dot-less forms have no such shield, which is why they are measured separately.
//
// 280 is the primary narrow width because `CONCIERGE_DEFAULT_WIDTH` is 360 and `CONCIERGE_MIN_WIDTH`
// is 50 — it is a width a person would actually drag to, and it is comfortably past the ~390px the
// offending row needs, so the reflow is genuinely exercised.

import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer } from "./serve.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/**
 * 520 is comfortably wide, 280 the founder's plausible narrow, 200 the truncation end — and **360
 * is the app's own `CONCIERGE_DEFAULT_WIDTH`**, which is in this list because the row was ALREADY
 * overflowing there before this change. The bug was never only about a dragged-narrow column; a
 * default-width column needed ~390px for a row it was given 360 for. Dropping 360 from this list
 * would retire the one width every user sees.
 *
 * THE LIST NOW RUNS ALL THE WAY DOWN TO `CONCIERGE_MIN_WIDTH` (50), and that is the point of the
 * three extra entries (roborev 58700). It used to stop at 200, which left a **50-135px band the
 * column can genuinely be dragged to and nothing measured** — and that band was a REGRESSION, not
 * merely uncovered: the old row kept its status inside the card there by collapsing it to
 * min-content and word-stacking it, while the reflowed row's `flex: 0 0 auto` + `nowrap` status
 * pushed it straight past the card's right edge, into a card with `maxWidth: 100%` and no clipping
 * of its own. So the change traded a word-stack for the very overflow it exists to remove, in
 * exactly the band that was not being looked at.
 *
 * 135 is roughly where a ~105px status plus the card's 26px of padding stops fitting at all; 100
 * and 50 are past it, and 50 is the floor the resize engine enforces.
 */
export const DEFAULT_WIDTHS = [520, 360, 280, 200, 135, 100, 50];

/**
 * Turn the raw `--widths` value into a width list, or `null` when it is not one.
 *
 * A PURE HELPER RATHER THAN INLINE PARSING, so the CLI contract is assertable without booting Chrome
 * and a dev server — the shape roborev 58761 asked for, because the old test pinned a safety
 * property that the code did not actually have.
 *
 * `undefined` (flag absent) means "use the defaults" and is the only non-string input that is NOT an
 * error. Everything else must parse to at least one finite positive number: `--widths` bare arrives
 * as boolean `true`, and `520,,200` or a typo yields `NaN`/`0` — all of which used to sail through
 * into a silently wrong grading run. Returning `null` (rather than throwing or defaulting) keeps the
 * decision about what to DO with bad input at the call site.
 */
export function parseWidths(raw) {
  if (raw === undefined) return DEFAULT_WIDTHS;
  if (typeof raw !== "string") return null;
  const widths = raw.split(",").map((w) => Number(w.trim()));
  if (widths.length === 0) return null;
  if (widths.some((w) => !Number.isFinite(w) || w <= 0)) return null;
  return widths;
}

/**
 * Below this width the card is OUT OF CONTRACT for the founder's hybrid, and this constant is where
 * that is said out loud rather than left as a gap in the width list.
 *
 * WHAT STILL HOLDS AT EVERY WIDTH: containment. Nothing may pass the card's content edge and the
 * card may not scroll horizontally, down to `CONCIERGE_MIN_WIDTH`. That is the property a reader
 * can actually be hurt by — content painting over the thread, or a status escaping into the column.
 *
 * WHAT DOES NOT HOLD BELOW IT: the LINE BUDGET. The hybrid ("chip + pill on one line, status below
 * it, ≤2.5 line-heights") assumes the chip and the pill fit beside each other, and at a ~24-109px
 * content box they simply do not — the project chip alone is ~55px and is deliberately `flex: none`
 * because the founder settled that it stays at every width. So below this width the lead group is
 * allowed to break internally and a row may run to three or four lines. That is a legible row in a
 * column nobody reads prose in, which is the right trade; it is not the word-stack the reflow was
 * written to kill, because the status still moves as a unit.
 *
 * 200 rather than 135: 200 is the width the truncation half of the hybrid was designed against and
 * the narrowest one the unit test models, so the hybrid checks keep exactly the coverage they had.
 */
export const HYBRID_MIN_WIDTH = 200;

/**
 * The measurement, run INSIDE the page. Returned as plain data so the verdict is computed in node
 * where it can be read in a diff, rather than hidden in a browser-side boolean.
 *
 * Every number is CSS px from a live layout. `right` comparisons use the card's CONTENT box (its
 * padding box minus padding), because a child sitting on the padding is already outside the space
 * the card gives it.
 */
const MEASURE = `(() => {
  const px = (v) => parseFloat(v) || 0;
  const card = document.querySelector('[data-testid="concierge-recap"]');
  const cs = getComputedStyle(card);
  const cardRect = card.getBoundingClientRect();
  const contentRight = cardRect.right - px(cs.paddingRight) - px(cs.borderRightWidth);

  const lineHeightOf = (el) => {
    const s = getComputedStyle(el);
    const lh = s.lineHeight === 'normal' ? px(s.fontSize) * 1.4 : px(s.lineHeight);
    return lh || px(s.fontSize) * 1.4;
  };

  const rows = [...card.querySelectorAll('[data-testid="recap-change"],[data-testid="recap-decision"]')]
    .map((row) => {
      const rect = row.getBoundingClientRect();
      const lh = lineHeightOf(row);
      // The widest right edge among the row and everything in it. A clipped-but-still-laid-out
      // child is exactly what the old bug produced, so descendants are measured too.
      const overhang = [row, ...row.querySelectorAll('*')].reduce((worst, el) => {
        const r = el.getBoundingClientRect();
        return r.width === 0 && r.height === 0 ? worst : Math.max(worst, r.right - contentRight);
      }, -Infinity);
      const status = row.querySelector('[data-testid="recap-change-status"]');
      const lead = row.querySelector('[data-testid="recap-change-lead"]');
      const prose = row.querySelector('[data-testid="recap-decision-prose"]');
      // Are the lead group and the status on the SAME flex line? Compared by TOP edge with a
      // half-line tolerance: align-items:baseline leaves them at slightly different tops within one
      // line, while a wrap moves the status a whole line-height down.
      // NO BACKTICKS ANYWHERE IN THIS STRING — it is a template literal, and one in a comment ends
      // it mid-expression with a SyntaxError pointing at the next word.
      const sameLine =
        status && lead
          ? Math.abs(status.getBoundingClientRect().top - lead.getBoundingClientRect().top) < lh * 0.5
          : null;
      return {
        testid: row.getAttribute('data-testid'),
        text: row.textContent.slice(0, 60),
        height: rect.height,
        lineHeight: lh,
        lines: rect.height / lh,
        overhang,
        statusHeight: status ? status.getBoundingClientRect().height : null,
        statusLines: status ? status.getBoundingClientRect().height / lh : null,
        statusSameLine: sameLine,
        // A decision row is a SENTENCE, so it is allowed to be as tall as its own prose. What it is
        // not allowed to do is orphan the verb on a line of its own, which is what happens when the
        // prose's flex base size is its whole max-content width.
        proseHeight: prose ? prose.getBoundingClientRect().height : null,
      };
    });

  // Truncation is only observable as a clipped box: scrollWidth is the text's full width, and
  // clientWidth is what survives \`overflow: hidden\`. Equal means nothing was cut.
  const names = [...card.querySelectorAll('[data-testid="concierge-agent-pill-name"]')].map((n) => ({
    text: n.textContent,
    scrollWidth: n.scrollWidth,
    clientWidth: n.clientWidth,
    truncated: n.scrollWidth > n.clientWidth,
  }));

  // ── The baseline control. Compare the TEXT RUNS, not the boxes: a Range's rect is the text's own
  // line box, which is directly comparable between a bare span and the span inside a pill.
  const runRect = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const box = r.getBoundingClientRect();
    r.detach?.();
    return box;
  };
  const ref = document.getElementById('prose-ref');
  // The pill ELEMENT, not its inner name span: a range over the pill's contents has the same
  // bottom either way (the text run sits lower than the 6px dot), and selecting the element keeps
  // this measurement runnable against the PRE-CHANGE component, which has no inner span at all.
  // That is what makes the recorded offset below checkable rather than asserted.
  const prosePill = document.querySelector('#prose [data-testid="concierge-agent-pill"]');
  // NULL FIELDS RATHER THAN A THROW (roborev 58797), for the reason spelled out on CLICK_TRUNCATED:
  // an unguarded runRect on a renamed #prose-ref / concierge-agent-pill rejects the evaluate and
  // exits 2 as "no Chrome", hiding the very rename that broke it. verdictFor grades a null delta
  // as a failed check instead. (No backticks in here - this comment lives inside a template literal.)
  const baseline =
    ref && prosePill
      ? {
          refBottom: runRect(ref).bottom,
          pillBottom: runRect(prosePill).bottom,
          delta: Math.abs(runRect(ref).bottom - runRect(prosePill).bottom),
        }
      : {
          refBottom: null,
          pillBottom: null,
          delta: null,
          missing: !ref ? '#prose-ref' : '#prose [data-testid=concierge-agent-pill]',
        };

  // ── THE DOT-LESS FORMS, EACH AGAINST ITS OWN REFERENCE WORD ──────────────────────────────────
  // The control above measures the LIVE pill, whose first flex item is the 6px status dot — so it
  // reports on a pill that is SHIELDED from the scroll-container baseline rule no matter what the
  // name span does. These are the forms where the name span IS the first flex item.
  //
  // The 'hasDot' field is the vacuity guard: if one of these paragraphs ever starts drawing a dot (an
  // unwired pill does, the moment its id resolves), the control has quietly become a second copy of
  // the shielded case and would pass while proving nothing.
  const dotless = [...document.querySelectorAll('p[data-dotless]')].map((p) => {
    const pill = p.querySelector(
      '[data-testid="concierge-agent-pill"],[data-testid="concierge-agent-pill-closed"],[data-testid="concierge-agent-pill-unwired"]',
    );
    const pref = p.querySelector('.prose-ref');
    if (!pill || !pref) {
      return { form: p.dataset.dotless, testid: null, hasDot: null, delta: null };
    }
    const nameSpan = pill.querySelector('[data-testid="concierge-agent-pill-name"]');
    const refBottom = runRect(pref).bottom;
    const pillBottom = runRect(pill).bottom;
    return {
      form: p.dataset.dotless,
      testid: pill.getAttribute('data-testid'),
      // A dot is an empty aria-hidden span; the name span is the only other child. So "the pill's
      // first element child is the name span" is exactly "there is no dot".
      hasDot: pill.firstElementChild !== nameSpan,
      nameOverflow: nameSpan ? getComputedStyle(nameSpan).overflow : null,
      refBottom,
      pillBottom,
      delta: Math.abs(refBottom - pillBottom),
    };
  });

  // Everything in the card that reaches past its content edge, worst first — NOT just the rows.
  // "scrollWidth 143 <= clientWidth 133" says the card overflows and says nothing about WHAT, and
  // the row-level check next door is blind to the summary line and the section headings, which are
  // the two things in this card that are neither a row nor bounded by one.
  const offenders = [...card.querySelectorAll('*')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        testid: el.getAttribute('data-testid'),
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 32),
        past: r.right - contentRight,
      };
    })
    .filter((o) => o.past > 1)
    .sort((a, b) => b.past - a.past)
    .slice(0, 4);

  return {
    offenders,
    cardScrollWidth: card.scrollWidth,
    cardClientWidth: card.clientWidth,
    columnWidth: document.getElementById('column')?.getBoundingClientRect().width ?? null,
    rows,
    names,
    baseline,
    dotless,
  };
})()`;

/** Arm the fourth dot-less form. `showClosed` suppresses the dot on a pill whose id RESOLVES but
 *  whose reveal came back "gone", and there is no way to reach that state except by clicking. Run
 *  before MEASURE; the probe then waits for the testid to flip before reading geometry. */
const ARM_SHOWCLOSED = `(() => {
  const pill = document.querySelector('#prose-showclosed [data-testid="concierge-agent-pill"]');
  if (!pill) return { armed: false, reason: 'no live pill in #prose-showclosed' };
  pill.click();
  return { armed: true };
})()`;

/** Click the narrowest pill and report whether the card's handler ran. Proves truncation did not
 *  cost the pill its whole reason for existing. */
// RETURNS A SHAPED NULL RATHER THAN THROWING (roborev 58797). `pill.click()` on a missing element
// rejects the `page.evaluate`, which propagates out of the per-width loop into
// `main().catch → process.exit(2)` — the code this file's header defines as "the probe could not
// run (no Chrome, no server)". So renaming `concierge-agent-pill` would report itself as an
// ENVIRONMENT problem and the regression would never be looked at. `verdictFor` already reads
// `clicked.tag` / `clicked.clicks`, so a null shape fails there instead of crashing here.
const CLICK_TRUNCATED = `(() => {
  window.__recapClicks.length = 0;
  const pill = document.querySelector('[data-testid="concierge-recap"] [data-testid="concierge-agent-pill"]');
  if (!pill) return { tag: null, clicks: [], title: null, missing: 'concierge-agent-pill in the recap card' };
  pill.click();
  return { tag: pill.tagName, clicks: [...window.__recapClicks], title: pill.getAttribute('title') };
})()`;

/** How many line-heights a reflowed row may occupy. Two lines plus the row's own 4px of padding and
 *  2px of row-gap; 2.5 is that with a little slack, and is comfortably under the ~4-line stack the
 *  old row produced. */
export const MAX_ROW_LINES = 2.5;

/** Sub-pixel slack. A right edge may land a fraction past the content edge from rounding without
 *  anything being visibly clipped. */
export const EDGE_TOLERANCE = 1;

/**
 * How far a pill's text already sits below the prose around it, BEFORE this change — measured, not
 * assumed, by running this probe against the pre-change `AgentPill` (`git show HEAD:…`): 2.00px at
 * every width tried, identical to the post-change reading.
 *
 * WHY IT IS NOT ZERO, and why that is a separate bug from this one. The pill is an `inline-flex`
 * box, so its baseline is donated by its FIRST flex item — which is the 6px status dot, an empty
 * span with no text baseline of its own. The synthesised baseline (the dot's bottom edge, dot
 * centred in the line) sits above the label's real text baseline, so aligning the pill to the
 * sentence pushes its text ~2px down.
 *
 * THE CHECK IS THEREFORE "HAS NOT MOVED", NOT "IS ZERO". Asserting zero would fail on code that
 * predates this work and tempt the next person to "fix" it by moving the pill, which is a visible
 * change to every concierge reply and nothing to do with narrow columns.
 *
 * IT DID NOT CATCH THE TRAP IT WAS WRITTEN FOR, and that is worth stating rather than leaving for
 * someone to rediscover. Adding `overflow: hidden` to the pill's OUTER box and re-running this
 * probe moved the offset not at all: Chrome takes an `inline-flex` container's baseline from its
 * first flex item, not from the "overflow ⇒ bottom margin edge" rule, which bites for
 * `inline-block`/`inline-table`. The declaration is guarded by `AgentPill.truncation.test.tsx`
 * instead; this check stays as a canary for the day that box's `display` changes, and because a
 * pill silently sliding off its sentence is invisible in every other measurement here.
 */
export const BASELINE_OFFSET_PX = 2;

/** Turn one width's measurement into pass/fail claims. Pure, so the rules are readable and
 *  testable without a browser. */
export function verdictFor(width, m, clicked) {
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  const offenders = m.offenders ?? [];
  add(
    m.cardScrollWidth <= m.cardClientWidth,
    "the card does not scroll horizontally",
    `scrollWidth ${m.cardScrollWidth} <= clientWidth ${m.cardClientWidth}` +
      (offenders.length === 0
        ? ""
        : ` — past the content edge: ${offenders
            .map((o) => `${o.testid ?? o.tag.toLowerCase()} +${o.past.toFixed(1)}px "${o.text}"`)
            .join("; ")}`),
  );

  // ── THERE MUST BE SOMETHING TO MEASURE, AS A FAIL RATHER THAN AS A CRASH (roborev 58700) ──────
  // Every judgement below folds over `m.rows`, and each fold used to seed from `m.rows[0]`. With no
  // rows — a renamed `recap-change` / `recap-decision` testid, or a fixture that stopped producing
  // them — that seed is `undefined`, `worst.overhang` throws a TypeError, and `main().catch` exits
  // **2**, which this file's own header defines as "the probe could not run (no Chrome, no server)".
  // So a stale selector reported itself as an ENVIRONMENT problem: the reader wires up Chrome, the
  // probe still exits 2, and the actual regression is never looked at. State it as a failed check
  // and return, so the instrument says what is wrong with it in its own vocabulary.
  const rows = m.rows ?? [];
  if (rows.length === 0) {
    add(
      false,
      "the card rendered rows to measure",
      "no [data-testid=recap-change] / [data-testid=recap-decision] element in the card — the " +
        "fixture stopped producing rows, or the testids were renamed out from under this probe",
    );
    return { width, checks, measurement: m };
  }

  const worst = rows.reduce((w, r) => (r.overhang > w.overhang ? r : w), rows[0]);
  add(
    worst.overhang <= EDGE_TOLERANCE,
    "no row's content passes the card's content edge",
    `worst overhang ${worst.overhang.toFixed(2)}px on "${worst.text}"`,
  );

  // The change rows are what every hybrid rule below judges, and they have their own testid — so
  // they need their own non-emptiness check rather than riding on the one above.
  const changeRows = rows.filter((r) => r.testid === "recap-change");
  // AT EVERY WIDTH, NOT ONLY ABOVE THE HYBRID FLOOR (roborev 58761). This guard used to be gated
  // behind `width >= HYBRID_MIN_WIDTH`, with the `changeRows.length === 0` branch deliberately
  // empty — so at 135/100/50 a card whose change rows had VANISHED produced zero checks and
  // reported PASS. The below-floor branch asserts a real rule of its own ("clipped, never
  // word-stacked", which this file calls the one hybrid property that survives down here, and which
  // is the actual bug the reflow was written to kill), so it needs change rows just as much. A full
  // sweep masked it because the >=200 widths still failed, but `visual:recap-narrow --widths=100` is
  // a documented invocation and would have gone green on a card with no rows at all.
  add(
    changeRows.length > 0,
    "the card rendered CHANGE rows, which is what the hybrid rules judge",
    `${changeRows.length} of ${rows.length} row(s) are [data-testid=recap-change]`,
  );

  // THE SHOWCLOSED CONTROL, graded rather than thrown (roborev 58761 — see the arming step in
  // `main`). A dot-less form that never armed means the baseline claims below are about three forms
  // instead of four, which is a failure of the instrument and must read as one.
  if (m.armed !== undefined) {
    add(
      m.armed.armed === true,
      "the showClosed control was reachable",
      m.armed.reason ?? "armed",
    );
  }

  if (changeRows.length === 0) {
    // Nothing below can say anything true; the check above has already recorded the failure.
  } else if (width < HYBRID_MIN_WIDTH) {
    // ── BELOW THE HYBRID FLOOR: CONTAINMENT IS THE WHOLE CONTRACT ──────────────────────────────
    // Recorded as a passing check rather than as silence, so a reader of the output can tell "this
    // width was judged by a narrower rule" from "this width was skipped". See `HYBRID_MIN_WIDTH`
    // for why the line budget is given up here and containment is not.
    add(
      true,
      `below ${HYBRID_MIN_WIDTH}px only CONTAINMENT is in contract — the line budget is not`,
      `tallest change row ${Math.max(...changeRows.map((r) => r.lines)).toFixed(2)} lines, judged only for overflow`,
    );
    // The one hybrid property that DOES survive down here, because it is the bug the reflow was
    // written to kill: the status may be clipped, but it may never go back to stacking one word per
    // line. `nowrap` is what holds it, and nothing about a narrow column should be able to undo it.
    const stacked = rows.filter((r) => r.statusLines !== null && r.statusLines > 1.5);
    add(
      stacked.length === 0,
      "the status label stays on ONE line even here — it is clipped, never word-stacked",
      stacked.length === 0
        ? "no status is word-stacked"
        : `word-stacked: ${stacked.map((r) => `"${r.text}" ${r.statusLines.toFixed(2)} lines`).join(", ")}`,
    );
  } else if (width >= 500) {
    // WIDE: the reflow must not fire when there is room — that is the "exactly as today" half.
    // `changeRows` is non-empty in this branch — the guard above returned otherwise, which is what
    // makes seeding the fold from element 0 safe rather than a TypeError waiting on a renamed
    // testid (roborev 58700).
    const changes = changeRows;
    const tallest = changes.reduce((t, r) => (r.lines > t.lines ? r : t), changes[0]);
    add(
      tallest.lines <= 1.5,
      "every change row is still ONE line when there is room",
      `tallest ${tallest.lines.toFixed(2)} lines ("${tallest.text}")`,
    );
    add(
      changes.every((r) => r.statusSameLine === true),
      "chip, pill and status share ONE line when there is room",
      changes.map((r) => `${r.statusSameLine}`).join(", "),
    );
  } else {
    // Change rows only. A decision row is prose and may legitimately be as tall as its sentence.
    // `changeRows` is non-empty in this branch — the guard above returned otherwise, which is what
    // makes seeding the fold from element 0 safe rather than a TypeError waiting on a renamed
    // testid (roborev 58700).
    const changes = changeRows;
    const tallest = changes.reduce((t, r) => (r.lines > t.lines ? r : t), changes[0]);
    add(
      tallest.lines <= MAX_ROW_LINES,
      `no change row exceeds ${MAX_ROW_LINES} lines`,
      `tallest ${tallest.lines.toFixed(2)} lines ("${tallest.text}")`,
    );
    // The decision row's own rule: the verb shares the first line with the sentence it introduces.
    // If the prose gets pushed to its own line, the row is exactly one line-height taller than its
    // prose — which is the shape a max-content flex basis produces and this measures directly.
    const orphaned = m.rows.filter(
      (r) => r.proseHeight !== null && r.height - r.proseHeight > r.lineHeight * 0.5,
    );
    add(
      orphaned.length === 0,
      "the decision verb shares its line with the sentence it introduces",
      orphaned.length === 0
        ? "no orphaned verb"
        : orphaned
            .map((r) => `"${r.text}" row ${r.height.toFixed(1)}px vs prose ${r.proseHeight.toFixed(1)}px`)
            .join(", "),
    );
    // ── THE POSITIVE STATEMENT OF THE FOUNDER'S DECISION ──────────────────────────────────────
    // This is the check that tells his hybrid apart from the option he REJECTED, and nothing else
    // here can: drop `flex-wrap` and nothing overflows and nothing word-stacks — the row silently
    // becomes always-one-line-truncate, eating the agent's name at a width where there was room to
    // simply move the status down.
    //
    // A ROW THAT FITS KEEPS ITS STATUS ON THE LINE, so the rule is conditional rather than blanket:
    // "drodio-website / @OG Images / Done" is short enough to fit at 280px, and demanding it wrap
    // would be demanding a bug. What must hold is that a row which DID wrap wrapped in the right
    // place — the status left the line whole, rather than the pill being squeezed to make room.
    const wrapped = m.rows.filter((r) => r.statusSameLine !== null && r.lines > 1.5);
    const wrongBreak = wrapped.filter((r) => r.statusSameLine === true);
    add(
      wrongBreak.length === 0,
      "a row that no longer fits moved its STATUS to its own line",
      wrongBreak.length === 0
        ? `${wrapped.length} row(s) wrapped, all below the pill`
        : wrongBreak.map((r) => `"${r.text}" wrapped somewhere else`).join(", "),
    );
    // …and the fixture must actually REACH that state at this width, or the check above is vacuous
    // by construction: with no wrapped row there is nothing for it to judge.
    add(
      wrapped.length > 0,
      "the long row genuinely reflowed at this width",
      `${wrapped.length} of ${m.rows.filter((r) => r.statusSameLine !== null).length} change row(s) wrapped`,
    );
    const stacked = m.rows.filter((r) => r.statusLines !== null && r.statusLines > 1.5);
    add(
      stacked.length === 0,
      "the status label stays on ONE line — it moves as a unit or not at all",
      stacked.length === 0
        ? "no status is word-stacked"
        : `word-stacked: ${stacked.map((r) => `"${r.text}" ${r.statusLines.toFixed(2)} lines`).join(", ")}`,
    );
  }

  if (width <= 220) {
    // VERY NARROW: the pill alone no longer fits, so the ellipsis is what is left.
    add(
      m.names.some((n) => n.truncated),
      "the pill's name is genuinely truncated, with the clip actually applied",
      m.names.map((n) => `${n.text}: ${n.scrollWidth}/${n.clientWidth}`).join(" | "),
    );
    add(
      clicked.tag === "BUTTON" && clicked.clicks.length === 1,
      "a truncated pill is still a working control",
      `${clicked.tag}, ${clicked.clicks.length} click(s), title=${JSON.stringify(clicked.title)}`,
    );
    add(
      /Concierge Says What It Is Doing/.test(clicked.title ?? ""),
      "the FULL name survives truncation in the tooltip",
      JSON.stringify(clicked.title),
    );
  }

  // A MISSING REFERENCE IS A FAILED CHECK, NOT A CRASH (roborev 58797). `MEASURE` now hands back
  // null fields when `#prose-ref` or the prose pill cannot be found, so the `.toFixed` calls below
  // would throw and be reported as exit 2 — "the probe could not run" — hiding the rename.
  const bl = m.baseline ?? {};
  add(
    bl.delta !== null && bl.delta !== undefined && bl.delta <= BASELINE_OFFSET_PX + EDGE_TOLERANCE,
    `a pill in prose has not MOVED on its sentence's baseline (≤ ${BASELINE_OFFSET_PX}px, unchanged)`,
    bl.delta === null || bl.delta === undefined
      ? `could not measure — ${bl.missing ?? "no baseline reading"} is not in the harness`
      : `ref bottom ${bl.refBottom.toFixed(2)} vs pill ${bl.pillBottom.toFixed(2)} (Δ ${bl.delta.toFixed(2)}px)`,
  );

  // ── THE DOT-LESS FORMS, WHICH IS WHERE THE SCROLL-CONTAINER BASELINE RULE ACTUALLY BITES ──────
  // The check above measures the LIVE pill and is the ONLY form the probe measured before roborev
  // 58698/58699. Its first flex item is the 6px status dot, so the dot donates the container's
  // baseline and shields it from anything the name span does — which is why "adding overflow:hidden
  // moved nothing" was a true reading and still not evidence that the clip is safe.
  //
  // THESE FORMS HAVE NO DOT, so the name span IS the first flex item, and a clip that makes it a
  // scroll container moves the whole pill: its baseline stops being the label's text baseline and
  // becomes a baseline synthesised from that span's border box. Every one of them is reachable —
  // `-unwired` is what SupportModal and agent replies render, both `-closed` forms are what a wired
  // surface draws for an id its roster no longer holds, and the `showClosed` button is any live
  // pill one failed reveal later.
  //
  // ZERO, NOT `BASELINE_OFFSET_PX`. The 2.00px the dotted pill sits low by is the DOT's doing (see
  // that constant); a pill with no dot has a real text baseline and should land exactly on the
  // sentence's, so anything else is the synthesis this check exists to catch.
  //
  // AND THE MEASUREMENT DOES NOT CURRENTLY EXERCISE THE HAZARD — said plainly, because the same
  // thing was true one level up and pretending otherwise is how the first version of this got
  // written. Mutating the name span back to `overflow: hidden` and re-running moves these deltas
  // NOT AT ALL (Δ0.00 either way at every width where the control shares a line): Chrome does not
  // synthesise a flex item's baseline from its border box merely because the item is a scroll
  // container, however clearly CSS Box Alignment §9 says a scroll container's baseline is
  // synthesised. WebKit is the engine this app actually renders in and was not measured here, and
  // the rule is real regardless — so the fix stands on the spec and on the repo's own
  // `.clip-no-scroll` reasoning, not on these numbers. What IS falsifiable is the check below: the
  // computed overflow. That one goes red the instant the clip becomes a scroll container again.
  const dotless = m.dotless ?? [];
  add(
    dotless.length > 0,
    "the dot-less baseline controls are on the page at all",
    `${dotless.length} control(s): ${dotless.map((d) => d.form).join(", ") || "none"}`,
  );
  for (const d of dotless) {
    // A control that starts drawing a dot has silently become a copy of the shielded case, and
    // would pass while proving nothing — the vacuity this whole block exists to escape.
    add(
      d.hasDot === false,
      `the "${d.form}" control really is dot-less`,
      `testid=${d.testid}, hasDot=${d.hasDot}, name overflow=${d.nameOverflow}`,
    );
    // THE FALSIFIABLE HALF, and the reason the block above is honest about not being one. This is a
    // COMPUTED style read in a real browser, so it proves three things a jsdom declaration test
    // cannot: the `clip-no-scroll` class is really on the span, the stylesheet carrying it really
    // loaded, and the `@supports (overflow: clip)` upgrade really resolved. Put `overflow: hidden`
    // back on `nameText` — where it shipped — and this goes red immediately, because an inline
    // style wins over the class.
    add(
      d.nameOverflow === "clip",
      `the "${d.form}" pill's name clips WITHOUT becoming a scroll container`,
      `computed overflow=${d.nameOverflow} (expected "clip"; "hidden" means the class was overridden ` +
        `or the @supports upgrade did not resolve)`,
    );
    add(
      d.delta !== null && d.delta <= EDGE_TOLERANCE,
      `a dot-less "${d.form}" pill sits ON its sentence's baseline`,
      d.delta === null
        ? "not measured — the control's pill or its reference word was not found"
        : `ref bottom ${d.refBottom.toFixed(2)} vs pill ${d.pillBottom.toFixed(2)} (Δ ${d.delta.toFixed(2)}px)`,
    );
  }

  return { width, checks, measurement: m };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const widths = parseWidths(args.widths);
  // VALIDATED, NOT COERCED (roborev 58761). `--widths` bare gives `args.widths === true`, which is
  // truthy, so the old `String(true).split(",").map(Number)` produced `[NaN]` — the probe then
  // navigated to `?w=NaN`, the harness set `width: "NaNpx"`, the column fell back to the 1200px
  // viewport, and every width comparison in `verdictFor` was false for NaN, so the 200-499px narrow
  // rules were graded against a wide layout. `--widths=520,,200` (`Number("")` -> 0) and any typo
  // did the same. That is a silent PASS for an instrument, which this file's own closing comment
  // calls the worst possible failure — so a bad width list is a hard exit, not a quiet reinterpretation.
  if (widths === null) {
    console.error(
      `--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`,
    );
    process.exit(2);
  }

  let server;
  let browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 1200, height: 900 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage();
      try {
        await page.navigate(`${server.url}/scripts/visual/recap-narrow-harness.html?w=${width}`);
        await page.waitForFunction("window.__recapHarnessReady === true", { timeout: 30000 });
        // Reach the fourth dot-less form BEFORE measuring — `showClosed` only exists after a reveal
        // has come back "gone", and waiting on the testid flip is what keeps this from reading a
        // pre-click tree (React commits the state change a frame later).
        // THE ARMING STEP MUST NOT THROW (roborev 58761). This commit's whole thesis is that a
        // stale selector is a FAILED CHECK, not exit 2 — and this was a new stale-selector→exit-2
        // path: `ARM_SHOWCLOSED`'s `{ armed: false, reason }` was discarded, the `waitForFunction`
        // below then threw, propagated out of the per-width loop and landed in
        // `main().catch → process.exit(2)` — the code this file's header defines as "the probe could
        // not run (no Chrome, no server)". So if the showClosed pill ever stops flipping, the probe
        // would report an environment problem for 5s × 7 widths and the regression would never be
        // looked at. The outcome is carried to `verdictFor` instead, which grades it.
        const armed = await page.evaluate(ARM_SHOWCLOSED);
        await page
          .waitForFunction(
            `!!document.querySelector('#prose-showclosed [data-testid="concierge-agent-pill-closed"]')`,
            { timeout: 5000 },
          )
          .catch(() => {});
        const m = await page.evaluate(MEASURE);
        m.armed = armed;
        const clicked = await page.evaluate(CLICK_TRUNCATED);
        if (page.consoleErrors.length) {
          console.error(`page errors at ${width}px:\n  ${page.consoleErrors.join("\n  ")}`);
        }
        results.push(verdictFor(width, m, clicked));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  if (args.json) {
    console.log(JSON.stringify({ results, ok: failed.length === 0 }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n── ${r.width}px ${"─".repeat(48)}`);
      for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n          ${c.detail}`);
    }
    console.log(
      failed.length === 0
        ? `\nRECAP NARROW PROBE PASSED (${results.length} width(s): ${widths.join(", ")})`
        : `\nRECAP NARROW PROBE FAILED at ${failed.map((r) => `${r.width}px`).join(", ")}`,
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// Only when run directly, so the pure helpers above stay importable by a unit test — and they now
// ARE imported: `harness.test.mjs` feeds `verdictFor` synthetic measurements (an overflowing row, a
// word-stacked status, a break in the wrong place, an empty row set) so the rules themselves are
// shown to be able to fail, the same way `seam-probe.mjs`'s helpers have been covered all along.
// This comment used to claim that coverage while none existed.
//
// `pathToFileURL`, NOT the `file://${process.argv[1]}` idiom. Sparkle's own worktrees live under
// "~/Library/Application Support/…", and `import.meta.url` percent-encodes that space while string
// concatenation does not — so the comparison is false, `main()` never runs, and the probe exits 0
// having measured NOTHING. A silent green is the worst possible failure for an instrument.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
