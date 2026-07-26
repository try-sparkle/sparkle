import { describe, expect, it } from "vitest";
import { agentDisplayName } from "./agentDisplayName";

const base = { aiTitle: undefined, autoNameVariants: null, name: "Build agent" } as Parameters<
  typeof agentDisplayName
>[0];

describe("agentDisplayName", () => {
  it("prefers Claude Code's own session title", () => {
    expect(
      agentDisplayName({
        ...base,
        aiTitle: "OG Image Pipeline",
        autoNameVariants: { title: "Auto name", description: "" },
      }),
    ).toBe("OG Image Pipeline");
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
});
