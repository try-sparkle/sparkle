import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./projectStore";
import type { AgentTabStatus } from "../types";

// The "Dismiss Alert" store surface (advanceAlerts / dismissAlert / reenableAlert). The episode math
// itself is covered in engine/alertDismissal.test.ts; this pins the projectStore integration: the
// per-agent record is advanced/persisted, non-red agents are NOT churned with empty records, and the
// dismiss/re-enable round-trip lands on the agent.
describe("projectStore — Dismiss Alert", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  function setup(): { pid: string; aid: string } {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    return { pid, aid };
  }
  const agentOf = (aid: string) =>
    useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
  const advance = (pid: string, map: Record<string, AgentTabStatus>) =>
    useProjectStore.getState().advanceAlerts(pid, map);

  it("does NOT attach a record to a non-red agent (no blob churn)", () => {
    const { pid, aid } = setup();
    advance(pid, { [aid]: "working" });
    expect(agentOf(aid).alert).toBeUndefined();
  });

  it("records an episode when an agent enters a red status", () => {
    const { pid, aid } = setup();
    advance(pid, { [aid]: "waiting" });
    expect(agentOf(aid).alert).toEqual({ seq: 1, lastRed: "waiting", dismissedSeq: null });
  });

  it("does not bump seq while the same red status persists", () => {
    const { pid, aid } = setup();
    advance(pid, { [aid]: "waiting" });
    advance(pid, { [aid]: "waiting" });
    expect(agentOf(aid).alert!.seq).toBe(1);
  });

  it("dismiss then advance-same keeps it dismissed; a new episode re-alerts", () => {
    const { pid, aid } = setup();
    advance(pid, { [aid]: "waiting" }); // seq 1
    useProjectStore.getState().dismissAlert(pid, aid, "waiting");
    expect(agentOf(aid).alert).toEqual({ seq: 1, lastRed: "waiting", dismissedSeq: 1 });

    advance(pid, { [aid]: "waiting" }); // unchanged → still dismissed
    expect(agentOf(aid).alert!.dismissedSeq).toBe(1);
    expect(agentOf(aid).alert!.seq).toBe(1);

    advance(pid, { [aid]: "errored" }); // NEW/different red episode → seq 2, stale dismissal
    const rec = agentOf(aid).alert!;
    expect(rec.seq).toBe(2);
    expect(rec.dismissedSeq).toBe(1); // 1 !== 2 → no longer suppressed (re-alert)
  });

  it("re-enable clears the dismissal", () => {
    const { pid, aid } = setup();
    advance(pid, { [aid]: "waiting" });
    useProjectStore.getState().dismissAlert(pid, aid, "waiting");
    useProjectStore.getState().reenableAlert(pid, aid);
    expect(agentOf(aid).alert!.dismissedSeq).toBeNull();
    expect(agentOf(aid).alert!.seq).toBe(1); // seq/lastRed untouched
  });

  it("dismiss BEFORE any advance records the episode so it survives the next advance", () => {
    const { pid, aid } = setup();
    expect(agentOf(aid).alert).toBeUndefined(); // advanceAlerts hasn't run yet
    // Dismiss straight away (the button passes the live red status through).
    useProjectStore.getState().dismissAlert(pid, aid, "waiting");
    expect(agentOf(aid).alert).toEqual({ seq: 1, lastRed: "waiting", dismissedSeq: 1 });
    // The next advance for the same status must NOT re-alert (dismissedSeq stays == seq).
    advance(pid, { [aid]: "waiting" });
    const rec = agentOf(aid).alert!;
    expect(rec.seq).toBe(1);
    expect(rec.dismissedSeq).toBe(1);
  });

  it("a worker-attention-injected red AFTER a dismissed-then-cleared episode re-alerts", () => {
    // Regression lock (roborev 35292): the concern is that a stale dismissedSeq===seq could suppress a
    // later overlay-injected red. It can't, because the sidebar calls advanceAlerts on the OVERLAID
    // status map (which already carries the injected red), so seq bumps past the old dismissedSeq.
    const { pid, aid } = setup();
    advance(pid, { [aid]: "waiting" }); // real episode, seq 1
    useProjectStore.getState().dismissAlert(pid, aid, "waiting"); // dismissedSeq 1
    advance(pid, { [aid]: "working" }); // leaves red → lastRed cleared, seq still 1, dismissedSeq 1
    // A worker-attention overlay later injects a virtual red ("approval") — advanceAlerts sees it.
    advance(pid, { [aid]: "approval" });
    const rec = agentOf(aid).alert!;
    expect(rec.seq).toBe(2); // new episode
    expect(rec.dismissedSeq).toBe(1); // stale dismissal < seq → NOT suppressed (re-alerts)
  });

  it("advanceAlerts leaves the projects array identity unchanged when nothing changed", () => {
    const { pid, aid } = setup();
    advance(pid, { [aid]: "waiting" }); // creates the record
    const before = useProjectStore.getState().projects;
    advance(pid, { [aid]: "waiting" }); // no red-signature change
    expect(useProjectStore.getState().projects).toBe(before);
  });
});
