// @vitest-environment jsdom
//
// The RED worst-case "these subsystems are completely blocked" bar. Covers: it names the blocked
// subsystems from OBSERVABLE account exhaustion, it shows the founder's exact copy + "+N more"
// overflow, its "Manage fleet" CTA routes to Accounts, it writes the shared store (so the amber bar
// steps aside), and it renders nothing when only a PAST bench exists. jsdom has no layout engine, so
// the copy/props are asserted here and the pixels live in a real-layout test elsewhere.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlockedAgentsBanner,
  BLOCKED_AGENTS_BAR_TESTID,
  BLOCKED_AGENTS_CTA_TESTID,
  type BlockedAgentsBannerDeps,
} from "./BlockedAgentsBanner";
import { useBlockedSubsystemsStore } from "../stores/blockedSubsystemsStore";
import { useAccountLimitStore } from "../stores/accountLimitStore";
import { C } from "../theme/colors";

const HOUR = 3_600_000;
const SPARKLE_ID = "__sparkle_self__";

interface Wire {
  usage: { id: string; exhaustedUntil: number | null }[];
  accounts: { id: string; isDefault: boolean }[];
  sticky: Record<string, string | undefined>;
  panes: Record<string, string | undefined>;
  agentNames: Record<string, string>;
}

/** Build injectable deps over a plain wire snapshot, so no IPC or global registry is touched. */
function deps(wire: Partial<Wire>, openAccounts = vi.fn()): Partial<BlockedAgentsBannerDeps> {
  const w: Wire = {
    usage: wire.usage ?? [],
    accounts: wire.accounts ?? [{ id: "acct-default", isDefault: true }],
    sticky: wire.sticky ?? {},
    panes: wire.panes ?? {},
    agentNames: wire.agentNames ?? {},
  };
  return {
    loadAccountState: (async () => ({
      accounts: w.accounts,
      usage: w.usage,
      identities: [],
      ceilings: [],
    })) as unknown as BlockedAgentsBannerDeps["loadAccountState"],
    stickyAccountSnapshot: (key: string) => w.sticky[key],
    paneAccountMap: () => w.panes,
    agentNames: () => w.agentNames,
    openAccounts,
  };
}

beforeEach(() => {
  useBlockedSubsystemsStore.setState({ blocked: [] });
  // A raised limit is what gates the poll on (accountLimitStore.current), so the banner only reads
  // account state while a limit is actually indicated — every render test models that live limit.
  useAccountLimitStore.setState({
    current: { accountId: "acct-default", until: Date.now() + HOUR },
    dismissed: new Set(),
  });
});
afterEach(() => {
  cleanup();
  useAccountLimitStore.setState({ current: null, dismissed: new Set() });
});

describe("BlockedAgentsBanner", () => {
  it("names AI Enhancement Features and shows the founder's copy + CTA when the default account is exhausted", async () => {
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-default", isDefault: true }],
        })}
      />,
    );
    const bar = await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    const text = bar.textContent ?? "";
    expect(text).toContain("Blocked due to session limits:");
    expect(text).toContain("AI Enhancement Features");
    expect(text).toContain("Manage fleet");
    expect(text).toContain("to unblock");
  });

  it("lists BOTH AI Enhancement Features and Improve Sparkle agent when they share the exhausted account (the founder's co-failure)", async () => {
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-default", isDefault: true }],
          sticky: { [SPARKLE_ID]: "acct-default" },
        })}
      />,
    );
    const bar = await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    const text = bar.textContent ?? "";
    expect(text).toContain("AI Enhancement Features");
    expect(text).toContain("Improve Sparkle agent");
  });

  it("dedupes a satellite-window Improve Sparkle pane via the REAL predicate — no raw id, no duplicate (production wiring)", async () => {
    // Exercises the component's own `isSparkleAgentId` wiring (not injectable): a
    // `__sparkle_self__-win-<uuid>` pane must not appear as a second entry, and its raw id must never
    // reach the copy. Only the pool account is exhausted, so AI-Enhanced (default) is not listed.
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [
            { id: "acct-default", exhaustedUntil: null },
            { id: "acct-pool", exhaustedUntil: Date.now() + HOUR },
          ],
          accounts: [{ id: "acct-default", isDefault: true }],
          sticky: { [SPARKLE_ID]: "acct-pool" },
          panes: { [`${SPARKLE_ID}-win-abc`]: "acct-pool", a1: "acct-pool" },
          agentNames: { a1: "Real Agent" },
        })}
      />,
    );
    const bar = await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    const text = bar.textContent ?? "";
    expect(text).not.toContain(`${SPARKLE_ID}-win`); // no raw internal id in user copy
    expect(text).toContain("Improve Sparkle agent");
    // …and only ONCE (the sticky binding), not a second time from the pane.
    expect(text.match(/Improve Sparkle agent/g)?.length ?? 0).toBe(1);
    expect(text).toContain("Real Agent");
  });

  it("truncates a long list to '+N more' so it can never overflow the bar", async () => {
    // Default + Improve + Concierge + three named panes = 6 blocked on one exhausted account.
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-x", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-x", isDefault: true }],
          sticky: { [SPARKLE_ID]: "acct-x", "sparkle:concierge": "acct-x" },
          panes: { a1: "acct-x", a2: "acct-x", a3: "acct-x" },
          agentNames: { a1: "Rail One", a2: "Rail Two", a3: "Rail Three" },
        })}
      />,
    );
    const bar = await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    const text = bar.textContent ?? "";
    // BLOCKED_MAX_VISIBLE = 2 → two names shown, remaining four summarised.
    expect(text).toContain("+ 4 more");
    // The first two (AI-Enhanced, Improve Sparkle) are visible; a later one is folded away.
    expect(text).toContain("AI Enhancement Features");
    expect(text).toContain("Improve Sparkle agent");
    expect(text).not.toContain("Rail Three");
  });

  it("routes 'Manage fleet' to the Accounts surface", async () => {
    const openAccounts = vi.fn();
    render(
      <BlockedAgentsBanner
        deps={deps(
          {
            usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
            accounts: [{ id: "acct-default", isDefault: true }],
          },
          openAccounts,
        )}
      />,
    );
    fireEvent.click(await screen.findByTestId(BLOCKED_AGENTS_CTA_TESTID));
    expect(openAccounts).toHaveBeenCalledTimes(1);
  });

  it("writes the shared blocked store, so the amber AiServiceBanner can step aside", async () => {
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-default", isDefault: true }],
        })}
      />,
    );
    await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    expect(useBlockedSubsystemsStore.getState().blocked.map((b) => b.label)).toContain(
      "AI Enhancement Features",
    );
  });

  it("paints RED (C.sienna), not the amber caution fill", async () => {
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-default", isDefault: true }],
        })}
      />,
    );
    const bar = await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    // jsdom normalises a hex fill to its rgb() form, so compare through the same normalisation
    // rather than against the raw token string.
    const asRendered = (color: string) => {
      const probe = document.createElement("div");
      probe.style.background = color;
      return probe.style.background;
    };
    expect(bar.style.background).toBe(asRendered(C.sienna));
    expect(bar.style.background).not.toBe(asRendered(C.amber));
  });

  it("paints the 'Manage fleet' link with the SAME ink token as the bar it sits in", async () => {
    // THE CAPABILITY, not the scanner's label. `linkContrast` is a static scan: it proves the CTA's
    // colour is *traceable to some ink tier*, which is a weaker claim than "legible on THIS bar".
    // The bar's fill is `C.sienna` (red) — the amber sibling's ink was copied onto it wholesale and
    // nobody had checked forest-on-red — so what has to hold is that the link and the sentence
    // beside it are the SAME ink, and stay that way.
    //
    // Asserting equality of the declared token is what catches the drift the static scan cannot:
    // `var(--c-forest)` and `var(--c-on-fill-ink)` hold the same hex today, so a bar on `forest` and
    // a link on `onFillInk` would render identically AND pass `linkContrast` — right up until
    // `forest`, the app body background, is re-tuned and only one of them moves.
    render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-default", isDefault: true }],
        })}
      />,
    );
    const bar = await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    const cta = await screen.findByTestId(BLOCKED_AGENTS_CTA_TESTID);

    // It is a link at all — otherwise the ink assertion below guards nothing.
    expect(cta.style.textDecoration).toContain("underline");
    // Both actually declare an ink; `toBe("")` on either would make the equality vacuous.
    expect(bar.style.color).not.toBe("");
    expect(cta.style.color).not.toBe("");
    // ...and it is ONE token, so they cannot drift apart.
    expect(cta.style.color).toBe(bar.style.color);
    // The ink tier's own name, not the surface token that happens to share its value today.
    //
    // ⚠️ COMPARED THROUGH THE CSSOM, NOT AS A RAW STRING, because `.style.color` is FORM-DEPENDENT:
    // jsdom passes a `var(--c-*)` through verbatim but normalises a hex literal to `rgb(r, g, b)`.
    // `C.onFillInk` is a LITERAL — it is `BRAND.forest`, constant navy in both themes, because the
    // brand fills it sits on are constant too — so a direct `toBe(C.onFillInk)` compares "#0a1a3f"
    // against "rgb(10, 26, 63)" and fails on the spelling while the inks are in fact identical.
    // Round-tripping the expectation through the same CSSOM makes the assertion about the VALUE.
    const probe = document.createElement("span");
    probe.style.color = C.onFillInk;
    expect(probe.style.color).not.toBe("");
    expect(cta.style.color).toBe(probe.style.color);
  });

  it("renders nothing when the only bench is in the PAST (a lapsed limit is not a block)", async () => {
    const load = vi.fn(async () => ({
      accounts: [{ id: "acct-default", isDefault: true }],
      usage: [{ id: "acct-default", exhaustedUntil: Date.now() - 1 }],
      identities: [],
      ceilings: [],
    }));
    render(
      <BlockedAgentsBanner
        deps={{
          ...deps({}),
          loadAccountState: load as unknown as BlockedAgentsBannerDeps["loadAccountState"],
        }}
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalled());
    // Flush the .then that folds the (empty) result into the store.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId(BLOCKED_AGENTS_BAR_TESTID)).toBeNull();
    expect(useBlockedSubsystemsStore.getState().blocked).toEqual([]);
  });

  it("does NOT read account state on a healthy machine (no limit indicated → no poll)", async () => {
    // The cost fix: an always-mounted banner must not poll forever. With no raised limit and nothing
    // already blocked, it must not touch loadAccountState at all.
    useAccountLimitStore.setState({ current: null, dismissed: new Set() });
    const load = vi.fn(async () => ({
      accounts: [{ id: "acct-default", isDefault: true }],
      usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
      identities: [],
      ceilings: [],
    }));
    render(
      <BlockedAgentsBanner
        deps={{
          ...deps({}),
          loadAccountState: load as unknown as BlockedAgentsBannerDeps["loadAccountState"],
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId(BLOCKED_AGENTS_BAR_TESTID)).toBeNull();
  });

  it("clears the shared store on unmount, so a surface rendering the amber bar alone is not left suppressed", async () => {
    const { unmount } = render(
      <BlockedAgentsBanner
        deps={deps({
          usage: [{ id: "acct-default", exhaustedUntil: Date.now() + HOUR }],
          accounts: [{ id: "acct-default", isDefault: true }],
        })}
      />,
    );
    await screen.findByTestId(BLOCKED_AGENTS_BAR_TESTID);
    expect(useBlockedSubsystemsStore.getState().blocked.length).toBeGreaterThan(0);
    unmount();
    expect(useBlockedSubsystemsStore.getState().blocked).toEqual([]);
  });
});
