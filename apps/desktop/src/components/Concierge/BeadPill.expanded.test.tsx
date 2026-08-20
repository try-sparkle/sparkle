// @vitest-environment jsdom
//
// Bead cards render EXPANDED when the concierge names them (`[ui].bead_cards_expanded`).
//
// The founder's ask, verbatim: "I wanna try changing things such that you show these bead cards as
// expanded by default and of me having to click on them to expand them… Let's give that a try."
//
// ══ WHY THIS IS ITS OWN FILE ════════════════════════════════════════════════════════════════════
// "Let's give that a try" is an experiment with a revert path (`bead_cards_expanded = false`), and
// a file boundary keeps the guard for the experiment separable from the guard for the pill itself.
// `BeadPill.test.tsx`'s rows deliberately mount WITHOUT the auto-expand provider — they describe
// click-to-expand, which is still exactly what every non-concierge surface does — so nothing here
// belongs beside them.
//
// ══ WHAT THESE TESTS ARE GUARDING AGAINST, SPECIFICALLY ═════════════════════════════════════════
// Every rule this feature has is INVISIBLE in the rendered output: a collapsed card, a card whose
// budget was spent on an id-shaped English word, and an id that never resolved at all are the same
// three pixels of pill. So the assertions below are on the CARD's own contents and on the specific
// gestures that must and must not close it — never on "a pill exists", which was true before any of
// this and would stay true with the whole feature deleted.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "../Markdown";
import { ConciergeThread } from "./ConciergeThread";
import {
  BeadAutoExpandProvider,
  BeadPillProvider,
  autoExpandedBeadIds,
  type BeadPillContextValue,
  type ResolvedBead,
} from "./BeadPill";
import { useBeadsStore } from "../../stores/beadsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  DEFAULT_BEAD_CARDS_EXPANDED,
  DEFAULT_BEAD_CARDS_EXPANDED_MAX,
  normalizeBeadCardsExpandedMax,
} from "../../stores/settingsStore";
import type { Bead } from "../../services/beads";
import type { ConciergeMessage } from "./types";

afterEach(() => cleanup());

// The poller would shell out to `bd` through a Tauri bridge jsdom does not have. Stubbed for the
// whole file, exactly as `BeadPill.test.tsx` does, so beads stay ON and the real resolution path
// runs.
const realPoller = {
  startPolling: useBeadsStore.getState().startPolling,
  stopPolling: useBeadsStore.getState().stopPolling,
};
const settingsBefore = {
  beadCardsExpanded: useSettingsStore.getState().beadCardsExpanded,
  beadCardsExpandedMax: useSettingsStore.getState().beadCardsExpandedMax,
};
beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} });
  // The SHIPPED defaults, restated rather than assumed: these rows describe what the founder gets
  // out of the box, so reading them from the constants keeps the file honest if the default moves.
  useSettingsStore.setState({
    beadCardsExpanded: DEFAULT_BEAD_CARDS_EXPANDED,
    beadCardsExpandedMax: DEFAULT_BEAD_CARDS_EXPANDED_MAX,
  });
});
afterEach(() => {
  useBeadsStore.setState(realPoller);
  useSettingsStore.setState(settingsBefore);
});

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Never hide a row that needs action",
    description: "FOUNDER'S RULE, verbatim: \"We should never hide a row that needs action from me.\"",
    status: "open",
    type: "bug",
    priority: 0,
    labels: [],
    parent: null,
    ...over,
  };
}

const QOGAH = bead({ id: "sparkle-qogah" });

/** A board holding `beads`. `rootPath` is supplied on purpose — WITHOUT it the card renders
 *  read-only and "Build It" is absent, which would make the goal assertion below unsatisfiable for
 *  a reason that has nothing to do with expansion. */
function ctx(beads: Bead[], over: Partial<BeadPillContextValue> = {}): BeadPillContextValue {
  return {
    beads: new Map(beads.map((b) => [b.id, { bead: b, projectId: "p1", rootPath: "/repo" }])),
    onViewOnBoard: vi.fn(() => true),
    ...over,
  };
}

/** The concierge path: the auto-expand provider wrapped around the reply's markdown, which is what
 *  `ConciergeMessageRow` mounts in production. */
function mountReply(value: BeadPillContextValue, text: string) {
  return render(
    <BeadPillProvider value={value}>
      <BeadAutoExpandProvider text={text}>
        <Markdown text={text} />
      </BeadAutoExpandProvider>
    </BeadPillProvider>,
  );
}

const pills = () => screen.queryAllByTestId("concierge-bead-pill");
const cards = () => screen.queryAllByTestId("concierge-bead-card");
const card = () => screen.queryByTestId("concierge-bead-card");

// ── 1. THE GOAL ─────────────────────────────────────────────────────────────────────────────────

describe("expanded by default — the card is there without a click", () => {
  // THE GOAL, stated as one assertion per thing the founder's screenshot shows. Deliberately not
  // "a card exists": every one of these fields is a separate render path on `BeadCard`, and the
  // screenshot is the spec.
  it("shows title, id, status, priority, type, progress and Build It with no click", () => {
    mountReply(
      ctx([
        bead({
          id: "sparkle-qogah",
          title: "Never hide a row that needs action",
          // OPEN, and that is load-bearing rather than incidental. "Build It" is offered on any
          // bead that has NOT BEEN STARTED YET (`isStartable` in `useBeadBuildActions`) — the type
          // no longer gates it, but the status does. This fixture used to be `in_progress`, which
          // passed only while the concierge surface checked nothing about status and so offered
          // the button on work already underway; the sibling test below pins that it no longer
          // does. Using a state that HAS the action is what makes "…and Build It, with no click"
          // an assertion about EXPANSION rather than an accident of the fixture.
          status: "open",
          priority: 0,
          type: "task",
        }),
      ]),
      "One thing only you can settle: sparkle-qogah",
    );

    // NO CLICK HAPPENS ANYWHERE IN THIS TEST. That absence is the assertion.
    const c = card();
    expect(c).not.toBeNull();
    expect(screen.getByTestId("concierge-bead-card-title").textContent).toBe(
      "Never hide a row that needs action",
    );
    expect(screen.getByTestId("concierge-bead-card-id").textContent).toContain("sparkle-qogah");
    const meta = screen.getByTestId("concierge-bead-card-meta").textContent ?? "";
    expect(meta).toContain("open");
    expect(meta).toContain("P0");
    expect(meta).toContain("task");
    expect(screen.getByTestId("concierge-bead-card-stage")).not.toBeNull();
    expect(screen.getByTestId("concierge-bead-card-build-it")).not.toBeNull();
  });

  // THE PAIRED NEGATIVE, and it is the half with the power. The assertion above says the expanded
  // card CAN carry Build It; on its own that is satisfied just as well by a surface that offers the
  // button unconditionally — which is exactly what the concierge used to do. This bead differs from
  // that one in ONE field, so a rule that stopped reading `status` would light both up and this
  // test is the only thing that would go red.
  //
  // It is the concierge half of the shared gate: `BeadPill` has no COLUMN to read (it is a card in
  // a chat thread, not a board lane), which is how the status question came to be asked on the
  // board card and nowhere else. Everything else about the card must still render, so this is not
  // "the card is missing" passing for "the button is missing".
  it("withholds Build It once the work has started — the card is otherwise unchanged", () => {
    mountReply(
      ctx([
        bead({
          id: "sparkle-qogah",
          title: "Never hide a row that needs action",
          status: "in_progress",
          priority: 0,
          type: "task",
        }),
      ]),
      "One thing only you can settle: sparkle-qogah",
    );

    expect(card()).not.toBeNull();
    expect(screen.getByTestId("concierge-bead-card-title").textContent).toBe(
      "Never hide a row that needs action",
    );
    expect(screen.getByTestId("concierge-bead-card-meta").textContent ?? "").toContain(
      "in progress",
    );
    expect(screen.queryByTestId("concierge-bead-card-build-it")).toBeNull();
  });

  // THE LOAD-BEARING ONE. Everything above renders the provider by hand, so it would keep passing
  // with `ConciergeMessageRow` never wired at all — i.e. with the feature firing on nothing the
  // founder will ever see. This drives the real thread instead. If it is deleted as redundant, the
  // feature can regress to a component nobody mounts.
  it("expands inside a real concierge reply, through ConciergeMessageRow's own wiring", () => {
    render(
      <BeadPillProvider value={ctx([QOGAH])}>
        <ConciergeThread
          messages={
            [
              { id: "s1", kind: "sparkle", text: "settled on sparkle-qogah so nobody re-litigates" },
            ] as ConciergeMessage[]
          }
          onNudgeClick={vi.fn()}
          onNudgeAction={vi.fn()}
        />
      </BeadPillProvider>,
    );
    expect(card()).not.toBeNull();
    expect(screen.getByTestId("concierge-bead-card-title").textContent).toBe(
      "Never hide a row that needs action",
    );
  });

  // A proactive push is the same words arrived unasked, and it renders through the OTHER of the two
  // `<Markdown>` call sites in `ConciergeMessageRow`. Wrapping only one of them is the likeliest
  // way to half-ship this.
  it("expands in a proactive push too — the second Markdown call site", () => {
    render(
      <BeadPillProvider value={ctx([QOGAH])}>
        <ConciergeThread
          messages={
            [{ id: "s1", kind: "sparkle", text: "filed sparkle-qogah", proactive: true }] as ConciergeMessage[]
          }
          onNudgeClick={vi.fn()}
          onNudgeAction={vi.fn()}
        />
      </BeadPillProvider>,
    );
    expect(card()).not.toBeNull();
  });

  // A surface OUTSIDE the concierge — SupportModal, an agent's own reply — mounts no provider and
  // must be untouched by any of this.
  it("leaves a non-concierge surface on click-to-expand", () => {
    render(
      <BeadPillProvider value={ctx([QOGAH])}>
        <Markdown text="see sparkle-qogah" />
      </BeadPillProvider>,
    );
    expect(card()).toBeNull();
    fireEvent.click(pills()[0]!);
    expect(card()).not.toBeNull();
  });
});

// ── 2. THE COLLAPSE AFFORDANCE STILL WORKS ──────────────────────────────────────────────────────

describe("the collapse control — he is changing the default, not removing the affordance", () => {
  it("collapses on the pill, and STAYS collapsed", () => {
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(card()).not.toBeNull();
    fireEvent.click(pills()[0]!);
    expect(card()).toBeNull();
    // The founder's requirement in his own terms: it stays collapsed while that message is on
    // screen. A re-render (any state change anywhere above) must not re-open it — which is what a
    // plain `useState(autoOpen)` recomputed on render would do.
    act(() => {
      useSettingsStore.setState({ beadCardsExpandedMax: 7 });
    });
    expect(card()).toBeNull();
    // …and it is still a toggle, not a one-way door.
    fireEvent.click(pills()[0]!);
    expect(card()).not.toBeNull();
  });

  it("collapses on the card's × — the control the screenshot shows", () => {
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(screen.getByTestId("concierge-bead-card-close"));
    expect(card()).toBeNull();
  });

  it("keeps aria-expanded honest without a click", () => {
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(pills()[0]!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(pills()[0]!);
    expect(pills()[0]!.getAttribute("aria-expanded")).toBe("false");
  });
});

// ── 3. THE OUTSIDE CLICK ────────────────────────────────────────────────────────────────────────

describe("an auto-expanded card survives the click that answers the message", () => {
  // THE BUG THIS FEATURE WOULD OTHERWISE SHIP WITH. The very next thing the founder does after
  // reading a reply is click his composer to answer it. Under the ungated listener that one press
  // collapsed every card in the thread — the feature would appear to work for a few seconds and
  // then delete itself.
  it("ignores a mousedown outside it", () => {
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(card()).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(card()).not.toBeNull();
  });

  // THE PAIRED ASSERTION, and the one that makes the row above mean something. Absence of a close
  // proves nothing on its own — a listener that was never registered at all, for either kind of
  // card, passes the row above perfectly. This shows the mechanism is live and merely gated: a card
  // the reader OPENED BY HAND still closes on an outside press, exactly as it did before.
  it("still closes a HAND-OPENED card on a mousedown outside it", () => {
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!); // collapse it…
    expect(card()).toBeNull();
    fireEvent.click(pills()[0]!); // …and re-open it BY HAND
    expect(card()).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(card()).toBeNull();
  });

  // Escape closes either kind — the reader's keyboard exit, which does not depend on finding a pill
  // that may have scrolled off screen.
  it("closes on Escape", () => {
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(card()).toBeNull();
  });
});

// ── 4. MANY BEADS IN ONE REPLY ──────────────────────────────────────────────────────────────────

describe("a reply that names many beads", () => {
  const ids = ["sparkle-aaa11", "sparkle-bbb22", "sparkle-ccc33", "sparkle-ddd44"];

  it("expands every one when uncapped — the shipped default", () => {
    mountReply(ctx(ids.map((id) => bead({ id }))), ids.join(" and "));
    expect(pills()).toHaveLength(4);
    expect(cards()).toHaveLength(4);
  });

  it("expands the first N and leaves the tail as pills when capped", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 2 });
    mountReply(ctx(ids.map((id) => bead({ id }))), ids.join(" and "));
    // Every id is still a pill — the cap changes the card, never the linkification.
    expect(pills()).toHaveLength(4);
    expect(cards()).toHaveLength(2);
    // DOCUMENT ORDER: the cap truncates the tail of his list, not an arbitrary subset of it.
    expect(cards().map((c) => c.getAttribute("data-bead-id"))).toEqual([
      "sparkle-aaa11",
      "sparkle-bbb22",
    ]);
  });

  it("still opens a capped-out bead on a click", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 1 });
    mountReply(ctx(ids.map((id) => bead({ id }))), ids.join(" and "));
    expect(cards()).toHaveLength(1);
    fireEvent.click(pills()[3]!);
    expect(cards()).toHaveLength(2);
  });
});

// ── 5. THE OFF SWITCH ───────────────────────────────────────────────────────────────────────────

describe("[ui].bead_cards_expanded = false is the whole revert", () => {
  it("restores click-to-expand exactly", () => {
    useSettingsStore.setState({ beadCardsExpanded: false });
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(card()).toBeNull();
    fireEvent.click(pills()[0]!);
    expect(card()).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(card()).toBeNull();
  });
});

// ── 6. THE RULE ITSELF ──────────────────────────────────────────────────────────────────────────

describe("autoExpandedBeadIds — the rules that are invisible on screen", () => {
  const board = (ids: string[]): ReadonlyMap<string, ResolvedBead> =>
    new Map(ids.map((id) => [id, { bead: bead({ id }), projectId: "p1" }]));
  const on = { enabled: true, max: 0 };

  // THE RULE THE WHOLE CAP DEPENDS ON. `remarkBeadRefs` is loose by design and yields every
  // id-SHAPED token, so a budget spent on ordinary hyphenated English would collapse the one card
  // the founder actually wanted. Here `auto-heal` and `one-shot` come FIRST in the text and would
  // eat a cap of 2 entirely.
  it("spends the cap only on ids that RESOLVE, never on id-shaped English", () => {
    const text = "the auto-heal path is one-shot; see sparkle-qogah and sparkle-aaa11";
    const got = autoExpandedBeadIds(text, board(["sparkle-qogah", "sparkle-aaa11"]), {
      enabled: true,
      max: 2,
    });
    expect([...got]).toEqual(["sparkle-qogah", "sparkle-aaa11"]);
  });

  it("counts a repeated id once against the cap", () => {
    const text = "sparkle-qogah, then sparkle-qogah again, then sparkle-aaa11";
    const got = autoExpandedBeadIds(text, board(["sparkle-qogah", "sparkle-aaa11"]), {
      enabled: true,
      max: 2,
    });
    expect([...got]).toEqual(["sparkle-qogah", "sparkle-aaa11"]);
  });

  it("takes them in document order", () => {
    const text = "sparkle-ccc33 before sparkle-aaa11 before sparkle-bbb22";
    const got = autoExpandedBeadIds(text, board(["sparkle-aaa11", "sparkle-bbb22", "sparkle-ccc33"]), {
      enabled: true,
      max: 2,
    });
    expect([...got]).toEqual(["sparkle-ccc33", "sparkle-aaa11"]);
  });

  it("is empty when disabled, whatever the text says", () => {
    const got = autoExpandedBeadIds("sparkle-qogah", board(["sparkle-qogah"]), {
      enabled: false,
      max: 0,
    });
    expect(got.size).toBe(0);
  });

  it("treats max <= 0 as no cap", () => {
    const ids = ["sparkle-aaa11", "sparkle-bbb22", "sparkle-ccc33"];
    expect(autoExpandedBeadIds(ids.join(" "), board(ids), on).size).toBe(3);
  });
});

// ── 7. A HAND-EDITED CAP ────────────────────────────────────────────────────────────────────────

describe("normalizeBeadCardsExpandedMax — config.toml is untrusted input", () => {
  it("keeps a sane cap", () => {
    expect(normalizeBeadCardsExpandedMax(3)).toBe(3);
    expect(normalizeBeadCardsExpandedMax(0)).toBe(0);
  });

  // THE DANGEROUS ONE. A negative cap makes every `size >= max` test true at the first id — so NO
  // card expands and the symptom is indistinguishable from the feature having been switched off,
  // with the config file plainly saying it is on.
  it("floors a negative to 0 (= no cap) rather than expanding nothing", () => {
    expect(normalizeBeadCardsExpandedMax(-1)).toBe(0);
    expect(normalizeBeadCardsExpandedMax(-99)).toBe(0);
  });

  it("rounds a fraction DOWN, so 2.9 is a cap of 2 rather than 3", () => {
    expect(normalizeBeadCardsExpandedMax(2.9)).toBe(2);
  });

  it("falls back to the default for an absent or non-numeric value", () => {
    expect(normalizeBeadCardsExpandedMax(undefined)).toBe(DEFAULT_BEAD_CARDS_EXPANDED_MAX);
    expect(normalizeBeadCardsExpandedMax("3")).toBe(DEFAULT_BEAD_CARDS_EXPANDED_MAX);
    expect(normalizeBeadCardsExpandedMax(Number.NaN)).toBe(DEFAULT_BEAD_CARDS_EXPANDED_MAX);
  });
});

// ── 8. THE CONSTRAINT THIS CHANGE MUST NOT BREAK ────────────────────────────────────────────────

describe("the linkifier's own boundaries are untouched", () => {
  // `remarkBeadRefs` deliberately visits TEXT nodes only, so a backticked id stays dead monospace.
  // This change is about the DEFAULT OPEN STATE of a rendered card, not about what gets matched —
  // and an auto-expand pass that re-scanned the raw text could quietly start expanding cards for
  // ids that were never linkified at all.
  it("does not expand a card for a backticked id", () => {
    mountReply(ctx([QOGAH]), "the bead is `sparkle-qogah` in code");
    expect(pills()).toHaveLength(0);
    expect(cards()).toHaveLength(0);
  });

  // THE HALF THE ROW ABOVE DOES NOT COVER, and the one that actually bites (roborev 65335). "No
  // card for a backticked id" is true for a reason that has nothing to do with the cap: no pill is
  // drawn there, so no card can be. The question the cap asks is different — did that id CONSUME A
  // SLOT on its way to drawing nothing? It did, because the rule read the raw markdown source while
  // the linkifier reads the mdast tree and never visits an `inlineCode` node.
  //
  // Latent at the shipped default (uncapped), and the config template points the founder straight
  // at the case that triggers it ("3 is a good first try"). The symptom is the worst kind: with a
  // cap of 1 and a reply that opens `bd show sparkle-qogah`, ZERO cards expand while the config
  // plainly says the feature is on — indistinguishable from having switched it off.
  it("does not spend a cap slot on a backticked id, which can never become a card", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 1 });
    mountReply(
      ctx([QOGAH, bead({ id: "sparkle-aaa11", title: "The one he actually wanted" })]),
      "run `bd show sparkle-qogah` first — the live one is sparkle-aaa11",
    );
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.getAttribute("data-bead-id")).toBe("sparkle-aaa11");
  });

  // The same defect in its other shape: a FENCED block. Same cause, different node type, and worth
  // its own row because a fence is what the concierge writes when it quotes a command to run.
  it("does not spend a cap slot on an id inside a fenced block", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 1 });
    mountReply(
      ctx([QOGAH, bead({ id: "sparkle-aaa11", title: "The one he actually wanted" })]),
      "```\nbd show sparkle-qogah\n```\n\nthe live one is sparkle-aaa11",
    );
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.getAttribute("data-bead-id")).toBe("sparkle-aaa11");
  });

  // And inside a LINK, where the linkifier's `inLink` guard stops it from nesting an anchor in an
  // anchor. An id in the label or the URL draws no pill, so it must not cost a slot either.
  it("does not spend a cap slot on an id inside a link", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 1 });
    mountReply(
      ctx([QOGAH, bead({ id: "sparkle-aaa11", title: "The one he actually wanted" })]),
      "[the sparkle-qogah work](https://example.test/x) — the live one is sparkle-aaa11",
    );
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.getAttribute("data-bead-id")).toBe("sparkle-aaa11");
  });

  // An id that resolves to nothing is prose, exactly as before — no pill, no card, no wrapper.
  it("does not expand a card for an id that does not resolve", () => {
    const { container } = mountReply(ctx([]), "recorded on sparkle-17hm1 today");
    expect(pills()).toHaveLength(0);
    expect(cards()).toHaveLength(0);
    expect(container.textContent).toContain("recorded on sparkle-17hm1 today");
  });
});

// ── 9. A BEAD THAT RESOLVES LATE ────────────────────────────────────────────────────────────────

describe("a bead filed after the message was written", () => {
  // THE TRAP A PLAIN `useState(autoOpen)` FALLS INTO, and it is the common case rather than an edge
  // one: `beadsStore` polls, so a bead the concierge just filed resolves SECONDS after its message
  // renders. A seeded initial state reads `false` at mount and sits collapsed forever.
  it("opens its card when the board catches up, with no click", () => {
    const text = "just filed sparkle-qogah";
    const { rerender } = render(
      <BeadPillProvider value={ctx([])}>
        <BeadAutoExpandProvider text={text}>
          <Markdown text={text} />
        </BeadAutoExpandProvider>
      </BeadPillProvider>,
    );
    expect(pills()).toHaveLength(0);
    expect(cards()).toHaveLength(0);

    rerender(
      <BeadPillProvider value={ctx([QOGAH])}>
        <BeadAutoExpandProvider text={text}>
          <Markdown text={text} />
        </BeadAutoExpandProvider>
      </BeadPillProvider>,
    );
    expect(pills()).toHaveLength(1);
    expect(cards()).toHaveLength(1);
  });

  it("survives StrictMode's double-invoke", () => {
    render(
      <StrictMode>
        <BeadPillProvider value={ctx([QOGAH])}>
          <BeadAutoExpandProvider text="see sparkle-qogah">
            <Markdown text="see sparkle-qogah" />
          </BeadAutoExpandProvider>
        </BeadPillProvider>
      </StrictMode>,
    );
    expect(cards()).toHaveLength(1);
  });
});
