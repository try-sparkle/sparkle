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
// `working` flips on every turn (notification spam) and `blocked`/`stopped` are passive. They stay
// off and unlisted; widen this list if that changes.
const NOTIFY_OPTIONS: Array<{ status: AgentTabStatus; label: string }> = [
  { status: "waiting", label: "Needs your answer (a question)" },
  { status: "approval", label: "Needs your approval" },
  { status: "errored", label: "Errored or crashed" },
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
