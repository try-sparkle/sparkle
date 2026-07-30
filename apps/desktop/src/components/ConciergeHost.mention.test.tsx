// @vitest-environment jsdom
//
// WHAT AN @-MENTION DOES TO A SEND — the host's half of the founder's ask.
//
// The composer's half (picker, pill, backspace) is ComposeBox.mentions.test.tsx and the rules are
// mentions.test.ts. What is pinned HERE is everything those two cannot see:
//
//   • an addressed message goes to the agent it NAMED, not to the one that happens to be selected;
//   • it goes there through the EXISTING gate — armed intent, countdown, cancellable — and never by
//     a second delivery path;
//   • the "@" itself never reaches the terminal;
//   • the router is not consulted at all (and not billed for);
//   • the concierge STILL REPLIES afterwards, which is the headline requirement;
//   • naming an unreachable agent says so rather than silently answering in chat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(
    async (_agentId: string, _text: string, _opts?: unknown) => ({ ok: true, path: "free-text" }),
  ),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  agentCanAcceptInput: vi.fn((_agentId: string) => true),
  answersLivePicker: vi.fn((_agentId: string, _text: string) => false),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: (id: string) => h.agentCanAcceptInput(id),
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: (id: string, t: string) => h.answersLivePicker(id, t),
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
// The recommended-action row mounts a real metered engine; this suite is about the compose box, so
// it is stubbed out entirely rather than fed a stage to portal into.
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
}));

const RUNTIME = {
  status: { ag1: "idle", ag2: "idle" },
  workflowShipped: {},
  workflowStage: {},
  workflowState: {},
  branchStatus: {},
};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
}));

import { ConciergeHost, relayFollowUp, type ConciergePromptTarget } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { armedIntents, cancelIntent, fireIntent } from "../services/dispatchIntent";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

function agent(id: string, name: string) {
  return {
    id,
    name,
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "idle",
    statusColor: "#e0533f",
    statusLabel: "Idle",
    // `done`, not `needs_you`: a surfaced agent adds nudge cards that have nothing to do with this.
    band: "done" as const,
    inScope: true,
    muted: false,
    topLevel: true,
  };
}
const COUNTS = { needs_you: 0, running: 0, done: 2 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [agent("ag1", "Blueprint UI/UX"), agent("ag2", "Kraken Auth")],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** The SELECTED agent throughout: every row that asserts a mention beat the selection aims here. */
const SELECTED: ConciergePromptTarget = { projectId: "p1", agentId: "ag1", name: "Blueprint UI/UX" };

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const thread = () => screen.getByTestId("concierge-thread");

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  h.dispatchConciergeAnswer.mockClear();
  h.startConciergeTurn.mockClear();
  // mockRESET, not mockClear: one row below points the router at the agent with `mockResolvedValue`,
  // which is persistent — `mockClear` drops the recorded calls and leaves that implementation in
  // place, so every later row silently ran against a router that always said "agent". That is how
  // the unreachable-agent row failed: it dispatched. Reset the implementation and restate the
  // default, so each row starts from the same knob position.
  h.routeMessage.mockReset();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.agentCanAcceptInput.mockReset();
  h.agentCanAcceptInput.mockReturnValue(true);
  h.answersLivePicker.mockReset();
  h.answersLivePicker.mockReturnValue(false);
});
afterEach(() => {
  for (const i of armedIntents()) cancelIntent(i.id);
  cleanup();
  vi.clearAllMocks();
});

/** Type a message and press Send. The caret is asserted onto the node because the mention query
 *  reads it (see ComposeBox.mentions.test.tsx's own `type`). */
async function send(text: string) {
  const ta = box();
  fireEvent.change(ta, {
    target: { value: text, selectionStart: text.length, selectionEnd: text.length },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

/** Let every armed countdown elapse — the gate an addressed send still passes through. Fires the
 *  intents directly rather than advancing timers, matching ConciergeHost.test.tsx. */
async function elapse() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function mount() {
  return render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
}

describe("ConciergeHost — an addressed message goes where it was addressed", () => {
  it("delivers to the NAMED agent, not to the selected one", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
  });

  // The "@" must not reach the PTY: the agent there is a Claude Code CLI, where a leading "@" opens
  // its own file-reference autocomplete — a picker inside the agent's composer with the instruction
  // stranded behind it.
  it("strips the address before the text reaches the terminal", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![1]).toBe("ship the DMG");
  });

  // Explicitness buys a skipped CLASSIFY, never a skipped GATE. This is the line the "no forceAgent
  // twin" warning in deliver() is really protecting.
  it("still arms a cancellable countdown rather than dispatching outright", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    expect(armedIntents()).toHaveLength(1);
    expect(armedIntents()[0]!.targetName).toBe("Kraken Auth");
    // Nothing has reached a terminal yet.
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("cancelling the countdown means nothing is delivered", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await act(async () => {
      cancelIntent(armedIntents()[0]!.id);
      await Promise.resolve();
    });
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("dispatches through the countdown authority, like every other routed send", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![2]).toMatchObject({
      userPrompt: true,
      authority: { kind: "countdown" },
    });
  });

  // A named destination is not a guess, so there is nothing to ask a model about — and nothing to
  // bill for. (Tier 2 is a metered Haiku call.)
  it("never consults the router for an addressed message", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.routeMessage).not.toHaveBeenCalled();
  });

  it("still consults the router for an ordinary one", async () => {
    mount();
    await send("what should I do next");
    expect(h.routeMessage).toHaveBeenCalledTimes(1);
  });

  it("posts a receipt naming the agent it reached", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    await waitFor(() => expect(thread().textContent).toContain("Kraken Auth"));
  });

  // The bubble keeps the address (and draws it as a pill); only the wire loses it.
  it("keeps the full text, address included, in the thread", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await waitFor(() =>
      expect(screen.getByTestId("you-bubble").textContent).toBe("@Kraken Auth ship the DMG"),
    );
    expect(screen.getByTestId("concierge-mention-pill").textContent).toBe("@Kraken Auth");
  });
});

describe("ConciergeHost — the concierge stays in the conversation", () => {
  // THE HEADLINE REQUIREMENT: "the concierge sends it over to that builder agent, but ALSO still
  // participates in the conversation… I want the concierge to be a thought partner."
  it("still produces a concierge turn after relaying", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    const prompt = h.startConciergeTurn.mock.calls[0]![0];
    expect(prompt).toContain("Kraken Auth");
    expect(prompt).toContain("ship the DMG");
  });

  // AFTER delivery, never at arm time — a reply saying "sent it" over a send the user then
  // cancelled would be exactly the kind of small lie the receipt rules in this file prevent.
  it("says nothing while the countdown is still running", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  it("says nothing when the send was cancelled", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await act(async () => {
      cancelIntent(armedIntents()[0]!.id);
      await Promise.resolve();
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  it("says nothing when the delivery failed", async () => {
    mount();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // A message the ROUTER sent to an agent is one the user wrote to that agent. Following it with an
  // unbidden chat turn would put a paragraph of commentary after every terse "yes" at a picker —
  // and bill a brain turn for it.
  it("does NOT follow up on a router-decided agent send", async () => {
    mount();
    h.routeMessage.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
    await send("ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });
});

describe("relayFollowUp", () => {
  it("names the agent and quotes what went, in the user's voice", () => {
    const p = relayFollowUp("Kraken Auth", "ship the DMG");
    expect(p).toContain("Kraken Auth");
    expect(p).toContain("ship the DMG");
  });

  // Bounded for the reason the router bounds its context line: a pasted essay would otherwise bill
  // unbounded metered input tokens on every mention.
  it("caps how much of a long message it quotes", () => {
    const p = relayFollowUp("Kraken Auth", "x".repeat(5000));
    expect(p.length).toBeLessThan(700);
  });
});

describe("ConciergeHost — an address that cannot be honoured", () => {
  // Not silently: the user typed a name and watched a pill appear, so a chat answer with no
  // explanation is the one outcome they will not expect. The receipt names Sparkle, not the agent
  // that turned out to be unreachable, so it cannot carry this on its own.
  it("says so when the named agent cannot take a message, and keeps the words", async () => {
    mount();
    h.agentCanAcceptInput.mockReturnValue(false);
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(thread().textContent).toContain("can't take a message"));
    // The message still went somewhere — to Sparkle, the recoverable direction.
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // "@Kraken Auth" alone strips to an empty wire payload, and writing an empty line into a live PTY
  // is at best a stray newline at the agent's prompt.
  it("asks what to send rather than delivering an empty prompt", async () => {
    mount();
    await send("@Kraken Auth");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(armedIntents()).toHaveLength(0);
    await waitFor(() => expect(thread().textContent).toContain("what should I send over"));
  });

  // A mention naming an agent that has left the feed simply fails to resolve, and the message falls
  // back to the auto-router — the same answer deliver() gives when any aim goes missing.
  it("falls back to the router when the name matches nobody in the fleet", async () => {
    mount();
    await send("@Nobody At All ship it");
    expect(h.routeMessage).toHaveBeenCalledTimes(1);
  });
});

describe("ConciergeHost — an addressed message is a message, not a picker keystroke", () => {
  // THE GATE IS DECLARED, NOT MIRRORED (roborev 54569). This row used to assert only that the host
  // skipped its own `answersLivePicker` check — which enforces nothing, because the picker match
  // lives inside `dispatchConciergeAnswer`, and this suite mocks that. So it stayed green while the
  // real dispatcher pressed the button. What the host can honestly be held to is that it DECLARES
  // the disposition; the refusal itself is pinned against the real matcher and the real write
  // primitive in services/conciergeDispatch.test.ts.
  it("tells the dispatcher this text may never become a keystroke", async () => {
    mount();
    h.answersLivePicker.mockReturnValue(true);
    await send("@Kraken Auth yes");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
    expect(h.dispatchConciergeAnswer.mock.calls[0]![1]).toBe("yes");
    expect(h.dispatchConciergeAnswer.mock.calls[0]![2]).toMatchObject({ neverPickerAnswer: true });
  });

  // An ordinary routed send keeps the keystroke path — answering a picker from the concierge is a
  // feature, and this flag must not quietly take it away from every message.
  it("does NOT set the flag on a router-decided send", async () => {
    mount();
    h.routeMessage.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
    await send("yes");
    await elapse();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![2]).toMatchObject({
      neverPickerAnswer: false,
    });
  });
});

// roborev 54665. The refusal reused `ambiguous-picker`, whose copy says the answer mapped to no
// option and to "answer with just the option" — both false here, so the user retyped the same thing
// and got a byte-identical refusal, with the only exit being to guess that the "@" was the problem.
// Naming the agent you mean is MOST natural when several are asking at once, so this is not rare.
describe("ConciergeHost — what the user is told when the named agent is mid-prompt", () => {
  it("names the real reason, and only the exit that is unconditionally safe", async () => {
    mount();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "addressed-at-picker" });
    await send("@Kraken Auth yes");
    await elapse();
    const said = thread().textContent ?? "";
    expect(said).toContain("waiting on a choice on screen");
    // The remedy names the agent the user actually meant, so following it cannot land anywhere else.
    expect(said).toContain("open Kraken Auth and pick");
    // NOT the line that told them to do what they had already done (roborev 54665)…
    expect(said).not.toContain("answer with just the option.");
    // …and NOT "drop the @Name and send just the option" either (roborev 54673). That advice was
    // only safe when the named agent happened to be the column's current target: an unaddressed
    // message resolves against `targetRef.current`, so with the address gone a bare "yes" aims at
    // whatever the column points at — and a terse "yes" on THAT agent's live picker is framed as
    // `y\r` and presses its button. Naming an agent is most natural precisely when several are
    // asking at once, i.e. exactly when the shown target is someone else. A user following the
    // copy would have answered a question they never read, which is what `neverPickerAnswer`
    // exists to prevent.
    expect(said).not.toContain("drop the");
  });
});

describe("ConciergeHost — a message that names a SECOND agent", () => {
  // roborev 54569. The wire text used to have EVERY mention span deleted, so an instruction that
  // referred to another agent reached the terminal with its referenced party silently removed.
  it("keeps the other agent's name in the instruction, minus the sigil", async () => {
    mount();
    await send("@Kraken Auth please coordinate with @Blueprint UI/UX before you land this");
    await elapse();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
    expect(h.dispatchConciergeAnswer.mock.calls[0]![1]).toBe(
      "please coordinate with Blueprint UI/UX before you land this",
    );
  });

  // One destination per message: fanning an irreversible action across every name in a sentence is
  // not something to do behind a comma. The other name is still drawn as a pill in the bubble.
  it("delivers to the FIRST name only", async () => {
    mount();
    await send("@Kraken Auth and @Blueprint UI/UX both ship");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
    await waitFor(() => expect(screen.getAllByTestId("concierge-mention-pill")).toHaveLength(2));
  });
});

// ══ @Sparkle IS A DESTINATION, AND ITS SIGIL MUST NEVER REACH A TERMINAL ══════════════════════════
//
// Bead sparkle-kaz1l. Dictating the word "Sparkle" inserts an `@Sparkle` pill (the founder asked for
// speech and typing to produce the same thing), and `mentionRoster` offers `@Sparkle` in the picker —
// but the concierge is not a FEED agent, so resolving that mention against the feed roster always
// missed. The message fell through as "named nobody".
//
// THE REACHABLE HARM WAS THE REDIRECT, NOT THE ROUTER. `routeMessage` can no longer return
// `target: "agent"` at all (see conciergeRouter's header), so an @Sparkle message was never
// misrouted by classification. But it always lands on Sparkle, so its receipt always offers
// "Also ask <agent>" — and `redirect` replays the REMEMBERED PAYLOAD straight into `promptAgent`,
// the one wire into a PTY that never passed through `mentionAim`'s stripping. One tap typed
// `@Sparkle what is the status?` into a Claude Code CLI, where the leading `@` opens its
// file-reference autocomplete and strands the instruction behind a picker nobody asked for.
//
// So there are two assertions worth making, and the second is the one that would have caught it.
describe("ConciergeHost — @Sparkle addresses the concierge", () => {
  it("never dispatches to an agent, however the router is feeling", async () => {
    // The router is pointed AT the agent to prove the address wins deterministically. In production
    // `routeMessage` cannot say "agent", so this is a stricter fixture than reality — the point is
    // that @Sparkle does not depend on that guarantee holding.
    h.routeMessage.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("does not spend a router call on a destination the user stated", async () => {
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.routeMessage).not.toHaveBeenCalled();
  });

  // THE ONE THAT CATCHES THE BUG. Send to Sparkle, then take the receipt's own redirect into a real
  // agent — the exact two taps a user makes — and assert on the bytes that reached the dispatcher.
  it("carries NO @ into the terminal when its receipt is redirected to an agent", async () => {
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    const redirect = await waitFor(() =>
      screen.getByRole("button", { name: /^Also ask / }),
    );
    await act(async () => {
      fireEvent.click(redirect);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    const wire = h.dispatchConciergeAnswer.mock.calls[0]![1] as string;
    // The instruction survives; only the sigil is gone. Asserting the absence of "@" ALONE would
    // pass against a wire that lost the whole sentence, which is the other way to strand it.
    expect(wire).not.toContain("@");
    expect(wire).toContain("what is the status of the build?");
  });

  // ══ THE STRIP IS FOR THE PTY, AND ONLY THE PTY (roborev 55765) ══════════════════════════════════
  //
  // The first cut of the fix above stripped the message where the REPLAY IS RECORDED, on the stated
  // grounds that the only other consumer was the display copy. That was wrong about the code: the
  // Sparkle-bound arm of `redirect` reads the remembered PAYLOAD, not `sentTextRef`. So "Also ask
  // Sparkle" began asking the brain about a message with the addressed agent's name deleted —
  // `mentionFreeText` removes the addressing span whole, not just its sigil.
  //
  // Which contradicts this file's own invariant, stated where `mentionAim` is built: "`payload` still
  // has to carry the address everywhere else — Sparkle answering the message should see who it was
  // aimed at." Two renderings are now remembered, and this row is the one that tells them apart: it
  // passes only if the brain-bound replay is the UNSTRIPPED one.
  it("keeps the agent's name when the receipt is redirected to Sparkle", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    // The relay follow-up has already asked Sparkle once ("still produces a concierge turn after
    // relaying"). The redirect is the NEXT call, so this row reads the last one rather than [0] —
    // indexing [0] here would assert against the follow-up and pass no matter what the redirect did.
    //
    // SNAPSHOT AFTER THE BUTTON RESOLVES, AND PIN AN EXACT COUNT (roborev 55963). The follow-up is
    // emitted in the same synchronous block as the `setReceipt` that mounts this button, so taking
    // the count first left a scheduling window where the follow-up landed AFTER the snapshot. A
    // `toBeGreaterThan` is then satisfied by the follow-up alone, `.at(-1)` reads it instead of the
    // redirect — and it quotes the whole `@Kraken Auth ship the DMG`, so BOTH assertions below pass
    // against a redirect arm that dispatched nothing. Latent rather than broken (the mutation still
    // died), but this row is the file's only guard on the payload/wire split, so it must not be one
    // timing shift away from vacuous.
    const redirect = await waitFor(() =>
      screen.getByRole("button", { name: "Also ask Sparkle" }),
    );
    const beforeRedirect = h.startConciergeTurn.mock.calls.length;
    await act(async () => {
      fireEvent.click(redirect);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    await waitFor(() =>
      expect(h.startConciergeTurn.mock.calls.length).toBe(beforeRedirect + 1),
    );
    const asked = h.startConciergeTurn.mock.calls.at(-1)![0] as string;
    // BOTH halves. The name is the regression; the instruction is the control that stops this
    // passing against a replay that lost the sentence instead.
    expect(asked).toContain("Kraken Auth");
    expect(asked).toContain("ship the DMG");
  });

  // ══ A BARE ADDRESS HAS NOTHING TO REDIRECT, SO IT MUST NOT OFFER TO ═════════════════════════════
  //
  // "@Sparkle" alone strips to "". The addressed path has refused that since roborev 55418, but its
  // guard needs a mention that resolved to a PROMPTABLE agent, and @Sparkle never does — so this
  // message reached Sparkle carrying a redirectable receipt whose replay was the empty string.
  // `redirect` then refused it silently and left the button mounted for a second tap that did
  // nothing either: a dead affordance, the exact failure the receipt rules here exist against.
  it("offers no redirect for a BARE address", async () => {
    mount();
    await send("@Sparkle");
    await elapse();
    // The receipt itself MUST render — otherwise "no button" is true for the uninteresting reason
    // that nothing rendered at all, and the row would pass against a message that never sent.
    await waitFor(() => expect(screen.getByTestId("routing-receipt")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Also ask / })).toBeNull();
  });

  // The control for the row above: the SAME address with words after it keeps its button. Without
  // this, "offers no redirect" would also pass against a change that killed the redirect outright.
  it("still offers the redirect when the address carries an instruction", async () => {
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Also ask / })).toBeTruthy());
  });
});
