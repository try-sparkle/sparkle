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
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatch,
  flushPendingSends: vi.fn(async () => []),
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
// The voice stack (CM-U9) is mocked in EVERY host test, not just the voice one (roborev 48171):
// the host imports it unconditionally, so without this the base tests run the real dictation hook
// and the real stopVoice() on every simulated send — mutating global dictation state and coupling
// these tests to the mic pipeline.
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    micLive: false,
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("../services/conciergeVoice", () => ({
  speakConciergeReply: vi.fn(async () => "elevenlabs" as const),
  speakOnDemand: vi.fn(async () => "elevenlabs" as const),
  stopConciergeVoice: vi.fn(),
  shouldSpeakConciergeReply: vi.fn(() => true),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
vi.mock("../services/conciergeAttach", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, pickAttachments: h.pick, loadAttachmentPaths: h.loadPaths };
});

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { Attachment } from "./composer/attachments";

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
  };
  const counts = { needs_you: 1, running: 0, done: 0 };
  return {
    projects: [{ id: "p1", name: "sparkle", inScope: true, counts, agents: [agent] }],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const mount = () => render(<ConciergeHost feed={feed()} promptTarget={target} />);

async function attachImage() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    await Promise.resolve();
  });
}

const type = (text: string) =>
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

const clickSend = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText("Send"));
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  h.deferred = undefined; // no stale subscription answering for an unmounted host
  vi.clearAllMocks();
  h.pick.mockResolvedValue([shot]);
  h.loadPaths.mockResolvedValue([shot]);
  h.dispatch.mockResolvedValue({ ok: true, path: "free-text" });
});
afterEach(() => cleanup());

/** Queries scoped to the VISIBLE transcript. The column also renders a hidden `role="status"` live
 *  region carrying the last finished line (roborev 53010), so a document-wide getByText would match
 *  the same string twice — and would pass even if the visible thread stopped rendering it. */
const threadEl = () => screen.getByTestId("concierge-thread");
const inThread = (re: RegExp | string) => within(threadEl()).getByText(re);

describe("ConciergeHost — attach pickers", () => {
  it("the Image button runs the picker and stages a chip", async () => {
    mount();
    await attachImage();
    expect(h.pick).toHaveBeenCalledWith("image");
    expect(screen.getByTestId("concierge-attachment-chips").textContent).toContain("shot.png");
  });

  it("each button runs its own picker kind", async () => {
    mount();
    h.pick.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
      fireEvent.click(screen.getByRole("button", { name: "Files" }));
      await Promise.resolve();
    });
    expect(h.pick).toHaveBeenCalledWith("screenshot");
    expect(h.pick).toHaveBeenCalledWith("files");
  });

  it("removing a chip un-stages it", async () => {
    mount();
    await attachImage();
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
  });
});

describe("ConciergeHost — attachments reach the dispatched prompt", () => {
  it("prefixes the path when the prompt goes to the AGENT, as a user prompt", async () => {
    mount();
    await attachImage();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    type("what is wrong here?");
    await clickSend();
    // Three renderings, one message (roborev 46911/46925): only the WIRE payload carries the path.
    expect(h.dispatch).toHaveBeenCalledWith("ag1", "/tmp/shot.png what is wrong here?", {
      userPrompt: true,
      display: "what is wrong here? · 1 image",
      namingBasis: "what is wrong here?",
    });
  });

  it("prefixes the path into the BRAIN snapshot too", async () => {
    mount();
    await attachImage();
    type("what is wrong here?");
    await clickSend();
    const snapshot = h.startConciergeTurn.mock.calls[0]![0];
    expect(snapshot).toContain("/tmp/shot.png what is wrong here?");
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("delivers an attachment with no typed text at all", async () => {
    mount();
    await attachImage();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    await clickSend();
    // An attachments-only send: the naming basis is EMPTY by construction, which is what makes
    // auto-naming skip it rather than naming the agent after a temp file.
    expect(h.dispatch).toHaveBeenCalledWith("ag1", "/tmp/shot.png", {
      userPrompt: true,
      display: "1 image",
      namingBasis: "",
    });
  });
});

describe("ConciergeHost — the thread, and clearing", () => {
  it("shows counts in the transcript and never the temp path", async () => {
    mount();
    await attachImage();
    type("look");
    await clickSend();
    const bubble = inThread(/look/).textContent ?? "";
    expect(bubble).toContain("1 image");
    expect(bubble).not.toContain("tmp");
  });

  it("clears the chips once the send lands, so the next message starts empty", async () => {
    mount();
    await attachImage();
    type("look");
    await clickSend();
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
  });

  it("restores the chips when the agent send did NOT land", async () => {
    h.dispatch.mockResolvedValue({ ok: false, path: "pty-gone" });
    mount();
    await attachImage();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    type("look");
    await clickSend();
    expect(screen.getByTestId("concierge-attachment-chips").textContent).toContain("shot.png");
  });

  // A QUEUED send resolves ok:true — it is held, not lost — so the synchronous restore above never
  // runs for it. If the hold then ages out, the thread says "Send it again" while the files have
  // already been consumed and would have to be re-picked from disk (roborev 51594).
  it("hands the files back when a HELD send never lands", async () => {
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    await attachImage();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    type("look");
    await clickSend();
    // Held: the box is clear while the promise stands.
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();

    await act(async () => {
      h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "x", display: "look · 1 image" });
    });
    expect(screen.getByTestId("concierge-attachment-chips").textContent).toContain("shot.png");
  });

  it("each held send gets its own batch — a file-less queued send can't eat another's", async () => {
    // The Approve relay (and any queued prompt with nothing attached) emits its own deferred
    // outcome. When the hold queue only recorded sends WITH files, that outcome popped the batch
    // belonging to a LATER send: either dropping the files for good, or handing them back while
    // their send was still held so the next send delivered the same file twice (roborev 52969).
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    // 1) a queued send carrying NOTHING…
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    type("just words");
    await clickSend();
    // 2) …then one carrying a file.
    await attachImage();
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
    expect(screen.getByTestId("concierge-attachment-chips").textContent).toContain("shot.png");
  });

  it("a queued APPROVE takes a slot too, so it can't eat a later send's files", async () => {
    // The relay is machine-authored and carries nothing, but it queues and emits its own outcome —
    // the exact producer/consumer asymmetry that made the hold queue drift (roborev 53015). The
    // typed-prompt case above exercises promptAgent's empty hold; this one exercises approve's.
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    fireEvent.click(screen.getByText("Approve"));
    await act(async () => {});
    await attachImage();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
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
    expect(screen.getByTestId("concierge-attachment-chips").textContent).toContain("shot.png");
  });

  it("does NOT hand them back when the held send lands after all", async () => {
    h.dispatch.mockResolvedValue({ ok: true, path: "queued" });
    mount();
    await attachImage();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    type("look");
    await clickSend();

    await act(async () => {
      h.deferred?.({ ok: true, path: "free-text", agentId: "ag1", sent: "x", display: "look · 1 image" });
    });
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
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
