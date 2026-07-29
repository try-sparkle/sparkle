import { describe, it, expect } from "vitest";
import {
  AGENT_REF_SCHEME,
  agentRefHref,
  parseAgentRefHref,
  stripAgentRefs,
  stripMentionSigil,
} from "./agentRefs";

describe("parseAgentRefHref", () => {
  it("reads the id out of a well-formed reference", () => {
    expect(parseAgentRefHref("sparkle-agent:f2169b97-3a27-454a")).toBe("f2169b97-3a27-454a");
    expect(parseAgentRefHref(agentRefHref("agent-7"))).toBe("agent-7");
  });

  it("tolerates the leading whitespace markdown can carry into an href", () =>
    expect(parseAgentRefHref("  sparkle-agent:agent-7  ")).toBe("agent-7"));

  it("matches the scheme case-insensitively, as URL schemes are", () =>
    expect(parseAgentRefHref("SPARKLE-AGENT:agent-7")).toBe("agent-7"));

  it("returns null for every other scheme, so ordinary links are untouched", () => {
    for (const href of [
      "https://example.com",
      "mailto:a@b.c",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "vscode://file/etc/passwd",
      "sparkle-agentx:agent-7", // near-miss scheme
      "not-a-scheme",
      "",
    ]) {
      expect(parseAgentRefHref(href)).toBeNull();
    }
  });

  it("returns null for a non-string href", () => {
    expect(parseAgentRefHref(undefined)).toBeNull();
  });

  it("REFUSES a malformed id rather than passing model output through", () => {
    // The id reaches a store lookup and a navigation call, and it arrives inside model-authored
    // text. Anything outside the conservative id class is refused; the pill then renders inert and
    // the reader still sees the plain name, so refusing costs a click and nothing else.
    for (const bad of [
      "sparkle-agent:", // empty
      "sparkle-agent:../../etc/passwd",
      "sparkle-agent:agent 7", // whitespace
      "sparkle-agent:agent'7",
      "sparkle-agent:<script>",
      "sparkle-agent:agent/7",
      `sparkle-agent:${"a".repeat(129)}`, // over the length bound
    ]) {
      expect(parseAgentRefHref(bad)).toBeNull();
    }
  });

  it("accepts an id exactly at the length bound and refuses one past it", () => {
    expect(parseAgentRefHref(`${AGENT_REF_SCHEME}${"a".repeat(128)}`)).toHaveLength(128);
    expect(parseAgentRefHref(`${AGENT_REF_SCHEME}${"a".repeat(129)}`)).toBeNull();
  });

  it("does not treat a TRUNCATED token as a reference", () =>
    // The thread store clips a persisted message at 4000 chars, so a restored bubble can hold a
    // half-written link. It must degrade to text, never resolve to a partial id.
    expect(parseAgentRefHref("sparkle-a")).toBeNull());
});

describe("stripMentionSigil", () => {
  it("removes the sigil the persona asks the model to write", () =>
    expect(stripMentionSigil("@Kraken Auth")).toBe("Kraken Auth"));

  it("leaves a name that has no sigil alone", () =>
    expect(stripMentionSigil("Kraken Auth")).toBe("Kraken Auth"));

  it("removes only ONE sigil, so a name that really starts with @ survives", () =>
    expect(stripMentionSigil("@@odd")).toBe("@odd"));

  it("trims surrounding whitespace", () =>
    expect(stripMentionSigil("  @Kraken Auth  ")).toBe("Kraken Auth"));
});

describe("stripAgentRefs — the clipboard is the second consumer", () => {
  it("flattens a reference to the words the pill shows", () =>
    expect(stripAgentRefs("Ask [@Kraken Auth](sparkle-agent:9f3c1d2e) about it.")).toBe(
      "Ask @Kraken Auth about it.",
    ));

  it("flattens EVERY reference in a message, not just the first", () =>
    expect(
      stripAgentRefs("[@A](sparkle-agent:a1) and [@B](sparkle-agent:b2) both replied."),
    ).toBe("@A and @B both replied."));

  it("emits exactly one sigil whether or not the model wrote one", () => {
    // The persona ASKS for `[@Name](…)`, but it is a request to a language model, not a schema —
    // the pill strips the sigil and draws its own for exactly this reason, and so does this.
    expect(stripAgentRefs("[@Kraken Auth](sparkle-agent:a1)")).toBe("@Kraken Auth");
    expect(stripAgentRefs("[Kraken Auth](sparkle-agent:a1)")).toBe("@Kraken Auth");
  });

  it("leaves an ORDINARY link alone — it is part of the answer", () =>
    expect(stripAgentRefs("See [the runbook](https://example.com/r) first.")).toBe(
      "See [the runbook](https://example.com/r) first.",
    ));

  it("leaves a MALFORMED reference literal, exactly as the renderer does", () =>
    // Same test for "ours" as the renderer (`parseAgentRefHref`), so the two cannot disagree about
    // which links are references: an id that fails the trust boundary is flattened by neither.
    expect(stripAgentRefs("[@x](sparkle-agent:bad id)")).toBe("[@x](sparkle-agent:bad id)"));

  it("leaves ordinary markdown structure untouched — the reason this button copies source", () => {
    const md = "| a | b |\n| - | - |\n\n```ts\nconst x = 1;\n```";
    expect(stripAgentRefs(md)).toBe(md);
  });

  it("is a no-op on text with no links at all", () =>
    expect(stripAgentRefs("just words")).toBe("just words"));
});
