// @vitest-environment jsdom
//
// DEAD SUBJECT — THIS FILE DOES NOT COVER THE SHIPPED APP. Nothing mounts <Composer>: it went with
// SparkleAgentPane's composer, and `Composer.unreachable.test.ts` asserts mechanically that no
// non-test file imports it. Every case below really runs and really passes, against a component no
// user can reach — which is why it does not LOOK vacuous. The live compose surface is
// `Concierge/ComposeBox`; a behaviour you need guarded must be pinned there to mean anything.
//
// The composer's side of the "+ New Build Agent" drop target (see useNewBuildAgentDrop):
// drags/drops over the button are the button's — the composer suppresses its drop outline
// and must NOT attach the files — while drops anywhere else keep attaching here. Plus the
// negative half of the pending-attachments queue: this composer must NOT drain it. The drain
// moved to the concierge compose box (ConciergeHost) when db29f0a48 removed the per-agent
// composer; see the comment on that row.
//
// THIS FILE USED TO MOCK `@tauri-apps/api/webview` WHOLESALE, and that is why it scored 11/11
// against an app in which dropping a file did nothing at all. The mock replaced the thing under
// test: `onDragDropEvent` registers FOUR independent listeners (tauri://drag-enter/-over/-drop/
// -leave) and builds the `{type, paths, position}` payload these branches read, and a stub that
// hands the component one fabricated handler plus hand-authored payloads asserts none of it. The
// event names could change, the drop listener could stop being registered, the payload shape could
// move — and every assertion below would still have passed.
//
// It now runs against `src/test/tauriEventBackend`, which mocks one layer LOWER
// (`window.__TAURI_INTERNALS__`), so the real `@tauri-apps/api` executes on top: real `listen()`,
// real event names, real payload construction. `fire()` emits WIRE-shaped events by name, exactly
// as Rust does.
//
// WHAT THAT BUYS, measured rather than asserted. Deleting the registration entirely fails BOTH
// versions — but the old one dies with `TypeError: captured.handler is not a function`, a crash in
// the test's own scaffolding that names nothing, while this one fails on "registers all four drag
// phases under Tauri's real wire names" and says so. The structural gain is the class of fault that
// only reaches the real API: an upstream rename of `tauri://drag-drop`, a change to the
// `{type, paths, position}` mapping, a registration that drops one of the four, or a listener that
// stops being webview-scoped. The old file fabricated the POST-mapping payload, so none of those
// could ever reach an assertion in it; here every one of them does.
//
// Still stubbed, and honestly so: `document.elementFromPoint`. jsdom has no layout engine, so a hit
// test cannot be exercised for real here — the stub places the "cursor" over one marked surface or
// another. That is a genuine limit of this environment, not a seam being faked away.
import { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => ({
  submitPrompt: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Tile loading normally round-trips through Rust; resolve file tiles synchronously instead.
vi.mock("./composer/attachmentsApi", () => ({
  nextId: (() => {
    let seq = 0;
    return (prefix: string) => `${prefix}-${++seq}`;
  })(),
  loadAttachment: vi.fn((path: string) =>
    Promise.resolve({
      id: `att-${path}`,
      kind: "file" as const,
      path,
      name: path.split("/").pop()!,
    }),
  ),
  copyImageToClipboard: vi.fn(() => Promise.resolve()),
  downloadAttachment: vi.fn(() => Promise.resolve(true)),
  downloadAttachments: vi.fn(() => Promise.resolve(true)),
  screenshotAttachment: (path: string, dataUrl: string) => ({
    id: `shot-${path}`,
    kind: "image" as const,
    path,
    name: "screenshot.png",
    dataUrl,
  }),
}));

import { Composer } from "./Composer";
import { loadAttachment } from "./composer/attachmentsApi";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
import {
  CONCIERGE_COLUMN_DND_TARGET,
  NEW_BUILD_AGENT_DND_TARGET,
  SPARKLE_TERMINAL_DND_TARGET,
  reportDropWithNoTarget,
} from "../services/dndTargets";
import { log } from "../logger";
import {
  installTauriEventBackend,
  DRAG_ENTER,
  DRAG_OVER,
  DRAG_DROP,
  DRAG_LEAVE,
  type TauriEventBackend,
} from "../test/tauriEventBackend";

// jsdom has no elementFromPoint — stub it to place the "cursor" over one of the two surfaces that
// own a dropped file themselves (services/dndTargets.FILE_DROP_TARGETS), or over neither.
const button = document.createElement("button");
button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
const conciergeBox = document.createElement("div");
conciergeBox.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
// The Sparkle pane's TERMINAL box — the third surface that owns its drops. This composer renders in
// that same pane, directly below this box, which is why it has to hit-test the region rather than
// assume "my pane, my drop".
const sparkleTerminal = document.createElement("div");
sparkleTerminal.setAttribute("data-dnd-target", SPARKLE_TERMINAL_DND_TARGET);
let overButton = false;
let overConciergeBox = false;
let overSparkleTerminal = false;

/** The point every "over a marked surface" case drags to, and the one that is nowhere. */
const ON_TARGET = { x: 10, y: 10 };
const ELSEWHERE = { x: 400, y: 400 };

// THE STUB HONOURS ITS ARGUMENTS (roborev 57048). It used to ignore them entirely and answer purely
// from the module-level flags below, which meant the `position` half of the payload never reached an
// assertion: `isOverDndTarget` is its only consumer, so a broken coordinate mapping — the wire
// position arriving mangled, halved, or dropped — selected exactly the same branch and every test
// still passed. Requiring the coordinates to match makes the emitted position load-bearing, so the
// file now covers all three fields of `{type, paths, position}` rather than two.
document.elementFromPoint = vi.fn((x: number, y: number) => {
  if (x !== ON_TARGET.x || y !== ON_TARGET.y) return document.body;
  return overButton
    ? button
    : overConciergeBox
      ? conciergeBox
      : overSparkleTerminal
        ? sparkleTerminal
        : document.body;
});

let backend: TauriEventBackend;

/** Emit a real `tauri://drag-*` event. Takes the API-level shape the tests were written against and
 *  sends the WIRE payload Rust actually sends; the genuine `onDragDropEvent` does the mapping. */
const fire = (p: { type: string; position?: { x: number; y: number }; paths?: string[] }) =>
  act(() => {
    const { type, position, paths } = p;
    if (type === "enter") backend.emit(DRAG_ENTER, { paths, position });
    else if (type === "over") backend.emit(DRAG_OVER, { position });
    else if (type === "drop") backend.emit(DRAG_DROP, { paths, position });
    else if (type === "leave") backend.emit(DRAG_LEAVE, null);
    else throw new Error(`unknown drag phase: ${type}`);
  });

beforeEach(() => {
  backend = installTauriEventBackend("main");
  vi.mocked(loadAttachment).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
  vi.mocked(log.info).mockClear();
  overButton = false;
  overConciergeBox = false;
  overSparkleTerminal = false;
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
  usePendingAttachmentsStore.setState({ pending: {} });
});
afterEach(async () => {
  cleanup();
  // Let the unmount's async unlisten settle against the LIVE backend before retiring it.
  await Promise.resolve();
  backend.teardown();
});

async function renderComposer(
  agentId = "a1",
  inputRef = createRef<HTMLTextAreaElement>(),
  onSubmitPrompt: () => void = vi.fn(),
) {
  const view = render(
    <Composer
      agentId={agentId}
      active
      disabled={false}
      inputRef={inputRef}
      onSubmitPrompt={onSubmitPrompt}
    />,
  );
  // Registration is four real IPC round-trips now, not a synchronous stub assignment.
  await waitFor(() => expect(backend.eventNames()).toContain(DRAG_DROP));
  return view;
}

describe("Composer — new-build-agent drop target", () => {
  // THE ASSERTION THE OLD MOCK COULD NOT MAKE. With `@tauri-apps/api/webview` stubbed out the wire
  // names were never used at all, so an upstream rename — or a registration that quietly covers
  // only three of the four phases — had nothing to fail against. Naming the literal strings is
  // deliberate: asserting against our own constants would only prove they equal themselves.
  it("registers all four drag phases under Tauri's real wire names", async () => {
    await renderComposer();
    expect(backend.eventNames().sort()).toEqual(
      [DRAG_ENTER, DRAG_OVER, DRAG_DROP, DRAG_LEAVE].sort(),
    );
  });

  // FINDING 1's positive half: prove the emitted wire position actually reaches the hit test,
  // rather than only proving that some element was returned.
  it("passes the emitted wire position through to the hit test", async () => {
    await renderComposer();
    vi.mocked(document.elementFromPoint).mockClear();
    fire({ type: "drop", position: ON_TARGET, paths: ["/tmp/notes.txt"] });
    expect(document.elementFromPoint).toHaveBeenCalledWith(ON_TARGET.x, ON_TARGET.y);
  });

  // CHURN (roborev 57048). `Composer`'s effect deps are [active, attachPaths, overOtherTarget]; if
  // any upstream link loses memoization the effect re-runs per render, and because teardown is async
  // there is a window on EVERY render with no drop listener — precisely the "drop does nothing"
  // symptom. Asserted on the CUMULATIVE count, because a churning effect unregisters as well as
  // registers and the live count settles back to 4 (see tauriEventBackend.listenCount).
  it("registers ONCE and does not churn across re-renders", async () => {
    // STABLE PROPS ACROSS RE-RENDERS, and this is the whole care of the test. A fresh
    // `createRef()` or a fresh `onSubmitPrompt` per re-render changes `inputRef`, which invalidates
    // `attachPaths`, which legitimately re-runs the effect — so an unstable-props loop measures the
    // TEST, not the component. (First draft did exactly that and read 25 `tauri://drag-enter`
    // registrations, which looked like a Composer leak and was not.)
    const ref = createRef<HTMLTextAreaElement>();
    const onSubmit = vi.fn();
    // Mount with the SAME props the re-renders use, or the first re-render legitimately re-runs the
    // effect and the count reads 2 — measuring the harness rather than the component.
    const view = await renderComposer("a1", ref, onSubmit);
    for (let i = 0; i < 25; i++) view.rerender(
      <Composer agentId="a1" active disabled={false} inputRef={ref} onSubmitPrompt={onSubmit} />,
    );
    // Let every pending listen()/unlisten() chain settle — each registration is four sequential
    // awaits, so a single microtask tick would sample mid-flight and undercount.
    await waitFor(() => expect(backend.registered.length).toBeLessThanOrEqual(4));
    // CUMULATIVE, never decremented: a churning effect unregisters as well as registers, so the
    // LIVE count settles back to 4 and would pass while the listener was absent half the time.
    expect(backend.listenCount(DRAG_DROP)).toBe(1);
    expect(backend.registered).toHaveLength(4);
  });

  it("scopes its listeners to THIS webview, not to every target", async () => {
    await renderComposer();
    // A global listen would let a drop on another window attach files into this composer.
    for (const r of backend.registered) {
      expect(r.target).toEqual({ kind: "Webview", label: "main" });
    }
  });

  it("attaches a drop that lands anywhere else (existing behavior)", async () => {
    await renderComposer();
    fire({ type: "drop", position: ELSEWHERE, paths: ["/tmp/notes.txt"] });
    expect(loadAttachment).toHaveBeenCalledWith("/tmp/notes.txt");
    expect(await screen.findByText("notes.txt")).toBeTruthy();
  });

  it("ignores a drop on the + New Build Agent button (the button's listener owns it)", async () => {
    await renderComposer();
    overButton = true;
    fire({ type: "drop", position: ON_TARGET, paths: ["/tmp/notes.txt"] });
    // Nothing loads and no tile appears — the file belongs to the NEW agent's composer.
    expect(loadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  // The concierge compose box is the OTHER surface that owns its drops (useConciergeAttachments
  // stages the file for the next prompt). Both carve-outs come from one list now, but only the
  // button half had ever been pinned (roborev 51593) — and the failure mode is the one the code
  // comment warns about: the same file attaching twice, here AND in the concierge box.
  it("ignores a drop on the concierge compose box (it stages the file itself)", async () => {
    await renderComposer();
    overConciergeBox = true;
    fire({ type: "drop", position: ON_TARGET, paths: ["/tmp/notes.txt"] });
    expect(loadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  // THE TERMINAL RIGHT ABOVE THIS BOX. Both surfaces live in the Sparkle pane, and this composer's
  // catch-all used to take the whole pane — so a file dropped on the terminal was loaded here as a
  // chat tile instead of pasted into the CLI. Loading reads the file, and the loader refuses paths
  // outside the allowed roots or under a dot-directory, which is how a dropped .txt could vanish
  // with only a log line. The paste half is asserted in SparkleAgentPane.drop.test.tsx; this is the
  // half that keeps the file from ALSO landing here.
  it("ignores a drop on the Sparkle pane's terminal (it pastes the path itself)", async () => {
    await renderComposer();
    overSparkleTerminal = true;
    fire({ type: "drop", position: ON_TARGET, paths: ["/tmp/notes.txt"] });
    expect(loadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("suppresses the drop-here visual over the Sparkle terminal, so only one surface lights up", async () => {
    await renderComposer();
    const dropHint = () =>
      (screen.getByRole("textbox") as HTMLTextAreaElement).placeholder.startsWith("Drop the file");
    fire({ type: "enter", position: ELSEWHERE, paths: ["/tmp/notes.txt"] });
    expect(dropHint()).toBe(true);
    overSparkleTerminal = true;
    fire({ type: "over", position: ON_TARGET });
    expect(dropHint()).toBe(false);
  });

  it("suppresses the drop-here visual over the concierge box too", async () => {
    await renderComposer();
    const dropHint = () =>
      (screen.getByRole("textbox") as HTMLTextAreaElement).placeholder.startsWith("Drop the file");
    fire({ type: "enter", position: ELSEWHERE, paths: ["/tmp/a.png"] });
    expect(dropHint()).toBe(true);
    overConciergeBox = true;
    fire({ type: "over", position: ON_TARGET });
    expect(dropHint()).toBe(false);
  });

  it("suppresses the drop-here visual while the drag is over the button", async () => {
    await renderComposer();
    // dropActive drives both the dashed textarea border and this placeholder — assert on the
    // placeholder (the border shorthand doesn't survive jsdom's style parsing).
    const dropHint = () =>
      (screen.getByRole("textbox") as HTMLTextAreaElement).placeholder.startsWith("Drop the file");
    fire({ type: "enter", position: ELSEWHERE, paths: ["/tmp/a.png"] });
    expect(dropHint()).toBe(true); // normal drag-over composer → "drop here" state
    overButton = true;
    fire({ type: "over", position: ON_TARGET });
    expect(dropHint()).toBe(false); // over the button → the button's hover visual, not ours
    overButton = false;
    fire({ type: "over", position: ELSEWHERE });
    expect(dropHint()).toBe(true); // dragging back off the button re-arms the composer
  });

  // THE DRAIN ITSELF NO LONGER LIVES HERE. Files queued by a "+ New Build Agent" drop are staged on
  // the CONCIERGE compose box now — that is the input surface for a build agent since db29f0a48
  // removed the per-agent composer, and this Composer only ever renders for the Sparkle self-improve
  // agent, which no drop can key to. Coverage moved with the behaviour, to
  // ConciergeHost.test.tsx ("capture handoffs land in the compose box"). What stays here is the
  // half that is still this file's job: this composer must keep its hands OFF the queue, so a drop
  // can't be consumed by a surface that will never show it.
  it("never drains the new-build-agent queue — that belongs to the concierge box now", async () => {
    usePendingAttachmentsStore.getState().add("a1", ["/tmp/handoff.txt"]);
    usePendingAttachmentsStore.getState().add("someone-else", ["/tmp/theirs.txt"]);
    await renderComposer("a1");
    expect(loadAttachment).not.toHaveBeenCalled();
    // Both entries survive, its own included — untouched, not merely un-rendered.
    expect(usePendingAttachmentsStore.getState().drain("a1")).toEqual(["/tmp/handoff.txt"]);
    expect(usePendingAttachmentsStore.getState().drain("someone-else")).toEqual([
      "/tmp/theirs.txt",
    ]);
  });
});

// THE CATCH-ALL WIRING (roborev 53914). dndTargets covers the counter itself, but the half that
// decides whether the alarm behaves is HERE: this composer accepts any drop outside
// FILE_DROP_TARGETS — the sidebar, the tab strip, the top bar — none of which any `data-dnd-target`
// region describes, so without a registration the other listeners report those successful drops as
// dead. Deleting `registerCatchAllDropTarget()` restores exactly the false warnings the change
// removed; deleting `unregisterCatchAll()` from the cleanup leaks the counter and permanently
// disables the alarm for the session, and RATCHETS, because the Sparkle pane mounts and unmounts
// every time the user switches panes. Both mutations leave the rest of the suite green.
describe("Composer — registers as the window-global catch-all drop target", () => {
  /** A position over neither marked target, i.e. the drop only a catch-all would claim. */
  const nowhere = { x: 400, y: 400 };

  it("suppresses the dead-drop WARNING while it is mounted and active", async () => {
    await renderComposer();
    reportDropWithNoTarget(nowhere);
    expect(log.warn).not.toHaveBeenCalled();
    // Downgraded, not dropped — at INFO, which always forwards to the persistent log (debug
    // does not in a shipped build), so a support capture still carries the record.
    expect(log.info).toHaveBeenCalled();
  });

  it("releases the registration on unmount, so the alarm comes back", async () => {
    await renderComposer();
    cleanup();
    // A DIFFERENT position: the reporter dedupes on the last one it saw.
    reportDropWithNoTarget({ x: 401, y: 400 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    // AND the four real listeners must actually come off (roborev 57048). The counter above is the
    // catch-all claim only; without this, a cleanup that dropped `safeUnlisten(unlistenPromise)` —
    // leaking a listener that keeps attaching files into an unmounted composer — passes untouched.
    await waitFor(() => expect(backend.eventNames()).not.toContain(DRAG_DROP));
    expect(backend.registered).toHaveLength(0);
  });

  it("does not register at all when it is not the active pane", async () => {
    render(
      <Composer
        agentId="a1"
        active={false}
        disabled={false}
        inputRef={createRef<HTMLTextAreaElement>()}
        onSubmitPrompt={vi.fn()}
      />,
    );
    reportDropWithNoTarget({ x: 402, y: 400 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    // DIRECTLY, now that the real registration is observable: an inactive pane must hold no
    // listener at all. The catch-all counter above is a proxy for that; this is the thing itself,
    // and it is what would catch a background pane quietly claiming drops meant for the visible one.
    await Promise.resolve();
    expect(backend.eventNames()).toEqual([]);
  });
});
