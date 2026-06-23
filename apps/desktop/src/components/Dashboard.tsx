import { C, FONT_WEIGHT } from "@sparkle/ui";
import { approveAgent, denyAgent } from "../agentRunner";
import { checkClaude } from "../preflight";
import { useAgentStore } from "../stores/agentStore";
import { sortCards, useSessionStore } from "../stores/sessionStore";
import { AgentCard } from "./AgentCard";
import { ApprovalCard } from "./ApprovalCard";
import { ChatPanel } from "./ChatPanel";
import { ExpertModeDrawer } from "./ExpertModeDrawer";

export function Dashboard() {
  const sessions = useSessionStore((s) => s.sessions);
  const setStatus = useSessionStore((s) => s.setStatus);
  const resolveApproval = useSessionStore((s) => s.resolveApproval);
  const pendingApprovalFor = useSessionStore((s) => s.pendingApprovalFor);
  const startLocalAgent = useSessionStore((s) => s.startLocalAgent);

  async function handleNewAgent() {
    const status = await checkClaude();
    if (!status.installed || !status.path) {
      // TODO: show a "Connect Claude" panel guiding `claude login`.
      console.warn("Claude Code not found — run `claude login` (Max subscription).");
      return;
    }
    // Launch the user's own claude in a local PTY — Sparkle never sees the token.
    await startLocalAgent({ name: "Agent", command: status.path });
  }

  const expertSessionId = useAgentStore((s) => s.expertSessionId);
  const toggleExpert = useAgentStore((s) => s.toggleExpert);
  const floorLevel = useAgentStore((s) => s.floorLevel);
  const chat = useAgentStore((s) => s.chat);
  const addChat = useAgentStore((s) => s.addChat);

  const expertVisible = floorLevel >= 4; // §15
  const ordered = sortCards(sessions);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", height: "100vh" }}>
      <div style={{ padding: 24, overflowY: "auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <img
              src="/sparkle-logo.svg"
              alt="Sparkle"
              style={{ height: 30, display: "block" }}
            />
            <p style={{ color: C.muted, fontSize: 13, margin: "10px 0 20px" }}>
              What's building · what needs you · what shipped
            </p>
          </div>
          <button
            onClick={() => void handleNewAgent()}
            style={{
              background: C.teal,
              color: C.cream,
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 14,
              fontWeight: FONT_WEIGHT.medium,
              cursor: "pointer",
              height: "fit-content",
            }}
          >
            + New Agent
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: 16,
            alignItems: "start",
          }}
        >
          {ordered.map((s) => {
            const approval =
              s.status === "waiting" ? pendingApprovalFor(s.id) : undefined;

            if (approval) {
              return (
                <ApprovalCard
                  key={s.id}
                  approval={approval}
                  onApprove={() => {
                    void approveAgent(s.id).catch(() => {}); // no-op for mock (no PTY)
                    resolveApproval(approval.id);
                    setStatus(s.id, "active");
                  }}
                  onDeny={() => {
                    void denyAgent(s.id).catch(() => {});
                    resolveApproval(approval.id);
                    setStatus(s.id, "paused");
                  }}
                  onAskMore={() => {}}
                />
              );
            }

            return (
              <div key={s.id} style={{ display: "flex", flexDirection: "column" }}>
                <AgentCard
                  session={s}
                  expertVisible={expertVisible}
                  expertOpen={expertSessionId === s.id}
                  onPause={() =>
                    setStatus(s.id, s.status === "paused" ? "active" : "paused")
                  }
                  onDetails={() => {}}
                  onToggleExpert={() => toggleExpert(s.id)}
                />
                {expertVisible && expertSessionId === s.id && (
                  <ExpertModeDrawer lines={s.rawTerminal} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ borderLeft: "1px solid #0d140f", background: C.deepForest }}>
        <ChatPanel
          messages={chat}
          onAction={(action) =>
            addChat({
              id: crypto.randomUUID(),
              role: "user",
              text: action === "start_building" ? "Start building" : action,
              timestamp: new Date().toISOString(),
            })
          }
        />
      </div>
    </div>
  );
}
