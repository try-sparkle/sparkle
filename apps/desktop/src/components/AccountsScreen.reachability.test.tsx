// @vitest-environment jsdom
//
// THE BUG, in the founder's words: "This accounts page is showing off the screen. […] Able to add
// more accounts because that is off the screen."
//
// The accounts dialog rendered at whatever height its content wanted, inside a modal card with no
// height bound and no scroll region. With the spawn ledger under it the card ran past the bottom of
// the window — and because the card is centred, past the TOP as well, so there was nowhere to
// scroll to. The control it carried off was "+ Add account", which is the exact remedy the panel's
// own banner recommends ("Sign in another Claude account to give it somewhere to go"). The screen
// buried the button that does the thing it tells you to do.
//
// ── WHAT THIS FILE CAN AND CANNOT ASSERT ─────────────────────────────────────────────────────
// jsdom has no layout engine: `getBoundingClientRect` is all zeros, `vh` never evaluates, and no
// element ever overflows anything. So "the button is above the fold" is not measurable here and a
// test claiming to measure it would be theatre. What IS measurable is the pair of structural facts
// that make the bad geometry impossible, and both are FALSE against the code as it was:
//
//   1. the card is bounded to the viewport and its body scrolls — so the dialog can never exceed
//      the window, and every control in it is reachable;
//   2. the add-account control is PINNED — it lives in a `position: sticky; top: 0` header, so no
//      ledger length can carry it out of view even mid-scroll.
//
// (1) alone would have unblocked him; (2) is what stops the bug returning the next time something
// long is added above the fold.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import { ModalShell, MODAL_PADDING } from "./ModalShell";
import { expectBoundedCard } from "./dialogCardGeometryTestUtils";
import type { Account, Identity } from "../services/accountStore";
import type { SpawnLogEntry } from "../services/accountLedger";

afterEach(cleanup);

function acct(id: string): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0 };
}

/** The founder's actual ledger shape: one account signed in, every entry naming it. */
function spawns(n: number): SpawnLogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    at: Date.parse("2026-08-08T18:00:00Z") - i * 60_000,
    key: `agent-${String(i).padStart(12, "0")}`,
    accountId: "personal",
    nickname: "Personal",
    configDir: "/cfg/personal",
    email: "founder@example.com",
    reason: "auto" as const,
    tokens5h: null,
    ceiling: null,
    fraction: null,
    eligibleCount: 1,
    signedInCount: 1,
    candidateIds: ["personal"],
  }));
}

// PARTIAL on purpose: this suite is about IO and layout, so it overrides only the IO. The routing
// readers ("what runs where") fall through to their real implementations, which read empty global
// registries under jsdom — no panes mounted, no preference set — i.e. exactly the stubs it would
// otherwise have to write out.
function deps(entries: SpawnLogEntry[]): Partial<AccountsDeps> {
  return {
    listAccounts: vi.fn(async () => [acct("personal")]),
    getUsage: vi.fn(async () => []),
    getIdentities: vi.fn(
      async (): Promise<Identity[]> => [
        { id: "personal", email: "founder@example.com", organization: null, accountUuid: "u-1" },
      ],
    ),
    listCeilings: vi.fn(async () => []),
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    addAccount: vi.fn(async () => acct("new")),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    readSpawnLog: vi.fn(async () => entries),
  };
}

/** Nearest ancestor that is pinned by CSS. Everything on this screen is styled inline, so
 *  `element.style` is the real declaration — not a computed value jsdom would have to invent. */
function stickyAncestor(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n.style.position === "sticky") return n;
  }
  return null;
}

/** Render the PRODUCTION composition — KebabMenu mounts AccountsScreen inside a ModalShell, and the
 *  overflow is a property of the two together, not of either alone. Testing the screen bare would
 *  miss the card that failed to bound it. */
async function renderDialog(rows: number) {
  render(
    <ModalShell width={520} onCancel={() => {}}>
      <AccountsScreen onLogin={vi.fn()} deps={deps(spawns(rows))} />
    </ModalShell>,
  );
  const addBtn = await screen.findByText("+ Add account");
  return addBtn as HTMLElement;
}

describe("the accounts dialog cannot grow off the screen", () => {
  it("bounds the card to the viewport and scrolls its body, however long the ledger is", async () => {
    await renderDialog(60);
    // All 60 spawns really are accounted for — the bound must come from the card, not from the
    // panel quietly dropping data. (They collapse to one row per account; the fixture gives each spawn
    // a distinct agent key, so the row's distinct-agent count is 60 — proof nothing was discarded.)
    //
    // TWO counts, because the panel reports the ledger at two altitudes and each can drop data
    // independently. The summary row counts DISTINCT AGENTS; the disclosure label counts raw
    // SELECTION RECORDS — and it is the record list, not the account summary, whose length actually
    // threatens the card's height. Pinning only the summary would leave the disclosure free to
    // truncate the very list this test exists to bound.
    await waitFor(() => expect(screen.getByText("60 agents")).toBeTruthy());
    expect(screen.getByText("Show the last 60 selections")).toBeTruthy();

    const body = screen.getByTestId("modal-shell-body");

    // THE SHARED ASSERTION, not a local copy of it. This used to hand-roll the three checks, and the
    // copy had already drifted twice: it rejected a `%` ceiling, and it omitted the card-level-
    // scrollport ban entirely — the one check that corresponds to a bug that actually shipped. A
    // rule written out five times is a rule with five versions.
    expectBoundedCard({ card: body.parentElement as HTMLElement, scrollport: body });
  });

  it("pins the add-account control so no ledger length can scroll it away", async () => {
    const addBtn = await renderDialog(60);

    const pinned = stickyAncestor(addBtn);
    expect(pinned).not.toBeNull();
    // Pinned to the TOP of the scrollport specifically. A sticky header with no `top` sticks
    // nowhere and behaves exactly like the static header this replaced.
    expect(pinned!.style.top).toBe("0px");
    // It must RESERVE its own vertical space: a negative top margin (which it used to carry to sit
    // flush against the card edge) laid the content out `MODAL_PADDING`px higher than the header
    // pins to when stuck, so the stuck header painted over the intro line and the account cards'
    // action buttons — the founder's overlap screenshot. `margin-top: 0` is what keeps the content
    // scrolling BELOW the header rather than behind it.
    expect(pinned!.style.marginTop).toBe("0px");
    // It must sit above the content sliding under it, and paint an opaque plane — a transparent
    // sticky header lets the ledger render straight through the button.
    expect(Number(pinned!.style.zIndex)).toBeGreaterThan(0);
    expect(pinned!.style.background).toBeTruthy();

    // The pinned header lives INSIDE the scrollport (that is what `sticky` means) but must not be
    // inside the ledger panel it is meant to outlive.
    const body = screen.getByTestId("modal-shell-body");
    expect(body.contains(pinned!)).toBe(true);
    expect(screen.getByTestId("account-spawn-log").contains(addBtn)).toBe(false);
  });

  it("covers the WebKit sticky band above the header so no content bleeds through it", async () => {
    // THE BUG: WKWebView (this app's engine) resolves a sticky `top: 0` against the scroll
    // container's CONTENT box, so the header pins `MODAL_PADDING`px below the card's top edge and
    // rows scroll up through the uncovered band above it — the green routing text the founder saw
    // bleeding above the title. jsdom has no layout engine, so the band's PIXELS are not measurable
    // here (see the file header). What IS measurable — and is exactly the structure that fixes it —
    // is that the sticky header carries an opaque cover that (a) is absolutely positioned, so it
    // reserves no flow and cannot re-create the overlap a negative top margin caused, and (b) is
    // pulled up by `MODAL_PADDING` and is `MODAL_PADDING` tall, i.e. it spans precisely the band.
    await renderDialog(60);
    const header = screen.getByTestId("accounts-header");
    const cover = screen.getByTestId("accounts-header-top-cover");

    // It lives INSIDE the sticky header — that is what makes it move with the pin and paint in the
    // header's stacking context, above the rows. A cover elsewhere in the tree would not travel with
    // the header when stuck.
    expect(header.style.position).toBe("sticky");
    expect(header.contains(cover)).toBe(true);
    expect(cover).not.toBe(header);

    // Absolute → no layout box, so it cannot push the following rows down (the overlap failure mode).
    expect(cover.style.position).toBe("absolute");
    // It spans exactly the band: pulled up by the inset and as tall as the inset.
    expect(cover.style.top).toBe(`-${MODAL_PADDING}px`);
    expect(cover.style.height).toBe(`${MODAL_PADDING}px`);
    // Pinned to its containing block's edges (`0`), NOT a negative bleed: the header is already
    // full-bleed, so its padding box — which the absolute cover is positioned against — already spans
    // the scrollport edge-to-edge. A negative bleed would push past the right edge and, because the
    // dialog body is `overflow-y: auto` (so overflow-x computes to auto), make it scroll sideways.
    expect(cover.style.left).toBe("0px");
    expect(cover.style.right).toBe("0px");
    // Opaque, and the SAME plane as the header — a transparent cover would let content show straight
    // through it.
    expect(cover.style.background).toBeTruthy();
    expect(cover.style.background).toBe(header.style.background);
  });

  it("keeps the control reachable when the ledger is empty too, not only when it is long", async () => {
    // The pin must not be conditional on overflow — a header that appears only once the page is
    // already too tall is a header nobody can rely on.
    const addBtn = await renderDialog(0);
    expect(stickyAncestor(addBtn)?.style.top).toBe("0px");
  });
});
