// @vitest-environment jsdom
//
// sparkle-m8f39q (P0). THE FOUNDER'S SCREENSHOT: a green bar reading "Session limit reached:
// Automatically switching 26 agents to DROdio Personal" sitting directly above an open accounts
// modal reading "No accounts yet. Add one to get started." Both on screen at once; both cannot be
// true.
//
// WHAT THE FORENSICS ESTABLISHED, so the next reader does not re-derive it: on that machine the
// banner was the HONEST surface. `accounts.json` held 7 accounts including the named destination,
// and the spawn log shows every spawn in the surrounding seconds routed to it. The pane was the one
// making the false claim. But the direction is incidental — what made the contradiction POSSIBLE is
// that the banner's claim was never re-checked against anything:
//
//   • `AccountSwitchHost`'s read effect is keyed on the `plan` object, and `advanceSwitch` returns
//     the IDENTICAL reference whenever no agent moved, so React bails and the effect never re-runs;
//   • phase 1 of `useAccountSwitch` is short-circuited while any plan exists, and a plan retires
//     only on FULL completion — so a wedged switch pins the notice indefinitely;
//   • the `named()` nameability gate was applied to the recommendation branch ONLY, on the stated
//     grounds that the plan branch "names no account" — which stopped being true when the
//     destination nickname was added to that sentence.
//
// Together those make the green bar a frozen relic that can outlive its own truth without limit.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { SwitchPlan } from "../services/accountSwitch";
import { SWITCH_AMBER, SWITCH_GREEN } from "./AccountSwitchBanner";

const loadAccountState = vi.fn();
vi.mock("../services/accountSelection", () => ({ loadAccountState: () => loadAccountState() }));

// The REVALIDATION leg, mocked separately from the initial load on purpose: keeping them distinct
// is what lets a test assert that the tick pays the CHEAP read and not the full one.
const listAccounts = vi.fn();
vi.mock("../services/accountStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accountStore")>();
  return { ...actual, listAccounts: () => listAccounts() };
});

// ONE object, returned by every call — the real wedged-plan condition. `advanceSwitch` preserves
// the reference when nothing moves, so a test that handed back a fresh object each render would
// re-run the effect for a reason production never supplies and prove nothing about the freeze.
const PLAN: SwitchPlan = {
  fromAccountId: "acct-from",
  toAccountId: "acct-to",
  moved: ["m0", "m1"],
  pending: Array.from({ length: 24 }, (_, i) => `p${i}`),
};

// Swappable so a test can hand back a DIFFERENT plan object — which is what `advanceSwitch` really
// does every time an agent completes its turn (`accountSwitch.ts`), and is therefore what makes the
// load effect re-run during a live migration. Held in a hoisted box because `vi.mock` factories run
// before module-scope `let`s initialize.
const hoisted = vi.hoisted(() => ({ plan: null as SwitchPlan | null }));

vi.mock("../hooks/useAccountSwitch", () => ({
  useAccountSwitch: () => ({
    recommendation: null,
    plan: hoisted.plan,
    accept: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

/** A new plan OBJECT for the same migration, as if one pending agent just moved. */
const planAfterOneMove = (): SwitchPlan => ({
  ...PLAN,
  moved: [...PLAN.moved, PLAN.pending[0]!],
  pending: PLAN.pending.slice(1),
});

import { AccountSwitchHost } from "./AccountSwitchHost";

const account = (id: string, nickname: string): Account => ({
  id,
  nickname,
  configDir: `/tmp/${id}`,
  isDefault: false,
  createdAt: 0,
});

/** The destination the plan points at, as a registry row. */
const DESTINATION = account("acct-to", "DROdio Personal");
/** The account the fleet is migrating OFF. Its presence is what makes a read self-consistent. */
const SOURCE = account("acct-from", "DROdio Storytell");

const state = (accounts: Account[], failed = false) => ({
  accounts,
  usage: [],
  identities: [],
  ceilings: [],
  failed,
});

/** jsdom normalizes any color assigned to `style.background` into `rgb(r, g, b)`, so a test that
 *  looks for the hex literal can never fail — it is absent whichever wrap painted the element.
 *  Comparing against the normalized form of the EXPORTED constant is what gives the assertion
 *  teeth: swap the amber wrap back to the green one and the expected string stops matching. */
const rgb = (hex: string) =>
  `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

/** Let the mocked promises and their `.then` land. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  hoisted.plan = PLAN;
  loadAccountState.mockReset();
  listAccounts.mockReset();
  listAccounts.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AccountSwitchHost — the switch notice cannot name a destination the registry lacks", () => {
  // ── THE FOUNDER'S STATED ACCEPTANCE CRITERION ─────────────────────────────────────────────────
  // "puts the registry in the empty state and asserts the switcher either names no destination or
  // fails visibly." It is an OR, and the empty case satisfies the FIRST disjunct: no name. It
  // deliberately does NOT satisfy the second — see the next test for why accusing on an empty read
  // would be this same bug pointed the other way.
  it("registry EMPTY: names NO destination", async () => {
    loadAccountState.mockResolvedValue(state([]));
    render(<AccountSwitchHost />);
    await settle();

    // Asserted on the nickname the real registry carried, so this fails if the component ever falls
    // back to a remembered or manufactured name.
    expect(document.body.textContent).not.toContain("DROdio Personal");
    expect(document.body.querySelector("strong")).toBeNull();
  });

  it("registry EMPTY: does NOT accuse — an empty read is evidence about the READ, not the account", async () => {
    // The corroboration rule. A wholly-empty registry mid-migration cannot be believed: the plan's
    // SOURCE account is missing from it too, and that account provably exists — it is the one the
    // fleet is migrating off. `read_accounts_at` returns Ok(vec![]) for a missing file, and an
    // intermittent empty read on this exact IPC path is the known defect that put "No accounts yet"
    // on the founder's screen beside an accounts.json holding seven rows. Condemning the
    // destination on that evidence would replace an honest green bar with a false amber one.
    loadAccountState.mockResolvedValue(state([]));
    render(<AccountSwitchHost />);
    await settle();

    expect(screen.queryByText(/could not confirm/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The migration is genuinely under way, so the notice itself stays up.
    expect(screen.getByRole("status").textContent).toContain("26 agents");
  });

  // ── THE SECOND DISJUNCT: a corroborated absence DOES fail visibly ─────────────────────────────
  it("registry shows OTHER accounts but not the destination: fails VISIBLY", async () => {
    // Now the read has told us something about this account specifically: it can see the source and
    // a sibling, and the destination is not there.
    loadAccountState.mockResolvedValue(state([SOURCE, account("acct-other", "DROdio Gmail")]));
    render(<AccountSwitchHost />);
    await settle();

    // (1) NAMES NO DESTINATION.
    expect(document.body.textContent).not.toContain("DROdio Personal");

    // (2) FAILS VISIBLY — three separate claims, none of which a silent blank satisfies. A bar that
    // merely dropped the name would still read as a successful rescue.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("could not confirm the destination account");
    expect(screen.queryByRole("status")).toBeNull();
    // Not painted in the success colour — the property the amber wrap exists for.
    expect(alert.style.background).toBe(rgb(SWITCH_AMBER));
    expect(alert.style.background).not.toBe(rgb(SWITCH_GREEN));
    // The agent count still reports, so the user learns the scale of what is unaccounted for.
    expect(alert.textContent).toContain("26 agents");
  });

  it("registry HAS the destination: green success bar, named — the alarm is not stuck on", async () => {
    // The control. Without it, a component hard-wired to alarm would pass the tests above.
    loadAccountState.mockResolvedValue(state([SOURCE, DESTINATION]));
    render(<AccountSwitchHost />);
    await settle();

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Automatically switching 26 agents");
    expect(status.textContent).toContain("DROdio Personal");
    expect(status.style.background).toBe(rgb(SWITCH_GREEN));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("read FAILED: no name AND no alarm — a broken read is not evidence the account is gone", async () => {
    // `loadAccountState` never rejects; it resolves `{ failed: true }`. Before the fix the host
    // collapsed that to `accounts: []`, which under the new gate would make every transient IPC
    // hiccup scream that the destination had vanished.
    loadAccountState.mockResolvedValue(state([], true));
    render(<AccountSwitchHost />);
    await settle();

    expect(document.body.textContent).not.toContain("DROdio Personal");
    expect(screen.queryByText(/could not confirm/i)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("26 agents");
  });

  it("read NOT YET RESOLVED: no alarm flash on first paint", async () => {
    loadAccountState.mockReturnValue(new Promise(() => {}));
    render(<AccountSwitchHost />);
    await settle();

    expect(screen.queryByText(/could not confirm/i)).toBeNull();
    expect(document.body.textContent).not.toContain("DROdio Personal");
  });

  // ── THE FREEZE ITSELF: the property the whole P0 turns on ─────────────────────────────────────
  it("RE-VALIDATES a live notice: a destination that disappears flips the bar, plan object unchanged", async () => {
    vi.useFakeTimers();
    // Starts corroborated — the state the founder's bar was in when it was first painted.
    loadAccountState.mockResolvedValue(state([SOURCE, DESTINATION]));
    render(<AccountSwitchHost />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("DROdio Personal");

    // The destination leaves the registry, and the read stays self-consistent (the source is still
    // there), so this IS evidence about the destination. NOTHING about the plan changes — same
    // object, same agents, no migration progress — which is why the old effect never looked again.
    listAccounts.mockResolvedValue([SOURCE]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await settle();

    expect(screen.getByRole("alert").textContent).toContain("could not confirm the destination account");
    expect(document.body.textContent).not.toContain("DROdio Personal");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("revalidation pays the CHEAP read only — never the full account load", async () => {
    // `loadAccountState` fans out to `accounts_usage`, the transcript walk documented at 17,316
    // files / 5.7 GB and ~10s on the founder's machine. Its cache TTL (5s) is SHORTER than the tick
    // (10s), so routing revalidation through it would miss the cache every single time and put that
    // walk on a repeating timer — for hours, in exactly the wedged-plan case this fix exists for.
    vi.useFakeTimers();
    loadAccountState.mockResolvedValue(state([SOURCE, DESTINATION]));
    render(<AccountSwitchHost />);
    await settle();
    const fullLoadsAfterMount = loadAccountState.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();

    expect(listAccounts.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(loadAccountState.mock.calls.length).toBe(fullLoadsAfterMount);
  });

  // ── THE CORROBORATION RULE, ENFORCED ON THE WRITE SIDE TOO ───────────────────────────────────
  // The gate below refuses to accuse on an empty read. If the TICK still accepted one, the same
  // unbelievable evidence would get in through the other door — and because accusing requires a
  // non-empty registry, an empty tick would not merely blank the name, it would silently CLEAR a
  // raised alert. These two tests are why the write path checks emptiness as well as the read path.
  it("a transient EMPTY revalidation does not blank a good destination name", async () => {
    vi.useFakeTimers();
    loadAccountState.mockResolvedValue(state([SOURCE, DESTINATION]));
    render(<AccountSwitchHost />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("DROdio Personal");

    listAccounts.mockResolvedValue([]); // the known intermittent empty read
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await settle();

    expect(screen.getByRole("status").textContent).toContain("DROdio Personal");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a transient EMPTY revalidation cannot CLEAR a raised alert back to green", async () => {
    // The dangerous half. The alarm must not switch itself off on the very failure mode that
    // motivates it.
    vi.useFakeTimers();
    loadAccountState.mockResolvedValue(state([SOURCE])); // corroborated absence -> amber
    render(<AccountSwitchHost />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("could not confirm the destination account");

    listAccounts.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();

    expect(screen.getByRole("alert").textContent).toContain("could not confirm the destination account");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // ── THE SAME RULE ON THE OTHER WRITER ────────────────────────────────────────────────────────
  // `accounts` has TWO writers: the tick above and the `loadAccountState` effect. The rule was once
  // applied to the tick alone, which left the identical outcome reachable through the other door —
  // and that door is WIDE OPEN during a real migration, because `advanceSwitch` returns a NEW plan
  // object every time an agent moves, re-running the effect every few seconds. `loadAccountState`
  // does not flag an empty registry as failed either (its `failed` is a SHAPE check, and `[]` is
  // well-shaped), so "not failed" is not "believable". These two tests drive that writer.
  it("an EMPTY read through the LOAD effect cannot clear a raised alert", async () => {
    loadAccountState.mockResolvedValue(state([SOURCE])); // corroborated absence -> amber
    const { rerender } = render(<AccountSwitchHost />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("could not confirm the destination account");

    // An agent moves — a NEW plan object — and this time the registry reads empty.
    loadAccountState.mockResolvedValue(state([]));
    hoisted.plan = planAfterOneMove();
    rerender(<AccountSwitchHost />);
    await settle();

    expect(screen.getByRole("alert").textContent).toContain("could not confirm the destination account");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an EMPTY read through the LOAD effect cannot blank a good destination name", async () => {
    loadAccountState.mockResolvedValue(state([SOURCE, DESTINATION]));
    const { rerender } = render(<AccountSwitchHost />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("DROdio Personal");

    loadAccountState.mockResolvedValue(state([]));
    hoisted.plan = planAfterOneMove();
    rerender(<AccountSwitchHost />);
    await settle();

    expect(screen.getByRole("status").textContent).toContain("DROdio Personal");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops revalidating once the notice is DISMISSED — no timer against a claim nobody can see", async () => {
    vi.useFakeTimers();
    loadAccountState.mockResolvedValue(state([SOURCE, DESTINATION]));
    render(<AccountSwitchHost />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    await settle();
    // The ✕ hides this switch's notice; the component renders nothing.
    expect(screen.queryByRole("status")).toBeNull();

    const callsAtDismiss = listAccounts.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();

    expect(listAccounts.mock.calls.length).toBe(callsAtDismiss);
  });
});
