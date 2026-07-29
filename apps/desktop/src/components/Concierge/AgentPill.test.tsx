// @vitest-environment jsdom
//
// The pill an agent NAMED BY THE CONCIERGE draws as, and its one degradation path.
//
// The second describe renders through `<Markdown>` rather than mounting the pill directly: the
// whole design rests on react-markdown handing a `sparkle-agent:` href to the link override, and a
// test that only mounts `AgentPill` would keep passing if that wiring were removed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bandColor } from "../../engine/statusBandLabels";
import { asRgb } from "../statusDotTestUtils";
import { Markdown } from "../Markdown";
import { AgentPill, AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import { agentRefHref } from "./agentRefs";
import type { MentionAgent } from "./mentions";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return {
    projectId: "p1",
    projectName: "web",
    band: "running",
    canAcceptInput: true,
    ...over,
  };
}

const KRAKEN = agent({ id: "agent-7", name: "Kraken Auth", band: "needs_you" });

function ctx(over: Partial<AgentPillContextValue> = {}): AgentPillContextValue {
  return { agents: [KRAKEN], onOpenAgent: vi.fn(), ...over };
}

function mountPill(value: AgentPillContextValue, agentId: string, fallbackName: string) {
  return render(
    <AgentPillProvider value={value}>
      <AgentPill agentId={agentId} fallbackName={fallbackName} />
    </AgentPillProvider>,
  );
}

function mountMarkdown(value: AgentPillContextValue, text: string) {
  return render(
    <AgentPillProvider value={value}>
      <Markdown text={text} />
    </AgentPillProvider>,
  );
}

describe("AgentPill — resolved", () => {
  it("renders as a button carrying the agent's id and band", () => {
    mountPill(ctx(), "agent-7", "@Kraken Auth");
    const pill = screen.getByTestId("concierge-agent-pill");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("data-agent-id")).toBe("agent-7");
    expect(pill.getAttribute("data-band")).toBe("needs_you");
  });

  it("draws exactly ONE sigil even though the model was asked to write it too", () => {
    // The persona asks for `[@Name](…)` and the pill draws its own `@`; a compliant model would
    // otherwise produce "@@Kraken Auth".
    mountPill(ctx(), "agent-7", "@Kraken Auth");
    expect(screen.getByTestId("concierge-agent-pill").textContent).toMatch(/^@Kraken Auth$/);
  });

  it("paints its dot with the SHARED band color, not a private copy", () => {
    // Same resolution the build rows and the mention picker use (bandColor → AGENT_STATUS), so a
    // pill and the row it points at cannot drift apart.
    for (const band of ["needs_you", "running", "done"] as const) {
      cleanup();
      mountPill(ctx({ agents: [agent({ id: "a", name: "N", band })] }), "a", "@N");
      const dot = screen.getByTestId("concierge-agent-pill").querySelector("span");
      expect(dot).not.toBeNull();
      expect(dot!.style.background).toBe(asRgb(bandColor(band)));
    }
  });

  it("shows the LIVE name, not the name the message was written with", () => {
    // The founder's criterion: "renamed agents update in place; the pill binds to agent ID, not the
    // name string." The message still says "Kraken", the roster says "Kraken Auth v2".
    mountPill(
      ctx({ agents: [agent({ id: "agent-7", name: "Kraken Auth v2" })] }),
      "agent-7",
      "@Kraken",
    );
    // Exact, not `toContain`: the stale name "Kraken" is a PREFIX of the live one, so a containment
    // check would pass even if the pill were still rendering what the message said.
    expect(screen.getByTestId("concierge-agent-pill").textContent).toBe("@Kraken Auth v2");
  });

  it("names the project in its tooltip, which is what tells four same-named agents apart", () => {
    mountPill(ctx(), "agent-7", "@Kraken Auth");
    expect(screen.getByTestId("concierge-agent-pill").getAttribute("title")).toBe("Open Kraken Auth in web");
  });

  it("opens the agent WITH its project id, which the reveal path needs", () => {
    const onOpenAgent = vi.fn();
    mountPill(ctx({ onOpenAgent }), "agent-7", "@Kraken Auth");
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    // Named fields, not positional strings: `openProjectTab` takes (projectId, agentId) — the
    // OPPOSITE order, both `string` — so a positional signature would let a swap typecheck and fail
    // silently at runtime (roborev 54894).
    expect(onOpenAgent).toHaveBeenCalledWith({ agentId: "agent-7", projectId: "p1" });
  });
});

describe("AgentPill — unresolved", () => {
  it("is inert, explains itself, and still reads as the agent's name", () => {
    // The founder's criterion: a closed or discarded agent renders inert with a tooltip, not a dead
    // link. The reader is looking at real history; the sentence must still make sense.
    mountPill(ctx(), "agent-gone", "@Retired Agent");
    const inert = screen.getByTestId("concierge-agent-pill-inert");
    expect(inert.tagName).not.toBe("BUTTON");
    expect(inert.textContent).toContain("@Retired Agent");
    expect(inert.getAttribute("title")).toMatch(/no longer open/i);
    expect(screen.queryByTestId("concierge-agent-pill")).toBeNull();
  });

  it("does not call the opener when clicked", () => {
    const onOpenAgent = vi.fn();
    mountPill(ctx({ onOpenAgent }), "agent-gone", "@Retired Agent");
    fireEvent.click(screen.getByTestId("concierge-agent-pill-inert"));
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("renders inert with NO provider at all, so other markdown surfaces are unaffected", () => {
    // SupportModal and agent replies render <Markdown> outside the concierge column. An agent link
    // there must degrade, never throw and never render a button wired to nothing.
    render(<Markdown text={`Ask [@Kraken Auth](${agentRefHref("agent-7")}) about it.`} />);
    expect(screen.getByTestId("concierge-agent-pill-inert").textContent).toContain("@Kraken Auth");
  });
});

describe("degradation of a non-plain link text", () => {
  it("recovers the name from INSIDE elements, so it never renders a bare @", () => {
    // `[**@Kraken Auth**](…)` is ordinary markdown a model emits unprompted. Keeping only direct
    // string children made the fallback "", so an unresolvable pill rendered as a bare "@"
    // mid-sentence — "Ask @ about it." — defeating the degradation contract (roborev 54894).
    mountMarkdown(ctx(), `Ask [**@Retired Agent**](${agentRefHref("agent-gone")}) about it.`);
    const inert = screen.getByTestId("concierge-agent-pill-inert");
    expect(inert.textContent).toBe("@Retired Agent");
    expect(document.body.textContent).not.toContain("Ask @ about");
  });
});

describe("Markdown integration", () => {
  it("turns a sparkle-agent link into a live pill", () => {
    mountMarkdown(ctx(), `You should ask [@Kraken Auth](${agentRefHref("agent-7")}) about it.`);
    expect(screen.getByTestId("concierge-agent-pill").getAttribute("data-agent-id")).toBe("agent-7");
  });

  it("still renders an ordinary https link exactly as before", () => {
    mountMarkdown(ctx(), "See [the docs](https://example.com/x).");
    const a = screen.getByText("the docs");
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(screen.queryByTestId("concierge-agent-pill")).toBeNull();
  });

  it("still refuses a dangerous scheme — the pill path must not have widened the allowlist", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "vscode://x"]) {
      cleanup();
      mountMarkdown(ctx(), `[click](${href})`);
      const a = screen.getByText("click");
      expect(a.getAttribute("href")).toBeNull();
      expect(screen.queryByTestId("concierge-agent-pill")).toBeNull();
    }
  });

  it("renders a TRUNCATED token as readable text instead of throwing", () => {
    // The thread store clips a persisted message at 4000 chars with "… (truncated)", so a restored
    // bubble can hold a half-written link. This is the shape that reaches the renderer.
    mountMarkdown(ctx(), "Ask [@Kraken Auth](sparkle-a… (truncated)");
    expect(screen.queryByTestId("concierge-agent-pill")).toBeNull();
    expect(document.body.textContent).toContain("Kraken Auth");
  });

  it("refuses a malformed id rather than resolving it", () => {
    mountMarkdown(ctx(), "Ask [@Kraken Auth](sparkle-agent:../../etc/passwd) about it.");
    expect(screen.queryByTestId("concierge-agent-pill")).toBeNull();
    expect(document.body.textContent).toContain("Kraken Auth");
  });
});
