// @vitest-environment jsdom
//
// THE MOUNTED THREAD IS SET IN THE TERMINAL'S FACE (bead sparkle-wj3ya, then sparkle-tjb6r).
//
// The founder, at least three times: *"I want the font in the concierge pane — both the font of the
// text that I'm writing in the prompt compose box, AS WELL AS THE FONT IN THE THREAD — to be the same
// font as the terminal window … to help make it clear to me that I'm speaking to the agent."* And
// later, still not fixed: *"I've asked for this so many times and it hasn't been done."*
//
// ══ WHY IT HADN'T BEEN — AND THIS TEST IS PART OF THE ANSWER ════════════════════════════════════
// He was right, and earlier versions of THIS FILE are a reason it kept reading as shipped:
//
//   • PR #1054 set the COMPOSER in the terminal face and stopped there.
//   • A later change set `TERM_BODY_FONT` on this thread's scroll container, "so it CASCADES to the
//     message bodies rather than being applied per bubble" — and this test asserted that container.
//     Both were correct as far as they went.
//   • But `Markdown` hardcodes `fontFamily: FONT_UI` on its OWN root, which every paragraph and list
//     item inherits. So the agent's prose — the bulk of this column — rendered in the UI SANS face
//     regardless of the container, two layers below where anyone was looking.
//   • And the agent turn's wrapper separately overrode the cascade with `FONT_MONO` at `TERM_TYPE`:
//     a different monospace (`--k-mono` → SF Mono) at 12px, where xterm is constructed with
//     `TERM_BODY_FONT` ("Source Code Pro") at 13.
//
// The old assertions passed through all of that, because they read only the scroller — the one level
// at which everything WAS right. The container case even claimed to guard it: *"a build that styled
// today's bubbles individually would fail here."* The build did exactly that and stayed green. That is
// the vacuous-test shape AGENTS.md calls the #1 fleet-wide finding, in the file whose whole job was to
// prevent it.
//
// SO THE LOAD-BEARING ASSERTION IS AN ALLOWLIST OVER A WALK: no element inside a turn may declare any
// face other than the terminal's. That fails against every one of the shipped attempts, and a fourth
// "set it on the container" fix cannot satisfy it without actually reaching the prose.
//
// IT WAS A DENYLIST FIRST — `not.toContain(FONT_UI)` — AND THAT SHIPPED A THIRD WRONG FACE. Forbidding
// the one value already known to be wrong says nothing about the next one: code spans and the bead
// pill kept `FONT_MONO` (`--k-mono` → SF Mono) inside a column set in Source Code Pro, passed the
// guard trivially, and were invisible for the same reason the original defect was — monospace beside
// monospace. Enumerate what a turn MAY declare; anything else fails on arrival.
//
// AND AN ALLOWLIST IS STILL ONLY AS GOOD AS THE ELEMENTS THE WALK REACHES. The bead pill was written
// into this fixture and rendered as bare text with no element at all, because its context was never
// provided — so the guard traversed no pill and the pill's hardcoded face stayed green. Presence is
// therefore asserted per element kind BEFORE the faces are, and `mount` provides both pill contexts.
//
// ══ WHY THE CONSTANT AND NOT A FONT STRING ══════════════════════════════════════════════════════
// The requirement is not "some monospace" — it is *the same font as the terminal*, imported rather
// than re-typed, because the terminal is themeable and per-column zoom is landing. A test quoting a
// literal stack would pass against a hardcoded second copy, which is the drift being guarded: nothing
// would be WRONG, only different, and nothing would go red.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  MountedAgentThread,
  MOUNTED_AGENT_TESTID,
  MOUNTED_HUMAN_TESTID,
  MOUNTED_THREAD_TESTID,
} from "./MountedAgentThread";
import { Markdown } from "../Markdown";
import { MD_CODE_FACE_VAR } from "../mdCodeFace";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import { BeadPillProvider, type BeadPillContextValue } from "./BeadPill";
import { TERM_BODY_BASE_SIZE, TERM_BODY_FONT } from "../terminalChrome";
import { FONT_MONO, FONT_UI } from "../../theme/scale";
import type { MountedThread } from "../../stores/mountedThreadStore";
import type { TranscriptEntry } from "../../services/agentTranscript";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const EMPTY: MountedThread = {
  entries: [],
  next: null,
  hasMore: false,
  loading: false,
  paging: false,
  tailFile: null,
  tailByte: 0,
  error: null,
};

/** THE FIXTURE IS THE GUARD'S REACH, AND A NARROW ONE IS HOW THIS BUG SURVIVED.
 *
 *  An earlier version of this file asserted "no element inside the thread declares `FONT_UI`" over a
 *  fixture of one heading and one list — so the walk visited `<h2>`, `<ul>`/`<li>` and `<p>` and
 *  nothing else. Every OTHER element `Markdown` can emit was unguarded: a `fontFamily: FONT_UI` added
 *  to the table, blockquote, link or pill renderer would have kept it green. A negative assertion is
 *  only as strong as the element kinds it actually traverses.
 *
 *  So this text exercises every renderer in `components` that can carry a face: heading, list,
 *  paragraph, INLINE CODE and a FENCED BLOCK (the two that kept `FONT_MONO` and are the reason the
 *  face now travels by custom property), blockquote, table, a plain link, an AGENT ref (`AgentPill`)
 *  and a BEAD ref (`BeadPill`, synthesized by `remarkBeadRefs` from the bare id). */
const AGENT = {
  id: "a1",
  kind: "agent",
  text: [
    "## Landed",
    "",
    "- rebased onto main, `git rebase origin/main`",
    "- pushed the branch",
    "",
    "> the founder asked three times",
    "",
    "| step | state |",
    "| --- | --- |",
    "| rebase | done |",
    "",
    "```sh",
    "gh pr merge 1317 --merge",
    "```",
    "",
    "See [the PR](https://github.com/drodio/sparkle/pull/1317), ask [@Blueprint](sparkle-agent:agent-1),",
    "tracked as sparkle-tjb6r.",
  ].join("\n"),
} as unknown as TranscriptEntry;

const HUMAN = {
  id: "h1",
  kind: "human",
  text: "ship it",
  promptSource: "typed",
} as unknown as TranscriptEntry;

/** THE PILL CONTEXTS ARE PROVIDED, AND THAT IS NOT SETUP BOILERPLATE.
 *
 *  Both pills default to an EMPTY context, and an unresolved id renders as bare text with no element
 *  at all (`BeadPill`: `if (resolved === undefined) return <>{beadId}</>`). So a fixture that writes
 *  `sparkle-tjb6r` and `[@Blueprint](sparkle-agent:…)` without providing a roster produces NO pill —
 *  the walk below never traverses one, and a pill hardcoding the wrong face stays green while the
 *  fixture's comment claims it is covered. That is exactly what happened: `BeadPill` kept
 *  `fontFamily: FONT_MONO` through the first version of this guard.
 *
 *  `ConciergeColumn` wraps the real `MountedAgentThread` in these same providers, so resolving here
 *  is what the mounted column actually renders, not a test-only arrangement. */
const ROSTER = [
  {
    id: "agent-1",
    name: "Blueprint UI/UX",
    projectId: "p1",
    projectName: "Sparkle",
    band: "running",
  },
] as unknown as AgentPillContextValue["agents"];

const BEADS = new Map([
  [
    "sparkle-tjb6r",
    {
      bead: {
        id: "sparkle-tjb6r",
        title: "the mounted thread reads as the terminal",
        description: "",
        status: "open",
        labels: [],
      },
      projectId: "p1",
    },
  ],
]) as unknown as BeadPillContextValue["beads"];

function mount(entries: TranscriptEntry[] = []) {
  return render(
    <AgentPillProvider value={{ agents: ROSTER } as AgentPillContextValue}>
      <BeadPillProvider value={{ beads: BEADS } as BeadPillContextValue}>
        <MountedAgentThread
          thread={{ ...EMPTY, entries }}
          agentId="agent-1"
          agentName="Blueprint UI/UX"
          onReachTop={vi.fn()}
        />
      </BeadPillProvider>
    </AgentPillProvider>,
  );
}

/** Every inline `font-family` declared anywhere in the subtree. The WALK is the point: the defect was
 *  a descendant overriding an ancestor, so an assertion reading one level cannot see it. */
function declaredFaces(root: HTMLElement): string[] {
  const out: string[] = [];
  if (root.style.fontFamily) out.push(root.style.fontFamily);
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (el.style.fontFamily) out.push(el.style.fontFamily);
  });
  return out;
}

/** THE ALLOWLIST, NOT A DENYLIST — the difference is the whole finding.
 *
 *  Forbidding `FONT_UI` only catches the ONE wrong face that was already found. It says nothing about
 *  the second one this change had to remove: code spans declaring `FONT_MONO` (`--k-mono` → SF Mono)
 *  inside a column set in Source Code Pro — a different typeface that passes a "not FONT_UI" test
 *  trivially, and is invisible precisely because it is monospace too. Enumerating what a TURN may
 *  declare means the next wrong face fails on arrival, whoever introduces it and whatever it is.
 *
 *  `var(--md-code-face…)` is allowed as a REFERENCE, not as a face: it is the one legitimate reason a
 *  descendant re-declares a family (code must stay monospace when the root is not), and its VALUE is
 *  pinned separately at the root that publishes it — see the `--md-code-face` cases below. Without
 *  that second assertion this entry would be the laundering hole. */
function assertOnlyTerminalFaces(scope: HTMLElement): void {
  const strays = declaredFaces(scope).filter(
    (f) =>
      f !== TERM_BODY_FONT &&
      // A literal `inherit` is the ABSENCE of a face, not a face — `heading()` carries it precisely
      // so a heading follows the root instead of re-deciding. Excluding it here is not a loophole:
      // it can only ever resolve to whatever this walk already checked on the ancestor.
      f !== "inherit" &&
      !f.startsWith(`var(${MD_CODE_FACE_VAR}`),
  );
  expect(strays).toEqual([]);
}

describe("MountedAgentThread — the thread reads as terminal", () => {
  it("sets the terminal typeface on the thread", () => {
    mount();
    expect(screen.getByTestId(MOUNTED_THREAD_TESTID).style.fontFamily).toBe(TERM_BODY_FONT);
  });

  // The SIZE too, and from the same module. `TERM_BODY_BASE_SIZE` is what xterm gets at zoom 1, so a
  // thread set in the right face at the wrong size still does not read as the terminal.
  it("sets the terminal body size on the thread", () => {
    mount();
    expect(screen.getByTestId(MOUNTED_THREAD_TESTID).style.fontSize).toBe(
      `${TERM_BODY_BASE_SIZE}px`,
    );
  });

  it("puts it on the scrolling container, not on individual bubbles", () => {
    mount();
    const thread = screen.getByTestId(MOUNTED_THREAD_TESTID);
    expect(thread.getAttribute("data-concierge-scroller")).toBe("yes");
    expect(thread.style.fontFamily).toBe(TERM_BODY_FONT);
  });

  // ══ THE TWO THAT FAIL AGAINST EVERY SHIPPED ATTEMPT ═══════════════════════════════════════════
  it("renders the AGENT'S PROSE in the terminal face, not merely the container", () => {
    mount([AGENT]);
    const md = screen
      .getByTestId(MOUNTED_AGENT_TESTID)
      .querySelector<HTMLElement>("[data-md-face]");
    expect(md).not.toBeNull();
    // Asked for BY NAME. Before the fix this root declared `FONT_UI`, inside Markdown where nothing
    // in this component could reach it.
    expect(md!.getAttribute("data-md-face")).toBe("terminal");
    expect(md!.style.fontFamily).toBe(TERM_BODY_FONT);
    expect(md!.style.fontSize).toBe(`${TERM_BODY_BASE_SIZE}px`);
  });

  it("declares the UI face NOWHERE inside the mounted thread", () => {
    mount([HUMAN, AGENT]);
    // Thread-WIDE, chrome included: a timestamp or an activity chip may be smaller-than-body
    // furniture, but none of it may be sans-serif on a plane that is meant to read as the terminal.
    expect(declaredFaces(screen.getByTestId(MOUNTED_THREAD_TESTID))).not.toContain(FONT_UI);
  });

  // THE FIXTURE ACTUALLY RENDERS WHAT IT CLAIMS TO. A walk over a subtree proves nothing about an
  // element kind that subtree does not contain, and the failure is SILENT — the guard stays green
  // and its comment keeps promising coverage. This is not hypothetical: the bead pill was written
  // into the fixture, rendered as bare text because its context was never provided, and kept a
  // hardcoded `FONT_MONO` straight through the guard that was supposed to catch exactly that.
  //
  // So presence is asserted FIRST, per element kind, and any renderer that stops emitting an element
  // fails here rather than quietly narrowing the walk below back to headings and list items.
  it("renders every element kind the face guard claims to cover", () => {
    mount([AGENT]);
    const turn = screen.getByTestId(MOUNTED_AGENT_TESTID);
    const count = (sel: string) => turn.querySelectorAll(sel).length;
    expect(count("h2")).toBeGreaterThanOrEqual(1);
    expect(count("li")).toBeGreaterThanOrEqual(2);
    expect(count("blockquote")).toBeGreaterThanOrEqual(1);
    expect(count("table")).toBeGreaterThanOrEqual(1);
    expect(count("a")).toBeGreaterThanOrEqual(1);
    expect(count("pre")).toBeGreaterThanOrEqual(1);
    expect(count("code")).toBeGreaterThanOrEqual(2);
    // The two pills resolve only because `mount` provides their contexts — see the note there.
    expect(count('[data-testid="concierge-bead-pill"]')).toBeGreaterThanOrEqual(1);
    expect(count('[data-testid="concierge-agent-pill-name"]')).toBeGreaterThanOrEqual(1);
  });

  // And the strict form, over the TURNS — see `assertOnlyTerminalFaces` for why an allowlist rather
  // than one forbidden constant. Paired with the presence case above, "the conversation is in one
  // face" is a claim about every renderer that can carry a face, not about the two element kinds a
  // thinner fixture happened to produce.
  it("declares NO face other than the terminal's on any turn", () => {
    mount([HUMAN, AGENT]);
    assertOnlyTerminalFaces(screen.getByTestId(MOUNTED_AGENT_TESTID));
    assertOnlyTerminalFaces(screen.getByTestId(MOUNTED_HUMAN_TESTID));
  });

  // THE SECOND MONOSPACE, WHICH "not FONT_UI" CANNOT SEE. Code is the content an agent writes most of
  // and the last thing left in `--k-mono` (SF Mono) while the prose around it was Source Code Pro.
  it("renders the agent's CODE in the terminal face too", () => {
    mount([AGENT]);
    const md = screen.getByTestId(MOUNTED_AGENT_TESTID).querySelector<HTMLElement>("[data-md-face]")!;
    // The value the code elements resolve THROUGH. Pinned here rather than at each `<code>`, because
    // this is the single declaration that decides the answer for all of them.
    expect(md.style.getPropertyValue(MD_CODE_FACE_VAR)).toBe(TERM_BODY_FONT);
    const codes = Array.from(md.querySelectorAll<HTMLElement>("code"));
    // Both kinds are present in the fixture — the inline span and the one inside the fenced slab —
    // and an empty list would make the assertion below vacuous.
    expect(codes.length).toBeGreaterThanOrEqual(2);
    codes.forEach((c) => expect(c.style.fontFamily.startsWith(`var(${MD_CODE_FACE_VAR}`)).toBe(true));
  });

  // The agent's wrapper must not re-declare a face at all: the container cascade and Markdown's
  // `face` prop are the two channels, and a third is the next thing to drift. This pins the deleted
  // `fontFamily: FONT_MONO` / `fontSize: TERM_TYPE` override rather than trusting it stays deleted.
  it("does not re-declare a face or size on the agent turn wrapper", () => {
    mount([AGENT]);
    const turn = screen.getByTestId(MOUNTED_AGENT_TESTID);
    expect(turn.style.fontFamily).toBe("");
    expect(turn.style.fontSize).toBe("");
  });

  // YOUR words: same face, inherited; the BUBBLE and the right-alignment are what separate the two
  // voices now. Asserting the shape too, so a later "make it all uniform" pass cannot quietly take
  // away the affordance the face used to provide.
  it("keeps your own words in the same face, distinguished by the bubble instead", () => {
    mount([HUMAN]);
    const bubble = screen.getByTestId(MOUNTED_HUMAN_TESTID);
    expect(bubble.style.fontFamily).toBe("");
    expect(bubble.style.fontSize).toBe(`${TERM_BODY_BASE_SIZE}px`);
    expect(bubble.style.background).not.toBe("");
    expect(bubble.parentElement!.style.alignSelf).toBe("flex-end");
  });
});

// ══ THE PAIR THAT STOPS THE ABOVE BEING "WE DELETED FONT_UI" ════════════════════════════════════
// Every assertion above would ALSO pass against a Markdown that had simply lost its UI face for
// everyone — which would silently reformat the unmounted concierge thread, the one surface the founder
// explicitly said must not change: *"when it's not mounted it should be using the same font that it's
// using now."* So: the UI face is still the default, and the terminal face is opt-in.
describe("Markdown — the UI face is still the default everywhere else", () => {
  it("renders in the UI face when no face is asked for", () => {
    const { container } = render(<Markdown text="plain reply" />);
    const md = container.querySelector<HTMLElement>("[data-md-face]")!;
    expect(md.getAttribute("data-md-face")).toBe("ui");
    expect(md.style.fontFamily).toBe(FONT_UI);
  });

  it("renders in the terminal face only when asked", () => {
    const { container } = render(<Markdown text="plain reply" face="terminal" />);
    const md = container.querySelector<HTMLElement>("[data-md-face]")!;
    expect(md.style.fontFamily).toBe(TERM_BODY_FONT);
  });

  // The code face is a SECOND channel, so it needs the same pair. Without this case, pointing
  // `--md-code-face` at the terminal unconditionally would satisfy every terminal assertion above
  // while quietly restyling the code in every chat bubble in the app.
  it("keeps code on the UI mono face by default", () => {
    const { container } = render(<Markdown text="a `snippet` here" />);
    const md = container.querySelector<HTMLElement>("[data-md-face]")!;
    expect(md.style.getPropertyValue(MD_CODE_FACE_VAR)).toBe(FONT_MONO);
  });
});
