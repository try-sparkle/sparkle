// @vitest-environment jsdom
//
// THE MOUNTED THREAD IS SET IN THE TERMINAL'S FACE (bead sparkle-wj3ya).
//
// The founder, twice: *"I want the font in the concierge pane — both the font of the text that I'm
// writing in the prompt compose box, AS WELL AS THE FONT IN THE THREAD — to be the same font as the
// terminal window … to help make it clear to me that I'm speaking to the agent."*
//
// PR #1054 shipped the COMPOSER in that face and stopped, which is why he asked twice and saw it
// half-work. `ComposeBox.terminalFont.test.tsx` pins the box; this pins the conversation above it.
//
// ══ WHY THIS ASSERTS THE CONSTANT AND NOT A FONT STRING ═════════════════════════════════════════
// The bead's requirement is not "some monospace font" — it is *the same font as the terminal*,
// imported rather than re-typed, because the terminal is themeable and per-column zoom is landing.
// A test quoting a literal stack would pass against a hardcoded second copy, which is precisely the
// drift being guarded against: nothing would be WRONG, only different, and nothing would go red.
//
// So the assertion compares against `TERM_BODY_FONT` itself. It fails if the component stops using
// the shared constant, and it keeps passing when the constant's VALUE changes — which is the whole
// point of there being one.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MountedAgentThread, MOUNTED_THREAD_TESTID } from "./MountedAgentThread";
import { TERM_BODY_BASE_SIZE, TERM_BODY_FONT } from "../terminalChrome";
import type { MountedThread } from "../../stores/mountedThreadStore";

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

function mount() {
  return render(
    <MountedAgentThread
      thread={EMPTY}
      agentId="agent-1"
      agentName="Blueprint UI/UX"
      onReachTop={vi.fn()}
    />,
  );
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

  // ══ ON THE SCROLLER, SO IT CASCADES ═════════════════════════════════════════════════════════════
  // Applied to the container rather than per bubble, deliberately: a per-bubble list is what drifts
  // the moment a new row type is added, and the founder's ask is about the thread, not about the
  // rows that happen to exist today. Asserting the container is what makes that structural choice
  // the thing under test — a build that styled today's bubbles individually would fail here.
  it("puts it on the scrolling container, not on individual bubbles", () => {
    mount();
    const thread = screen.getByTestId(MOUNTED_THREAD_TESTID);
    expect(thread.getAttribute("data-concierge-scroller")).toBe("yes");
    expect(thread.style.fontFamily).toBe(TERM_BODY_FONT);
  });
});
