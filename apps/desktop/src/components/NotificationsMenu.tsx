import { AGENT_STATUS } from "../theme/colors";
import type { AgentTabStatus } from "../types";
import { useSettingsStore } from "../stores/settingsStore";
import { SettingCheckbox } from "./SettingCheckbox";

// "Notifications" control for the TopBar ⋯ menu: a checkbox per agent status that, when checked,
// fires a Notification Center banner the moment any agent crosses INTO that status. Backed by
// settingsStore.notifyStatuses (persisted). The dock badge is separate and always tracks the
// waiting/approval count regardless of these toggles.
//
// We surface the statuses a user actually reasons about — the red tier (needs you / crashed) and
// the finished tier (your turn / done). The remaining states are intentionally NOT offered:
// `working` flips on every turn (notification spam) and `stopped`/`new` are passive. They
// stay off and UNLISTED HERE — which is not the same as unreachable: `set_notification_rule`
// (services/conciergeTools/settings.ts) validates against the store's own key set, so the concierge
// can still turn any of them on. Widen this list if that changes. (`new` — spawned, never briefed —
// is the strongest case for staying out of the UI: it is the ABSENCE of an ask, so a banner for it
// would be the app reminding the user about their own un-actioned intent. See
// engine/newAgentAttention.ts.)
const NOTIFY_OPTIONS: Array<{ status: AgentTabStatus; label: string }> = [
  { status: "waiting", label: "Needs your answer (a question)" },
  { status: "approval", label: "Needs your approval" },
  { status: "errored", label: "Errored or crashed" },
  // ── LISTED 2026-08-18, AND ITS OLD JUSTIFICATION FOR BEING HIDDEN IS NOW FALSE ────────────────
  // `blocked` sat with `stopped`/`new` above under the word "passive", from when it meant only
  // statusEngine's quiet-settle stall timer. It no longer does. `stallEscalation.OUTSTANDING` now
  // admits a cause ONLY when the founder is the one actor who can clear it, and one of its members
  // is `blocked-on-human` — the agent was asked point-blank what was blocking it and answered that a
  // PERSON is. Calling that passive is exactly the mismatch the founder reported on 2026-08-18, one
  // layer up from the dot.
  //
  // ⚠️ STILL OFF BY DEFAULT (DEFAULT_NOTIFY_STATUSES.blocked === false) and that is not a nicety.
  // The status is shared by every OUTSTANDING cause, so this toggle cannot be scoped to the
  // blocked-on-human one alone — the notification pipeline keys on STATUS (`attention.newlyEntered`
  // over the enabled set) and has no access to stall causes, which are computed in AgentSidebar.
  // Defaulting it on would page for the whole red tier, which is the storm `attention.ATTENTION`
  // deliberately avoids. Listing it makes the choice discoverable instead of concierge-only; a
  // cause-scoped banner needs plumbing that does not exist yet.
  { status: "blocked", label: "Blocked — only you can unstick it" },
  { status: "idle", label: "Finished a turn — your turn" },
  { status: "done", label: "Done / completed" },
];

/** A small status-color dot, so each row is tied to the same color the agent shows in the sidebar. */
function StatusDot({ status }: { status: AgentTabStatus }) {
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 auto",
        width: 8,
        height: 8,
        marginTop: 5,
        borderRadius: "50%",
        background: AGENT_STATUS[status].color,
      }}
    />
  );
}

export function NotificationsMenu() {
  const notifyStatuses = useSettingsStore((s) => s.notifyStatuses);
  const setNotifyStatus = useSettingsStore((s) => s.setNotifyStatus);

  return (
    <div>
      {NOTIFY_OPTIONS.map(({ status, label }) => (
        <SettingCheckbox
          key={status}
          label={label}
          checked={!!notifyStatuses[status]}
          onToggle={() => setNotifyStatus(status, !notifyStatuses[status])}
          accessory={<StatusDot status={status} />}
        />
      ))}
    </div>
  );
}
