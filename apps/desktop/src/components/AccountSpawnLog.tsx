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

/** How many past selections to show. The ledger keeps 2000; this is a glance, not an audit. */
const SHOW = 25;

/** Human phrasing for why an account was chosen. The distinction that matters is between a rule
 *  that CHOSE and a rule that had no alternative — so "only signed-in account" is surfaced by the
 *  caller from `signedInCount`, not hidden inside these labels. */
const REASON_LABEL: Record<SelectionReason, string> = {
  auto: "picked automatically",
  sticky: "kept its existing account",
  pinned: "pinned by you",
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

export interface AccountSpawnLogProps {
  /** IO seam so the panel can be tested without a backend. Defaults to the real ledger read. */
  read?: (limit: number) => Promise<SpawnLogEntry[]>;
}

export function AccountSpawnLog({ read = readSpawnLog }: AccountSpawnLogProps) {
  const [entries, setEntries] = useState<SpawnLogEntry[] | null>(null);
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

  return (
    <div style={wrap}>
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
          {entries.map((e, i) => (
            <div key={`${e.at}-${e.key}-${i}`} style={row}>
              <span style={{ color: C.muted, minWidth: 96 }}>{fmtTime(e.at)}</span>
              <span style={{ minWidth: 110, color: C.muted }}>{describeKey(e.key)}</span>
              <strong style={{ color: e.accountId ? C.cream : C.amberInk }}>
                {/* The authenticated email is the trustworthy label; the nickname is user-typed and
                    has no bearing on which login a config dir actually holds. Fall back only when
                    no identity resolved. */}
                {e.email ?? e.nickname ?? "no account (used your terminal's login)"}
              </strong>
              <span style={{ color: C.muted }}>{REASON_LABEL[e.reason] ?? e.reason}</span>
              {e.fraction != null && (
                <span style={{ color: e.fraction >= 0.8 ? C.amberInk : C.muted }}>
                  {Math.round(e.fraction * 100)}% of its limit
                </span>
              )}
              {/* An unmeasured account is NOT an empty one — say so rather than rendering 0%. */}
              {e.fraction == null && e.accountId != null && (
                <span style={{ color: C.muted }}>limit not learned yet</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
