// @vitest-environment jsdom
//
// The shared bead card — the ONE component the board and the concierge both render.
//
// ══ WHAT THESE ROWS ARE GUARDING, AND WHY EACH ONE CAN FAIL ════════════════════════════════════
// Every assertion here is on a SIDE EFFECT or on a value that was demonstrably absent before this
// component existed. Specifically:
//
//   * The priority pick asserts `beadsUpdate` was CALLED, with the patch it must carry. Asserting
//     that a menu option rendered would pass against a pill wired to nothing at all.
//   * The stage line asserts the LINE and its stage word are in the tree. This is the regression the
//     whole change exists for: the founder screenshotted the line on the collapsed board card and
//     asked why it vanishes when the card opens.
//   * The scroll clamp asserts the STYLE VALUE, never a measured height — jsdom has no layout
//     engine, so `getBoundingClientRect` is all zeroes and a height assertion would be theatre.
//   * The pinned header asserts the header is OUTSIDE the clamped element, which is what "the
//     priority control never scrolls out of sight" actually means in the DOM.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadCard } from "./BeadCard";
import type { Bead } from "../../services/beads";

afterEach(() => cleanup());

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "One card for the board and the concierge",
    description: "A bead is drawn by three components that share no code.",
    status: "open",
    type: "task",
    priority: 0,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const B = bead({ id: "sparkle-qogah" });

/** The card in its concierge chrome, which is the stricter of the two. */
function mount(over: Partial<Parameters<typeof BeadCard>[0]> = {}) {
  return render(
    <BeadCard bead={B} chrome="concierge" stage="planned" workers={[]} {...over} />,
  );
}

const t = "concierge-bead-card";

// ── 1. THE STATUS LINE — THE POINT OF THE WHOLE COMPONENT ───────────────────────────────────────

describe("BeadCard — the workflow status line is on every surface", () => {
  // The founder's item 1. The line existed only on the board's COLLAPSED card; it was absent from
  // the board's open card and from the concierge card entirely.
  it("renders the progress line AND its stage word", () => {
    mount({ stage: "planned" });
    const line = screen.getByTestId(`${t}-stage`);
    expect(line).not.toBeNull();
    // `stageMeta("planned").short` — the word the board prints beside the same line.
    expect(screen.getByTestId(`${t}-stage-label`).textContent).toBe("Planned");
  });

  // The line has to MOVE with the stage, or it is a decoration that always says the same thing.
  it("advances the line and the word when the stage advances", () => {
    const { rerender } = mount({ stage: "planned" });
    // BY TESTID, never structurally. Every ancestor here is a `<span>` (the card is phrasing
    // content throughout), so `span > span > span` matches the TRACK — whose own parent chain is
    // also spans — and returns an element with no width, comparing '' to '' forever. That is
    // exactly how this test first failed.
    const fill = () => screen.getByTestId(`${t}-stage-fill`);
    const planned = fill().style.width;
    expect(planned).not.toBe("");
    rerender(<BeadCard bead={B} chrome="concierge" stage="merged" workers={[]} />);
    expect(screen.getByTestId(`${t}-stage-label`).textContent).not.toBe("Planned");
    expect(fill().style.width).not.toBe(planned);
  });
});

// ── 2. WHAT SCROLLS, AND WHAT MUST NOT ──────────────────────────────────────────────────────────

describe("BeadCard — only the description scrolls", () => {
  it("clamps the description when a max height is given", () => {
    mount({ descMaxHeight: 180 });
    const desc = screen.getByTestId(`${t}-description`);
    // jsdom cannot lay out, so the STYLE is the fact — a measured height would be all zeroes.
    expect(desc.style.maxHeight).toBe("180px");
    expect(desc.style.overflowY).toBe("auto");
  });

  it("grows to fit when no max height is given", () => {
    mount();
    const desc = screen.getByTestId(`${t}-description`);
    expect(desc.style.maxHeight).toBe("");
    expect(desc.style.overflowY).toBe("");
  });

  // bead sparkle-qogah: never hide a row that needs action. The priority control and the way out of
  // the card must be OUTSIDE the scrolling region, which is a containment fact, not a style fact.
  it("keeps the priority control, the id and View-on-board outside the scroll region", () => {
    mount({
      descMaxHeight: 180,
      onSetPriority: vi.fn(async () => {}),
      onViewOnBoard: vi.fn(),
    });
    const desc = screen.getByTestId(`${t}-description`);
    expect(desc.contains(screen.getByTestId(`${t}-priority`))).toBe(false);
    expect(desc.contains(screen.getByTestId(`${t}-view-on-board`))).toBe(false);
    expect(desc.contains(screen.getByTestId(`${t}-id`))).toBe(false);
    expect(desc.contains(screen.getByTestId(`${t}-stage`))).toBe(false);
  });
});

// ── 3. THE FIELDS THE CONCIERGE CARD NEVER HAD ──────────────────────────────────────────────────

describe("BeadCard — every field, on both surfaces", () => {
  it("shows the bead id, labels, parent epic and workers", () => {
    mount({
      bead: bead({ id: "sparkle-qogah", labels: ["agent-feedback", "ui"], parent: "sparkle-epic1" }),
      workers: ["worker-a", "worker-b"],
    });
    expect(screen.getByTestId(`${t}-id`).textContent).toBe("sparkle-qogah");
    expect(screen.getByTestId(`${t}-labels`).textContent).toBe("agent-feedback, ui");
    expect(screen.getByTestId(`${t}-parent`).textContent).toBe("sparkle-epic1");
    expect(screen.getByTestId(`${t}-workers`).textContent).toContain("worker-a, worker-b");
  });

  it("omits the rows a bead has nothing for", () => {
    mount({ bead: bead({ id: "sparkle-qogah", labels: [], parent: null }), workers: [] });
    expect(screen.queryByTestId(`${t}-labels`)).toBeNull();
    expect(screen.queryByTestId(`${t}-parent`)).toBeNull();
    expect(screen.queryByTestId(`${t}-workers`)).toBeNull();
  });

  // The card renders inside `<Markdown>`'s `<p>` in the concierge chrome. A `<div>` there is invalid
  // nesting the browser resolves by closing the paragraph and reparenting the card away from the
  // sentence that referenced it — so the component may not contain one, in EITHER chrome.
  it("is built entirely from phrasing content, in both chromes", () => {
    const { container, rerender } = mount({
      onViewOnBoard: vi.fn(),
      onChat: vi.fn(),
      onClose: vi.fn(),
      onSetPriority: vi.fn(async () => {}),
      onBuildIt: vi.fn(async () => {}),
      workers: ["w"],
      bead: bead({ id: "sparkle-qogah", labels: ["x"], parent: "sparkle-epic1" }),
    });
    expect(container.querySelectorAll("div")).toHaveLength(0);
    rerender(<BeadCard bead={B} chrome="board" stage="planned" workers={["w"]} onClose={vi.fn()} />);
    expect(container.querySelectorAll("div")).toHaveLength(0);
  });
});

// ── 4. AN ABSENT CALLBACK IS AN ABSENT AFFORDANCE ───────────────────────────────────────────────

describe("BeadCard — a surface with no project renders read-only", () => {
  it("renders no control at all when no callback is supplied", () => {
    mount();
    expect(screen.queryByTestId(`${t}-view-on-board`)).toBeNull();
    expect(screen.queryByTestId(`${t}-close`)).toBeNull();
    expect(screen.queryByTestId(`${t}-priority-trigger`)).toBeNull();
    expect(screen.queryByTestId(`${t}-build-it`)).toBeNull();
    expect(screen.queryByTestId(`${t}-build-all-prd`)).toBeNull();
    // The Chat button obeys the same rule, and its case is the load-bearing one: the SATELLITE
    // window hides it purely by supplying no callback (bead sparkle-1cpomd), because that window
    // mounts no composer and a draft handed over there is dropped silently.
    expect(screen.queryByTestId(`${t}-chat`)).toBeNull();
  });

  // …but the priority is still SAID. It is the most decision-relevant field on the card, and a
  // read-only surface that hides it entirely is worse than one that cannot change it.
  it("still states the priority when it cannot be changed", () => {
    mount({ bead: bead({ id: "sparkle-qogah", priority: 2 }) });
    expect(screen.getByTestId(`${t}-priority-readonly`).textContent).toBe("P2");
  });

  it("renders View on board as a BUTTON, not a link", () => {
    mount({ onViewOnBoard: vi.fn() });
    expect(screen.getByTestId(`${t}-view-on-board`).tagName).toBe("BUTTON");
  });
});

// ── 5. THE PRIORITY WRITE — A REAL DATA MUTATION ────────────────────────────────────────────────

describe("BeadCard — picking a priority writes it", () => {
  function open(onSetPriority: (p: number) => Promise<void>, priority = 0) {
    mount({ bead: bead({ id: "sparkle-qogah", priority }), onSetPriority });
    fireEvent.click(screen.getByTestId(`${t}-priority-trigger`));
  }

  it("offers the four priorities in the founder's words", () => {
    open(vi.fn(async () => {}));
    expect(screen.getByTestId(`${t}-priority-option-0`).textContent).toContain("P0: Do it now");
    expect(screen.getByTestId(`${t}-priority-option-1`).textContent).toContain("P1: Do it next");
    expect(screen.getByTestId(`${t}-priority-option-2`).textContent).toContain(
      "P2: Do it when most efficient",
    );
    expect(screen.getByTestId(`${t}-priority-option-3`).textContent).toContain(
      "P3: Do it when cycles are available",
    );
  });

  // THE SIDE EFFECT. Not "the option rendered" — the write ran, with the value that was picked.
  it("calls the writer with the picked priority", async () => {
    const write = vi.fn(async () => {});
    open(write);
    fireEvent.click(screen.getByTestId(`${t}-priority-option-1`));
    await waitFor(() => expect(write).toHaveBeenCalledWith(1));
  });

  // The optimistic value lives in COMPONENT state, never in `beadsStore` — that store replaces its
  // whole snapshot every 5s and would clobber it. So the pill must show the new value immediately
  // and keep showing it while the prop still carries the old one.
  it("shows the picked priority immediately, before the poll catches up", async () => {
    let release = () => {};
    const write = vi.fn(() => new Promise<void>((r) => (release = r)));
    open(write, 0);
    fireEvent.click(screen.getByTestId(`${t}-priority-option-2`));
    await waitFor(() =>
      expect(screen.getByTestId(`${t}-priority-trigger`).getAttribute("data-priority")).toBe("2"),
    );
    release();
  });

  // A SECOND PICK WHILE THE FIRST IS IN FLIGHT WOULD RACE TWO WRITES against a database whose
  // ordering nobody controls. The control is disabled for the duration.
  it("disables the control while a write is in flight", async () => {
    let release = () => {};
    const write = vi.fn(() => new Promise<void>((r) => (release = r)));
    open(write, 0);
    fireEvent.click(screen.getByTestId(`${t}-priority-option-1`));
    const trigger = () => screen.getByTestId(`${t}-priority-trigger`) as HTMLButtonElement;
    await waitFor(() => expect(trigger().disabled).toBe(true));
    release();
    await waitFor(() => expect(trigger().disabled).toBe(false));
  });

  // ROLLBACK. The write failed, so the only honest thing to show is the value the bead still has —
  // beside a sentence saying why it did not change. There is no toast system in this app.
  it("rolls back and shows the failure beside the control", async () => {
    const write = vi.fn(async () => {
      throw new Error("bd is busy — priority not saved");
    });
    open(write, 0);
    fireEvent.click(screen.getByTestId(`${t}-priority-option-3`));
    await waitFor(() =>
      expect(screen.getByTestId(`${t}-error`).textContent).toBe("bd is busy — priority not saved"),
    );
    // Rolled BACK: the pill reads the bead's real priority again, not the one that failed to save.
    expect(screen.getByTestId(`${t}-priority-trigger`).getAttribute("data-priority")).toBe("0");
  });

  // The menu is portaled to `document.body` on purpose: left in the tree it would be clipped by the
  // concierge column, which is narrow and scrolls.
  it("portals the menu out of the card", () => {
    const { container } = render(
      <BeadCard bead={B} chrome="concierge" stage="planned" workers={[]} onSetPriority={vi.fn(async () => {})} />,
    );
    fireEvent.click(screen.getByTestId(`${t}-priority-trigger`));
    const menu = screen.getByTestId(`${t}-priority-menu`);
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it("closes the menu on Escape, and consumes the press", () => {
    mount({ onSetPriority: vi.fn(async () => {}) });
    fireEvent.click(screen.getByTestId(`${t}-priority-trigger`));
    expect(screen.queryByTestId(`${t}-priority-menu`)).not.toBeNull();
    // WRAPPED IN `act`. A bare `window.dispatchEvent` runs the listener outside React's batching,
    // so the state change it makes is never flushed and the menu is still in the DOM when the next
    // line reads it — a red row for a component that is behaving correctly.
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(e);
    });
    expect(screen.queryByTestId(`${t}-priority-menu`)).toBeNull();
    // Cable etiquette: the press is consumed so it peels THIS layer only.
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves an already-consumed Escape alone", () => {
    mount({ onSetPriority: vi.fn(async () => {}) });
    fireEvent.click(screen.getByTestId(`${t}-priority-trigger`));
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    e.preventDefault(); // a layer above already took it
    act(() => {
      window.dispatchEvent(e);
    });
    expect(screen.queryByTestId(`${t}-priority-menu`)).not.toBeNull();
  });
});

// ── 6. BUILD IT ─────────────────────────────────────────────────────────────────────────────────

describe("BeadCard — the build handoff", () => {
  it("runs the handoff and reports its failure in place", async () => {
    const buildIt = vi.fn(async () => {
      throw new Error("At capacity. Started 0 of 3; the rest are untouched.");
    });
    mount({ onBuildIt: buildIt });
    fireEvent.click(screen.getByTestId(`${t}-build-it`));
    await waitFor(() => expect(buildIt).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId(`${t}-error`).textContent).toContain("Started 0 of 3");
  });

  it("offers the PRD batch only when more than one epic shares the PRD", () => {
    const { rerender } = mount({ onBuildAllPrd: vi.fn(async () => {}), prdEpicCount: 1 });
    expect(screen.queryByTestId(`${t}-build-all-prd`)).toBeNull();
    rerender(
      <BeadCard
        bead={B}
        chrome="concierge"
        stage="planned"
        workers={[]}
        onBuildAllPrd={vi.fn(async () => {})}
        prdEpicCount={3}
      />,
    );
    expect(screen.getByTestId(`${t}-build-all-prd`).textContent).toBe("Build all 3 epics in this PRD");
  });
});

// ── 6. A PRIORITY SAVE MUST NOT CLAIM A BUILD STARTED ───────────────────────────────────────────
// One shared `busy` flag drove both the priority pill and the build buttons, so saving a priority
// relabelled the primary action to "Building…" and disabled it — announcing a handoff that never
// happened. On the board that is a straight regression: `DetailOverlay` had a `buildBusy` only the
// build handlers touched (roborev 59115).
describe("BeadCard — the priority write and the build button have separate busy states", () => {
  it("leaves Build It untouched while a priority save is in flight", async () => {
    // A write that never settles, so the in-flight state is observable.
    let release: (() => void) | undefined;
    const onSetPriority = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mount({ onSetPriority, onBuildIt: async () => {} });

    fireEvent.click(screen.getByTestId(`${t}-priority-trigger`));
    fireEvent.click(screen.getByTestId(`${t}-priority-option-2`));
    await waitFor(() => expect(onSetPriority).toHaveBeenCalledWith(2));

    const build = screen.getByTestId(`${t}-build-it`) as HTMLButtonElement;
    // THE ASSERTION: the build button still says Build It and is still pressable. With one shared
    // flag this read "Building…" and `disabled` was true.
    expect(build.textContent).toBe("Build It");
    expect(build.disabled).toBe(false);

    await act(async () => {
      release?.();
    });
  });

  it("disables Build It while a BUILD is in flight, which is the flag's real job", async () => {
    let release: (() => void) | undefined;
    const onBuildIt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mount({ onBuildIt });

    fireEvent.click(screen.getByTestId(`${t}-build-it`));
    await waitFor(() =>
      expect((screen.getByTestId(`${t}-build-it`) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId(`${t}-build-it`).textContent).toBe("Building…");

    await act(async () => {
      release?.();
    });
  });
});

// ── SEVERITY BADGE — the relevance score, a SEPARATE axis from priority ──────────────────────────

describe("BeadCard — the severity badge", () => {
  it("renders the severity level from the `sev-<N>` label", () => {
    mount({ bead: bead({ id: "", labels: ["sev-3"] }) });
    const badge = screen.getByTestId(`${t}-severity`);
    // THE ASSERTION: the badge shows the score the label carries (S3), not merely that a node exists.
    expect(badge.textContent).toBe("S3");
    expect(badge.getAttribute("data-severity")).toBe("3");
  });

  it("takes the MAX when duplicate sev labels are present", () => {
    mount({ bead: bead({ id: "sparkle-sev2", labels: ["sev-1", "sev-4"] }) });
    expect(screen.getByTestId(`${t}-severity`).textContent).toBe("S4");
  });

  it("renders NO badge when the bead carries no sev label", () => {
    // The overwhelming common case — absent score is absent badge, not `S0`.
    mount({ bead: bead({ id: "sparkle-nosev", labels: ["ui", "kanban"] }) });
    expect(screen.queryByTestId(`${t}-severity`)).toBeNull();
  });
});

// ── COMMENT THREAD + COMPOSE — the human-facing half ─────────────────────────────────────────────

describe("BeadCard — the comment thread and compose box", () => {
  const ct = `${t}-comments`;

  it("renders existing comments' text", () => {
    mount({
      comments: [
        { id: "c-1", author: "DROdio", text: "the first note", createdAt: "2026-08-12T00:00:00Z" },
      ],
    });
    expect(screen.getByText("the first note")).toBeTruthy();
    expect(screen.getByText("DROdio")).toBeTruthy();
  });

  it("shows the empty state when comments loaded but the thread is empty", () => {
    mount({ comments: [] });
    expect(screen.getByTestId(`${ct}-empty`)).toBeTruthy();
  });

  it("calls onComment with the typed text when Comment is pressed", async () => {
    const onComment = vi.fn().mockResolvedValue(undefined);
    mount({ comments: [], onComment });

    const box = screen.getByTestId(`${ct}-input`) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  a new comment  " } });
    fireEvent.click(screen.getByTestId(`${ct}-submit`));

    // THE SIDE EFFECT: the shipped write path is invoked with the TRIMMED text the reader typed —
    // asserting the button rendered would pass against a compose box wired to nothing.
    await waitFor(() => expect(onComment).toHaveBeenCalledWith("a new comment"));
  });

  it("clears the draft after a successful post", async () => {
    const onComment = vi.fn().mockResolvedValue(undefined);
    mount({ comments: [], onComment });
    const box = screen.getByTestId(`${ct}-input`) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "posted" } });
    fireEvent.click(screen.getByTestId(`${ct}-submit`));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("does NOT dispatch an all-whitespace comment", () => {
    const onComment = vi.fn().mockResolvedValue(undefined);
    mount({ comments: [], onComment });
    const box = screen.getByTestId(`${ct}-input`) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId(`${ct}-submit`));
    expect(onComment).not.toHaveBeenCalled();
  });

  it("keeps the draft and shows the error when the post fails", async () => {
    const onComment = vi.fn().mockRejectedValue(new Error("bd is busy"));
    mount({ comments: [], onComment });
    const box = screen.getByTestId(`${ct}-input`) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.click(screen.getByTestId(`${ct}-submit`));
    expect(await screen.findByTestId(`${ct}-error`)).toBeTruthy();
    expect(box.value).toBe("keep me");
  });

  it("renders NO compose box when onComment is absent (read-only surface)", () => {
    mount({ comments: [{ id: "c-1", author: null, text: "read only", createdAt: null }] });
    expect(screen.queryByTestId(`${ct}-input`)).toBeNull();
    // …but the existing thread is still shown.
    expect(screen.getByText("read only")).toBeTruthy();
  });

  it("renders NO thread section at all when neither comments nor onComment is given", () => {
    mount({});
    expect(screen.queryByTestId(ct)).toBeNull();
  });
});

// ── 9. THE CHAT BUTTON ──────────────────────────────────────────────────────────────────────────
//
// bead sparkle-1cpomd. The founder: *"a Chat button in the TOP RIGHT of every bead card, task or
// epic, in the same blue as Build It."*
//
// Every row here asserts something that was demonstrably false before the button existed. Nothing
// asserts "it rendered" on its own — the absent-callback row in section 4 already carries the other
// half of that, and the two together are what make the presence meaningful.
describe("BeadCard — the Chat button", () => {
  it("calls onChat exactly once per click, and starts nothing else", () => {
    const onChat = vi.fn();
    const onBuildIt = vi.fn(async () => {});
    const onViewOnBoard = vi.fn();
    mount({ onChat, onBuildIt, onViewOnBoard });
    fireEvent.click(screen.getByTestId(`${t}-chat`));
    expect(onChat).toHaveBeenCalledTimes(1);
    // THE NEIGHBOURS ARE ASSERTED SILENT. They sit inches away and share the card's blue; a
    // handler wired to the wrong element would still make the row above pass.
    expect(onBuildIt).not.toHaveBeenCalled();
    expect(onViewOnBoard).not.toHaveBeenCalled();
  });

  // TOP RIGHT, and LEFTMOST of the corner controls — the founder asked for a position, so the
  // position is the assertion. The title span is `flex: 1`, so DOM order after it IS the visual
  // order along the row; jsdom has no layout, so an x-coordinate assertion would be theatre
  // (every rect here is zeroes).
  it("sits in the title row, after the title and before View on board", () => {
    mount({ onChat: vi.fn(), onViewOnBoard: vi.fn(), onClose: vi.fn() });
    const row = screen.getByTestId(`${t}-title`).parentElement!;
    const kids = Array.from(row.children);
    const at = (id: string) => kids.indexOf(screen.getByTestId(`${t}-${id}`));
    expect(at("chat")).toBeGreaterThan(kids.indexOf(screen.getByTestId(`${t}-title`)));
    expect(at("chat")).toBeLessThan(at("view-on-board"));
    expect(at("view-on-board")).toBeLessThan(at("close"));
  });

  // "THE SAME BLUE AS BUILD IT" — asserted against the Build It button rendered in the SAME tree,
  // never against a hard-coded hex. A literal would go on passing after a theme change that made
  // the two buttons different colours, which is the only thing this row exists to catch.
  it("is filled in Build It's blue, read off Build It itself", () => {
    mount({
      onChat: vi.fn(),
      onBuildIt: vi.fn(async () => {}),
      onBuildAllPrd: vi.fn(async () => {}),
      prdEpicCount: 2,
    });
    const chat = screen.getByTestId(`${t}-chat`);
    const build = screen.getByTestId(`${t}-build-it`);
    expect(chat.style.background).toBe(build.style.background);
    expect(chat.style.color).toBe(build.style.color);
    expect(chat.style.borderRadius).toBe(build.style.borderRadius);
    expect(chat.style.background).not.toBe("");
    // A FILL, not an outline. Asserted against the OUTLINED secondary rendered beside Build It
    // ("Build all 2 epics"), not against the string "none" — jsdom normalises `border: none` to the
    // empty string, so a literal check compares '' to 'none' and fails on correct code. Comparing
    // the two buttons states the real distinction and survives that normalisation.
    expect(chat.style.border).toBe(build.style.border);
    expect(chat.style.border).not.toBe(screen.getByTestId(`${t}-build-all-prd`).style.border);
  });

  // …but at the TITLE ROW's scale, so it reads as a corner control rather than a second
  // call-to-action shouting over the title it sits beside.
  it("wears the title row's compact metrics, not Build It's", () => {
    mount({ onChat: vi.fn(), onViewOnBoard: vi.fn(), onBuildIt: vi.fn(async () => {}) });
    const chat = screen.getByTestId(`${t}-chat`);
    const neighbour = screen.getByTestId(`${t}-view-on-board`);
    expect(chat.style.padding).toBe(neighbour.style.padding);
    expect(chat.style.fontSize).toBe(neighbour.style.fontSize);
    expect(chat.style.flex).toBe("0 0 auto");
    expect(chat.style.padding).not.toBe(screen.getByTestId(`${t}-build-it`).style.padding);
  });

  it("is a real button with a title that says what it does", () => {
    mount({ onChat: vi.fn() });
    const chat = screen.getByTestId(`${t}-chat`);
    expect(chat.tagName).toBe("BUTTON");
    expect(chat.getAttribute("type")).toBe("button");
    expect(chat.getAttribute("title")).toMatch(/chat/i);
    expect(chat.textContent).toContain("Chat");
  });

  // ══ NOT GATED ON `buildBusy` ═════════════════════════════════════════════════════════════════
  // One shared busy flag is what made a PRIORITY save relabel the primary action to "Building…".
  // Handing a draft to the composer starts nothing, so it must stay live while a build is in
  // flight — otherwise the founder's way of ASKING about the build he just started is disabled by
  // that build.
  it("stays clickable while a build is in flight", async () => {
    let release: () => void = () => {};
    const onChat = vi.fn();
    mount({ onChat, onBuildIt: () => new Promise<void>((r) => (release = r)) });
    fireEvent.click(screen.getByTestId(`${t}-build-it`));
    // The build really is in flight — otherwise the row below proves nothing.
    await waitFor(() => expect(screen.getByTestId(`${t}-build-it`).textContent).toBe("Building…"));
    const chat = screen.getByTestId(`${t}-chat`);
    expect((chat as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(chat);
    expect(onChat).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
  });

  // TASK **OR** EPIC, the founder's words. Nothing in this component keys on `bead.type`, so this
  // row is here to keep it that way: a future `type === "task"` gate would fail here rather than
  // quietly removing the button from every epic.
  it("renders for an epic exactly as for a task", () => {
    mount({ onChat: vi.fn(), bead: bead({ id: "sparkle-epic1", type: "epic" }) });
    expect(screen.getByTestId(`${t}-chat`)).toBeTruthy();
    cleanup();
    mount({ onChat: vi.fn(), bead: bead({ id: "sparkle-task1", type: "task" }) });
    expect(screen.getByTestId(`${t}-chat`)).toBeTruthy();
  });
});
