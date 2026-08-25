// @vitest-environment jsdom
//
// Attachments end-to-end through the integration layer (parity row #21, bead sparkle-4562.3):
// an attach button runs the real picker seam, a chip appears, and the NEXT send carries the file
// to whichever target the box is aimed at — the brain snapshot or the agent dispatch — with the
// thread showing counts rather than temp paths. Cleared on a send that lands, restored on one
// that does not.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  deferred: undefined as
    | ((r: { ok: boolean; path: string; agentId: string; sent?: string; display?: string }) => void)
    | undefined,
  // Counts unsubscribes. The clearing itself is subscription-SCOPED in the factory below, like the
  // real seam: a singleton that always cleared would let the first unsubscribe kill a second
  // subscription's callback, and the failure would surface as an unrelated "chips not restored"
  // assertion (roborev 53057).
  unsubscribeDeferred: vi.fn(),
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  dispatch: vi.fn(async (): Promise<{ ok: boolean; path?: string }> => ({ ok: true })),
  pick: vi.fn(),
  loadPaths: vi.fn(),
  route: vi.fn(async () => ({ target: "sparkle" as "sparkle" | "agent", reason: "test", source: "heuristic" as const })),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
// Mirror EVERY export the tree touches: Vitest throws on access to a missing mock export, and the
// host's error handler now calls `isSupersededDetail` (roborev 53460/53462). The real one, not a
// stub, so this file can't disagree with the sentinels Rust emits.
vi.mock("../services/concierge", async (importOriginal) => ({
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
  turnAccountFor: () => null,
  isSupersededDetail: (await importOriginal<typeof import("../services/concierge")>())
    .isSupersededDetail,
  startConciergeTurn: h.startConciergeTurn,
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatch,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  agentCanAcceptPrompt: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  // Not exercised in these rows (no picker on screen), but the host imports it — and Vitest
  // throws on ACCESS to an export a factory omits, so a partial mock breaks the whole file.
  answersLivePicker: () => false,
  // Same reason, and this one IS reached here: the Approve relay reads it on every press to decide
  // whether it is pressing a menu option or typing (bead sparkle-voudj7). Omitting it made the
  // queued-approve row fail as a stale attachment chip — the throw was swallowed by `approve`'s own
  // catch, so no dispatch happened and no hold slot was taken.
  pickerPressFor: vi.fn(() => undefined),
  onDeferredSendOutcome: (
    cb: (r: {
      ok: boolean;
      path: string;
      agentId: string;
      sent?: string;
      display?: string;
    }) => void,
  ) => {
    h.deferred = cb;
    // Removes only the listener it was handed — exactly what onDeferredSendOutcome does.
    return () => {
      if (h.deferred === cb) h.deferred = undefined;
      h.unsubscribeDeferred();
    };
  },
}));
// The user no longer picks a destination — the host routes (PRD/sparkle/concierge-auto-routing).
// `routeMessage` is a KNOB here: these rows are about which rendering reaches which destination,
// not about how the decision is made (that is services/conciergeRouter.test.ts).
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.route }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
// The dictation hook (CM-U9) is mocked in EVERY host test, not just the voice one (roborev 48171):
// the host imports it unconditionally, so without this the base tests run the real hook on every
// simulated send — mutating global dictation state and coupling these tests to the mic pipeline.
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("../services/conciergeAttach", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, pickAttachments: h.pick, loadAttachmentPaths: h.loadPaths };
});

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { Attachment } from "./composer/attachments";
import { armedIntents, clearAllIntents, fireIntent } from "../services/dispatchIntent";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
beforeEach(enableAiEnhancementsForTests);

const shot: Attachment = {
  id: "s1",
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
  dataUrl: "data:image/png;base64,AAA",
};

const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

function feed(): ConciergeFeed {
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "approval",
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you" as const,
    inScope: true,
    muted: false,
    // A parentless build agent — it gets a row of its own in column two, which is what the
    // surfacing gate now also requires (see ConciergeHost.surfacedAgents).
    topLevel: true,
    // Nothing above it in the tree, so no ancestor row can be speaking for it.
    representedElsewhere: false,
  };
  const counts = { needs_you: 1, questions: 0, running: 0, done: 0 };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [agent] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const mount = () => render(<ConciergeHost feed={feed()} promptTarget={target} />);

/** Stage a file through the compose box's attach affordance. Both buttons are permanently visible
 *  (bead sparkle-f8bjx), so there is nothing to reveal first — this used to need a hover on the
 *  paperclip before either action existed. ComposeBox.test.tsx owns that control's own behaviour. */
async function attachViaUpload() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await Promise.resolve();
  });
}

const type = (text: string) =>
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

// Routing is async (tier 2 is a network round trip) and every delivery chains behind the previous
// one, so nothing lands in the same tick as the click.
const clickSend = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText("Send"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await elapseCountdowns();
};

/**
 * Let every armed send's countdown run out.
 *
 * An agent-bound send now ARMS an intent (services/dispatchIntent) the user can cancel, and only
 * the uncancelled expiry delivers — so a suite asserting that the files reached the PTY has to pass
 * through the gate. Fired directly rather than by advancing timers, so this suite keeps real timers.
 */
async function elapseCountdowns() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    // Generously many: the expiry re-enters the send QUEUE and the delivery it runs is several
    // awaits deep, so too few ticks reads as "the send never happened" rather than as a race.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  h.deferred = undefined; // no stale subscription answering for an unmounted host
  vi.clearAllMocks();
  h.pick.mockResolvedValue({ attachments: [shot], failed: [] });
  h.loadPaths.mockResolvedValue({ attachments: [shot], failed: [] });
  h.dispatch.mockResolvedValue({ ok: true, path: "free-text" });
  h.route.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.startConciergeTurn.mockResolvedValue(null);
});

/** Point the router at the agent for the next send — the routed replacement for flipping the
 *  removed send-target toggle. */
const routeToAgent = () =>
  h.route.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
afterEach(() => {
  cleanup();
  // See ConciergeHost.test.tsx: a module-level armed intent would leak into the next test.
  clearAllIntents();
});

/** Queries scoped to the VISIBLE transcript. The column also renders a hidden `role="status"` live
 *  region carrying the last finished line (roborev 53010), so a document-wide getByText would match
 *  the same string twice — and would pass even if the visible thread stopped rendering it. */
const threadEl = () => screen.getByTestId("concierge-thread");
const inThread = (re: RegExp | string) => within(threadEl()).getByText(re);

describe("ConciergeHost — attach pickers", () => {
  it("the Upload action runs the picker and stages a chip", async () => {
    mount();
    await attachViaUpload();
    expect(h.pick).toHaveBeenCalledWith("files");
    // A staged IMAGE is a PICTURE now (it shares the transcript's AttachmentStrip), so its name is
    // its accessible name rather than body text. Asserted on the role+name so it holds for both
    // shapes the strip can draw — a thumbnail and a named file chip.
    expect(
      within(screen.getByTestId("concierge-attachment-chips")).getByRole("button", {
        name: "View shot.png",
      }),
    ).toBeTruthy();
  });

  // Both attach actions, each on its own kind. Neither needs revealing — they are permanently
  // visible buttons (bead sparkle-f8bjx), and the control's own behaviour is ComposeBox.test.tsx's.
  // This row is only about the host running the right picker for the action that was chosen.
  it("each action runs its own picker kind", async () => {
    mount();
    h.pick.mockResolvedValue({ attachments: [], failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      await Promise.resolve();
    });
    expect(h.pick).toHaveBeenCalledWith("screenshot");
    expect(h.pick).toHaveBeenCalledWith("files");
  });

  it("removing a chip un-stages it", async () => {
    mount();
    await attachViaUpload();
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
  });
});

describe("ConciergeHost — attachments reach the dispatched prompt", () => {
  it("prefixes the path when the prompt goes to the AGENT, as a user prompt", async () => {
    mount();
    await attachViaUpload();
    routeToAgent();
    type("what is wrong here?");
    await clickSend();
    // Three renderings, one message (roborev 46911/46925): only the WIRE payload carries the path.
    expect(h.dispatch).toHaveBeenCalledWith("ag1", "/tmp/shot.png what is wrong here?", {
      // Routed sends now reach the PTY only by way of the countdown gate, so the authority is a
      // `countdown` naming the intent that elapsed (services/dispatchIntent). The id is generated,
      // hence expect.any — what matters is that it is a countdown and not a silent router send.
      authority: { kind: "countdown", intentId: expect.any(String) },
      userPrompt: true,
      display: "what is wrong here? · 1 image",
      namingBasis: "what is wrong here?",
      // FALSE for every send in this file: none of them is @-addressed, so each keeps the
      // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
      neverPickerAnswer: false,
      // FALSE too — the routed path, never a mounted send.
      mountedSend: false,
    });
  });

  // ══ THE SAME CLAIM, ON THE PATH PRODUCTION CAN ACTUALLY REACH (roborev 55309) ═════════════════
  // `routeToAgent()` above is a KNOB — and it is now a knob for a verdict `routeMessage` cannot
  // produce, since the answer-detector was deleted (conciergeRouter's header). The only send that
  // still reaches a terminal is an @-ADDRESSED one, and that path does NOT reuse `payload`: it
  // builds its own fourth rendering, `mentionAim.payload = attachedPayload(wire, staged)`, from the
  // address-stripped text. Nothing pinned it. Rebuild that line from the bare `text` and every
  // suite in the repo stayed green while an addressed message silently dropped the user's
  // screenshot — the same defect the picker suite exists to prevent, on the one path where the
  // agent, not the brain, is the thing left guessing.
  //
  // No `routeToAgent()` here, deliberately: the address alone must be what sends it.
  it("prefixes the path on an ADDRESSED send, and strips only the address", async () => {
    mount();
    await attachViaUpload();
    type("@CI Hardening what is wrong here?");
    await clickSend();
    expect(h.route).not.toHaveBeenCalled(); // named, so nothing is classified or billed
    expect(h.dispatch).toHaveBeenCalledWith(
      "ag1",
      // The `@…` is gone (a leading `@` opens Claude Code's own file autocomplete) — the PATH is not.
      "/tmp/shot.png what is wrong here?",
      expect.objectContaining({
        userPrompt: true,
        // The thread's rendering never carries the temp path (roborev 46911/46925), address or no.
        display: "@CI Hardening what is wrong here? · 1 image",
        // An addressed message is a message, never a keystroke.
        neverPickerAnswer: true,
      }),
    );
  });

  // roborev 53670. The leak that shipped was in the WIRING, not in the formatters: the host had
  // both renderings in scope at the arm site and put the wire payload on the intent. A test that
  // hand-builds an intent cannot see that — and the realistic recurrence, `display: payload`, is
  // two strings that are both in scope on the same line, so it compiles and leaves every other
  // suite green while the banner speaks /tmp/shot.png again. Assert the ARMED intent, before the
  // countdown consumes it, on a send that carries a real attachment.
  it("arms the countdown with the user's words, never the attachment path", async () => {
    mount();
    await attachViaUpload();
    routeToAgent();
    type("what is wrong here?");
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const armed = armedIntents()[0];
    expect(armed, "the send should have armed an intent").toBeTruthy();
    // The payload MUST carry the path — that is what lets the agent read the file.
    expect(armed!.text).toContain("/tmp/shot.png");
    // What the banner and the live region quote must not.
    expect(armed!.display).toBe("what is wrong here? · 1 image");
    expect(armed!.display).not.toContain("/tmp/shot.png");

    await elapseCountdowns();
  });

  it("prefixes the path into the BRAIN snapshot too", async () => {
    mount();
    await attachViaUpload();
    type("what is wrong here?");
    await clickSend();
    const snapshot = h.startConciergeTurn.mock.calls[0]![0];
    expect(snapshot).toContain("/tmp/shot.png what is wrong here?");
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("delivers an attachment with no typed text at all", async () => {
    mount();
    await attachViaUpload();
    routeToAgent();
    await clickSend();
    // An attachments-only send: the naming basis is EMPTY by construction, which is what makes
    // auto-naming skip it rather than naming the agent after a temp file.
    expect(h.dispatch).toHaveBeenCalledWith("ag1", "/tmp/shot.png", {
      // Routed sends now reach the PTY only by way of the countdown gate, so the authority is a
      // `countdown` naming the intent that elapsed (services/dispatchIntent). The id is generated,
      // hence expect.any — what matters is that it is a countdown and not a silent router send.
      authority: { kind: "countdown", intentId: expect.any(String) },
      userPrompt: true,
      display: "1 image",
      namingBasis: "",
      // FALSE for every send in this file: none of them is @-addressed, so each keeps the
      // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
      neverPickerAnswer: false,
      // FALSE too — the routed path, never a mounted send.
      mountedSend: false,
    });
  });
});

describe("ConciergeHost — the thread, and clearing", () => {
  it("shows counts in the transcript and never the temp path", async () => {
    mount();
    await attachViaUpload();
    type("look");
    await clickSend();
    const bubble = inThread(/look/).textContent ?? "";
    expect(bubble).toContain("1 image");
    expect(bubble).not.toContain("tmp");
  });

  it("clears the chips once the send lands, so the next message starts empty", async () => {
    mount();
    await attachViaUpload();
    type("look");
    await clickSend();
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
  });

  it("restores the chips when the agent send did NOT land", async () => {
    h.dispatch.mockResolvedValue({ ok: false, path: "pty-gone" });
    mount();
    await attachViaUpload();
    routeToAgent();
    type("look");
    await clickSend();
    // A staged IMAGE is a PICTURE now (it shares the transcript's AttachmentStrip), so its name is
    // its accessible name rather than body text. Asserted on the role+name so it holds for both
    // shapes the strip can draw — a thumbnail and a named file chip.
    expect(
      within(screen.getByTestId("concierge-attachment-chips")).getByRole("button", {
        name: "View shot.png",
      }),
    ).toBeTruthy();
  });

  // A QUEUED send resolves ok:true — it is held, not lost — so the synchronous restore above never
  // runs for it. If the hold then ages out, the thread says "Send it again" while the files have
  // already been consumed and would have to be re-picked from disk (roborev 51594).
  it("hands the files back when a HELD send never lands", async () => {
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    await attachViaUpload();
    routeToAgent();
    type("look");
    await clickSend();
    // Held: the box is clear while the promise stands.
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();

    await act(async () => {
      h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "x", display: "look · 1 image" });
    });
    // A staged IMAGE is a PICTURE now (it shares the transcript's AttachmentStrip), so its name is
    // its accessible name rather than body text. Asserted on the role+name so it holds for both
    // shapes the strip can draw — a thumbnail and a named file chip.
    expect(
      within(screen.getByTestId("concierge-attachment-chips")).getByRole("button", {
        name: "View shot.png",
      }),
    ).toBeTruthy();
  });

  it("each held send gets its own batch — a file-less queued send can't eat another's", async () => {
    // The Approve relay (and any queued prompt with nothing attached) emits its own deferred
    // outcome. When the hold queue only recorded sends WITH files, that outcome popped the batch
    // belonging to a LATER send: either dropping the files for good, or handing them back while
    // their send was still held so the next send delivered the same file twice (roborev 52969).
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    // 1) a queued send carrying NOTHING…
    routeToAgent();
    type("just words");
    await clickSend();
    // 2) …then one carrying a file.
    await attachViaUpload();
    type("look");
    await clickSend();
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();

    // The FIRST outcome belongs to the file-less send: it must hand back nothing.
    await act(async () => {
      h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "just words" });
    });
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();

    // The SECOND belongs to the send that carried the image.
    await act(async () => {
      h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "x", display: "look · 1 image" });
    });
    // A staged IMAGE is a PICTURE now (it shares the transcript's AttachmentStrip), so its name is
    // its accessible name rather than body text. Asserted on the role+name so it holds for both
    // shapes the strip can draw — a thumbnail and a named file chip.
    expect(
      within(screen.getByTestId("concierge-attachment-chips")).getByRole("button", {
        name: "View shot.png",
      }),
    ).toBeTruthy();
  });

  it("a queued APPROVE takes a slot too, so it can't eat a later send's files", async () => {
    // The relay is machine-authored and carries nothing, but it queues and emits its own outcome —
    // the exact producer/consumer asymmetry that made the hold queue drift (roborev 53015). The
    // typed-prompt case above exercises promptAgent's empty hold; this one exercises approve's.
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    fireEvent.click(screen.getByText("Approve"));
    await act(async () => {});
    await attachViaUpload();
    routeToAgent();
    type("look");
    await clickSend();

    // Approve's outcome first: it held nothing, so nothing comes back.
    await act(async () => {
      h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "approve" });
    });
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
    // …and the file send's outcome still finds its own batch.
    await act(async () => {
      h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "x", display: "look · 1 image" });
    });
    // A staged IMAGE is a PICTURE now (it shares the transcript's AttachmentStrip), so its name is
    // its accessible name rather than body text. Asserted on the role+name so it holds for both
    // shapes the strip can draw — a thumbnail and a named file chip.
    expect(
      within(screen.getByTestId("concierge-attachment-chips")).getByRole("button", {
        name: "View shot.png",
      }),
    ).toBeTruthy();
  });

  it("does NOT hand them back when the held send lands after all", async () => {
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    await attachViaUpload();
    routeToAgent();
    type("look");
    await clickSend();

    await act(async () => {
      h.deferred?.({ ok: true, path: "free-text", agentId: "ag1", sent: "x", display: "look · 1 image" });
    });
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
  });
});

// §8 of PRD/feat/ui-refresh-2026-07-27-plan.md. The counts row above proves the temp path never
// leaks into the transcript; it does NOT prove the user can see WHAT they sent. Before this, a
// screenshot reached the model correctly and left no trace in the column at all — the staged
// attachments live on the view model and are cleared on send, so the bubble had nothing to render.
// The message record now carries its own snapshot, which is what makes it survive scrollback.
describe("ConciergeHost — the sent attachment stays visible in the bubble", () => {
  it("renders the image inline, and it is still there after a later message", async () => {
    mount();
    await attachViaUpload();
    type("look");
    await clickSend();

    const img = within(threadEl()).getByRole("img", { name: "shot.png" });
    expect(img.getAttribute("src")).toBe(shot.dataUrl);

    // The point of snapshotting onto the MESSAGE rather than reading the staged list: a second send
    // clears the staging area, and the first bubble must not go blank when it does.
    type("and again");
    await clickSend();

    const still = within(threadEl()).getByRole("img", { name: "shot.png" });
    expect(still.getAttribute("src")).toBe(shot.dataUrl);
    // …and exactly one: the later message carried nothing, so nothing duplicates.
    expect(within(threadEl()).getAllByRole("img")).toHaveLength(1);
  });

  it("shows a non-image as a named chip, never as a thumbnail", async () => {
    // The picker is a knob in this suite (see the mock): what it returns is what gets staged, so a
    // `file` record here exercises the non-image arm without needing a second attach button.
    h.pick.mockResolvedValue({
      attachments: [
        { id: "f1", kind: "file", path: "/tmp/notes.pdf", name: "notes.pdf" } satisfies Attachment,
      ],
      failed: [],
    });
    mount();
    await attachViaUpload();
    type("read this");
    await clickSend();

    const strip = within(threadEl()).getByTestId("concierge-message-attachments");
    expect(strip.textContent).toContain("notes.pdf");
    expect(within(strip).queryByRole("img")).toBeNull();
  });

  it("clicking the thumbnail opens the full-size lightbox", async () => {
    mount();
    await attachViaUpload();
    type("look");
    await clickSend();

    fireEvent.click(within(threadEl()).getByRole("button", { name: /shot\.png/ }));
    // The lightbox is a modal outside the thread, so the document now holds two renderings of the
    // same image and the lightbox's own download affordance.
    expect(screen.getByTitle("Download…")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "shot.png" })).toHaveLength(2);
  });
});

describe("ConciergeHost — subscription lifecycle", () => {
  it("unsubscribes the deferred-outcome listener on unmount", () => {
    // The `beforeEach` reset remains the backstop for cross-test bleed; this case is what actually
    // asserts the host lets go (roborev 53057). Counted rather than compared to zero: any
    // mount-time state churn that re-ran the effect would otherwise fail this for the wrong reason.
    const view = mount();
    const before = h.unsubscribeDeferred.mock.calls.length;
    const fire = h.deferred;
    view.unmount();
    expect(h.unsubscribeDeferred.mock.calls.length).toBeGreaterThan(before);
    // …and the callback it held is genuinely detached. Only the throw matters here: RTL removes
    // the container on unmount, so a DOM query would return null however the callback behaved —
    // vacuous, not evidence (roborev 53088).
    expect(() => fire?.({ ok: false, path: "expired", agentId: "ag1", sent: "x" })).not.toThrow();
  });
});
