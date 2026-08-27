// BlockedAgentsBanner — the RED, worst-case app-shell bar for "these subsystems are COMPLETELY
// BLOCKED right now" (a Claude session/usage limit is exhausted, not merely throttled).
//
// WHY IT IS SEPARATE FROM, AND OUTRANKS, AiServiceBanner. The founder hit exactly the gap this
// closes: his "Improve Sparkle" agent was fully blocked on its session limit while the only bar
// shown softly said "AI-Enhanced features are paused … we keep retrying automatically" — a total
// block narrated as a self-healing degradation. Amber = degraded/paused; RED = blocked. Precedence
// is blocked(red) > degraded(amber) > healthy, and it is enforced two ways: this bar renders ABOVE
// the amber ones, and it writes `blockedSubsystemsStore` so AiServiceBanner steps aside while any
// block stands (it must say the WORST condition, not the mildest).
//
// WHAT IT NAMES, and the honesty rule behind it (see engine/blockedSubsystems.ts). Every AI
// subsystem runs on the user's own `claude` subscription login; an account is a `CLAUDE_CONFIG_DIR`
// with its own usage window. When one account's limit is exhausted, every subsystem bound to it is
// blocked together — for a single-account user that is Improve Sparkle AND AI Enhancement Features
// at once, which is the co-failure the founder saw. The bar lists the subsystems whose OBSERVABLE
// binding resolves to a live-exhausted account and nothing it cannot see; it never invents a block.
//
// The list is dynamic and can be long (a whole fleet on one exhausted account), so it truncates to
// "+N more" and never overflows the bar (BANNER_BAR_TOP_ANCHOR in ProviderUnavailableBanner covers
// the wrap/anchor rules the three amber bars already follow). The one action a user can take —
// switch/re-auth/see per-account usage — lives in Settings → Accounts, so "Manage fleet" opens it.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { FiAlertOctagon } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import {
  computeBlockedSubsystems,
  summarizeBlocked,
  type BlockedSubsystem,
} from "../engine/blockedSubsystems";
import { useBlockedSubsystemsStore } from "../stores/blockedSubsystemsStore";
import { useAccountLimitStore } from "../stores/accountLimitStore";
import { loadAccountState, stickyAccountSnapshot, CONCIERGE_ACCOUNT_KEY } from "../services/accountSelection";
import { accountDisplay, signedInAccountIds, type Account, type Identity } from "../services/accountStore";
import { SPARKLE_AGENT_ID, isSparkleAgentId } from "../services/sparkleAgent";
import { effectiveOneshotAccount } from "../engine/usageLimit";
import { paneAccountMap } from "../services/paneControl";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { BANNER_BAR } from "./ProviderUnavailableBanner";

/** The full-width bar's hook, so a real-layout test can measure the element the user sees. */
export const BLOCKED_AGENTS_BAR_TESTID = "blocked-agents-bar";

/** The clickable CTA's hook, so a test can assert it routes to Accounts without matching prose. */
export const BLOCKED_AGENTS_CTA_TESTID = "blocked-agents-manage-fleet";

/**
 * How many subsystem names show before the rest roll into "+N more".
 *
 * A width bound cannot be measured in jsdom, so the overflow is a fixed cap rather than a live fit —
 * conservative on purpose (a low cap can never overflow a narrow bar). Two matches the founder's own
 * example shape: "…: [A], [B] + 24 more". The full list still reaches a user via Settings → Accounts.
 */
export const BLOCKED_MAX_VISIBLE = 2;

/** How often to re-read account state while deciding whether anything is blocked.
 *
 *  It only runs WHILE a limit is indicated (see the poll gate below), so a healthy machine pays
 *  nothing. It cannot lean on the account cache — a `withIdentities: false` load is never cached
 *  (`accountSelection` only publishes the cache on the identities path) and every load also kicks a
 *  live-usage refresh — so gating the poll, not caching it, is what keeps the cost off the idle case.
 *  `withIdentities: false` still earns its keep by skipping the expensive per-account `.claude.json`
 *  identity parse this banner never reads. */
export const BLOCKED_RECHECK_MS = 20_000;


/** The PRIVACY-SAFE name to show for one account in this red bar.
 *
 *  FOUNDER DIRECTIVE (never surface an email here). A token-based account records the email the
 *  paste authenticated as (`recordOauthIdentity`), and `accountDisplay(...).primary` is exactly that
 *  email — so naming an account by `primary` would print PII on a bar every user sees. This resolves
 *  to the user's OWN label (the nickname) instead, and when there is no nickname falls back to a
 *  non-PII fingerprint (the last 4 of the account id) — NEVER the email, for OAuth or token accounts
 *  alike. `identity` is accepted so the guarantee is testable against an account that HAS an email to
 *  leak; production passes none (the banner loads with `withIdentities: false`), so the nickname path
 *  is the live one and the email is never even read. */
export function blockedAccountName(account: Account, identity?: Identity): string {
  // `?? ""` guards a nickname-less account (never the shape in production, where the field is
  // required, but a partial fixture can omit it) so the trim below can't throw.
  const nickname = (accountDisplay(account, identity).nickname ?? "").trim();
  if (nickname) return nickname;
  // No nickname to show. Do NOT fall back to the email — a non-PII short fingerprint instead, enough
  // for the user to tell two unlabelled accounts apart without exposing the address.
  const id = account.id;
  return id.length > 4 ? `account …${id.slice(-4)}` : `account ${id}`;
}

/** Injectable seams. Real defaults in production; overridden in tests so no IPC or global registry is
 *  needed to drive a render. */
export interface BlockedAgentsBannerDeps {
  loadAccountState: typeof loadAccountState;
  stickyAccountSnapshot: (key: string) => string | undefined;
  paneAccountMap: () => Record<string, string | undefined>;
  agentNames: () => Record<string, string>;
  openAccounts: () => void;
}

const DEFAULT_DEPS: BlockedAgentsBannerDeps = {
  loadAccountState,
  stickyAccountSnapshot,
  paneAccountMap,
  agentNames: () => {
    const out: Record<string, string> = {};
    for (const p of useProjectStore.getState().projects) {
      for (const a of p.agents ?? []) out[a.id] = a.name;
    }
    return out;
  },
  // ONE CLICK to the manage-accounts view (the AccountsScreen where per-account usage / switch /
  // re-auth live), not the Settings → Accounts landing pane, which only carried a second "Manage
  // accounts…" button. `openSettings("accounts")` lands on that intermediate pane; `openManageAccounts`
  // is the direct seam the concierge kebab honours by mounting AccountsScreen straight away.
  openAccounts: () => useUiStore.getState().openManageAccounts(),
};

// See BANNER_BAR_TOP_ANCHOR in ProviderUnavailableBanner — the shell's bars share this shape, so a
// fix that left this one centred vertically would be half a fix. RED fill (`C.sienna`, the brand's
// error/deny colour) is the one deliberate departure from the amber siblings: blocked is not paused.
const bar: CSSProperties = { ...BANNER_BAR, background: C.sienna };

const sentence: CSSProperties = {
  // Overrides a flex item's `min-width: auto` floor so a long list WRAPS instead of spilling off both
  // edges — see BANNER_BAR_TOP_ANCHOR.
  minWidth: 0,
  overflowWrap: "break-word",
};

const cta: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  // `C.onFillInk`, not the local `INK` alias — the SAME value, named so the contrast guard can trace
  // it. `theme/linkContrast` fails closed on an underlined element whose colour it cannot resolve to
  // an ink tier, and a bare `ON_BRAND_FILL_DARK` carries no `C.<name>` for it to read.
  color: C.onFillInk,
  cursor: "pointer",
  font: "inherit",
  fontWeight: FONT_WEIGHT.semibold,
  textDecoration: "underline",
};

/** Build the one sentence the bar shows, with the visible names and any "+N more". Pure over the
 *  already-summarised parts so the exact copy is asserted in a test rather than re-derived here. */
export function blockedSentence(visible: readonly string[], overflow: number): string {
  const names = overflow > 0 ? `${visible.join(", ")} + ${overflow} more` : visible.join(", ");
  return `Blocked due to session limits: ${names}.`;
}

export function BlockedAgentsBanner({ deps }: { deps?: Partial<BlockedAgentsBannerDeps> } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const setBlocked = useBlockedSubsystemsStore((s) => s.setBlocked);
  const blocked = useBlockedSubsystemsStore((s) => s.blocked);

  // A ticker so a bench that lapses on the clock retires the bar on its own, even on an idle screen
  // (mirrors ProviderUnavailableBanner). Unconditional so hook order never changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // POLL GATE — the cost fix. This bar is always mounted, so an unconditional poll would pay a full
  // `loadAccountState` (uncached on the identity-less path) + a per-account live-usage refresh every
  // interval FOREVER on a healthy machine. Instead it polls only while a limit is actually indicated:
  //   • `accountLimitStore.current` is raised by `limitSync` exactly when a real bench lands and
  //     auto-switch cannot rescue it (the "dead in the water" case the founder hit — with a single
  //     account there is no healthy alternative, so it is always raised) — the precise moment this
  //     bar needs to compute; and
  //   • once anything is shown blocked, we keep polling so the bar retires itself when the bench
  //     lapses. When neither holds, `blocked` is already empty and there is nothing to recompute.
  const limitIndicated = useAccountLimitStore((s) => s.current != null);
  const shouldPoll = limitIndicated || blocked.length > 0;

  const { loadAccountState: load, stickyAccountSnapshot: sticky, paneAccountMap: panes, agentNames } =
    d;
  useEffect(() => {
    if (!shouldPoll) return;
    let alive = true;
    const check = () => {
      // WITH IDENTITIES — needed here specifically for the AI-Enhanced failover. This poll runs only
      // while a limit is indicated (see `shouldPoll`), and to decide whether AI-Enhanced is REALLY
      // blocked we must know whether a healthy SIGNED-IN sibling exists to fail over to
      // (`effectiveOneshotAccount`). Without identities every account reads as signed-out, no failover
      // target is ever found, and the bar would keep naming AI-Enhanced blocked while the spawn
      // (`oneshotFailoverConfigDir`) had quietly rotated — the exact banner/spawn disagreement the
      // single-source selector exists to prevent. `blockedAccountName` still resolves by nickname,
      // never email.
      load({ withIdentities: true }).then((state) => {
        if (!alive) return;
        const paneMap = panes();
        // accountId → privacy-safe display name (nickname, never email — the point of the helper).
        const identityById = new Map(state.identities.map((i) => [i.id, i]));
        const accountNames: Record<string, string> = {};
        for (const a of state.accounts) accountNames[a.id] = blockedAccountName(a, identityById.get(a.id));
        const list = computeBlockedSubsystems({
          now: Date.now(),
          usage: state.usage,
          // The account AI-Enhanced ACTUALLY runs under, accounting for failover: when the default is
          // walled but a healthy signed-in sibling exists, this resolves to the sibling, so the bar
          // stops naming AI-Enhanced blocked exactly when the spawn has rotated to it. Same single
          // source the spawn reads (`oneshotFailoverConfigDir`), so the two cannot disagree.
          oneshotAccountId:
            effectiveOneshotAccount({
              accounts: state.accounts,
              usage: state.usage,
              signedInIds: new Set(signedInAccountIds(state.identities)),
              now: Date.now(),
            })?.id ?? null,
          improveSparkleAccountId: sticky(SPARKLE_AGENT_ID) ?? null,
          conciergeAccountId: sticky(CONCIERGE_ACCOUNT_KEY) ?? null,
          panes: Object.entries(paneMap).map(([agentId, accountId]) => ({ agentId, accountId })),
          agentNames: agentNames(),
          accountNames,
          isImproveSparkleAgentId: isSparkleAgentId,
        });
        setBlocked(list);
      });
    };
    check();
    const id = window.setInterval(check, BLOCKED_RECHECK_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // `now` is in the deps so a clock tick re-polls promptly; the seams are stable identities.
  }, [shouldPoll, load, sticky, panes, agentNames, setBlocked, now]);

  // Clear the shared list when this banner unmounts, so the invariant the store and AiServiceBanner
  // both rely on — "empty unless BlockedAgentsBanner is mounted and polling" — actually holds. A
  // stale non-empty list would otherwise keep the amber bar suppressed on a surface that renders it
  // alone, and would leak across tests (the store is a module singleton).
  useEffect(() => () => setBlocked([]), [setBlocked]);

  const summary = useMemo(() => summarizeBlocked(blocked, BLOCKED_MAX_VISIBLE), [blocked]);

  if (blocked.length === 0) return null;

  return (
    <div style={bar} data-testid={BLOCKED_AGENTS_BAR_TESTID}>
      <FiAlertOctagon size={14} style={{ flex: "none", marginTop: 1 }} aria-hidden />
      <span role="status" aria-live="polite" style={sentence}>
        {blockedSentence(summary.visible, summary.overflow)}{" "}
        <button
          type="button"
          style={cta}
          data-testid={BLOCKED_AGENTS_CTA_TESTID}
          onClick={() => d.openAccounts()}
        >
          Manage fleet
        </button>{" "}
        to unblock
      </span>
    </div>
  );
}

/** Re-export the item type so a consumer importing only the component gets it too. */
export type { BlockedSubsystem };
