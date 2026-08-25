// @vitest-environment jsdom
//
// THE HOST'S TWO WIRES for the countdown reset (bead sparkle-3kqg2v) — the seam that nothing else
// in this feature can see, and the one this repo's most-repeated failure lives on.
//
// The founder: *"reset the countdown if I paste something in or if I drop in an image or upload a
// file. Just reset the countdown back and then start the countdown again."*
//
// Four files prove the pieces, and every one of them would stay green with the feature 100% inert:
//
//   voice/autoSendTimer.test.ts                    — `restartCountdown` re-anchors the clock
//   voice/useAutoSend.test.ts                      — a bumped `draftGrewSeq` reaches that reducer
//   Concierge/ComposeBox.pasteResets.test.tsx      — a paste fires `onPasted`
//   hooks/useConciergeAttachments.stagedSeq.test.tsx — a drop / a picked file bump `stagedSeq`
//
// What is left is the HOST: it has to hand `onPasted` down through the column to the box, read
// `stagedSeq` off the attachment controller, SUM the two, and pass the total to the rail. Delete any
// one of those lines and all four suites above stay green while pasting does nothing at all — the
// countdown runs on exactly as it did before the fix. So these rows drive the REAL compose box and
// the REAL picker inside the REAL host, and assert on the value the rail actually receives.
//
// `useAutoSend` is WRAPPED, not replaced: the real hook runs underneath and only its argument is
// recorded. A stub returning a hand-built model would assert this file's own fiction.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  dispatch: vi.fn(async (): Promise<{ ok: boolean; path?: string }> => ({ ok: true })),
  pick: vi.fn(),
  loadPaths: vi.fn(),
  route: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  /** Every `draftGrewSeq` the rail has been handed, oldest first. */
  seqs: [] as number[],
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => ({
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
  turnAccountFor: () => null,
  isSupersededDetail: (await importOriginal<typeof import("../services/concierge")>())
    .isSupersededDetail,
  startConciergeTurn: h.startConciergeTurn,
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
  answersLivePicker: () => false,
  pickerPressFor: vi.fn(() => undefined),
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.route }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../services/conciergeAttach", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, pickAttachments: h.pick, loadAttachmentPaths: h.loadPaths };
});
// THE PROBE. Records the argument and delegates to the real hook, so the host is running its actual
// rail rather than a shape this file invented.
vi.mock("../voice/useAutoSend", async (orig) => {
  const real = await orig<typeof import("../voice/useAutoSend")>();
  return {
    ...real,
    useAutoSend: (args: Parameters<typeof real.useAutoSend>[0]) => {
      h.seqs.push(args.draftGrewSeq);
      return real.useAutoSend(args);
    },
  };
});

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { Attachment } from "./composer/attachments";
import { clearAllIntents } from "../services/dispatchIntent";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

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
    topLevel: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  h.seqs = [];
  h.pick.mockResolvedValue({ attachments: [shot], failed: [] });
  h.loadPaths.mockResolvedValue({ attachments: [shot], failed: [] });
  h.dispatch.mockResolvedValue({ ok: true, path: "free-text" });
  h.route.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.startConciergeTurn.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  clearAllIntents();
});

/** What the rail was handed most recently. */
const seq = () => h.seqs[h.seqs.length - 1]!;

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

/** Paste into the REAL compose box the browser's way. jsdom does not run the default action, so the
 *  native insert is performed here only when the handler declined to prevent it. */
function paste(text: string) {
  const ta = box();
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: (t: string) => string };
  };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? text : "") };
  act(() => {
    ta.dispatchEvent(e);
  });
  if (!e.defaultPrevented) {
    fireEvent.change(ta, { target: { value: ta.value + text } });
  }
}

/** Stage a file through the box's own Upload affordance — the real picker seam. */
async function upload() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await Promise.resolve();
  });
}

describe("the host hands the rail a gesture count that actually moves", () => {
  it("starts at zero — mounting is not a gesture", () => {
    mount();
    expect(seq()).toBe(0);
  });

  it("PASTING into the real box moves it — the `onPasted` wire, end to end", async () => {
    // THE FAILING ROW for the column/host threading. Drop `onPasted={onPasted}` from either hop and
    // this is the only assertion in the feature that notices.
    mount();
    const before = seq();
    paste("https://github.com/drodio/sparkle/pull/1934");
    expect(seq()).toBe(before + 1);
  });

  it("UPLOADING a file moves it — the `stagedSeq` wire, end to end", async () => {
    // Same failing row for the other producer: the destructure and the sum. The DROP reaches this
    // identical counter (hooks/useConciergeAttachments.stagedSeq.test.tsx proves the drop half
    // against the real Tauri registration path), so this covers both attachment cases.
    mount();
    const before = seq();
    await upload();
    expect(h.pick).toHaveBeenCalledWith("files");
    expect(seq()).toBe(before + 1);
  });

  it("the two producers are SUMMED, not shadowed — a paste after an upload still counts", async () => {
    // The reason the host adds rather than takes a max: the counters move independently, and a max
    // would swallow a paste made while the attachment count happened to be ahead of it. The rail
    // compares against the previous value, so a swallowed bump is a reset that silently never fires.
    mount();
    await upload();
    const afterUpload = seq();
    paste("one");
    expect(seq()).toBe(afterUpload + 1);
    await upload();
    expect(seq()).toBe(afterUpload + 2);
    paste("two");
    expect(seq()).toBe(afterUpload + 3);
  });

  it("TYPING does not move it — the countdown still ends on an idle box", () => {
    // The scope the founder narrowed to. If ordinary keystrokes bumped this, the countdown would
    // restart on every character and never fire at all — a worse bug than the one being fixed, and
    // one that would present as "auto-send stopped working".
    mount();
    const before = seq();
    fireEvent.change(box(), { target: { value: "ship it now" } });
    fireEvent.change(box(), { target: { value: "ship it now please" } });
    expect(seq()).toBe(before);
  });
});
