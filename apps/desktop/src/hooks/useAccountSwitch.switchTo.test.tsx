// @vitest-environment jsdom
//
// The MANUAL switch: `switchTo` / `activateAccount` — the "Activate this account" control.
//
// THE ASSERTION THAT MATTERS is the one at the end of the chain, not the one at the start. That a
// localStorage key was written is a precondition; it would pass with `chooseAccountForAgent` never
// wired up at all, which is exactly how this feature could ship inert. So these tests run the REAL
// `accountStore` and the REAL `accountSelection` over a mocked Tauri bridge and assert that the
// next spawn of a BRAND-NEW agent id resolves to the activated account.
//
// The fixtures are arranged so the activated account is the one auto-pick would NOT choose:
// `acct-b` carries the higher tally, so `acct-a` wins by default and every "b" assertion below is
// evidence that the activation decided it.
//
// The second half is bead sparkle-0t2o, at the new call site. `switchTo` re-pins and re-spawns real
// terminals; React may replay a state updater against the same prior state, so the advance must not
// live inside one. `toHaveBeenCalledTimes` is the only assertion that can see the difference — the
// resulting plan is identical either way, and only the side effects double.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabStatus } from "../types";

const h = vi.hoisted(() => ({
  replayUpdaters: false,
  restart: vi.fn((_agentId: string) => true),
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  paneAccounts: {} as Record<string, string | undefined>,
  // The project ROSTER — every agent that exists, mounted or not. A REGRESSION GUARD rather than a
  // fixture the hook reads: `switchTo` deliberately builds its plan from mounted panes only, so
  // nothing here reaches production code today. If the roster is ever re-added as a second plan
  // source, this mock supplies it and the pin it would write turns the pair below red.
  roster: [] as { agents: { id: string; name: string }[] }[],
}));

// Deterministic stand-in for React's *permitted* double-invocation of a state updater.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (init: unknown) => {
    const [value, set] = actual.useState(init as never);
    const wrapped = (next: unknown) => {
      if (h.replayUpdaters && typeof next === "function") {
        const updater = next as (cur: unknown) => unknown;
        set(((cur: unknown) => {
          updater(cur); // the render that gets discarded
          return updater(cur); // the render that commits
        }) as never);
        return;
      }
      set(next as never);
    };
    return [value, wrapped];
  };
  return { ...actual, useState };
});

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock("../services/paneControl", () => ({
  restartPane: (id: string) => h.restart(id),
  paneAccountMap: () => h.paneAccounts,
  busiestPaneAccount: () => "acct-a",
}));

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

vi.mock("../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projects: h.roster }) },
}));

// No banner in these tests: the manual path is the subject, and a live recommendation would set a
// plan of its own and muddy the restart counts.
vi.mock("../services/headroom", () => ({
  switchRecommendation: () => null,
  // No target goes invalid in this suite, so phase 2's mid-migration re-validation is a no-op.
  isHealthyTarget: () => true,
  bestHealthyTarget: () => null,
}));

const ACCOUNTS = [
  { id: "acct-a", nickname: "A", configDir: "/cfg/a", isDefault: true, createdAt: 1 },
  { id: "acct-b", nickname: "B", configDir: "/cfg/b", isDefault: false, createdAt: 2 },
];

// acct-b is the BUSIER account, so plain auto-pick prefers acct-a.
const USAGE: { id: string; tokens5h: number; tokens7d: number; exhaustedUntil: number | null }[] = [
  { id: "acct-a", tokens5h: 10, tokens7d: 100, exhaustedUntil: null },
  { id: "acct-b", tokens5h: 90, tokens7d: 900, exhaustedUntil: null },
];

/** The usage the mocked bridge reports, so a test can rate-limit an account MID-TEST — the whole
 *  point of the preferred account's gate is what it does once the chosen account runs out. */
let usage = USAGE;

const IDENTITIES = ACCOUNTS.map((a) => ({
  id: a.id,
  email: `${a.id}@example.invalid`,
  organization: null,
  accountUuid: `u-${a.id}`,
}));

// Imported AFTER the mocks so the hook and the resolver pick them up.
const { useAccountSwitch, activateAccount, recordPreference, SWITCH_ADVANCE_MS } = await import(
  "./useAccountSwitch"
);
const { chooseAccountForAgent, invalidateAccountState, resetStickyAccounts } = await import(
  "../services/accountSelection"
);
const { clearAllPins, clearPreferredAccount, getPreferredAccountId } = await import(
  "../services/accountStore"
);
const { setAccountInRotation, rotationOutIds, ROTATION_OUT_STORAGE_KEY } = await import(
  "../services/rotationState"
);
const { setPinFromSwitch, getPin, SWITCH_WRITTEN_PINS_STORAGE_KEY } = await import(
  "../services/accountStore"
);

/** What account would a spawn of `key` land on right now? Uncached, so it reads the live
 *  preference rather than a snapshot taken before the click. */
async function accountFor(key: string) {
  invalidateAccountState();
  const { chosen } = await chooseAccountForAgent(key);
  return chosen?.id;
}

function tick() {
  act(() => {
    vi.advanceTimersByTime(SWITCH_ADVANCE_MS);
  });
}

/** Mount the hook and let its phase-1 tick settle (it resolves nothing here — see the headroom
 *  mock — but it must not be mid-await when the assertions run). */
async function mounted() {
  const view = renderHook(() => useAccountSwitch(60 * 60 * 1000));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.replayUpdaters = false;
  h.restart.mockClear();
  h.paneAccounts = { a1: "acct-a", a2: "acct-a" };
  h.statuses = { a1: "idle", a2: "idle" };
  h.roster = [];
  usage = USAGE;
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
    if (cmd === "accounts_usage") return Promise.resolve(usage);
    if (cmd === "accounts_identities") return Promise.resolve(IDENTITIES);
    if (cmd === "accounts_ceilings") return Promise.resolve([]);
    if (cmd === "accounts_record_spawn") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
  invalidateAccountState();
  resetStickyAccounts();
  clearAllPins();
  clearPreferredAccount();
  localStorage.removeItem(ROTATION_OUT_STORAGE_KEY);
  localStorage.removeItem(SWITCH_WRITTEN_PINS_STORAGE_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("activation versus the rotation opt-out", () => {
  // TWO CONTROLS THAT CAN CONTRADICT EACH OTHER, and the resolution has to happen where the
  // preference is WRITTEN, not only where it is read. `usablePreferredAccount` declines a preference
  // for an account the user took out of rotation — its card says "out of rotation", and routing
  // there would put the dot and the router back in disagreement. But the button that writes the
  // preference gates on a readable email alone, so without this the two deadlock in the worst
  // available way: the control reports success, flips to "Back to automatic", and the effect is
  // PARTIALLY applied — `switchTo` pins already-running panes, pins are deliberately exempt from the
  // opt-out, so existing agents migrate while new spawns do not.
  //
  // Activating is the later and more specific instruction, so it revises the earlier one.
  // ── THE AUTOMATIC ARMS MUST NOT SWEEP PINS ──────────────────────────────────────────────────
  // Routing them through the full activation helper smuggled in `clearSwitchWrittenPins()`, a global
  // sweep across every project and window. That is right for the MANUAL lever, whose ask is
  // fleet-wide by definition — and wrong for an automatic switch, which `planSwitch` scopes to the
  // agents on the walled account precisely because "a third account's agents are fine where they
  // are". The dropped pin does not move that agent now; it moves it at its NEXT spawn, which falls
  // through to the new preference — the relocation the plan declined to make, with no gesture behind
  // it.
  it("recordPreference writes the preference and the rotation membership, and nothing else", () => {
    setPinFromSwitch("agent-elsewhere", "acct-a");
    expect(getPin("agent-elsewhere")).toBe("acct-a");
    setAccountInRotation("acct-b", false);

    recordPreference("acct-b");

    expect(getPreferredAccountId()).toBe("acct-b");
    expect(rotationOutIds().has("acct-b")).toBe(false);
    // The pin of an agent on a THIRD account survives — the automatic arms' whole scope claim.
    expect(getPin("agent-elsewhere")).toBe("acct-a");
  });

  it("the MANUAL lever still sweeps them, because its ask really is fleet-wide", async () => {
    // The paired positive. Without it, "recordPreference leaves pins alone" would pass against a
    // build that had lost the sweep everywhere — and a stale switch-written pin outranks the fleet
    // preference forever, which is the defect `clearSwitchWrittenPins` exists to prevent.
    const view = await mounted();
    setPinFromSwitch("agent-elsewhere", "acct-a");
    act(() => view.result.current.switchTo("acct-b"));
    tick();
    expect(getPin("agent-elsewhere")).toBeUndefined();
  });

  it("puts a taken-out account back IN rotation, so the activation is not silently inert", async () => {
    const view = await mounted();
    setAccountInRotation("acct-b", false);
    // The control: while it is out, a new agent does not land there (and `acct-a` is the auto-pick).
    expect(await accountFor("agent-before")).toBe("acct-a");

    act(() => view.result.current.switchTo("acct-b"));
    tick();
    await act(async () => {
      await Promise.resolve();
    });

    // The end of the chain, not the start: a BRAND-NEW agent actually resolves to the activated
    // account. Asserting only that the opt-out set was cleared would pass with the preference gate
    // never consulted at all.
    expect(await accountFor("agent-after")).toBe("acct-b");
    expect(rotationOutIds().has("acct-b")).toBe(false);
    // …and it revised only THAT account's state. A sweep of the whole set would silently undo every
    // other opt-out the user had made.
    setAccountInRotation("acct-a", false);
    act(() => view.result.current.switchTo("acct-b"));
    tick();
    expect(rotationOutIds().has("acct-a")).toBe(true);
  });
});

describe("switchTo — the manual activation", () => {
  it("makes the next spawn of a NEW agent land on the activated account", async () => {
    const view = await mounted();
    // The control: before activating, a new agent auto-picks the LESS busy account.
    expect(await accountFor("agent-before")).toBe("acct-a");

    act(() => view.result.current.switchTo("acct-b"));

    // THE SIDE EFFECT. Not "a key was written" — an agent that did not exist when the founder
    // clicked now spawns on the account he chose.
    expect(await accountFor("agent-created-after-the-click")).toBe("acct-b");
  });

  it("records the preference even when nothing is running to move", async () => {
    h.paneAccounts = {};
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));

    // No plan is left spinning — phase 2 never retires a plan with no pending agents…
    expect(view.result.current.plan).toBeNull();
    // …and the half that actually governs future spawns still happened.
    expect(await accountFor("agent-1")).toBe("acct-b");
  });

  it("moves every agent that is not already on the target, including one on a third account", async () => {
    // `planSwitch` filters to ONE origin account, which is right for the banner and wrong here: the
    // founder asked for agents to run on this account, so an agent parked on a third one is
    // precisely what he means to move.
    h.paneAccounts = { a1: "acct-a", a2: "acct-c", a3: "acct-b" };
    h.statuses = { a1: "idle", a2: "idle", a3: "idle" };
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    expect(view.result.current.plan?.pending.sort()).toEqual(["a1", "a2"]);

    tick();
    // a3 was already there and is never re-spawned.
    expect(h.restart.mock.calls.map((c) => c[0]).sort()).toEqual(["a1", "a2"]);
  });

  // ── An activation must not PIN what it cannot MOVE ───────────────────────────────────────────
  //
  // The plan is built from mounted panes alone, and enrolling the project roster beside them looked
  // like the obvious improvement — it names the closed-tab and satellite-window agents the pane map
  // cannot see. It is strictly harmful, because a roster-only agent has no pane to re-spawn, so the
  // ONLY effect `moveAgent` has on it is the pin. And a pin is a WORSE answer than the preference
  // the same click already recorded: `chooseAccountForAgent` gates the preference (real, signed in,
  // not exhausted) and falls through to auto-pick, while a pin is honoured before any eligibility
  // test at all. Sixty roster agents pinned by one click keep spawning onto the activated account
  // after it hits its ceiling — where the preference alone would have moved them.

  it("does not strand an UNMOUNTED agent on the primary once that account is exhausted", async () => {
    h.roster = [{ agents: [{ id: "closed-tab", name: "Closed Tab" }] }];
    h.paneAccounts = { a1: "acct-a" }; // `closed-tab` has no pane: nothing to re-spawn
    h.statuses = { a1: "idle" };
    const { getPin } = await import("../services/accountStore");
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    tick();

    // While acct-b is healthy the unmounted agent follows the activation — via the PREFERENCE, so
    // no pin was needed to get it there.
    expect(await accountFor("closed-tab")).toBe("acct-b");
    expect(getPin("closed-tab")).toBeUndefined();

    // acct-b hits its 5h limit. THE SIDE EFFECT: the gate drops the preference and the agent spawns
    // somewhere it can actually run. With a pin it would have spawned onto the exhausted account,
    // and nothing would ever have rescued it — `planSwitch` sees only mounted panes.
    usage = [
      { id: "acct-a", tokens5h: 10, tokens7d: 100, exhaustedUntil: null },
      { id: "acct-b", tokens5h: 90, tokens7d: 900, exhaustedUntil: Date.now() + 3_600_000 },
    ];
    expect(await accountFor("closed-tab")).toBe("acct-a");
  });

  it("…while a MOUNTED agent it did move keeps its pin, exhausted or not", async () => {
    // PAIRED, and the half that makes the assertion above mean something: "no pin was written for
    // the unmounted one" is only evidence if a pin IS written for the ones the plan actually moves.
    // Asserting absence alone would pass with `moveAgent` never pinning anything — i.e. with the
    // migration inert. The banner is what rescues these: they are mounted, so `planSwitch` sees them.
    h.roster = [{ agents: [{ id: "a1", name: "Mounted" }] }];
    h.paneAccounts = { a1: "acct-a" };
    h.statuses = { a1: "idle" };
    const { getPin } = await import("../services/accountStore");
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    tick();

    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a1"]);
    expect(getPin("a1")).toBe("acct-b");

    usage = [
      { id: "acct-a", tokens5h: 10, tokens7d: 100, exhaustedUntil: null },
      { id: "acct-b", tokens5h: 90, tokens7d: 900, exhaustedUntil: Date.now() + 3_600_000 },
    ];
    expect(await accountFor("a1")).toBe("acct-b");
  });

  it("leaves a busy agent alone until it reaches a safe boundary", async () => {
    h.statuses = { a1: "working", a2: "idle" };
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    tick();

    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a2"]);
    expect(view.result.current.plan?.pending).toEqual(["a1"]);

    h.statuses = { a1: "idle", a2: "idle" };
    tick();
    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a2", "a1"]);
    expect(view.result.current.plan).toBeNull();
  });

  // ── An activation must not be defeated by the LAST one ───────────────────────────────────────

  it("clears the pins an earlier activation wrote, so an unmounted agent still follows the new one", async () => {
    // A pin outranks the fleet preference, `moveAgent` writes one for every agent it moves, and
    // only agent CLOSE clears a pin — a pane unmount does not. So without the sweep: activate A
    // (a1 gets pinned to A), a1's pane unmounts, activate B — a1 is no longer in paneAccountMap to
    // be re-pinned and keeps spawning on A forever, against an explicit fleet-wide choice.
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    tick();
    expect(await accountFor("a1")).toBe("acct-b"); // pinned there by the move

    h.paneAccounts = {}; // a1's pane unmounts (tab or project switch — NOT a close)
    act(() => view.result.current.switchTo("acct-a"));

    // THE SIDE EFFECT: a1 follows the new activation even though nothing could re-pin it.
    expect(await accountFor("a1")).toBe("acct-a");
  });

  it("…but leaves every pin a PERSON set alone — the sweep is keyed on provenance", async () => {
    // PAIRED with the sweep above, and the reason it is not a wrecking ball. `AgentPane` exposes a
    // per-agent account picker its own comment calls a "manual override", and a pin beats every
    // judgement selection makes precisely because a human chose it. A sweep of "everything but the
    // sticky consumers" would delete every such override in every project and window on one click
    // — including for a mounted pane the plan does not even move, whose badge would then keep
    // rendering a pin that no longer exists.
    const { setPin, getPin } = await import("../services/accountStore");
    const view = await mounted();
    setPin("sparkle:concierge", "acct-a"); // the modal's sticky control
    setPin("__sparkle_self__", "acct-a");
    setPin("hand-pinned-agent", "acct-a"); // AgentPane's manual override

    act(() => view.result.current.switchTo("acct-b"));

    expect(getPin("sparkle:concierge")).toBe("acct-a");
    expect(getPin("__sparkle_self__")).toBe("acct-a");
    expect(getPin("hand-pinned-agent")).toBe("acct-a");
    // …and each still DECIDES, which is the effect a pin exists for. Asserting only that the key
    // survives would pass with the resolver ignoring pins entirely.
    expect(await accountFor("sparkle:concierge")).toBe("acct-a");
    expect(await accountFor("hand-pinned-agent")).toBe("acct-a");
  });

  it("does not MOVE a hand-pinned agent whose pane is mounted", async () => {
    // Surviving the sweep is not enough: the migration itself would overwrite the pin. The plan is
    // built from paneAccountMap() alone, so a mounted hand-pinned agent was pended, `moveAgent`
    // wrote the fleet's account over the person's choice AND re-marked the pin as machinery's — so
    // the NEXT activation deleted it outright. It also re-spawns an agent whose own picker
    // deliberately leaves running. `chooseAccountForAgent` ranks a pin above the preference because
    // a person chose it; the plan has to agree with the resolver.
    const { setPin, getPin } = await import("../services/accountStore");
    const view = await mounted();
    setPin("a1", "acct-a"); // AgentPane's manual override, on a MOUNTED pane

    act(() => view.result.current.switchTo("acct-b"));
    expect(view.result.current.plan?.pending).toEqual(["a2"]); // a1 is not swept
    tick();

    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a2"]);
    expect(getPin("a1")).toBe("acct-a");
    expect(await accountFor("a1")).toBe("acct-a");
  });

  it("a person overriding a switch-written pin takes ownership of it, so it survives", async () => {
    // The provenance mark has to move with the choice: once someone re-pins an agent the machinery
    // had moved, that pin is theirs. Without the unmark, the very next activation would delete it
    // and the override would appear to "not stick" for reasons nothing on screen could explain.
    const { setPin, getPin } = await import("../services/accountStore");
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b")); // machinery pins a1 → acct-b
    tick();
    setPin("a1", "acct-a"); // …and the user overrides it by hand

    act(() => view.result.current.switchTo("acct-b"));
    expect(getPin("a1")).toBe("acct-a");
    expect(await accountFor("a1")).toBe("acct-a");
  });

  it("does not move Improve Sparkle, whose pane is in the map like any other", async () => {
    // The modal says in so many words that activating an account does not move these two, and the
    // card above the button lists them. Sweeping the pane map verbatim moved Improve Sparkle
    // anyway: it is an ordinary AgentPane whose agent.id IS its sticky key. Worse for the satellite
    // variant — the pin lands on `-win-<uuid>` while the base key is untouched, splitting one
    // worktree's namespace across two accounts.
    const { getPin } = await import("../services/accountStore");
    h.paneAccounts = {
      a1: "acct-a",
      __sparkle_self__: "acct-a",
      "__sparkle_self__-win-6f2c": "acct-a",
    };
    h.statuses = { a1: "idle", __sparkle_self__: "idle", "__sparkle_self__-win-6f2c": "idle" };
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    expect(view.result.current.plan?.pending).toEqual(["a1"]);
    tick();

    // No re-spawn, and — the effect that outlives the plan — no pin written on either key.
    expect(h.restart.mock.calls.map((c) => c[0])).toEqual(["a1"]);
    expect(getPin("__sparkle_self__")).toBeUndefined();
    expect(getPin("__sparkle_self__-win-6f2c")).toBeUndefined();
    // Improve Sparkle keeps resolving for itself rather than being dragged to the activated account.
    expect(await accountFor("__sparkle_self__")).toBe("acct-a");
  });

  it("retires a plan aimed at a DIFFERENT account when the new plan is empty", async () => {
    // Otherwise phase 2 keeps ticking the superseded plan and re-pins each agent to the OLD target
    // as it reaches a safe boundary — writing pins that outrank the preference just set, so the
    // activation is undone by a plan the user already answered.
    h.paneAccounts = { a1: "acct-a" };
    h.statuses = { a1: "working" }; // busy, so it stays pending across the tick
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    expect(view.result.current.plan?.toAccountId).toBe("acct-b");

    // Now activate the account a1 is ALREADY on: the new plan is empty…
    h.paneAccounts = { a1: "acct-a" };
    act(() => view.result.current.switchTo("acct-a"));
    expect(view.result.current.plan).toBeNull();

    // …and the abandoned plan does not move a1 to acct-b when it goes idle.
    h.statuses = { a1: "idle" };
    tick();
    expect(h.restart).not.toHaveBeenCalled();
    expect(await accountFor("a1")).toBe("acct-a");
  });

  // ── sparkle-0t2o at the manual call site ─────────────────────────────────────────────────────
  it("restarts each pane exactly ONCE per tick even when the state update is replayed", async () => {
    h.replayUpdaters = true;
    const view = await mounted();

    act(() => view.result.current.switchTo("acct-b"));
    tick();

    // The bug shape is 4 restarts (a1 and a2 twice each). The plan is identical either way, so
    // only the call COUNT can see it. Do not weaken this to `toHaveBeenCalled`.
    expect(h.restart.mock.calls.map((c) => c[0]).sort()).toEqual(["a1", "a2"]);
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(view.result.current.plan).toBeNull();
  });
});

describe("activateAccount — the modal's lever", () => {
  it("drives the mounted hook, so the migration half runs too", async () => {
    await mounted();

    act(() => {
      expect(activateAccount("acct-b")).toBe(true);
    });
    tick();

    expect(h.restart.mock.calls.map((c) => c[0]).sort()).toEqual(["a1", "a2"]);
    expect(await accountFor("agent-new")).toBe("acct-b");
  });

  // THE CASE THAT ACTUALLY HAPPENS IN A RUNNING APP, and the one a mounted-host check cannot see.
  // `AccountSwitchHost` is mounted unconditionally inside `AuthGate`, so `liveSwitchTo` is set
  // essentially always — which made the old "did a hook answer" return a constant. Here the hook IS
  // mounted and the plan is still empty (every pane is already on the target), so nothing migrates.
  // Reporting `true` here is what tells a human waiting out a rate limit that a fleet is moving
  // when none is.
  it("returns false when the hook IS mounted but the plan enrolls nobody", async () => {
    // Every mounted pane is ALREADY on the target, so `planSwitchToAccount` comes back empty and
    // `switchTo` returns after the durable half. The hook is mounted throughout — that is the point.
    h.paneAccounts = { a1: "acct-b", a2: "acct-b" };
    await mounted();

    act(() => {
      expect(activateAccount("acct-b")).toBe(false);
    });
    tick();

    expect(h.restart).not.toHaveBeenCalled();
    // The durable half still ran — this is "nothing to move", not "nothing happened".
    expect(await accountFor("agent-new")).toBe("acct-b");
  });

  it("sweeps the last activation's pins even with NO hook mounted", async () => {
    // The path with no other remedy: nothing is mounted, so nothing arrives later to correct it. An
    // agent still carrying a pin from the PREVIOUS activation outranks the preference and would
    // keep spawning on the old account forever — the same "an activation defeats the next one"
    // defect the sweep exists to close, left open on the one path that cannot recover.
    const view = await mounted();
    act(() => view.result.current.switchTo("acct-b")); // machinery pins a1, a2 → acct-b
    tick();
    expect(await accountFor("a1")).toBe("acct-b");
    view.unmount();

    expect(activateAccount("acct-a")).toBe(false); // no hook took the migration half…
    // …and the durable half still happened, for an agent no migration can reach.
    expect(await accountFor("a1")).toBe("acct-a");
  });

  it("still records the preference with no hook mounted", async () => {
    const view = await mounted();
    view.unmount();

    // Returns false — nothing migrated — but the half that governs FUTURE spawns must not depend
    // on which components happen to be in the tree.
    expect(activateAccount("acct-b")).toBe(false);
    expect(getPreferredAccountId()).toBe("acct-b");
    expect(h.restart).not.toHaveBeenCalled();
    expect(await accountFor("agent-new")).toBe("acct-b");
  });
});
