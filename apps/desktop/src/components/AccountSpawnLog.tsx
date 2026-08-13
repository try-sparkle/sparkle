import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiRefreshCw } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { readSpawnLog, type SpawnLogEntry, type SelectionReason } from "../services/accountLedger";

// "Which account did my last N agents actually run on?" — rendered.
//
// This is the visible half of the spawn ledger (`accountLedger.ts`). The founder's standard for a
// feature is that he can SEE it working, and account rotation had nothing to see: the chosen account
// lived in one React `useState` inside the pane that spawned it and died with the pane. Being told
// twice that rotation "landed" while nothing on screen ever changed is what that costs.
//
// THE PANEL DELIBERATELY SHOWS `signedInCount` WHEN IT IS 1. A list of spawns that all name the same
// account looks identical whether rotation is broken or whether there was simply nothing else to
// choose — and on this machine it is the second. Without that number a reader draws exactly the
// wrong conclusion from a correct log, which is the failure this panel exists to end.

/** How many past selections to show. The ledger keeps 2000; this is a glance, not an audit.
 *
 *  EXPORTED BECAUSE THE COPY HAS TO NAME IT. Collapsing to one row per account replaced a visibly
 *  bounded list of dated rows with a bare cardinal number, and a bare number reads as a TOTAL. It
 *  is not one, in two independent ways: `load()` asks for at most this many, and the Rust side
 *  truncates to it — so on a machine with one account and hundreds of agents the row would read the
 *  same figure forever — and the ledger records SELECTION DECISIONS rather than starts, skipping a
 *  sticky key whose answer did not change (`shouldLogSelection`). A panel whose entire value is
 *  being trusted as evidence must not quote a number it cannot stand behind. */
export const SHOW = 25;

/** Ceiling on the per-spawn disclosure, in px. The disclosure is the only unbounded list left on
 *  this panel, and the whole reason this file changed is that an unbounded list pushed the accounts
 *  screen's controls off the window. It scrolls inside itself instead of growing the page. */
const DETAIL_MAX_HEIGHT = 220;

/** Human phrasing for why an account was chosen. The distinction that matters is between a rule
 *  that CHOSE and a rule that had no alternative — so "only signed-in account" is surfaced by the
 *  caller from `signedInCount`, not hidden inside these labels. */
const REASON_LABEL: Record<SelectionReason, string> = {
  auto: "picked automatically",
  sticky: "kept its existing account",
  pinned: "pinned by you",
  // "you activated this account", not "pinned": the founder chose it for the whole fleet, and the
  // ledger's job here is to show him that his choice was actually in force at this spawn.
  preferred: "your activated account",
  fallback: "least-bad — every account was near its limit",
  remembered: "carried over — accounts couldn't be read",
  none: "no account chosen",
};

const wrap: CSSProperties = {
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: 12,
  fontFamily: FONT_UI,
  color: C.cream,
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  padding: "5px 0",
  borderTop: `1px solid ${C.muted}`,
  fontSize: TYPE.small,
};

const headerBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: 4,
  color: C.cream,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontFamily: FONT_UI,
  fontSize: TYPE.micro,
  padding: "3px 7px",
};

/** The per-spawn disclosure's toggle. Deliberately a button rather than `<summary>`: the rows are
 *  mounted and unmounted by React state, so the open/closed truth has to live there. */
const disclosureBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.micro,
  padding: "6px 0 0",
  textDecoration: "underline",
};

function fmtTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What this entry is a spawn OF, in the user's terms. The two app-owned keys are not agent ids and
 *  reading them raw ("sparkle:concierge") tells the user nothing. */
function describeKey(key: string): string {
  if (key === "sparkle:concierge") return "Concierge";
  if (key.startsWith("__sparkle_self__")) return "Improve Sparkle";
  return `Agent ${key.slice(0, 8)}`;
}

/** One account, and every spawn that ran on it.
 *
 *  THE PANEL USED TO RENDER ONE ROW PER SPAWN, and on the machine this feature was built for that
 *  is 25 identical lines reading `founder@storytell.ai / picked automatically / limit not learned
 *  yet` — because only one account is signed in, which is precisely the situation the panel exists
 *  to explain. The founder's words: "No Need to show the same account multiple times. You can just
 *  show it once in terms of what's currently signed in." The data was never wrong; the presentation
 *  repeated it until the page outgrew the window. */
interface AccountGroup {
  /** Grouping identity. `null` is its own group — spawns that got no account at all. */
  accountId: string | null;
  /** The authenticated email where there is one; never the nickname over an email, since the
   *  nickname is user-typed and is evidence of nothing. */
  label: string;
  count: number;
  /** The NEWEST spawn on this account. Every "as of now" figure on the summary row — the limit
   *  fraction, the last-used time — is read from here, because an older spawn's numbers describe a
   *  machine state that has since moved on. */
  newest: SpawnLogEntry;
  /** How many distinct reasons appear across this account's spawns. More than one means the
   *  summary's single reason label is the newest of several, and it has to say so rather than
   *  presenting one spawn's reason as if it covered all of them. */
  reasonCount: number;
}

/** Collapse the ledger to one entry per account, newest account first.
 *
 *  Entries arrive newest-first, so the first sighting of an account is its newest spawn and insertion
 *  order is already "most recently used first" — no sort, and no clock read that would have to be
 *  injected to be testable. */
export function groupByAccount(entries: SpawnLogEntry[]): AccountGroup[] {
  const byId = new Map<string, AccountGroup>();
  const reasons = new Map<string, Set<SelectionReason>>();
  for (const e of entries) {
    // `null` is a real, distinct group (no account was chosen), not a missing key to be dropped.
    const id = e.accountId ?? " none";
    const existing = byId.get(id);
    if (existing) {
      existing.count += 1;
      reasons.get(id)!.add(e.reason);
      continue;
    }
    byId.set(id, {
      accountId: e.accountId,
      label: e.email ?? e.nickname ?? "no account (used your terminal's login)",
      count: 1,
      newest: e,
      reasonCount: 1,
    });
    reasons.set(id, new Set([e.reason]));
  }
  for (const [id, g] of byId) g.reasonCount = reasons.get(id)!.size;
  return [...byId.values()];
}

export interface AccountSpawnLogProps {
  /** IO seam so the panel can be tested without a backend. Defaults to the real ledger read. */
  read?: (limit: number) => Promise<SpawnLogEntry[]>;
}

export function AccountSpawnLog({ read = readSpawnLog }: AccountSpawnLogProps) {
  const [entries, setEntries] = useState<SpawnLogEntry[] | null>(null);
  // Collapsed by default. The per-spawn list is the thing that grew the accounts dialog past the
  // window, so it opens only when someone asks for it.
  const [detailOpen, setDetailOpen] = useState(false);
  // Monotonic request id. Two reads can be outstanding at once — Refresh clicked twice, or the
  // effect re-firing on a new `read` identity — and without this the SLOWER one wins whenever it
  // lands second, leaving the panel showing an older snapshot than one it already received. In a
  // surface whose whole value is being trusted as evidence, silently displaying stale data is the
  // worst failure available. Same generation pattern `accountSelection.ts` uses for its cache.
  // A ref, not state: superseding a request must not itself trigger a render.
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latestRequest.current;
    // `readSpawnLog` never rejects — an unreadable ledger resolves to []. So a failure and an empty
    // ledger are the same state here, and the copy below must not claim rotation didn't happen.
    const rows = await read(SHOW);
    // Drop a superseded response. This also covers the unmounted case: the ref survives, nothing
    // newer ever arrives, and no setState fires after teardown.
    if (mine === latestRequest.current) setEntries(rows);
  }, [read]);

  useEffect(() => {
    // The ref OBJECT is captured, not its `.current`. react-hooks/exhaustive-deps warns about
    // reading `.current` in a cleanup because it will have changed by then — which here is the
    // whole point: bumping the live counter is what invalidates the in-flight read. Holding the
    // stable container satisfies the rule without pinning a stale value the invalidation depends
    // on being fresh.
    const seq = latestRequest;
    void load();
    // Invalidate whatever is in flight when this effect is torn down, so a response that lands
    // after unmount can never be applied.
    return () => {
      seq.current++;
    };
  }, [load]);

  // Only the MOST RECENT entry can speak for the pool as it stands now; an older line's counts
  // describe a machine state that may since have changed.
  const latest = entries?.[0];
  // THREE STATES, NOT TWO — and lumping them cost this panel a false statement twice over.
  //
  // `<= 1` was wrong in both directions. Null means the accounts backend could not be read, and JS
  // coerces `null <= 1` to TRUE, so an unmeasured moment announced a one-account pool. Zero is a
  // real reading but a DIFFERENT situation: nobody is signed in at all, so "it is the only one
  // signed in" names an account that does not exist, and "sign in another" points at a remedy
  // premised on there already being one. Each state gets its own sentence, or none.
  const signedIn = latest?.signedInCount ?? null;
  // THE WHOLE SET, and the sentence says "the entries below" to match it. Scoping this to
  // `slice(1)` removed an overstatement but created a worse silence: a log whose NEWEST row names a
  // different account from the rows under it is a rotation that just happened, and that is exactly
  // the case where a reader most needs a sentence reconciling "only one signed in now" with a list
  // visibly showing two. Counting all of them, under copy that claims all of them, says something
  // true in both directions.
  const distinctAccounts = new Set(
    (entries ?? []).map((e) => e.accountId).filter((id): id is string => id != null),
  ).size;
  const pool: "unknown" | "none" | "single" | "healthy" =
    signedIn == null ? "unknown" : signedIn === 0 ? "none" : signedIn === 1 ? "single" : "healthy";
  // ZERO SIGNED IN DOES NOT MEAN NO ACCOUNT WAS CHOSEN, and assuming it did produced a panel that
  // contradicted its own next line. `partitionAccounts` keeps the FULL account list when the
  // signed-in filter would empty it (`eligible = authed.length > 0 ? authed : accounts`) — better a
  // login prompt than a dead agent — so `pickAccount` still returns a real registered account and
  // the spawn still exports its config dir. Only a genuinely empty registry yields `accountId:
  // null`. That is the sole state in which "Sparkle is not choosing an account at all" is true.
  const choseNothing = latest?.accountId == null;
  const groups = groupByAccount(entries ?? []);

  return (
    <div data-testid="account-spawn-log" style={wrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: TYPE.body }}>Which account recent agents ran on</strong>
        <button type="button" style={headerBtn} onClick={() => void load()}>
          <FiRefreshCw size={11} aria-hidden />
          Refresh
        </button>
      </div>

      {pool === "single" && (
        <div style={{ color: C.amberInk, fontSize: TYPE.small, marginTop: 8, lineHeight: 1.45 }}>
          {/* SPEAKS ONLY ABOUT NOW, and that is a correction rather than a style choice. The
              earlier copy asserted "every spawn below used the same account" as fact while deriving
              it solely from the newest entry's count — so a list that legitimately shows two
              accounts (rotation demonstrably having happened before one was signed out) would be
              captioned as if it showed one. A panel written to stop a correct log being misread
              must not itself make an unverified claim about the rows underneath it. */}
          <strong>Right now only one account is signed in</strong>, so new spawns have nowhere to
          rotate to — that is not rotation failing. Sign in another Claude account to give it
          somewhere to go.
          {distinctAccounts > 1 && (
            <> The entries below used {distinctAccounts} different accounts.</>
          )}
        </div>
      )}

      {pool === "none" && choseNothing && (
        <div style={{ color: C.amberInk, fontSize: TYPE.small, marginTop: 8, lineHeight: 1.45 }}>
          {/* NO CLAIM ABOUT THE REGISTRY. The panel cannot observe it, and the one place it
              renders is gated on `accounts.length > 0`, so "none is registered" was false exactly
              where it appeared. All this row can honestly report is that no account was chosen for
              these spawns. */}
          <strong>No account is signed in.</strong> These spawns did not get an account from
          Sparkle at all — they inherited whatever your terminal is logged into. Sign in at least
          two accounts to enable rotation.
        </div>
      )}

      {pool === "none" && !choseNothing && (
        <div style={{ color: C.amberInk, fontSize: TYPE.small, marginTop: 8, lineHeight: 1.45 }}>
          {/* The registry is NOT empty — auto-pick keeps the full account list rather than
              returning nothing, so a real account was chosen and its config dir was exported. Saying
              "Sparkle is not choosing an account" here would contradict the row directly below,
              which names the account it picked. */}
          <strong>No account is signed in.</strong> Spawns are still being routed to{" "}
          {latest?.nickname ?? "a registered account"}, whose config dir has no login — so the agent
          will be asked to sign in when it starts. Complete a sign-in there to fix it.
        </div>
      )}

      {entries == null && (
        <div style={{ color: C.muted, fontSize: TYPE.small, marginTop: 8 }}>Reading the log…</div>
      )}

      {entries != null && entries.length === 0 && (
        <div style={{ color: C.muted, fontSize: TYPE.small, marginTop: 8, lineHeight: 1.45 }}>
          Nothing recorded yet. The log fills in as agents start — it does not backfill, so spawns
          from before this build are not listed.
        </div>
      )}

      {entries != null && entries.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {/* ONE ROW PER ACCOUNT. See `groupByAccount` for why. */}
          {groups.map((g) => (
            <div key={g.accountId ?? "none"} style={row}>
              <strong style={{ color: g.accountId ? C.cream : C.amberInk }}>{g.label}</strong>
              {/* "N shown", never a bare total — see SHOW. Deliberately NOT "N of M": this span sits
                  inside a row labelled with ONE account, so a ratio reads as "this account has M
                  selections and we are showing N", which is false — M is the whole list. The
                  caption under the list already names the population and both its caveats. */}
              <span style={{ color: C.muted }}>{g.count} shown</span>
              <span style={{ color: C.muted }}>
                {REASON_LABEL[g.newest.reason] ?? g.newest.reason}
                {/* An account whose spawns were chosen for DIFFERENT reasons must not be summarised
                    as if one reason covered all of them. The count is the honest qualifier: the
                    label is the newest, and the row says how many it is standing in for. */}
                {g.reasonCount > 1 && ` (newest of ${g.reasonCount} reasons)`}
              </span>
              {g.newest.fraction != null && (
                <span style={{ color: g.newest.fraction >= 0.8 ? C.amberInk : C.muted }}>
                  {Math.round(g.newest.fraction * 100)}% of its limit
                </span>
              )}
              {/* An unmeasured account is NOT an empty one — say so rather than rendering 0%. */}
              {g.newest.fraction == null && g.newest.accountId != null && (
                <span style={{ color: C.muted }}>limit not learned yet</span>
              )}
              <span style={{ color: C.muted, marginLeft: "auto" }}>last {fmtTime(g.newest.at)}</span>
            </div>
          ))}

          {/* THE PER-SPAWN DETAIL, for anyone debugging a specific agent. Collapsed by default — it
              is the list that pushed this screen's controls off the window — and bounded when open,
              so expanding it scrolls inside the disclosure rather than growing the page again.

              The rows are UNMOUNTED while collapsed rather than merely hidden. A `<details>` keeps
              its children in the document, so the ledger would still be paying for 25 rows nobody
              asked for, and every one of the account labels above would appear a second time in the
              tree — which is the same duplication the collapse exists to remove, just invisible. */}
          <button
            type="button"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
            style={disclosureBtn}
          >
            {detailOpen
              ? "Hide the individual selections"
              : entries.length === 1
                ? "Show the single selection"
                : `Show each of the ${entries.length} selections`}
          </button>

          {/* WHAT THE NUMBERS ABOVE ACTUALLY COUNT. Both qualifications are load-bearing: the list
              is truncated to the newest SHOW, and an agent that keeps the account it already had is
              never re-recorded — so neither figure is a spawn total, and the panel says so instead
              of letting a reader assume one. */}
          <div style={{ color: C.muted, fontSize: TYPE.micro, marginTop: 6, lineHeight: 1.45 }}>
            {entries.length >= SHOW
              ? `Newest ${SHOW} recorded selections; older ones are not shown.`
              : `All ${entries.length} recorded selections.`}{" "}
            An agent that keeps the account it already had is not re-recorded, so these are not
            spawn totals.
          </div>
          {detailOpen && (
            <div
              data-testid="spawn-detail-list"
              style={{ maxHeight: DETAIL_MAX_HEIGHT, overflowY: "auto", marginTop: 4 }}
            >
              {entries.map((e, i) => (
                <div key={`${e.at}-${e.key}-${i}`} style={row}>
                  <span style={{ color: C.muted, minWidth: 96 }}>{fmtTime(e.at)}</span>
                  <span style={{ minWidth: 110, color: C.muted }}>{describeKey(e.key)}</span>
                  <strong style={{ color: e.accountId ? C.cream : C.amberInk }}>
                    {/* The authenticated email is the trustworthy label; the nickname is user-typed
                        and has no bearing on which login a config dir actually holds. Fall back only
                        when no identity resolved. */}
                    {e.email ?? e.nickname ?? "no account (used your terminal's login)"}
                  </strong>
                  <span style={{ color: C.muted }}>{REASON_LABEL[e.reason] ?? e.reason}</span>
                  {e.fraction != null && (
                    <span style={{ color: e.fraction >= 0.8 ? C.amberInk : C.muted }}>
                      {Math.round(e.fraction * 100)}% of its limit
                    </span>
                  )}
                  {e.fraction == null && e.accountId != null && (
                    <span style={{ color: C.muted }}>limit not learned yet</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
