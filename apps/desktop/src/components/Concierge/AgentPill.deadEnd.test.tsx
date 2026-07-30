// @vitest-environment jsdom
//
// THE CONTRACT: clicking an agent pill NEVER results in no visible change.
//
// The bug this file exists for: a pill labelled "Remove BYOK" was clicked and nothing happened —
// no navigation, no error, no explanation. A dead link that fails silently is worse than no link,
// because the reader cannot tell whether the agent is gone or whether the click registered.
//
// Two distinct silent paths produced that, and both are covered below:
//
//   • THE ID NO LONGER RESOLVES. Agents get closed and discarded, and a pill embeds a hard id. The
//     BYOK migration really did run under ids that are not in the roster today. Those pills
//     rendered a muted span whose only explanation was a `title` tooltip — hover-only, so a CLICK
//     produced nothing at all.
//   • THE REVEAL DOES NOT LAND. `openProjectTab` returns early on an unknown project and
//     `selectAndOpen` on a missing agent, both silently — so a pill whose agent was closed after
//     the reply rendered looks live, is clicked, and does nothing. The pill cannot predict this
//     (see the "no other-window state" note in AgentPill.tsx); it has to believe the OUTCOME.
//
// The cases are named (a)–(d) in the titles: they are the states a pill can be in, and the
// contract is that every one of them is visible to the reader.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPill, AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import type { MentionAgent } from "./mentions";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}

/** "Build 8" — the real shape of the agent whose pill went dead. */
const BUILD8 = agent({ id: "b78f9f8c", name: "Build 8" });

function ctx(over: Partial<AgentPillContextValue> = {}): AgentPillContextValue {
  return { agents: [BUILD8], onOpenAgent: vi.fn(() => true), onSeeHistory: vi.fn(), ...over };
}

function mount(value: AgentPillContextValue, agentId: string, fallbackName: string) {
  return render(
    <AgentPillProvider value={value}>
      <AgentPill agentId={agentId} fallbackName={fallbackName} />
    </AgentPillProvider>,
  );
}

/** Everything the reader can see, so "did the click change anything" is answerable as one string. */
const visible = () => document.body.textContent ?? "";

describe("a pill click never dead-ends", () => {
  it("(a) live and reachable — clicking navigates to that agent and explains nothing", () => {
    const onOpenAgent = vi.fn(() => true);
    mount(ctx({ onOpenAgent }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    // Named fields, not positional strings: `openProjectTab` takes (projectId, agentId) — the
    // opposite order, both `string` — so a swap would typecheck and fail silently (roborev 54894).
    expect(onOpenAgent).toHaveBeenCalledWith({ agentId: "b78f9f8c", projectId: "p1" });
    // Navigation IS the visible change here, so this case must NOT also open a notice.
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
  });

  it("(b) the reveal does NOT land — the pill says so instead of failing silently", () => {
    // The agent was closed between the render that drew this pill and the click that hit it, so
    // the reveal path bails. Previously this was the whole bug: a live-looking pill, a click, and
    // an unchanged screen.
    const onOpenAgent = vi.fn(() => false);
    const before = visible();
    mount(ctx({ onOpenAgent }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    expect(onOpenAgent).toHaveBeenCalled();
    const notice = screen.getByTestId("concierge-agent-pill-notice");
    expect(notice.textContent).toContain("Build 8");
    expect(notice.textContent).toMatch(/closed/i);
    // The whole point: the click CHANGED what is on screen.
    expect(visible()).not.toBe(before);
  });

  it("(b) a failed reveal also offers the history route, same as a known-closed pill", () => {
    const onSeeHistory = vi.fn();
    mount(ctx({ onOpenAgent: () => false, onSeeHistory }), "b78f9f8c", "@Build 8");
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    fireEvent.click(screen.getByTestId("concierge-agent-pill-notice-action"));
    expect(onSeeHistory).toHaveBeenCalledWith({ agentId: "b78f9f8c", name: "Build 8" });
  });

  it("(c) unresolvable id — clicking shows a named closed state, not nothing", () => {
    // "Build 8 is closed" — non-alarming, and it names the agent so the reader knows WHICH pill
    // they clicked. The old behavior put this in a `title` attribute, which a click never reveals.
    const before = visible();
    mount(ctx({ agents: [] }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));

    const notice = screen.getByTestId("concierge-agent-pill-notice");
    expect(notice.textContent).toContain("Build 8");
    expect(notice.textContent).toMatch(/closed/i);
    expect(visible()).not.toBe(before);
  });

  it("(c) unresolvable id — the closed state routes to that agent's prompt history", () => {
    // A closed agent's prompts are still searchable (services/history), which is exactly how the
    // dead BYOK ids were recovered. So the dead end becomes a destination.
    const onSeeHistory = vi.fn();
    mount(ctx({ agents: [], onSeeHistory }), "b78f9f8c", "@Build 8");
    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));
    fireEvent.click(screen.getByTestId("concierge-agent-pill-notice-action"));
    expect(onSeeHistory).toHaveBeenCalledWith({ agentId: "b78f9f8c", name: "Build 8" });
  });

  it("(d) renamed live agent — renders its CURRENT name, not the label frozen at write time", () => {
    // Real case: a0d5dc98… was "Build 9" when it received the BYOK PRD and is "Talk/Send Mode
    // Slider" today. A pill still reading "Build 9" sends the reader somewhere unrecognisable.
    mount(
      ctx({ agents: [agent({ id: "a0d5dc98", name: "Talk/Send Mode Slider" })] }),
      "a0d5dc98",
      "@Build 9",
    );
    // Exact, not `toContain`: a containment check would pass on a pill still rendering "Build 9"
    // if the live name merely appeared somewhere nearby.
    expect(screen.getByTestId("concierge-agent-pill").textContent).toBe("@Talk/Send Mode Slider");
    expect(visible()).not.toContain("Build 9");
  });

  it("(d) renamed agent whose reveal fails — the NOTICE names it currently too, not the stale label", () => {
    // The rename rule has to hold in the state that spells the name out in a sentence, otherwise
    // the one place the name is read as prose is the one place it goes stale.
    mount(
      ctx({
        agents: [agent({ id: "a0d5dc98", name: "Talk/Send Mode Slider" })],
        onOpenAgent: () => false,
      }),
      "a0d5dc98",
      "@Build 9",
    );
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    const notice = screen.getByTestId("concierge-agent-pill-notice");
    expect(notice.textContent).toContain("Talk/Send Mode Slider");
    expect(notice.textContent).not.toContain("Build 9");
  });
});

describe("the failed state is about a MOMENT, never sticky", () => {
  it("re-attempts on the next click, so a recovered agent opens on ONE click", () => {
    // Close a project, click the pill, reopen the project. The id is stable and the agent is back.
    // A pill that kept asserting "closed" — and whose first click merely dismissed its own notice —
    // would be the dead end one state deeper: the click meant to retry does nothing (roborev 55548).
    let reachable = false;
    const onOpenAgent = vi.fn(() => reachable);
    mount(ctx({ onOpenAgent }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(/closed/i);

    reachable = true; // the project is reopened
    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));

    // ONE click: it navigated, and the stale claim is gone.
    expect(onOpenAgent).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
    expect(screen.getByTestId("concierge-agent-pill")).toBeTruthy();
  });

  it("(b) a REPEATED failure is still acknowledged — the retry is never a silent no-op", () => {
    // A boolean state could not express this: setting "closed" on an already-closed pill is an
    // identical-value update, React bails out, and the reader's second click paints and announces
    // nothing — the dead end one step further out (roborev 55590).
    mount(ctx({ onOpenAgent: () => false }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    const first = screen.getByTestId("concierge-agent-pill-notice");
    const firstText = first.textContent;
    expect(firstText).toMatch(/Build 8 is closed/i);

    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));

    const second = screen.getByTestId("concierge-agent-pill-notice");
    // The WORDS changed, so the second failure is visible…
    expect(second.textContent).not.toBe(firstText);
    expect(second.textContent).toMatch(/still closed/i);
    // …and the region's child was REPLACED, which is what makes it an announcement rather than an
    // identical re-render a screen reader drops.
    expect(second).not.toBe(first);
  });

  it("(b) the retry pill does not advertise itself as a collapsible disclosure", () => {
    // It never collapses — activating it re-attempts. `aria-expanded` here would promise assistive
    // tech a control that cannot be un-expanded. The known-closed pill, which IS a toggle, keeps it.
    mount(ctx({ onOpenAgent: () => false }), "b78f9f8c", "@Build 8");
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    const retry = screen.getByTestId("concierge-agent-pill-closed");
    expect(retry.getAttribute("aria-expanded")).toBeNull();
    expect(retry.getAttribute("aria-controls")).toBe(
      screen.getByTestId("concierge-agent-pill-live").id,
    );
  });
});

describe("an unwired surface says nothing about the agent's lifecycle", () => {
  it("renders a LIVE agent as inert prose, not as closed, when no opener is wired", () => {
    // "This column has no reveal path" is a fact about the surface; "that agent is closed" is a
    // fact about the agent. Rendering the first as the second is a false claim (roborev 55548).
    mount({ agents: [BUILD8], onSeeHistory: vi.fn() } as AgentPillContextValue, "b78f9f8c", "@Build 8");

    const pill = screen.getByTestId("concierge-agent-pill-unwired");
    expect(pill.tagName).not.toBe("BUTTON");
    expect(pill.textContent).toContain("@Build 8");
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
    expect(visible()).not.toMatch(/closed/i);
  });

  it("makes NO closed claim with no provider at all — the case that actually reaches readers", () => {
    // SupportModal and agent replies render <Markdown> with no provider, so they get EMPTY
    // (`agents: []`) and every pill used to fall through to "…is closed" — a false statement about
    // a live agent, on the only path a reader hits. "Not in the roster I was given" is evidence of
    // nothing when there was no roster to look in (roborev 55590).
    mount({ agents: [] } as unknown as AgentPillContextValue, "b78f9f8c", "@Build 8");

    const pill = screen.getByTestId("concierge-agent-pill-unwired");
    expect(pill.textContent).toContain("@Build 8");
    expect(pill.getAttribute("title")).toBeNull();
    expect(visible()).not.toMatch(/closed/i);
  });
});

describe("the explanation is announced, not merely painted", () => {
  it("keeps the live region MOUNTED before the click, so the notice is an update to it", () => {
    // A role="status" element created with its text already inside it is commonly not announced —
    // notably VoiceOver in a WebKit webview, which is what this app renders in. If the region only
    // appeared along with the sentence, the contract would hold for sighted readers and fail for
    // everyone else (roborev 55522).
    mount(ctx({ agents: [] }), "b78f9f8c", "@Build 8");
    const region = screen.getByTestId("concierge-agent-pill-live");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");

    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));

    // SAME node, now filled — an update to a live region, not a new one.
    expect(screen.getByTestId("concierge-agent-pill-live")).toBe(region);
    expect(region.textContent).toContain("Build 8 is closed.");
  });

  it("points the pill's aria-controls at that region", () => {
    mount(ctx({ agents: [] }), "b78f9f8c", "@Build 8");
    const pill = screen.getByTestId("concierge-agent-pill-closed");
    const region = screen.getByTestId("concierge-agent-pill-live");
    expect(pill.getAttribute("aria-controls")).toBe(region.id);
    expect(region.id).toBeTruthy();
  });
});

describe("the closed state degrades where no host opted in", () => {
  it("stays a non-interactive span when the surface supplies no history route", () => {
    // SupportModal and agent replies render <Markdown> outside the concierge column. A pill there
    // must not become a button wired to nothing — that would be the dead link in a new costume.
    mount(
      { agents: [], onOpenAgent: vi.fn(() => false) } as AgentPillContextValue,
      "b78f9f8c",
      "@Build 8",
    );
    const closed = screen.getByTestId("concierge-agent-pill-closed");
    expect(closed.tagName).not.toBe("BUTTON");
    expect(closed.textContent).toContain("@Build 8");
  });
});
