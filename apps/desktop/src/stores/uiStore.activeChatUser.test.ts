// `activeChatUserId` — the ONE field that says a person chat is the active surface (Social Coding,
// bead `sparkle-xnjil.10`; design §10 "Key UI design calls").
//
// EVERY TEST HERE ASSERTS THE SIDE EFFECT, not the write it just made. `setActiveChatUserId("x")`
// leaving `activeChatUserId === "x"` is a precondition — it is true of a one-line setter that does
// nothing else, which is precisely the implementation these tests exist to rule out. What is
// load-bearing is what the write does to the OTHER surface over the same stage, and what it does
// NOT do to the persisted blob.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useUiStore, SPARKLE_PANE_SIDE } from "./uiStore";

const other = SPARKLE_PANE_SIDE === "right" ? "left" : "right";

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({
    activeChatUserId: null,
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
  });
});
afterEach(() => {
  localStorage.clear();
  useUiStore.setState({ activeChatUserId: null, activeSpecial: null });
});

describe("activeChatUserId — mutual exclusion with the other stage surfaces", () => {
  it("defaults to null: no chat is up until somebody opens one", () => {
    expect(useUiStore.getState().activeChatUserId).toBeNull();
  });

  // THE SIDE EFFECT. Both surfaces render into the primary pair's stage, so leaving `activeSpecial`
  // set would paint the Improve-Sparkle pane and the chat pane on top of each other.
  it("opening a chat CLEARS activeSpecial", () => {
    useUiStore.getState().setActiveSpecial("sparkle");
    useUiStore.getState().setActiveChatUserId("soc-1");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().activeChatUserId).toBe("soc-1");
  });

  it("…and the research pane too — it is the surface, not the string, that collides", () => {
    useUiStore.getState().setActiveSpecial("research");
    useUiStore.getState().setActiveChatUserId("soc-1");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // THE MIRROR. One direction alone is ambiguous: it passes for an implementation that lets the
  // Sparkle pane mount on top of a live chat.
  it("opening a special CLEARS the chat", () => {
    useUiStore.getState().setActiveChatUserId("soc-1");
    useUiStore.getState().setActiveSpecial("sparkle");
    expect(useUiStore.getState().activeChatUserId).toBeNull();
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
  });

  // CLOSING a chat is NOT the mirror of opening one, and the asymmetry is deliberate — see the
  // action's comment. `setActiveChatUserId(null)` must leave `activeSpecial` exactly as it found
  // it, or closing a chat would silently close the Improve-Sparkle pane behind it.
  it("closing a chat leaves activeSpecial untouched", () => {
    useUiStore.setState({ activeSpecial: "sparkle", activeChatUserId: "soc-1" });
    useUiStore.getState().setActiveChatUserId(null);
    expect(useUiStore.getState().activeChatUserId).toBeNull();
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
  });

  it("switching people replaces the id without disturbing anything else", () => {
    useUiStore.getState().setActiveChatUserId("soc-1");
    useUiStore.getState().setActiveChatUserId("soc-2");
    expect(useUiStore.getState().activeChatUserId).toBe("soc-2");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });
});

describe("activeChatUserId — the mode actions yield the stage", () => {
  // `openPlanBoard`/`showBuildStage` already null `activeSpecial` for the pane-owning side because
  // the board and the Sparkle pane share this stage. The chat pane shares it for the identical
  // reason, so it must ride the identical clear — otherwise entering Plan leaves a chat painting
  // over the board, which is the "half state" the mode actions were unified to prevent.
  it("openPlanBoard on the pane-owning side closes the chat", () => {
    useUiStore.getState().setActiveChatUserId("soc-1");
    useUiStore.getState().openPlanBoard(SPARKLE_PANE_SIDE);
    expect(useUiStore.getState().activeChatUserId).toBeNull();
  });

  it("showBuildStage on the pane-owning side closes the chat", () => {
    useUiStore.getState().setActiveChatUserId("soc-1");
    useUiStore.getState().showBuildStage(SPARKLE_PANE_SIDE);
    expect(useUiStore.getState().activeChatUserId).toBeNull();
  });

  // THE PAIRED NEGATIVE, and it is what makes the two above mean something. There is exactly one
  // chat pane and it lives in the primary pair's stage, so the OTHER column changing mode must not
  // reach it — a blanket clear would have the left column's Plan chevron close a conversation on
  // the right.
  it("the OTHER column's mode change does NOT close the chat", () => {
    useUiStore.getState().setActiveChatUserId("soc-1");
    useUiStore.getState().openPlanBoard(other);
    expect(useUiStore.getState().activeChatUserId).toBe("soc-1");
    useUiStore.getState().showBuildStage(other);
    expect(useUiStore.getState().activeChatUserId).toBe("soc-1");
  });
});

describe("activeChatUserId is TRANSIENT — both directions, or it comes back", () => {
  it("is never WRITTEN to the persisted blob", () => {
    localStorage.clear();
    useUiStore.getState().setActiveChatUserId("soc-1");
    const blob = JSON.parse(localStorage.getItem("sparkle-ui")!) as { state: Record<string, unknown> };
    expect("activeChatUserId" in blob.state).toBe(false);
    // NOT a vacuous pass on a blob that never got written: a persisted sibling is in there.
    expect("themePref" in blob.state).toBe(true);
  });

  it("is never RESTORED from one either — a launch never opens with somebody's chat up", async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ state: { activeChatUserId: "soc-1", composerHeight: 180 }, version: 4 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().activeChatUserId).toBeNull();
    // Proof the blob actually hydrated, so the null above is the strip and not a failed read.
    expect(useUiStore.getState().composerHeight).toBe(180);
  });
});
