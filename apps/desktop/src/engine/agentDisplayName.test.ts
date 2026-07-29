import { describe, expect, it } from "vitest";
import { agentDisplayName } from "./agentDisplayName";

const base = {
  aiTitle: undefined,
  autoNameVariants: null,
  name: "Build agent",
  namePinned: false,
  selfNamed: false,
} as Parameters<typeof agentDisplayName>[0];

describe("agentDisplayName", () => {
  // A LIVE title wins, and the fixture is the one production actually produces: `applyAiTitle` sets
  // `autoNameVariants = nameFromTitle(t)`, i.e. the title verbatim. (This case used to be written
  // with a DIFFERENT variants title, asserting that `aiTitle` beat it — a shape that only occurs
  // when the variants are the FRESHER of the two, so the old fixture was pinning the bug below.)
  it("prefers Claude Code's own session title", () => {
    expect(
      agentDisplayName({
        ...base,
        aiTitle: "OG Image Pipeline",
        autoNameVariants: { title: "OG Image Pipeline", description: "" },
      }),
    ).toBe("OG Image Pipeline");
  });

  // The other half of "one agent, one name" (roborev 55220). `aiTitle` is deliberately allowed to go
  // stale — `autoRenameAgent` renames past it and never updates it — so an agent whose work moved on
  // from its first turn carries a superseded title. The sidebar shows the fresh auto-name; leading
  // with the title showed the superseded one everywhere else.
  it("shows the CURRENT auto-name over a session title it has already moved past", () => {
    expect(
      agentDisplayName({
        ...base,
        name: "Retry Backoff",
        autoNameVariants: { title: "Retry Backoff", description: "" },
        aiTitle: "Make YouTube videos full width of page",
      }),
    ).toBe("Retry Backoff");
  });

  // The sidebar's own formula (AgentSidebar renders `autoNameVariants?.title || name` and never
  // reads `aiTitle`). Asserted as an AGREEMENT rather than a literal: the sidebar is the row the
  // user clicks, so any surface that disagrees with it is the one that is wrong.
  it("agrees with the sidebar's formula for an auto-named agent", () => {
    const a = {
      ...base,
      name: "Retry Backoff",
      autoNameVariants: { title: "Retry Backoff", description: "" },
      aiTitle: "Make YouTube videos full width of page",
    };
    expect(agentDisplayName(a)).toBe(a.autoNameVariants?.title || a.name);
  });

  it("falls back to the auto-namer's title", () => {
    expect(
      agentDisplayName({ ...base, autoNameVariants: { title: "Auto name", description: "" } }),
    ).toBe("Auto name");
  });

  it("falls back to the creation name last", () => {
    expect(agentDisplayName(base)).toBe("Build agent");
  });

  it("skips an empty aiTitle rather than showing a blank name", () => {
    expect(agentDisplayName({ ...base, aiTitle: "" })).toBe("Build agent");
  });

  // The two-names-for-one-agent bug. `selfNameAgent`/`renameAgent` clear `autoNameVariants` but
  // deliberately keep `aiTitle` (it is the auto-namer's race anchor), so before this rule the chain
  // still answered with the stale session title while `agent.name` — which get_state and the build
  // column read — answered with the chosen one. The exact observed pair is used as the fixture.
  const CHOSEN = "Concierge Issue Triage";
  const STALE_TITLE = "Debug Sparkle concierge agent control and capacity issues";

  it("shows the name the AGENT chose over the session title it was derived from", () => {
    expect(
      agentDisplayName({ ...base, name: CHOSEN, selfNamed: true, aiTitle: STALE_TITLE }),
    ).toBe(CHOSEN);
  });

  it("shows the name the HUMAN pinned over the session title", () => {
    expect(
      agentDisplayName({ ...base, name: CHOSEN, namePinned: true, aiTitle: STALE_TITLE }),
    ).toBe(CHOSEN);
  });

  // The other half of the same guarantee: this rule and a raw `agent.name` read must AGREE for an
  // authoritative name, because the surfaces that do each are on screen at the same time.
  it("agrees with a raw `name` read whenever the name is authoritative", () => {
    const agent = { ...base, name: CHOSEN, selfNamed: true, aiTitle: STALE_TITLE };
    expect(agentDisplayName(agent)).toBe(agent.name);
  });

  it("still lets the session title win when nothing has claimed the name", () => {
    expect(agentDisplayName({ ...base, name: CHOSEN, aiTitle: STALE_TITLE })).toBe(STALE_TITLE);
  });
});
