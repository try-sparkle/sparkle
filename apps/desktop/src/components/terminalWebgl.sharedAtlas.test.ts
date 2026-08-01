// Regression guard for the ONE-PANE-MOJIBAKE bug: a single terminal renders as dense garbage —
// blocks, box-drawing fragments, coloured noise — while every other pane in the same window is fine.
//
// This is the corrupted-glyph symptom that SURVIVED the context cap, the explicit context release
// and the lost-context draw guard, and it survived them because it is not a context bug at all.
//
// THE MECHANISM (see DEFECT #4 in terminalWebgl.ts for the addon source it is derived from):
// xterm gives every terminal with an equal config the SAME TextureAtlas — and Sparkle's panes all
// match on font, cell size, dpr and palette, so they share one. But one renderer's
// clearTextureAtlas() wipes the SHARED bitmap and glyph cache while clearing only ITS OWN per-cell
// model. Every other pane is left holding texture coordinates into a packing that no longer exists,
// so it draws the right cells in the right colors with the WRONG GLYPHS.
//
// The asymmetry is the tell, and it is what these tests pin: the pane that cleared looks fine, its
// siblings do not. A process-wide context budget cannot produce that.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  forceFullRepaint,
  registerAtlasPeer,
  unregisterAtlasPeer,
  clearSharedAtlasEverywhere,
  resetAtlasPeers,
} from "./terminalWebgl";

beforeEach(() => resetAtlasPeers());

function makePane() {
  return { clearTextureAtlas: vi.fn() };
}
const term = { refresh: vi.fn(), rows: 24 };

describe("clearing the shared texture atlas", () => {
  it("resyncs EVERY pane sharing the atlas, not just the one that cleared it", () => {
    // The founder's window: several panes open, one of them repaints.
    const repainting = makePane();
    const sibling1 = makePane();
    const sibling2 = makePane();
    [repainting, sibling1, sibling2].forEach(registerAtlasPeer);

    clearSharedAtlasEverywhere(repainting);

    // Without the broadcast the siblings are never told, and their per-cell models keep pointing at
    // the old packing — which is exactly what puts mojibake on screen.
    expect(sibling1.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(sibling2.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("clears the originating pane EXACTLY once — the broadcast must not double-clear it", () => {
    // The origin is cleared explicitly and then skipped in the peer loop. Clearing it twice would
    // wipe the atlas a second time right after the peers repopulated it, re-creating the bug.
    const origin = makePane();
    const sibling = makePane();
    [origin, sibling].forEach(registerAtlasPeer);

    clearSharedAtlasEverywhere(origin);

    expect(origin.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("clears an origin that was never registered (mid-attach, or a DOM-renderer pane)", () => {
    // attachWebgl registers only after the canvas probe succeeds, so an origin can legitimately be
    // absent from the set. It must still be cleared rather than silently skipped.
    const unregistered = makePane();
    const sibling = makePane();
    registerAtlasPeer(sibling);

    clearSharedAtlasEverywhere(unregistered);

    expect(unregistered.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(sibling.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("does NOT broadcast for a pane that owns no renderer", () => {
    // Attachment is capped at MAX_WEBGL_CONTEXTS and only visible panes hold one, so of 60-80 open
    // agents all but ~4 pass null here. Those panes never touched the shared atlas, so waking every
    // peer on their behalf is pure destruction — and the two callers that pass a nullable value run
    // on EVERY pane's mount (the theme/calm effect) and on document.fonts.ready. Broadcasting from
    // them would wipe the shared bitmap once per pane on a cold launch, so the atlas would never
    // stay warm and every live pane would re-rasterize its whole viewport 60-80 times over.
    const peer1 = makePane();
    const peer2 = makePane();
    [peer1, peer2].forEach(registerAtlasPeer);

    clearSharedAtlasEverywhere(null);

    expect(peer1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(peer2.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("does not clear a pane that has been torn down", () => {
    // teardownWebgl unregisters BEFORE dispose. A stale peer would mean calling clearTextureAtlas()
    // on a disposed addon on every later repaint.
    const live = makePane();
    const gone = makePane();
    [live, gone].forEach(registerAtlasPeer);
    unregisterAtlasPeer(gone);

    clearSharedAtlasEverywhere(live);

    expect(gone.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("keeps resyncing the healthy peers when one of them throws", () => {
    // One dead addon must not strand every other pane with a stale model — that would turn a
    // one-pane bug into an all-panes bug, which is the failure this whole broadcast exists to stop.
    const origin = makePane();
    const throws = {
      clearTextureAtlas: vi.fn(() => {
        throw new Error("disposed");
      }),
    };
    const healthy = makePane();
    [origin, throws, healthy].forEach(registerAtlasPeer);

    expect(() => clearSharedAtlasEverywhere(origin)).not.toThrow();

    expect(healthy.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });
});

describe("forceFullRepaint", () => {
  it("broadcasts to the other panes — the idle sweep must not corrupt its siblings", () => {
    // THE ACTUAL TRIGGER IN PRODUCTION. The idle sweep calls forceFullRepaint on whichever pane went
    // quiet. Before the broadcast that call was itself a cause of sibling corruption: the sweep
    // added to HEAL stray glyphs was creating them one pane over.
    const quietPane = makePane();
    const sibling = makePane();
    [quietPane, sibling].forEach(registerAtlasPeer);
    term.refresh.mockClear();

    forceFullRepaint(quietPane, term);

    expect(sibling.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("still repaints when there is no WebGL renderer at all (DOM-renderer fallback)", () => {
    // Counter-evidence: the broadcast must not make a null addon throw or skip the refresh, or the
    // DOM-renderer panes lose the blank-until-you-scroll fix this function was originally written for.
    term.refresh.mockClear();

    forceFullRepaint(null, term);

    expect(term.refresh).toHaveBeenCalledWith(0, 23);
  });
});
