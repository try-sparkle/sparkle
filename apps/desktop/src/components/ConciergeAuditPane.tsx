import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { FiCheck, FiClock, FiSlash } from "react-icons/fi";

import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE, WEIGHT } from "../theme/scale";
import { SECTION_LABEL, tag } from "./labelTreatment";
import {
  newestFirstCapped,
  useConciergeAudit,
  type AuditOutcome,
  type ConciergeAuditEntry,
} from "../services/conciergeAudit";
import { onConciergeActionReceipt } from "../services/conciergeReceipts";
// THE DURABLE LEDGER, and the reason this pane no longer reads the receipt ring: see
// `useRetirementLog` below, and `readRetirementLog`'s own header (roborev 63376).
import {
  readRetirementLog,
  type RetirementRecord,
  type RetirementLogReading,
} from "../services/deathRecordWriter";

// THE READER for services/conciergeAudit — the half of the concierge safety surface that answers
// "what did it just do?", and the half that did not exist. The store has recorded every
// `concierge_tool` call since it landed (attempts as well as successes, redacted through the
// approval card's own `describeApprovalArgs`), and nothing in the app read it back: a record with
// no reader is a record nobody can consult, which is the same as not having one.
//
// IT LIVES ON THE CONCIERGE TOOLS PANE, next to the per-tool policy, because the two are one
// question asked in two tenses. The policy pane says what the concierge MAY do; this says what it
// DID. Someone who comes to this pane is almost always here because something happened — either it
// did a thing they did not expect, or it did not do a thing they asked for — and the second case is
// the one a settings pane full of allow/ask/never controls cannot answer on its own.
//
// THE REFUSED AND STILL-RUNNING ROWS ARE THE POINT, and every decision below follows from that:
//
//  • A REFUSAL RENDERS BOTH ITS CODE AND ITS SENTENCE. They are different facts for different
//    readers — `needs-approval` is the machine-readable reason and "merge_pr needs your go-ahead"
//    is the one a human acts on — and a row carrying only the code reads as a failure with no
//    explanation, which is exactly the state this surface exists to end. A refusal that arrived
//    with no sentence says so in words rather than rendering an empty line.
//
//  • A RUNNING CALL READS AS RUNNING, and shows no duration. `running` is a real, persistent state
//    in the store (a call that never settles — a crash, a reload mid-flight — stays running rather
//    than vanishing), so the pane must be able to say "this started and I never heard back". The
//    duration is derived from `settledAt`, which is null there; printing "0ms" would state a fact
//    the record does not hold.
//
//  • THE ARGUMENTS SHOWN ARE THE STORE'S, NEVER RE-DERIVED. `entry.args` is already display-safe —
//    truncated, secret-ish values masked — by the same code the approval card uses. This component
//    renders those lines verbatim and holds no raw arguments; a second redactor here would drift
//    from the approval prompt's, and the drift would be invisible because both would look right.
//
// THE CUT IS NAMED. Only the most recent AUDIT_ROWS_SHOWN rows render, because this sits above 62
// policy rows in a scrolling dialog and an unbounded list would bury them. Truncating silently is
// the failure mode — the reader would take the oldest visible row as the beginning of the record —
// so the footer says how many older calls the store still holds. (The store itself is bounded at
// MAX_AUDIT_ENTRIES and evicts oldest-first, which is a second, larger cut with the same honesty
// problem; this one at least is stated on screen.)

/** How many rows render. See the header: a cut, stated rather than silent. */
export const AUDIT_ROWS_SHOWN = 12;

/** What each outcome is called on screen. `Done` rather than `OK` — this is a sentence about work
 *  that happened, not a status code — and `Refused` rather than `Failed`, because the overwhelming
 *  case is the policy layer declining, not the tool erroring. */
const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  running: "Running",
  ok: "Done",
  refused: "Refused",
};

/** The ink each outcome is drawn in. Themed tokens, so both light and dark stay legible: the raw
 *  brand green is too light on the light-mode dialog, which is what `successInk` exists for. */
const OUTCOME_INK: Record<AuditOutcome, string> = {
  running: C.amberInk,
  ok: C.successInk,
  refused: C.dangerInk,
};

/** One Feather glyph per outcome — never a character that looks like one (see glyphIcons.test). */
const OUTCOME_ICON: Record<AuditOutcome, typeof FiCheck> = {
  running: FiClock,
  ok: FiCheck,
  refused: FiSlash,
};

/** How many retirement rows render. Same cut, same disclosure rule as the call log below it. */
export const RETIREMENT_ROWS_SHOWN = AUDIT_ROWS_SHOWN;

/**
 * The retirement receipts this window has seen, oldest first.
 *
 * ══ WHY THIS PANE SUBSCRIBES TO RECEIPTS AT ALL ═════════════════════════════════════════════════
 * The call log below answers "what did the concierge do", and it answers it for someone who was
 * THERE — a row reading `lifecycle.retire_agent` at 03:14 is a true record and an unreadable one.
 * A retirement is the one concierge action taken with nobody watching: it decides on its own
 * initiative, overnight, that a finished agent is done with. The founder asked to be told what it
 * did while he was away, and a `domain.op` row cannot say WHICH agent or WHY. The receipt can — it
 * carries the agent's name and the concierge's own reason, verbatim — so this section renders the
 * receipt rather than re-deriving a sentence from the log's arguments.
 *
 * ══ IT DOES NOT CLAIM THE RECEIPT ═══════════════════════════════════════════════════════════════
 * `claimReceiptForDisplay` is the THREAD's claim, and calling it here would take a receipt the
 * thread has not drawn yet and suppress its line forever — turning a second reader into a silent
 * deletion of the first. Two surfaces may show one receipt; that is not a duplicate, it is a record
 * consulted twice. So this dedupes on `id` in its own state, which is also what makes the replay on
 * mount (and StrictMode's double-subscribe) idempotent.
 */
function useRetirementLog(): {
  records: readonly RetirementRecord[];
  ok: boolean;
  names: ReadonlyMap<string, string>;
} {
  const [reading, setReading] = useState<RetirementLogReading>({ records: [], ok: true });
  // Names are NOT on the ledger — a retired agent's row is gone from the store, which is the whole
  // point of the record outliving it. Receipts from THIS session carry one, so they are used to put
  // a name on a row when we happen to have it. A record from a previous session shows its id, which
  // is honest: we know it was retired and why, and we no longer know what it was called.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let live = true;
    const load = (): void => {
      void readRetirementLog().then((r) => {
        if (live) setReading(r);
      });
    };
    load();
    // A `retired` receipt is the SIGNAL that the ledger changed, never the DATA that is rendered.
    // Keeping one source of truth is what stops the two from disagreeing about a night's record —
    // and it is why the ring's cap and its reset no longer matter to this surface.
    const off = onConciergeActionReceipt((r) => {
      if (r.kind !== "retired") return;
      const name = r.agentName?.trim();
      if (r.agentId && name) {
        setNames((prev) => (prev.get(r.agentId!) === name ? prev : new Map(prev).set(r.agentId!, name)));
      }
      load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  return { records: reading.records, ok: reading.ok, names };
}

export function ConciergeAuditPane() {
  // The whole list, not a slice: eviction and settling both replace the array, and the component
  // needs to re-render for either. `entries` is a stable reference between writes, so this is one
  // subscription rather than a per-row one.
  const entries = useConciergeAudit((s) => s.entries);
  // NEWEST FIRST, AND THE STORE OWNS THAT RULE (roborev 55406). `recentConciergeAudit` already
  // implements "newest first, capped at N" and was left with no production caller at all when this
  // pane re-derived it as `[...entries].reverse().slice(0, N)`. Two implementations of one ordering
  // rule — one tested and unused, the other used and untested at the store level — is the drift the
  // store's own header warns about: change the store to keep newest-first so eviction can pop the
  // tail, and its helper's tests keep passing while this pane silently renders oldest-first.
  //
  // The helper is PURE over the array rather than reading the store itself, so `entries` is a real
  // `useMemo` dependency rather than an invisible one — `react-hooks/exhaustive-deps` flagged the
  // imperative version, correctly. The subscription is also what makes a write re-render at all, and
  // `older` needs the untruncated length.
  const shown = useMemo(() => newestFirstCapped(entries, AUDIT_ROWS_SHOWN), [entries]);
  const older = entries.length - shown.length;

  return (
    <section style={pane} data-testid="concierge-audit-pane">
      <RetirementLog />
      <h3 style={groupHeading}>What the concierge did</h3>
      {shown.length === 0 ? (
        <p style={emptyBox} data-testid="concierge-audit-empty">
          Nothing yet. Every tool the concierge reaches for lands here — the ones that ran, the ones
          still running, and the ones it was refused, with the arguments it used and the reason it
          was turned down.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {shown.map((entry) => (
              <AuditRow key={entry.key} entry={entry} />
            ))}
          </div>
          {older > 0 && (
            <p style={moreLine} data-testid="concierge-audit-more">
              {older === 1 ? "1 older call" : `${older} older calls`} not shown. This list keeps the
              most recent {AUDIT_ROWS_SHOWN}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What the concierge retired while nobody was watching — rendered only when it retired something.
 *
 * NO EMPTY STATE, unlike the call log below. The log's empty box exists to promise that refusals
 * will appear there, because a reader who opens it after a refusal and sees nothing would conclude
 * the record does not keep them. This section makes no such promise to make: an app that has never
 * retired anything has nothing to disclose, and a permanent "no retirements" line above a pane full
 * of policy rows is chrome rather than evidence.
 */
function RetirementLog() {
  const { records, ok, names } = useRetirementLog();
  const shown = useMemo(() => records.slice(0, RETIREMENT_ROWS_SHOWN), [records]);
  // Counted off the DURABLE list, which is the same list the rows came from. The old count was taken
  // off a volatile ring that had already evicted the earliest rows, so `older` read 0 over a night
  // that had truncated — the disclosure suppressed itself exactly when it was needed.
  const older = records.length - shown.length;

  // AN UNREADABLE LEDGER IS SAID OUT LOUD. It is the one case where rendering nothing would be a
  // claim rather than an absence: this surface treats a missing record as evidence, so "we could not
  // look" must never wear the same face as "it retired nothing".
  if (!ok) {
    return (
      <div style={pane} data-testid="concierge-retirement-log">
        <h3 style={groupHeading}>Agents it retired on its own</h3>
        <p style={emptyBox} data-testid="concierge-retirement-unreadable">
          I couldn&apos;t read the retirement record just now, so I can&apos;t tell you what was
          retired. This is not a report that nothing was.
        </p>
      </div>
    );
  }
  if (shown.length === 0) return null;

  return (
    <div style={pane} data-testid="concierge-retirement-log">
      <h3 style={groupHeading}>Agents it retired on its own</h3>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {shown.map((r) => (
          <RetirementRow key={`${r.agentId}-${r.retiredAt}`} record={r} name={names.get(r.agentId)} />
        ))}
      </div>
      {older > 0 && (
        <p style={moreLine} data-testid="concierge-retirement-more">
          {older === 1 ? "1 older retirement" : `${older} older retirements`} not shown. This list
          keeps the most recent {RETIREMENT_ROWS_SHOWN}.
        </p>
      )}
    </div>
  );
}

/** One retirement: which agent, whether it actually happened, when, and the concierge's own reason. */
function RetirementRow({ record, name }: { record: RetirementRecord; name?: string }) {
  // EVERY ROW HERE HAPPENED. The ledger is written only on a retirement that went through — a
  // refused one never reaches it, because the durable write GATES the teardown. So there is no
  // outcome to render: the presence of the row is the outcome, unlike the call log below, which
  // carries attempts as well.
  const Icon = OUTCOME_ICON.ok;
  // The retirer's OWN words, printed as the record holds them. `Concierge/refusalAudience` shortens
  // a reason for the thread; this pane is the audit trail, which is the one place a gist is a loss.
  const reason = record.reason.trim();
  const by = record.retiredBy === "concierge" ? "Retired" : "Retired by you";

  return (
    <div style={row} data-testid="concierge-retirement-entry">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <span style={outcomePill(OUTCOME_INK.ok)} data-testid="concierge-retirement-outcome">
          <Icon size={10} aria-hidden /> {by}
        </span>
        <span style={callName} data-testid="concierge-retirement-agent">
          {name?.trim() || record.agentId}
        </span>
        <span style={meta}>{clockTime(record.retiredAt)}</span>
      </div>
      {reason && (
        <div style={reasonRow}>
          <span style={reasonText} data-testid="concierge-retirement-reason">
            {reason}
          </span>
        </div>
      )}
    </div>
  );
}

/** One call: what it was, what became of it, why not (when it was refused), and what it was given. */
function AuditRow({ entry }: { entry: ConciergeAuditEntry }) {
  const Icon = OUTCOME_ICON[entry.outcome];
  const ink = OUTCOME_INK[entry.outcome];
  const refused = entry.outcome === "refused";

  return (
    <div style={row} data-testid="concierge-audit-entry">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <span style={outcomePill(ink)} data-testid="concierge-audit-outcome">
          <Icon size={10} aria-hidden /> {OUTCOME_LABEL[entry.outcome]}
        </span>
        <span style={callName} data-testid="concierge-audit-call">
          {entry.domain}.{entry.op}
        </span>
        <span style={meta}>{clockTime(entry.startedAt)}</span>
        {entry.settledAt !== null && (
          <span style={meta} data-testid="concierge-audit-duration">
            {formatDuration(entry.settledAt - entry.startedAt)}
          </span>
        )}
      </div>
      {refused && (
        <div style={reasonRow}>
          {entry.code && <span style={codePill}>{entry.code}</span>}
          <span style={reasonText} data-testid="concierge-audit-reason">
            {entry.message ?? "No reason came back with the refusal."}
          </span>
        </div>
      )}
      {entry.args.length > 0 && (
        <dl style={argsBlock} data-testid="concierge-audit-args">
          {entry.args.map((line) => (
            <div key={line.key} style={{ display: "flex", gap: 6, minWidth: 0 }}>
              <dt style={argKey}>{line.key}</dt>
              <dd style={argValue}>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Wall-clock start, in the reader's own zone. Hand-assembled rather than `toLocaleTimeString` so
 *  the shape is the same everywhere — this sits in a dense column beside a duration, and a locale
 *  that renders "1:05:03 PM" re-flows the row against one that renders "13:05:03". */
export function clockTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  // THE DAY IS PART OF THE FACT WHEN IT ISN'T TODAY (roborev 55406). This log is process-lifetime
  // state pruned only by its ROW-COUNT cap, never by age, and this app routinely stays open for days
  // — so a bare `14:05:03` on a row from Monday reads on Wednesday as "a few minutes ago",
  // indistinguishable from a call made in this session. That is the one thing this pane's own thesis
  // forbids: it refuses to print `0ms` for a running call because the record does not hold a
  // duration, and then asserted a same-day reading the record does not support either.
  //
  // THREE TIERS, BECAUSE A WEEKDAY ALONE WRAPS (roborev 55559). The first fix used only the weekday,
  // on the stated grounds that "the cap means a row is days old at most" — which was simply false,
  // and false in the exact way that made this fix necessary: the cap is on COUNT (200 entries), not
  // on age, so under light use a row can be weeks old. `Mon 14:05:03` read on a Monday seven days
  // later is the original defect verbatim, and at eight days it reads as yesterday. So beyond a week
  // the month and day are spelled out. All three forms keep a fixed-width shape for the row's
  // alignment.
  const startOfDay = (t: number) => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const daysApart = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (daysApart === 0) return hms;
  if (daysApart > 0 && daysApart < 7) {
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hms}`;
  }
  // A week or more back — and also anything in the FUTURE, which only a clock change produces; a
  // weekday would be actively misleading there, while a date is merely surprising.
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${mon[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")} ${hms}`;
}

/** How long the call took, once it has settled. Sub-second in ms (most of these are), longer in
 *  seconds to one decimal — a four-digit millisecond count is a number nobody reads. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- styles (matched to ConciergeToolsPane, the pane this renders inside) ----------------------

const pane: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const groupHeading: CSSProperties = { ...SECTION_LABEL, margin: 0 };

/** The empty state is a SENTENCE, not a control, so it gets no box.
 *
 *  The first cut drew it as the inset well the pane's notices use (`C.forest` under a `C.hairline`
 *  rule) and `modalChrome.test.ts` counted it as a 27th shell-borrowing field against a ceiling of
 *  26 — correctly. That ratchet is shrinking the population of styles that fake the spec's field
 *  pair out of the shell's tokens, and the honest way past it here is not to reach for
 *  `inputSurface`/`inputEdge` (this is not a field either) but to notice that a line of prose under
 *  a section label never needed chrome. Same treatment as ConciergeToolsPane's `settingBlurb`. */
const emptyBox: CSSProperties = {
  margin: 0,
  fontSize: TYPE.small,
  color: C.muted,
  lineHeight: 1.5,
};

const row: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "8px 0",
  borderBottom: `1px solid ${C.hairline}`,
};

/** The outcome tag. `tag()` rather than a hand-rolled pill so it reads as the same kind of mark as
 *  the risk and "set by you" tags one section down. */
function outcomePill(ink: string): CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 3, flex: "none", ...tag(ink) };
}

const callName: CSSProperties = {
  color: C.cream,
  fontFamily: FONT_MONO,
  fontSize: TYPE.body,
  fontWeight: WEIGHT.med,
  // A `domain.op` is one unbreakable token; break it rather than let it push the timestamp out.
  overflowWrap: "anywhere",
  minWidth: 0,
};

const meta: CSSProperties = {
  color: C.muted,
  fontFamily: FONT_MONO,
  fontSize: TYPE.micro,
  fontVariantNumeric: "tabular-nums",
  flex: "none",
};

const reasonRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  flexWrap: "wrap",
  minWidth: 0,
};

/** The machine-readable half of a refusal. Drawn in the same danger ink as its outcome tag, so the
 *  eye reads code and verdict as one statement rather than as a tag plus an unrelated chip. */
const codePill: CSSProperties = { ...tag(C.dangerInk), flex: "none" };

const reasonText: CSSProperties = {
  color: C.cream,
  fontSize: TYPE.small,
  fontFamily: FONT_UI,
  lineHeight: 1.45,
  minWidth: 0,
};

// Same treatment as the approval card's argument block (Concierge/ApprovalPrompt) — deliberately,
// because these are the same lines from the same redactor, and a reader who approved a call should
// recognise it here.
const argsBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  margin: 0,
  padding: "6px 8px",
  borderRadius: RADIUS.input,
  background: C.forest,
  fontSize: TYPE.small,
  fontFamily: FONT_MONO,
};

const argKey: CSSProperties = { flex: "none", color: C.muted, margin: 0 };

const argValue: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  color: C.cream,
  overflowWrap: "anywhere",
};

const moreLine: CSSProperties = {
  margin: "2px 0 0",
  fontSize: TYPE.micro,
  color: C.muted,
  lineHeight: 1.45,
};
