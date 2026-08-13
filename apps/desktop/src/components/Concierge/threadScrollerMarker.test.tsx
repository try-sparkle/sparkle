// @vitest-environment jsdom
//
// BOTH THREADS MUST CARRY `data-concierge-scroller` — the handle ComposeBox measures its drag
// ceiling against.
//
// WHY THIS TEST EXISTS AT ALL. The column swaps `ConciergeThread` for `MountedAgentThread` when the
// concierge is mounted to a build agent, so the composer cannot look for one component's testid: for
// the whole mounted session it would find nothing and fall back to `window.innerHeight`, which clips
// the Send row off the bottom (roborev 53572/53586). The shared marker is what makes its query
// component-agnostic.
//
// It is asserted here because the marker was ALREADY LOST ONCE, by a merge that took the other
// side's JSX for the scroller verbatim. Nothing caught it: the composer's selector is a union that
// still falls through to the testid, so the invariant was false while the behaviour was fine — the
// worst shape a regression can have, because the next person to simplify that selector reinstates a
// bug nobody can see coming (roborev 56359).
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { ConciergeThread } from "./ConciergeThread";
import { MountedAgentThread, MOUNTED_THREAD_TESTID } from "./MountedAgentThread";
import { EMPTY_MOUNTED_THREAD } from "../../stores/mountedThreadStore";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);
afterEach(cleanup);

/** The exact selector `ComposeBox.findThread` uses for the marker half of its union. */
const MARKER = '[data-concierge-scroller="yes"]';

describe("the composer's thread handle", () => {
  it("is on the concierge thread's scroller", () => {
    const { container } = render(
      <ConciergeThread
        messages={[{ id: "m1", kind: "you", text: "hello" }]}
        onNudgeClick={vi.fn()}
        onNudgeAction={vi.fn()}
      />,
    );
    const marked = container.querySelector(MARKER);
    expect(marked).toBeTruthy();
    // …and it is the SCROLLER itself, not some wrapper — measuring a non-scrolling box would report
    // the wrong height just as silently as finding nothing.
    expect(marked).toBe(screen.getByTestId(CONCIERGE_THREAD_TESTID));
  });

  it("is on the mounted agent thread's scroller", () => {
    const { container } = render(
      <MountedAgentThread
        thread={{ ...EMPTY_MOUNTED_THREAD, entries: [] }}
        agentId="agent-1"
        agentName="Kraken Auth"
        onReachTop={vi.fn()}
      />,
    );
    const marked = container.querySelector(MARKER);
    expect(marked).toBeTruthy();
    expect(marked).toBe(screen.getByTestId(MOUNTED_THREAD_TESTID));
  });
});

// ── …AND index.css's SCROLLBAR RULES REACH BOTH OF THEM (bead sparkle-nheu8) ───────────────────
//
// The marker got a SECOND consumer: the `::-webkit-scrollbar` rules that give the chat pane a
// persistent, grabbable bar instead of the macOS overlay one that fades. Those rules live in a
// stylesheet, so the two halves — the attribute in the JSX and the selector in the CSS — can drift
// apart with every suite green: `cssTokens.test.ts` only reads the CSS, and the tests above only
// read the DOM. Neither can see a rename on the other side.
//
// So the selector is read OUT of index.css and run against the real rendered scrollers, the same
// way `ProjectTabs.mirror.test.tsx` binds its mirror rules to the markup. jsdom never paints a
// scrollbar, so this deliberately asserts REACH, not appearance — the appearance half is pinned in
// cssTokens.test.ts and verified by screenshot in a running build.
// RESOLVED FROM THE VITEST ROOT, NOT FROM `import.meta.url`. Every other index.css reader in this
// repo uses `fileURLToPath(new URL(…, import.meta.url))`, and that idiom throws here — under
// `@vitest-environment jsdom` the module URL is an `http://localhost/…` one, so fileURLToPath dies
// with "The URL must be of scheme file". `process.cwd()` is apps/desktop (where vitest.config lives).
const CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

/** The base selectors (everything before `::`) of index.css's chat-scrollbar rules. */
function scrollbarBaseSelectors(): string[] {
  return [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map(([, sel]) => sel!.trim())
    .filter((sel) => sel.includes("-webkit-scrollbar") && sel.includes("concierge-scroller"))
    .map((sel) => sel.split("::")[0]!.trim());
}

describe("index.css's chat-scrollbar rules select the real scrollers", () => {
  it("finds them in index.css at all", () => {
    expect(scrollbarBaseSelectors().length).toBeGreaterThan(0);
  });

  it("every one of them matches the concierge thread's scroller", () => {
    render(
      <ConciergeThread
        messages={[{ id: "m1", kind: "you", text: "hello" }]}
        onNudgeClick={vi.fn()}
        onNudgeAction={vi.fn()}
      />,
    );
    const scroller = screen.getByTestId(CONCIERGE_THREAD_TESTID);
    for (const sel of scrollbarBaseSelectors()) {
      expect(scroller.matches(sel), `index.css selector "${sel}" does not match the scroller`).toBe(true);
    }
  });

  it("every one of them matches the mounted agent thread's scroller", () => {
    render(
      <MountedAgentThread
        thread={{ ...EMPTY_MOUNTED_THREAD, entries: [] }}
        agentId="agent-1"
        agentName="Kraken Auth"
        onReachTop={vi.fn()}
      />,
    );
    const scroller = screen.getByTestId(MOUNTED_THREAD_TESTID);
    for (const sel of scrollbarBaseSelectors()) {
      expect(scroller.matches(sel), `index.css selector "${sel}" does not match the scroller`).toBe(true);
    }
  });
});
