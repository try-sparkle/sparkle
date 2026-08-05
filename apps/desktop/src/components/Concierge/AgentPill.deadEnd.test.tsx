// @vitest-environment jsdom
//
// THE CONTRACT: clicking an agent pill ON A WIRED SURFACE never results in no visible change.
//
// ══ READ THE SCOPE OF THAT SENTENCE ═════════════════════════════════════════════════════════════
// It used to read "clicking an agent pill NEVER results in no visible change", full stop, and that
// was an over-claim this file's own tests contradicted — see "an unwired surface says nothing about
// the agent's lifecycle" below, which PINS a pill with no opener as a non-interactive `<span>`.
// A click there produces no visible change by design and by assertion, and that is the right
// behaviour (a surface with no reveal path must not pretend to have one) — but a header claiming
// otherwise made this suite read as proof of something broader than it tests. It was read that way,
// and the gap it hid is case (e) below (bead sparkle-ixsb3).
//
// The bug this file exists for: a pill labelled "Remove BYOK" was clicked and nothing happened —
// no navigation, no error, no explanation. A dead link that fails silently is worse than no link,
// because the reader cannot tell whether the agent is gone or whether the click registered.
//
// Three distinct silent paths produce that, and all three are covered below:
//
//   • THE ID NO LONGER RESOLVES. Agents get closed and discarded, and a pill embeds a hard id. The
//     BYOK migration really did run under ids that are not in the roster today. Those pills
//     rendered a muted span whose only explanation was a `title` tooltip — hover-only, so a CLICK
//     produced nothing at all.
//   • THE REVEAL DOES NOT LAND. `openProjectTab` returns early on an unknown project and
//     `selectAndOpen` on a missing agent, both silently — so a pill whose agent was closed after
//     the reply rendered looks live, is clicked, and does nothing. The pill cannot predict this
//     (see the "no other-window state" note in AgentPill.tsx); it has to believe the OUTCOME.
//   • THE REVEAL LANDS AND NOTHING MOVES. The one nobody named, and the one the founder hit. Every
//     write on the reveal path is idempotent and skips when its target state already holds, so for
//     an agent whose own column is ALREADY showing it the whole sequence writes nothing and reports
//     success — and a pill that says nothing on success produced a completely invisible click. That
//     state is not exotic: it is exactly what the concierge's own spawn leaves behind (`landInAgent`)
//     before it names the new agent as a pill in its reply, so the FIRST click on a freshly-spawned
//     agent's pill hit it every time. When that project sits on the OTHER pair from the one the
//     reader is watching, nothing they can see moves at all.
//
// WHY A BOOLEAN COULD NOT SAY THIS. `onOpenAgent` returned `true`/`false`, documented HERE as "the
// screen changed"/"it did not" and produced THERE (`openProjectTab`) as "the writes ran"/"they did
// not". Two files, opposite definitions of one bit, and the pill believed the wrong one. It returns
// a three-way `RevealOutcome` now, so "already showing" has a value of its own to be reported as.
//
// The cases are named (a)–(e) in the titles: they are the states a pill can be in, and the
// contract is that every one of them is visible to the reader.
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPill, AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import type { MentionAgent } from "./mentions";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}

/** "Build 8" — the real shape of the agent whose pill went dead. */
const BUILD8 = agent({ id: "b78f9f8c", name: "Build 8" });

function ctx(over: Partial<AgentPillContextValue> = {}): AgentPillContextValue {
  return { agents: [BUILD8], onOpenAgent: vi.fn((): RevealOutcome => "revealed"), onSeeHistory: vi.fn(), ...over };
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
    const onOpenAgent = vi.fn((): RevealOutcome => "revealed");
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
    const onOpenAgent = vi.fn((): RevealOutcome => "gone");
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
    mount(ctx({ onOpenAgent: (): RevealOutcome => "gone", onSeeHistory }), "b78f9f8c", "@Build 8");
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
        onOpenAgent: (): RevealOutcome => "gone",
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
    const onOpenAgent = vi.fn((): RevealOutcome => (reachable ? "revealed" : "gone"));
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
    mount(ctx({ onOpenAgent: (): RevealOutcome => "gone" }), "b78f9f8c", "@Build 8");

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
    mount(ctx({ onOpenAgent: (): RevealOutcome => "gone" }), "b78f9f8c", "@Build 8");
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    const retry = screen.getByTestId("concierge-agent-pill-closed");
    expect(retry.getAttribute("aria-expanded")).toBeNull();
    expect(retry.getAttribute("aria-controls")).toBe(
      screen.getByTestId("concierge-agent-pill-live").id,
    );
  });
});

describe("the reveal is a side effect, so it runs ONCE per click", () => {
  it("calls the opener ONCE under StrictMode, which re-invokes impure state updaters", () => {
    // WHY StrictMode AND NOT A PLAIN RENDER. A plain test render calls a `setState` updater exactly
    // once, so `toHaveBeenCalledTimes(1)` holds whether the navigation sits in the handler or
    // inside the updater — vacuous, and it cannot see the bug. This row was written that way first
    // and a mutation putting the call back in the updater kept it green.
    //
    // StrictMode deliberately double-invokes updaters in development to surface exactly this
    // impurity. The hazard is real outside tests too: React re-invokes updaters whenever it
    // discards and replays a render (interrupted concurrent render, Suspense retry), so an updater
    // that navigated would re-select the project tab and tear down the Sparkle overlay twice for
    // one click. This codebase already designs around it for dictated sends (voice/useAutoSend:
    // "updaters here stay out of it entirely"), and a version of this handler shipped with the
    // call inline in the updater (roborev 55618).
    //
    // WHY THE OPENER MUST RETURN false HERE. With a successful reveal the count goes 0 → 0; React
    // bails on the unchanged value, never re-renders, and so never double-invokes — a `() => true`
    // version of this row cannot fail either, for a subtler reason than the plain-render one. The
    // miss is what makes the state actually change (0 → 1) and the second invocation observable.
    const onOpenAgent = vi.fn((): RevealOutcome => "gone");
    render(
      <StrictMode>
        <AgentPillProvider value={ctx({ onOpenAgent })}>
          <AgentPill agentId="b78f9f8c" fallbackName="@Build 8" />
        </AgentPillProvider>
      </StrictMode>,
    );

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    expect(onOpenAgent).toHaveBeenCalledTimes(1);
    // First miss reads "is closed", not the second-miss wording — the count advanced by exactly 1.
    const notice = screen.getByTestId("concierge-agent-pill-notice");
    expect(notice.textContent).toMatch(/Build 8 is closed/i);
    expect(notice.textContent).not.toMatch(/still/i);
  });
});

describe("expanding an explanation is not the same fact as a failed reveal", () => {
  it("a re-resolving agent is NOT labelled closed by the disclosure it was expanded with", () => {
    // The unresolved pill's toggle and the resolved pill's miss counter mean different things, and
    // sharing one number let the first be read as the second: expand a closed pill, let a feed tick
    // re-add its agent (project reopened, cross-window sync), and the resolved branch inherited the
    // "1" as a failed attempt — rendering a live, in-roster agent as "is closed" with nothing ever
    // having been attempted (roborev 55618).
    const value = ctx({ agents: [] });
    const r = render(
      <AgentPillProvider value={value}>
        <AgentPill agentId="b78f9f8c" fallbackName="@Build 8" />
      </AgentPillProvider>,
    );
    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));
    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(/closed/i);

    // The agent comes back.
    r.rerender(
      <AgentPillProvider value={ctx({ agents: [BUILD8] })}>
        <AgentPill agentId="b78f9f8c" fallbackName="@Build 8" />
      </AgentPillProvider>,
    );

    // A live pill again — teal, dotted, openable — and NOT a word about it being closed.
    expect(screen.getByTestId("concierge-agent-pill")).toBeTruthy();
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
    expect(visible()).not.toMatch(/closed/i);
  });
});

describe("(e) a live agent whose column already shows it says WHERE, not nothing", () => {
  it("names the project instead of leaving the click invisible", () => {
    // The reveal ran and had nothing to do. Before this, the pill said nothing on any non-`false`
    // outcome, so the reader clicked and got no visible change whatsoever.
    const onOpenAgent = vi.fn((): RevealOutcome => "already-showing");
    mount(ctx({ onOpenAgent }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    expect(onOpenAgent).toHaveBeenCalled();
    // SOMETHING IS ON SCREEN. This is the whole contract.
    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(
      /Build 8 is already open in web\./i,
    );
  });

  it("does NOT call a live agent closed, in words or in dress", () => {
    // The two failure modes this branch sits between, and both have been shipped before in the
    // other direction (roborev 55548/55590): silence, or a false "…is closed" about a running agent.
    mount(ctx({ onOpenAgent: (): RevealOutcome => "already-showing" }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    expect(visible()).not.toMatch(/closed/i);
    // Still the LIVE pill — teal, with its status dot — not the muted closed form.
    expect(screen.getByTestId("concierge-agent-pill")).toBeTruthy();
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
    // And no "See what it did": that route is for prompts that OUTLIVED an agent, and this one is
    // running right now.
    expect(screen.queryByTestId("concierge-agent-pill-notice-action")).toBeNull();
  });

  it("re-announces on a repeat click rather than going quiet", () => {
    // Same reason the miss ladder counts (roborev 55590): an identical-value setState is a no-op
    // React bails out of, so the second click would paint and announce nothing. The notice is
    // re-keyed instead, which is what makes an unchanged answer a live-region UPDATE.
    mount(ctx({ onOpenAgent: (): RevealOutcome => "already-showing" }), "b78f9f8c", "@Build 8");
    const pill = screen.getByTestId("concierge-agent-pill");

    fireEvent.click(pill);
    const first = screen.getByTestId("concierge-agent-pill-notice");
    fireEvent.click(pill);
    const second = screen.getByTestId("concierge-agent-pill-notice");

    expect(second).not.toBe(first); // a REPLACED child, not an updated one
    expect(second.textContent).toMatch(/already open/i);
  });

  it("clears the sentence as soon as a click actually moves the screen", () => {
    // A non-navigating outcome is a fact about ONE moment. The reader reopens the project, clicks
    // again, and must not be left reading a stale explanation of a click that has since worked.
    let outcome: RevealOutcome = "already-showing";
    mount(ctx({ onOpenAgent: (): RevealOutcome => outcome }), "b78f9f8c", "@Build 8");

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(/already open/i);

    outcome = "revealed";
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
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
      { agents: [], onOpenAgent: vi.fn((): RevealOutcome => "gone") } as AgentPillContextValue,
      "b78f9f8c",
      "@Build 8",
    );
    const closed = screen.getByTestId("concierge-agent-pill-closed");
    expect(closed.tagName).not.toBe("BUTTON");
    expect(closed.textContent).toContain("@Build 8");
  });
});

// ── CASE (c), WITH A CALLER-OWNED REVEAL ────────────────────────────────────────────────────────
// A surface that supplies `onOpen` (RecapCard, NudgeCard) must NOT lose the closed-agent disclosure.
//
// This behaviour has been flipped twice in two commits, both times on the strength of a comment. A
// version of `AgentPill` special-cased `onOpen` in the unresolvable branch — to keep a permanently
// visible card from mounting a second live region — and that turned the pill into a button which
// called an opener that resolves the id FIRST and returns on null: no navigation, no notice, nothing
// announced, and the "See what it did" route gone. The whole suite stayed green through both the
// break and the revert, because nothing here had ever passed `onOpen` with an id that does not
// resolve (roborev 56068). Now something does.
describe("an unresolvable pill keeps its disclosure even when the caller owns the reveal", () => {
  const mountOwned = (onOpen: (t: { agentId: string; projectId: string }) => void, over = {}) =>
    render(
      <AgentPillProvider value={ctx({ agents: [], ...over })}>
        <AgentPill agentId="b78f9f8c" fallbackName="@Build 8" onOpen={onOpen} />
      </AgentPillProvider>,
    );

  it("shows the closed explanation on click, rather than calling a reveal that cannot land", () => {
    const onOpen = vi.fn();
    mountOwned(onOpen);
    const before = visible();
    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));
    // Something changed on screen…
    expect(visible()).not.toBe(before);
    expect(visible()).toContain("Build 8 is closed.");
    // …and the opener was NOT consulted: it resolves the id first and would have returned silently.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("still routes to the prompt history that outlived the agent", () => {
    const onSeeHistory = vi.fn();
    mountOwned(vi.fn(), { onSeeHistory });
    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));
    fireEvent.click(screen.getByTestId("concierge-agent-pill-notice-action"));
    expect(onSeeHistory).toHaveBeenCalledWith({ agentId: "b78f9f8c", name: "Build 8" });
  });
});
