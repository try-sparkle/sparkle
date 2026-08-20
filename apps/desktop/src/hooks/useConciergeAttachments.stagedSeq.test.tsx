// @vitest-environment jsdom
//
// `stagedSeq` — the countdown-reset signal for two of the founder's three cases (bead
// sparkle-3kqg2v): *"reset the countdown if I paste something in or if I drop in an image or upload
// a file."* The paste is the compose box's own (../components/Concierge/ComposeBox.pasteResets.test.tsx);
// the DROP and the PICKER both land here, and the host sums the two counters into `draftGrewSeq`.
//
// THE DROP RUNS THROUGH THE REAL TAURI REGISTRATION PATH, borrowed wholesale from
// ./useConciergeAttachments.registration.test.tsx — `window.__TAURI_INTERNALS__` is the only thing
// stubbed, so the real `getCurrentWebview().onDragDropEvent`, the real event names and the real
// payload mapping all run. A test that fabricated the handler could not tell a drop that reaches
// `add` from one that does not, which is the entire question here.
//
// WHY A SEPARATE FILE from the registration suite: that one is about whether the listeners exist at
// all. This is about what STAGING means — which producers count as a gesture and which do not — and
// the `restore` row below is the one nothing else in the suite would notice going wrong.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCore = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (orig) => {
  const actual = await orig<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeCore };
});
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/conciergeAttach", () => ({
  loadAttachmentPaths: vi.fn((paths: string[]) =>
    Promise.resolve({
      attachments: paths.map((p) => ({ id: `att-${p}`, kind: "file", path: p, name: p })),
      failed: [],
    }),
  ),
  pickAttachments: vi.fn(),
}));

import { installTauriEventBackend, DRAG_DROP, type TauriEventBackend } from "../test/tauriEventBackend";
import { useConciergeAttachments } from "./useConciergeAttachments";
import { loadAttachmentPaths, pickAttachments } from "../services/conciergeAttach";
import { CONCIERGE_COLUMN_DND_TARGET } from "../services/dndTargets";
import type { Attachment } from "../components/composer/attachments";

const column = document.createElement("div");
column.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
document.elementFromPoint = vi.fn(() => column);

const overConcierge = { x: 120, y: 400 };
let backend: TauriEventBackend;

beforeEach(() => {
  backend = installTauriEventBackend("main");
  invokeCore.mockReset();
  invokeCore.mockResolvedValue([]);
  vi.mocked(loadAttachmentPaths).mockClear();
  vi.mocked(pickAttachments).mockReset();
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  backend.teardown();
});

/** Mount and wait for the drag listeners to settle. */
async function mounted() {
  const view = renderHook(() => useConciergeAttachments());
  await waitFor(() => expect(backend.eventNames()).toContain(DRAG_DROP));
  return view;
}

/** A file lands on the concierge column, through the real wire payload shape. */
function drop(...paths: string[]) {
  act(() => {
    backend.emit(DRAG_DROP, { paths, position: overConcierge });
  });
}

const att = (id: string): Attachment =>
  ({ id, kind: "file", path: `/Users/x/${id}`, name: id }) as unknown as Attachment;

describe("a DROPPED image bumps stagedSeq (the founder's case 2)", () => {
  it("THE REPORT: dropping an image counts as a gesture", async () => {
    const { result } = await mounted();
    expect(result.current.stagedSeq, "mounting is not a gesture").toBe(0);

    drop("/Users/x/photo.png");

    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.stagedSeq).toBe(1);
  });

  it("ONE bump per DROP, not per FILE — a three-file drag is one gesture", async () => {
    // The countdown it restarts is owed one fresh threshold, not three. This is also what makes the
    // counter honest as a gesture count rather than a disguised `attachments.length`.
    const { result } = await mounted();
    drop("/Users/x/a.png", "/Users/x/b.png", "/Users/x/c.png");
    await waitFor(() => expect(result.current.attachments).toHaveLength(3));
    expect(result.current.stagedSeq).toBe(1);
  });

  it("two separate drops are two gestures", async () => {
    const { result } = await mounted();
    drop("/Users/x/a.png");
    await waitFor(() => expect(result.current.stagedSeq).toBe(1));
    drop("/Users/x/b.png");
    await waitFor(() => expect(result.current.stagedSeq).toBe(2));
  });

  it("a drop that MISSES the concierge column bumps nothing", async () => {
    // The webview drag event is window-global and two other listeners are live. A drop aimed at
    // "+ New Build Agent" must not restart this composer's countdown.
    const { result } = await mounted();
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      document.createElement("div"), // no data-dnd-target
    );
    drop("/Users/x/elsewhere.png");
    await Promise.resolve();
    expect(loadAttachmentPaths).not.toHaveBeenCalled();
    expect(result.current.stagedSeq).toBe(0);
  });
});

describe("an UPLOADED file bumps stagedSeq (the founder's case 3)", () => {
  it("THE REPORT: choosing a file from the picker counts as a gesture", async () => {
    const { result } = await mounted();
    vi.mocked(pickAttachments).mockResolvedValue({
      attachments: [att("picked.png")],
      failed: [],
    } as unknown as Awaited<ReturnType<typeof pickAttachments>>);

    act(() => {
      result.current.attach("image");
    });

    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.stagedSeq).toBe(1);
  });

  it("a CANCELLED picker bumps nothing — nothing arrived in the box", async () => {
    // A cancel resolves an empty outcome, which is silent everywhere else here too (it raises no
    // notice). Restarting the countdown on it would hold a send back for a gesture the user aborted.
    const { result } = await mounted();
    vi.mocked(pickAttachments).mockResolvedValue({
      attachments: [],
      failed: [],
    } as unknown as Awaited<ReturnType<typeof pickAttachments>>);

    act(() => {
      result.current.attach("files");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.stagedSeq).toBe(0);
  });
});

describe("…and the things that are NOT a gesture", () => {
  it("RESTORE does not bump — a failed send putting files back is not the user staging them", async () => {
    // THE ROW THIS FILE EXISTS FOR. `restore` grows `attachments`, so anything watching the LENGTH
    // would fire here — handing a fresh countdown to a draft the user has not touched, on the one
    // path where they are already being told their send did not land. `add` is the funnel;
    // `restore`, `remove` and `take` all bypass it, and that is what keeps this structural.
    const { result } = await mounted();
    drop("/Users/x/a.png");
    await waitFor(() => expect(result.current.stagedSeq).toBe(1));

    let taken: Attachment[] = [];
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toHaveLength(1);
    expect(result.current.stagedSeq, "a send is not a gesture either").toBe(1);

    act(() => {
      result.current.restore(taken);
    });
    expect(result.current.attachments).toHaveLength(1); // the files ARE back…
    expect(result.current.stagedSeq, "…but nothing was staged").toBe(1);
  });

  it("REMOVING a staged file does not bump", async () => {
    const { result } = await mounted();
    drop("/Users/x/a.png");
    await waitFor(() => expect(result.current.stagedSeq).toBe(1));
    const id = result.current.attachments[0]!.id;
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.stagedSeq).toBe(1);
  });

  it("NEVER GOES BACKWARDS, so the host's sum is monotonic", async () => {
    // The host adds this to its paste count and feeds the total to useAutoSend, which compares it
    // against the previous value. A counter that could decrease would make a real gesture read as
    // "unchanged" and silently drop a reset.
    const { result } = await mounted();
    const seen: number[] = [];
    drop("/Users/x/a.png");
    await waitFor(() => expect(result.current.stagedSeq).toBe(1));
    seen.push(result.current.stagedSeq);
    act(() => {
      result.current.remove(result.current.attachments[0]!.id);
    });
    seen.push(result.current.stagedSeq);
    drop("/Users/x/b.png");
    await waitFor(() => expect(result.current.stagedSeq).toBe(2));
    seen.push(result.current.stagedSeq);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});
