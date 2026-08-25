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

  // ══ TOP RIGHT, AND SECOND IN THE CORNER — THE ID IS NOW WHAT IT FOLLOWS ══════════════════════
  // This row used to read "after the TITLE and before View on board", because the chat button and
  // the title shared one flex row. They no longer do: the founder moved the id up beside the
  // controls and the title down a line — [09:52] *"chat would go to the right. The SparkLE ID
  // would go to the left of chat"*, [05:44] *"the title is gonna go down one row"* (bead
  // `sparkle-huw924.5`). The INTENT is unchanged and is still the whole point of the row — the
  // founder asked for a position, so the position is the assertion — but the neighbour it is
  // measured against moved, so measuring against the title now asks a question with no answer.
  //
  // The corner span is the row, and DOM order inside it IS the visual order along it. jsdom has no
  // layout, so an x-coordinate assertion would be theatre (every rect here is zeroes).
  it("sits in the corner cluster, after the id and before View on board", () => {
    mount({ onChat: vi.fn(), onViewOnBoard: vi.fn(), onClose: vi.fn() });
    const corner = screen.getByTestId(`${t}-corner`);
    const kids = Array.from(corner.children);
    const at = (id: string) => kids.indexOf(screen.getByTestId(`${t}-${id}`));

    expect(at("chat")).toBeGreaterThan(at("id"));
    expect(at("chat")).toBeLessThan(at("view-on-board"));
    expect(at("view-on-board")).toBeLessThan(at("close"));
    // Every one of them is really IN this cluster — `indexOf` returns -1 for a node that is not a
    // child, and -1 satisfies two of the three comparisons above on its own.
    for (const id of ["id", "chat", "view-on-board", "close"]) expect(at(id)).toBeGreaterThan(-1);
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

// ── 10. THE COLLAPSED CARD ──────────────────────────────────────────────────────────────────────
//
// The founder, 2026-08-22: the cards the concierge posts into chat *"are just taking up too much
// real estate, and I love them, but I want them to be click to expandable… maybe half the height
// when it's closed."*
//
// ══ WHY EVERY ROW BELOW IS PAIRED ══════════════════════════════════════════════════════════════
// Almost everything this feature does is an ABSENCE — no description, no labels, no comments, no
// scroller — and AGENTS.md's fourth vacuous shape is exactly that: `queryByTestId(x)` is null just
// as happily for a card that threw during render. So each absence row asserts the card's REAL
// content is on screen first, and the row beside it renders the SAME props one flag apart and finds
// the thing present. One row proves nothing; the pair pins the cause to `collapsed`.

/** The parent epic as `beadLineageOf` hands it over — a whole `Bead`, so the chip can say its
 *  TITLE rather than its id. */
const PARENT = bead({ id: "sparkle-epic1", title: "Bead cards collapse to half height", type: "epic" });

/** Everything on screen in document order. jsdom has no layout, so document order inside a row flex
 *  container IS its left-to-right order — the same fact `BeadCardChrome.test.tsx` measures. */
function indexOnMetaLine(id: string): number {
  const line = screen.getByTestId(`${t}-meta`);
  const node = screen.getByTestId(`${t}-${id}`);
  return Array.from(line.querySelectorAll("*")).indexOf(node);
}

/** THE SLOT an item sits in. The merged line wraps each item in one span, and that span is where
 *  the flex rule lives — `parentElement` is the wrong reach, since the priority pill has boxes of
 *  its own between its trigger and the slot. */
function metaSlot(id: string): HTMLElement {
  const node = screen.getByTestId(`${t}-${id}`);
  const found = Array.from(screen.getByTestId(`${t}-meta`).children).find((c) => c.contains(node));
  expect(found, `${id} is not on the merged line`).toBeTruthy();
  return found as HTMLElement;
}

/**
 * MAKE THE LINEAGE ROW LAY OUT, for the one test that needs the packer to have actually packed.
 *
 * jsdom has no layout engine, so every `offsetWidth`/`clientWidth` reads 0 — and `usePacking`
 * correctly FAILS OPEN on that, showing every pill and no "+N more". That is a real production
 * path and it is tested as one; it also means the overflow state is unreachable here unless the
 * numbers the packer reads are supplied. They are exactly four: the row's own width, its label's,
 * each pill's, and the hidden "+N more" twin's.
 *
 * 200 - (40 + 6 gap) = 154 available, against three 100px pills and a 30px "+2 more" — so one pill
 * fits beside the overflow count and two are hidden. The arithmetic is `packPills`', tested in
 * `engine/beadLineage.test.ts`; this only feeds it.
 *
 * Restores the original descriptors, because these live on `HTMLElement.prototype` and would
 * otherwise leak into every later test in the file.
 */
function stubLineageWidths(): () => void {
  const proto = HTMLElement.prototype;
  const keys = ["offsetWidth", "clientWidth"] as const;
  const before = keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  const px = (el: HTMLElement): number => {
    const testid = el.getAttribute("data-testid");
    if (testid === `${t}-tasks`) return 200;
    if (testid === `${t}-tasks-pill`) return 100;
    // The `Tasks:` label — a bare span, so its exact text is the only handle it has.
    if (el.textContent === "Tasks:") return 40;
    // The measuring twin: off-flow, aria-hidden, and the only absolutely positioned node here.
    if (el.getAttribute("aria-hidden") === "true" && el.style.position === "absolute") return 30;
    return 0;
  };
  for (const k of keys) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: HTMLElement) {
        return px(this);
      },
    });
  }
  return () => {
    for (const [k, descriptor] of before) {
      if (descriptor === undefined) delete (proto as unknown as Record<string, unknown>)[k];
      else Object.defineProperty(proto, k, descriptor);
    }
  };
}

/** How many `·` separators the merged line is drawing. */
function interpuncts(line: HTMLElement): number {
  return Array.from(line.querySelectorAll("span")).filter((n) => n.textContent === "\u00b7").length;
}

describe("BeadCard — the merged metadata line", () => {
  // [19:15] *"We have backlog, p two, task — and then we have the row that says planned. I think we
  // can all make that one line. So the row would not be the full width of the card, but it would be
  // to the right of where it says task."*
  //
  // THE ASSERTION IS CONTAINMENT, not "both nodes exist" — they both existed before this change,
  // on two different rows, which is the row of height the merge reclaims.
  it("puts the build state ON the metadata line, after the priority", () => {
    mount({ stage: "planned" });
    const line = screen.getByTestId(`${t}-meta`);
    const stage = screen.getByTestId(`${t}-stage`);
    expect(line.contains(stage)).toBe(true);
    expect(screen.getByTestId(`${t}-stage-label`).textContent).toBe("Planned");
    // THE ANCHOR MOVED, THE ASK DID NOT. This used to read the type WORD off this line and assert
    // the stage sat to its right. `sparkle-huw924.8` promoted the type to a pill in the card's
    // top-left corner and deleted the duplicated word, so there is no longer a type on this row to
    // be right of — and the old form failed with `expected -1 to be greater than -1`, which is the
    // assertion reporting an absent anchor rather than a misplaced stage.
    //
    // Re-anchored on the PRIORITY, which is the element the stage now follows, so the half of the
    // founder's ask that says WHERE is still pinned rather than quietly dropped.
    // Anchored on the PRIORITY, matched by shape rather than by a hard-coded value or a testid:
    // this suite mounts more than one chrome, and the priority is a chip in one (`-priority`) and a
    // read-only span in another (`-priority-readonly`), so naming either couples this assertion to
    // which chrome happens to be under test. `P<n>` is the rendered form in both.
    const text = line.textContent ?? "";
    const priorityAt = text.search(/P\d/);
    expect(priorityAt).toBeGreaterThan(-1);
    expect(priorityAt).toBeLessThan(text.indexOf("Planned"));
    // …and the type really is drawn, just not here: once, as the pill.
    expect(screen.getByTestId(`${t}-type-pill`).textContent).toBe("TASK");
    expect(text).not.toContain("task");
  });

  // THE HEIGHT SAVING IS NOT A COLLAPSED-ONLY FEATURE. He described it about the card, and a merge
  // that only applied closed would put the row back the moment anyone opened one.
  it("keeps the two rows merged EXPANDED as well as collapsed", () => {
    for (const collapsed of [true, false]) {
      cleanup();
      mount({ collapsed, stage: "planned" });
      expect(screen.getByTestId(`${t}-meta`).contains(screen.getByTestId(`${t}-stage`))).toBe(true);
    }
  });

  // ══ "NOT THE FULL WIDTH OF THE CARD" IS A STYLE FACT HERE ═══════════════════════════════════
  // *"the row would not be the full width of the card, but it would be to the right of where it
  // says task."* Exactly ONE item on the line takes the slack — the progress rule, the only item
  // with no intrinsic width worth keeping — and every named field holds its own size beside it.
  //
  // ASSERTED AS STYLE VALUES, deliberately, the same way this component's other narrow-column
  // rules are: jsdom has no layout engine, every box is 0×0, so a measured width would be theatre.
  it("gives the slack to the build state and to nothing else on the line", () => {
    mount({ onBuildIt: vi.fn(async () => {}), onSetPriority: vi.fn(async () => {}) });
    const slot = metaSlot;

    // ══ THE ROW IS ONE LINE, AND SAYS SO ═════════════════════════════════════════════════════
    // The merge exists to SAVE a row ("I think we can all make that one line"), so a line that is
    // allowed to wrap is not a narrower version of the feature — it is the absence of it. These
    // three are the whole mechanism and nothing pinned them: `rowStyle` wraps by default, so a
    // future edit that dropped this override would silently put the row back.
    const row = screen.getByTestId(`${t}-meta`);
    expect(row.style.flexWrap).toBe("nowrap");
    expect(row.style.minWidth).toBe("0");
    // The backstop is a CLIP, deliberately: a clipped tail still reads as one line.
    expect(row.style.overflow).toBe("hidden");

    // The bar shrinks and grows with the column. `minWidth: 0` is what lets it actually shrink —
    // without it a flex item refuses to go below its content and pushes the line wider.
    expect(slot("stage").style.flex).toBe("1 1 96px");
    expect(slot("stage").style.minWidth).toBe("0");
    // …and the named fields do NOT, or the line would stretch them instead of the bar and the
    // metadata would drift apart across the card.
    //
    // `0 0 auto` EXPLICITLY, not the unset value this used to assert. Unset means `0 1 auto` — a
    // flex item that SHRINKS — and under the `nowrap` the merged line now needs, that squeezed each
    // label below its own text width and broke the words mid-letter ("Backl/og", "e/pi/c") in the
    // `concierge-bead-card` capture. So "does not take the slack" and "does not give up width" are
    // two different claims, and this line has to make the second one.
    for (const id of ["build-it", "priority-trigger"]) {
      expect(slot(id).style.flex).toBe("0 0 auto");
      expect(slot(id).style.whiteSpace).toBe("nowrap");
    }
  });

  // ══ THE TWO CONTENT-LENGTH ITEMS MUST GIVE GROUND ═══════════════════════════════════════════
  // The blanket `0 0 auto` above is right for the short fixed labels and WRONG for the two items
  // whose width is their content: the parent chip (a bead TITLE — "A TITLE CAN BE A SENTENCE") and
  // `in <project>`. An unshrinkable wrapper is always exactly as wide as its own text, so the
  // chip's `maxWidth: 100%` resolves against it and `text-overflow: ellipsis` can NEVER fire — and
  // under the row's `nowrap` + `overflow: hidden` the chip is the LAST item, so a long epic title
  // is exactly what silently disappears off the card's edge.
  it("lets the parent chip and the project name give ground, so the ellipsis can fire", () => {
    mount({
      onBuildIt: vi.fn(async () => {}),
      onSetPriority: vi.fn(async () => {}),
      projectName: "some-other-project",
      lineage: { parent: PARENT, tasks: [], buildAgents: [] },
    });
    for (const id of ["parent", "project"]) {
      expect(metaSlot(id).style.flex, id).toBe("0 1 auto");
      expect(metaSlot(id).style.minWidth, id).toBe("0");
      // Shrinkable, but still ON THIS LINE — the merge is the whole point.
      expect(metaSlot(id).style.whiteSpace, id).toBe("nowrap");
    }
    // …and the chip really carries the ellipsis those two rules make reachable. Both halves, or
    // "it can shrink" is a claim about a chip that would clip anyway.
    const chip = screen.getByTestId(`${t}-parent`);
    expect(chip.style.textOverflow).toBe("ellipsis");
    expect(chip.style.overflow).toBe("hidden");
    // THE CEILING, and it is load-bearing rather than belt-and-braces: `minWidth: 0` lets a box give
    // ground but does not BOUND it, so without this the text lays itself out wider than the wrapper
    // and paints over the items after it on the line. Unpinned, it can be dropped by a future edit —
    // or lost in a merge conflict, which is exactly how its sibling went missing (roborev 68096).
    expect(chip.style.maxWidth).toBe("100%");
    // AND THE PROJECT NAME, which was shrinkable with NO truncation rules of its own — a box that
    // gives ground but does not ellipsise just renders past its own width, so a long project name
    // pushed the merged line out under `nowrap` instead of yielding. Its wrapper's `0 1 auto` above
    // is only half the fix; this is the half that makes the shrink visible rather than clipped.
    const project = screen.getByTestId(`${t}-project`);
    expect(project.style.textOverflow).toBe("ellipsis");
    expect(project.style.overflow).toBe("hidden");
    expect(project.style.whiteSpace).toBe("nowrap");
    expect(project.style.maxWidth).toBe("100%");
    // THE OTHER HALF: the short labels still refuse to shrink. Letting THEM give ground is what
    // broke the words mid-letter ("Backl/og", "e/pi/c") in the `concierge-bead-card` capture.
    for (const id of ["build-it", "priority-trigger"]) {
      expect(metaSlot(id).style.flex, id).toBe("0 0 auto");
    }
  });

  // ══ A SEPARATOR BETWEEN ITEMS — AND NEVER BEFORE THE BAR ════════════════════════════════════
  // The stage is a BAR, not a word, so an interpunct introducing it buys nothing even at full
  // width, and at the concierge's narrow default it dangles at the end of the line with nothing
  // visibly after it. Counted against the line's own item count so it cannot drift as items are
  // added, and asserted BOTH ways round — with the bar and without it — because "n - 1" alone
  // passes for a line that has no growing item at all.
  it("separates the items, and draws no separator before the growing one", () => {
    const props = {
      onBuildIt: vi.fn(async () => {}),
      onSetPriority: vi.fn(async () => {}),
      projectName: "some-other-project",
      lineage: { parent: PARENT, tasks: [], buildAgents: [] },
    };
    mount({ ...props, showStageLine: false });
    const without = screen.getByTestId(`${t}-meta`);
    expect(without.children.length).toBeGreaterThan(2);
    expect(interpuncts(without)).toBe(without.children.length - 1);

    cleanup();
    mount({ ...props, showStageLine: true });
    const withBar = screen.getByTestId(`${t}-meta`);
    // ONE MORE ITEM, and still one fewer separator than "between every pair" would give.
    expect(withBar.children.length).toBe(without.children.length + 1);
    expect(interpuncts(withBar)).toBe(withBar.children.length - 2);
  });

  // `showStageLine` is unchanged by the merge — the epics column passes false and must still get
  // NEITHER the bar nor the word. Paired: the card is fully on screen, so this is about the switch.
  it("still obeys showStageLine, which now gates the merged item", () => {
    mount({ showStageLine: false });
    expect(screen.getByTestId(`${t}-title`).textContent).toBe(B.title);
    expect(screen.getByTestId(`${t}-meta`)).toBeTruthy();
    expect(screen.queryByTestId(`${t}-stage`)).toBeNull();
    expect(screen.queryByTestId(`${t}-stage-label`)).toBeNull();
  });

  // [19:15] *"I think build it should probably actually be in the top left corner instead of the
  // bottom left."* FIRST on the line, and on the line at all — it used to be a row of its own below
  // the description, which is what made it unreachable on a long card.
  it("puts Build It FIRST on the merged line, not in a row of its own below", () => {
    mount({ onBuildIt: vi.fn(async () => {}), onSetPriority: vi.fn(async () => {}) });
    const line = screen.getByTestId(`${t}-meta`);
    expect(line.contains(screen.getByTestId(`${t}-build-it`))).toBe(true);
    // Before the status dot, before the priority pill, before the stage — i.e. the leftmost thing.
    expect(indexOnMetaLine("build-it")).toBeLessThan(indexOnMetaLine("priority-trigger"));
    expect(indexOnMetaLine("build-it")).toBeLessThan(indexOnMetaLine("stage"));
  });

  // The SECONDARY action does NOT come with it. Asserted as a containment difference against Build
  // It in the SAME tree, so "it moved" cannot pass by both of them moving.
  it("leaves `Build all N epics` off the line, below, expanded only", () => {
    mount({
      onBuildIt: vi.fn(async () => {}),
      onBuildAllPrd: vi.fn(async () => {}),
      prdEpicCount: 3,
    });
    const line = screen.getByTestId(`${t}-meta`);
    expect(line.contains(screen.getByTestId(`${t}-build-it`))).toBe(true);
    expect(line.contains(screen.getByTestId(`${t}-build-all-prd`))).toBe(false);
  });
});

describe("BeadCard — the parent epic rides the merged line", () => {
  // The founder settled this on 2026-08-22: the parent is one more chip at the right end of the
  // merged line, NOT a third lineage row — it costs zero extra height and keeps "just two rows" true.
  it("renders the parent's TITLE as a chip on the merged line, not a row of its own", () => {
    mount({ lineage: { parent: PARENT, tasks: [], buildAgents: [] } });
    const chip = screen.getByTestId(`${t}-parent`);
    // THE TITLE, never the raw id — that is the whole difference from the field this replaces.
    expect(chip.textContent).toBe("Bead cards collapse to half height");
    expect(chip.textContent).not.toBe("sparkle-epic1");
    expect(screen.getByTestId(`${t}-meta`).contains(chip)).toBe(true);
    // …and it did NOT become a third lineage row. `BeadLineageRows` renders exactly two.
    expect(screen.queryByTestId(`${t}-lineage`)).toBeNull();
  });

  it("is the LAST thing on the line — the right end", () => {
    mount({
      lineage: { parent: PARENT, tasks: [], buildAgents: [] },
      onSetPriority: vi.fn(async () => {}),
      onBuildIt: vi.fn(async () => {}),
    });
    for (const before of ["build-it", "priority-trigger", "stage"]) {
      expect(indexOnMetaLine(before)).toBeLessThan(indexOnMetaLine("parent"));
    }
  });

  // ONE PARENT TREATMENT, NOT TWO. The expanded-only `Epic:` field printed `bead.parent` as raw
  // mono text; it is gone, and the chip is what every surface now gets — EXPANDED INCLUDED.
  it("shows the same single chip expanded, with no second `Epic:` field", () => {
    mount({
      collapsed: false,
      bead: bead({ id: "sparkle-qogah", parent: "sparkle-epic1" }),
      lineage: { parent: PARENT, tasks: [], buildAgents: [] },
    });
    expect(screen.getAllByTestId(`${t}-parent`)).toHaveLength(1);
    expect(screen.getByTestId(`${t}-parent`).textContent).toBe("Bead cards collapse to half height");
  });

  // A surface that never resolved a lineage has only ever known the id. Saying nothing would be
  // worse than saying the id, and it is what the callers that predate `lineage` still pass.
  it("falls back to the raw parent id when no lineage was resolved", () => {
    mount({ bead: bead({ id: "sparkle-qogah", parent: "sparkle-epic1" }) });
    expect(screen.getByTestId(`${t}-parent`).textContent).toBe("sparkle-epic1");
  });

  // THE SIDE EFFECT: the jump really runs, with the parent's id. A chip that merely rendered would
  // satisfy every row above.
  it("jumps to the parent when clicked, and does NOT toggle the card", () => {
    const onOpenBead = vi.fn();
    const onToggleCollapsed = vi.fn();
    mount({ lineage: { parent: PARENT, tasks: [], buildAgents: [] }, onOpenBead, onToggleCollapsed });
    fireEvent.click(screen.getByTestId(`${t}-parent`));
    expect(onOpenBead).toHaveBeenCalledWith("sparkle-epic1");
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  // Callback-is-the-switch: no jump wired, so it is text rather than a dead control.
  it("is static text when no jump is wired", () => {
    mount({ lineage: { parent: PARENT, tasks: [], buildAgents: [] } });
    const chip = screen.getByTestId(`${t}-parent`);
    expect(chip.getAttribute("role")).toBeNull();
    expect(chip.getAttribute("tabindex")).toBeNull();
    expect(chip.style.cursor).toBe("default");
  });
});

describe("BeadCard — collapsed is LESS CONTENT, not a smaller window", () => {
  /** Everything the collapsed card is allowed to hide, and the props that make each one exist. */
  const HIDDEN = ["description", "labels", "workers", "build-all-prd", "comments", "goal"];

  function full(collapsed: boolean) {
    return {
      collapsed,
      bead: bead({ id: "sparkle-qogah", labels: ["ui"], parent: "sparkle-epic1" }),
      workers: ["worker-a"],
      onBuildIt: vi.fn(async () => {}),
      onBuildAllPrd: vi.fn(async () => {}),
      prdEpicCount: 3,
      comments: [],
      onComment: vi.fn(async () => {}),
      onSetGoal: vi.fn(),
      lineage: { parent: PARENT, tasks: [{ id: "sparkle-t1", label: "a task" }], buildAgents: [] },
    };
  }

  // THE ABSENCE HALF — with the card demonstrably rendered, so it cannot be the absence of the card.
  it("drops the description, labels, workers, batch build, goal and thread", () => {
    mount(full(true));
    expect(screen.getByTestId(`${t}-title`).textContent).toBe(B.title);
    expect(screen.getByTestId(`${t}-id`).textContent).toBe("sparkle-qogah");
    expect(screen.getByTestId(`${t}-meta`)).toBeTruthy();
    for (const id of HIDDEN) expect(screen.queryByTestId(`${t}-${id}`)).toBeNull();
  });

  // THE PRESENCE HALF — the same props, one flag apart. This is what pins every null above to
  // `collapsed` rather than to a prop nobody passed.
  it("shows every one of them again when expanded, on identical props", () => {
    mount(full(false));
    for (const id of HIDDEN) expect(screen.getByTestId(`${t}-${id}`)).toBeTruthy();
  });

  // WHAT SURVIVES: Build It (his explicit *"it COULD still say build it when it's collapsed"*) and
  // the two lineage rows (*"it would still just show me two rows"*).
  it("keeps Build It and the lineage rows, which is the point of the collapse", () => {
    mount(full(true));
    expect(screen.getByTestId(`${t}-build-it`).textContent).toBe("Build It");
    expect(screen.getByTestId(`${t}-tasks`).textContent).toContain("a task");
    expect(screen.getByTestId(`${t}-parent`)).toBeTruthy();
  });

  // ══ COLLAPSED DOES NOT SCROLL ═══════════════════════════════════════════════════════════════
  // *"when it's collapsed, it would not scroll — would just have less of the actual text."* A
  // scroller nested in the scrolling thread captures the wheel and stops the thread. Asserted over
  // EVERY element in the card, not just the description: a clamp added to any other field later
  // would be the same trap, and this row is what would catch it.
  it("renders NO scrolling region at all, even when a max height is supplied", () => {
    const { container } = mount({ ...full(true), descMaxHeight: 180 });
    const scrollers = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.style.overflowY === "auto" || el.style.maxHeight !== "",
    );
    expect(scrollers).toHaveLength(0);
  });

  // …and the clamp is still honoured when the card is OPEN, which is the state it was written for.
  it("still clamps the description when expanded with the same max height", () => {
    mount({ ...full(false), descMaxHeight: 180 });
    expect(screen.getByTestId(`${t}-description`).style.maxHeight).toBe("180px");
  });

  it("says which state it is in, for the surface that draws around it", () => {
    const { rerender } = mount({ collapsed: true });
    expect(screen.getByTestId(t).getAttribute("data-collapsed")).toBe("true");
    rerender(<BeadCard bead={B} chrome="concierge" stage="planned" workers={[]} collapsed={false} />);
    expect(screen.getByTestId(t).getAttribute("data-collapsed")).toBe("false");
  });

  // NOTHING BRANCHES ON `chrome`, which is the rule this component exists to enforce. `collapsed`
  // is a caller-supplied prop precisely so that stays true — the board's card collapses identically.
  it("collapses identically in every chrome", () => {
    for (const chrome of ["board", "concierge", "epics"] as const) {
      cleanup();
      const prefix = `${chrome}-bead-card`;
      render(<BeadCard bead={B} chrome={chrome} stage="planned" workers={[]} collapsed />);
      expect(screen.getByTestId(`${prefix}-title`)).toBeTruthy();
      expect(screen.queryByTestId(`${prefix}-description`)).toBeNull();
    }
  });
});

describe("BeadCard — the card body is the toggle", () => {
  // *"best might be that you just click on the card. Right? Instead of having a Chevron."*
  it("toggles when the body is clicked", () => {
    const onToggleCollapsed = vi.fn();
    mount({ collapsed: true, onToggleCollapsed });
    fireEvent.click(screen.getByTestId(t));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  // ══ THE DISCLOSURE IS THE TITLE BUTTON, NEVER THE ROOT ══════════════════════════════════════
  // The root carried `role="button"` + `tabIndex={0}` until ARIA's PRESENTATIONAL CHILDREN rule was
  // pointed at it: a `button` around the whole card drops the announced semantics of every control
  // inside it, makes one tab stop wrap other tabbable elements, and DISPLACES the chrome's own
  // `role="status"` — so a card posted into the concierge thread stopped announcing itself.
  it("announces the expansion on a real title button, and leaves the card's own role alone", () => {
    const { rerender } = mount({ collapsed: true, onToggleCollapsed: vi.fn(), id: "card-dom-id" });
    const title = () => screen.getByTestId(`${t}-title`);
    // A NATIVE BUTTON is what brings Enter, Space and a focus ring — none of them re-implemented.
    expect(title().tagName).toBe("BUTTON");
    expect(title().getAttribute("type")).toBe("button");
    expect(title().getAttribute("aria-expanded")).toBe("false");
    expect(title().getAttribute("aria-controls")).toBe("card-dom-id");

    const card = () => screen.getByTestId(t);
    // THE CHROME'S ROLE SURVIVES. This is the half the old root-button silently took away.
    expect(card().getAttribute("role")).toBe("status");
    expect(card().getAttribute("aria-expanded")).toBeNull();
    expect(card().getAttribute("tabindex")).toBeNull();
    // …and the founder's gesture is untouched: the body is still the click target.
    expect(card().style.cursor).toBe("pointer");

    rerender(
      <BeadCard
        bead={B}
        chrome="concierge"
        stage="planned"
        workers={[]}
        id="card-dom-id"
        onToggleCollapsed={vi.fn()}
      />,
    );
    expect(title().getAttribute("aria-expanded")).toBe("true");
  });

  // ══ EVERY NESTED CONTROL IS STILL A CONTROL ═════════════════════════════════════════════════
  // The concrete damage of a root `button` is not visible in a snapshot: assistive tech simply
  // stops announcing Build It, the priority pill, Chat, View on board, Close, the parent chip, the
  // goal editor and the comment box, because they are all INSIDE it. So the assertion is about
  // ANCESTRY — no control on this card may sit inside anything claiming button semantics.
  it("leaves every control on the card reachable — nothing sits inside a button", () => {
    mount({
      collapsed: false,
      onToggleCollapsed: vi.fn(),
      onBuildIt: vi.fn(async () => {}),
      onSetPriority: vi.fn(async () => {}),
      onChat: vi.fn(),
      onViewOnBoard: vi.fn(),
      onClose: vi.fn(),
      onOpenBead: vi.fn(),
      onSetGoal: vi.fn(),
      comments: [],
      onComment: vi.fn(async () => {}),
      lineage: { parent: PARENT, tasks: [], buildAgents: [] },
    });
    const controls = [
      "build-it",
      "priority-trigger",
      "chat",
      "view-on-board",
      "close",
      "parent",
      "goal",
      "comments-input",
      "title",
    ];
    for (const id of controls) {
      const el = screen.getByTestId(`${t}-${id}`);
      const above = el.parentElement;
      expect(above, `${id} has no parent`).toBeTruthy();
      expect(above?.closest("button") ?? null, `${id} is inside a <button>`).toBeNull();
      expect(
        above?.closest('[role="button"]') ?? null,
        `${id} is inside a role="button"`,
      ).toBeNull();
    }
  });

  // Enter and Space come from the BUTTON ELEMENT now — the root's hand-rolled keydown handler went
  // with the role that promised it. What this pins instead is the thing a native button cannot give
  // for free: the click must toggle EXACTLY ONCE. The button is a descendant of the card root's own
  // click handler, so without its `stopPropagation` the gesture toggles twice and nets to nothing.
  it("toggles from the title button exactly once", () => {
    const onToggleCollapsed = vi.fn();
    mount({ collapsed: true, onToggleCollapsed });
    fireEvent.click(screen.getByTestId(`${t}-title`));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  // ══ A DRAG-SELECTION IS NOT A CLICK ═════════════════════════════════════════════════════════
  // `click` is dispatched to the nearest common ancestor of mousedown and mouseup, so sweeping
  // across the description to copy it ends on the card root — and collapsed the card, hiding the
  // text that was just selected, before it could be copied. PAIRED: the same click with nothing
  // selected still toggles, or "it did not collapse" would be true of a card wired to nothing.
  // THE TITLE IS THE MOST NATURAL THING ON THE CARD TO SWEEP ACROSS, and it is a `<button>` that
  // stops the bubble — so the ROOT's selection guard never runs for it. A guard written only on the
  // root leaves exactly this gesture unprotected, which is why the check is shared.
  it("does not collapse when the selection was swept across the TITLE button itself", () => {
    const onToggleCollapsed = vi.fn();
    mount({ collapsed: false, onToggleCollapsed });
    const title = screen.getByTestId(`${t}-title`);
    const selection = vi.spyOn(window, "getSelection");
    try {
      selection.mockReturnValue({
        isCollapsed: false,
        toString: () => "Bead cards collapse to half height",
      } as unknown as Selection);
      fireEvent.mouseDown(title);
      fireEvent.mouseUp(title);
      // `detail: 1` — a real POINTER click. Left at the default 0 this would be indistinguishable
      // from a keyboard activation, which the guard now deliberately lets through.
      fireEvent.click(title, { detail: 1 });
      expect(onToggleCollapsed).not.toHaveBeenCalled();

      // THE PAIR — same control, nothing selected, so this is a statement about the SELECTION and
      // not about a title button that never toggles at all.
      selection.mockReturnValue({ isCollapsed: true, toString: () => "" } as unknown as Selection);
      fireEvent.click(title, { detail: 1 });
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally {
      selection.mockRestore();
    }
  });

  // A KEYPRESS IS NOT A DRAG. The title's toggle is a native `<button>`, so Enter and Space
  // activate it — the whole reason it is a button. A keyboard activation never touches the
  // document's selection, so a guard that only reads `getSelection()` killed it whenever a
  // selection happened to exist anywhere on the page: sweep the description, tab to the title,
  // press Enter, nothing. `detail` is 0 for a keyboard-generated click and >= 1 for a pointer one.
  it("still toggles on Enter while text is selected elsewhere — a keypress made no selection", () => {
    const onToggleCollapsed = vi.fn();
    mount({ collapsed: true, onToggleCollapsed });
    const title = screen.getByTestId(`${t}-title`);
    const selection = vi.spyOn(window, "getSelection");
    try {
      // A live selection, left over from a sweep that had nothing to do with this control.
      selection.mockReturnValue({
        isCollapsed: false,
        toString: () => "text selected somewhere else entirely",
      } as unknown as Selection);

      fireEvent.click(title, { detail: 0 }); // keyboard-generated
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

      // THE PAIR: the same live selection, but a real pointer click — still suppressed, or this
      // would be a statement about a guard that never fires at all.
      fireEvent.click(title, { detail: 1 });
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally {
      selection.mockRestore();
    }
  });

  // THE ID TRUNCATES, SO ITS FULL VALUE MUST STAY RECOVERABLE. The corner cluster is the narrowest
  // real estate on the card and the id is the only shrinkable thing in it, so at the concierge's
  // 360px default it ellipsises to a couple of characters. `BeadCardChrome.test.tsx` already pins
  // the styles that CAUSE that truncation; nothing pinned the recovery, so a refactor of this row
  // (PR #2431 is rewriting it) could drop the tooltip and leave the suite green while the id became
  // permanently unreadable.
  it("keeps the truncated bead id recoverable, because an id is a handle you copy", () => {
    mount({ collapsed: true });
    expect(screen.getByTestId(`${t}-id`).getAttribute("title")).toBe(B.id);
  });

  it("does not collapse when the gesture was a text selection", () => {
    const onToggleCollapsed = vi.fn();
    mount({ collapsed: false, onToggleCollapsed });
    const card = screen.getByTestId(t);
    const desc = screen.getByTestId(`${t}-description`);
    const selection = vi.spyOn(window, "getSelection");
    try {
      selection.mockReturnValue({
        isCollapsed: false,
        toString: () => "A bead is drawn by three components",
      } as unknown as Selection);
      fireEvent.mouseDown(desc);
      fireEvent.mouseUp(card);
      fireEvent.click(card, { detail: 1 });
      expect(onToggleCollapsed).not.toHaveBeenCalled();

      // THE PAIR. Same card, same click, nothing selected.
      selection.mockReturnValue({ isCollapsed: true, toString: () => "" } as unknown as Selection);
      fireEvent.click(card, { detail: 1 });
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally {
      selection.mockRestore();
    }
  });

  // CALLBACK-IS-THE-SWITCH. A surface that cannot expand must not advertise a gesture that does
  // nothing — and the click must really be inert, not merely unstyled.
  it("is inert when no toggle is wired — no role, no tab stop, no pointer", () => {
    mount({ collapsed: true });
    const card = screen.getByTestId(t);
    expect(card.getAttribute("role")).not.toBe("button");
    expect(card.getAttribute("tabindex")).toBeNull();
    expect(card.getAttribute("aria-expanded")).toBeNull();
    expect(card.style.cursor).toBe("");
    // THE TITLE IS TEXT AGAIN, not a control that does nothing — callback-is-the-switch reaches the
    // disclosure button too, now that the button is where the semantics live.
    expect(screen.getByTestId(`${t}-title`).tagName).toBe("SPAN");
    expect(screen.getByTestId(`${t}-title`).getAttribute("aria-expanded")).toBeNull();
    // …and the card is really on screen, so the nulls above are about the affordance.
    expect(screen.getByTestId(`${t}-title`).textContent).toBe(B.title);
  });
});

// ══ THE TRAP THE FOUNDER ASKED TO HAVE SOLVED RATHER THAN DISCOVERED ═══════════════════════════
// *"if the WHOLE CARD is the expand target, every interactive child inside it must STOP PROPAGATION
// so clicking them does not also toggle expansion. Get this wrong and Build It fires and collapses
// the card in the same click."*
//
// EVERY ROW ASSERTS BOTH HALVES: the control's own callback FIRED, and the toggle did NOT. Half a
// row is a vacuous test in either direction — a control wired to nothing never toggles anything,
// and a control whose click is swallowed entirely also never toggles anything.
describe("BeadCard — no control on the card ever toggles it", () => {
  it("fires each control and leaves the card's state alone", async () => {
    const onToggleCollapsed = vi.fn();
    const fired: Record<string, ReturnType<typeof vi.fn>> = {
      "build-it": vi.fn(async () => {}),
      "build-all-prd": vi.fn(async () => {}),
      close: vi.fn(),
      "view-on-board": vi.fn(),
      chat: vi.fn(),
      parent: vi.fn(),
    };
    mount({
      collapsed: false,
      onToggleCollapsed,
      onBuildIt: fired["build-it"],
      onBuildAllPrd: fired["build-all-prd"],
      prdEpicCount: 4,
      onClose: fired["close"],
      onViewOnBoard: fired["view-on-board"],
      onChat: fired["chat"],
      onOpenBead: fired["parent"],
      lineage: { parent: PARENT, tasks: [], buildAgents: [] },
    });

    for (const [id, spy] of Object.entries(fired)) {
      fireEvent.click(screen.getByTestId(`${t}-${id}`));
      // FLUSHED BETWEEN CLICKS. The two build buttons share one `buildBusy` flag, so without this
      // the second is still DISABLED from the first click and never fires — which would make the
      // "did not toggle" half of that row vacuously true, the exact shape this file guards against.
      await act(async () => {});
      // THE CONTROL REALLY RAN — otherwise "the card did not toggle" is true of a dead button.
      expect(spy, `${id} did not fire`).toHaveBeenCalled();
      // …AND THE CARD DID NOT TOGGLE. This is the founder's row.
      expect(onToggleCollapsed, `${id} toggled the card`).not.toHaveBeenCalled();
    }
  });

  // THE PORTALED MENU IS THE HARD CASE. `PriorityPill` renders its menu into `document.body`, so
  // the option is not a DOM descendant of the card — but React bubbles through the COMPONENT tree,
  // so the click reaches the card's `onClick` anyway. This row is the only one that catches it.
  it("writes a priority from the portaled menu without collapsing the card", async () => {
    const onToggleCollapsed = vi.fn();
    const onSetPriority = vi.fn(async () => {});
    mount({ onToggleCollapsed, onSetPriority });

    fireEvent.click(screen.getByTestId(`${t}-priority-trigger`));
    expect(onToggleCollapsed).not.toHaveBeenCalled();

    const option = screen.getByTestId(`${t}-priority-option-1`);
    // The menu really is outside the card — which is what makes React's tree bubbling the trap.
    expect(screen.getByTestId(t).contains(option)).toBe(false);
    fireEvent.click(option);
    await waitFor(() => expect(onSetPriority).toHaveBeenCalledWith(1));
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  // THE COMPOSER. Clicking into a half-typed comment must not collapse the card and lose the draft —
  // and a SPACE typed into the textarea bubbles to the card's keydown, which would do the same.
  it("keeps the comment composer usable — clicks and typed spaces never toggle", async () => {
    const onToggleCollapsed = vi.fn();
    const onComment = vi.fn(async () => {});
    mount({ onToggleCollapsed, comments: [], onComment });

    const box = screen.getByTestId(`${t}-comments-input`) as HTMLTextAreaElement;
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: " " });
    fireEvent.change(box, { target: { value: "a note with spaces" } });
    fireEvent.click(screen.getByTestId(`${t}-comments-submit`));

    await waitFor(() => expect(onComment).toHaveBeenCalledWith("a note with spaces"));
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  // THE GOAL EDITOR — a textarea on the epic card, same shape as the composer.
  it("keeps the goal editor usable", () => {
    const onToggleCollapsed = vi.fn();
    mount({ onToggleCollapsed, onSetGoal: vi.fn() });
    const goal = screen.getByTestId(`${t}-goal`);
    fireEvent.click(goal);
    fireEvent.keyDown(goal, { key: " " });
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  // THE LINEAGE ROWS own their own `stopPropagation` (see `BeadLineageRows`), and these two rows are
  // what would notice if it were ever removed: jumping to a task must not collapse the card you
  // jumped from, and "+N more" must expand it exactly ONCE rather than expand-then-re-collapse.
  it("jumps to a task without collapsing the card behind it", () => {
    const onToggleCollapsed = vi.fn();
    const onOpenBead = vi.fn();
    mount({
      collapsed: true,
      onToggleCollapsed,
      onOpenBead,
      lineage: { parent: null, tasks: [{ id: "sparkle-t1", label: "a task" }], buildAgents: [] },
    });
    fireEvent.click(screen.getByTestId(`${t}-tasks-pill`));
    expect(onOpenBead).toHaveBeenCalledWith("sparkle-t1");
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  // ══ "+N more" EXPANDS THE CARD EXACTLY ONCE ═════════════════════════════════════════════════
  // Rule 2 of `BeadLineageRows`: *"maybe the plus seven more is clickable, when I click on it, it
  // would expand the card."* It is a SECOND path to the same result as clicking the card body — so
  // the failure mode is not "nothing happens", it is expand-then-re-collapse in one gesture, which
  // renders as a card that refuses to open. Only the CARD can see that: `onExpand` is
  // `onToggleCollapsed`, so a missing `stopPropagation` fires the toggle twice and nets to zero,
  // and `BeadLineageRows`' own suite does not own the card root's handler.
  //
  // THIS ROW USED TO BE A COMMENT CLAIMING COVERAGE THAT COULD NOT EXIST. jsdom lays nothing out,
  // so every width reads 0, the packer correctly fails open, and the "+N more" node is NEVER
  // RENDERED — the assertion had nothing to click. Driving the widths is what makes the state
  // reachable, and it is the ONE thing the "jsdom does not lay out" exemption cannot excuse here,
  // because the packer reads exactly four numbers and all four can be supplied.
  it("expands exactly ONCE when '+N more' is clicked, on a row that really overflowed", () => {
    const restore = stubLineageWidths();
    try {
      const onToggleCollapsed = vi.fn();
      mount({
        collapsed: true,
        onToggleCollapsed,
        lineage: {
          parent: null,
          tasks: [
            { id: "sparkle-t1", label: "First task" },
            { id: "sparkle-t2", label: "Second task" },
            { id: "sparkle-t3", label: "Third task" },
          ],
          buildAgents: [],
        },
      });

      // THE STATE IS REALLY REACHED — without the stubbed widths this node does not exist at all,
      // which is precisely why the old prose was a claim about nothing.
      expect(screen.getAllByTestId(`${t}-tasks-pill`)).toHaveLength(1);
      const more = screen.getByTestId(`${t}-tasks-more`);
      expect(more.textContent).toBe("+2 more");

      fireEvent.click(more);
      // ONE expansion per gesture. Two would be the card refusing to open.
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

      // ══ THE PAIR, AND IT IS WHAT MAKES THE `1` ABOVE A LIVE NUMBER ═════════════════════════
      // The card root really is listening on this subtree: a click on the row's own background —
      // no pill, no "+N more" — reaches it and toggles. So "exactly once" is a statement about the
      // overflow control swallowing its bubble, not about a region the card ignores entirely.
      onToggleCollapsed.mockClear();
      fireEvent.click(screen.getByTestId(`${t}-tasks`));
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
