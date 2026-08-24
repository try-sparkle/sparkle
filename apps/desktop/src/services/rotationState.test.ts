// The one answer to "is this account in rotation", and the two persisted things that can change it.
//
// WHY THE DERIVATION IS TESTED SEPARATELY FROM THE SCREEN. The founder's complaint about this
// surface was never that a single component rendered wrongly — it was that the screen said one thing
// and the router did another (a green row that could not receive an agent; a count of "6 accounts
// available" over a list explaining that four of them were not). One pure function is what makes the
// dot, the kebab and the header count incapable of disagreeing, so it is the thing worth pinning.
import { describe, it, expect, beforeEach } from "vitest";
import {
  accountRotationState,
  rotationLabel,
  rotationReasonLabel,
  rotationOutIds,
  electRotationPool,
  setAccountInRotation,
  rotationPause,
  isRotationPaused,
  pauseRotation,
  resumeRotation,
  ROTATION_OUT_STORAGE_KEY,
  ROTATION_PAUSED_STORAGE_KEY,
  ROTATION_CHANGED_EVENT,
} from "./rotationState";

const IN = { signedIn: true, loginExpired: false, duplicate: false, manuallyOut: false };

beforeEach(() => {
  localStorage.removeItem(ROTATION_OUT_STORAGE_KEY);
  localStorage.removeItem(ROTATION_PAUSED_STORAGE_KEY);
});

describe("accountRotationState", () => {
  it("a signed-in, unexpired, unique, unexcluded account is IN rotation", () => {
    expect(accountRotationState(IN)).toEqual({ inRotation: true, reason: null, canToggle: true });
    expect(rotationLabel(accountRotationState(IN))).toBe("in rotation");
    expect(rotationReasonLabel(accountRotationState(IN))).toBeNull();
  });

  // ── PRECEDENCE ───────────────────────────────────────────────────────────────────────────────
  // Each of these overlaps the ones below it on purpose. Testing them one at a time in isolation
  // would pass against any ordering at all, and the ordering is the whole content of the function:
  // it decides which single sentence a card with room for one shows a human who has to fix it.

  it("reports NOT SIGNED IN over every other reason, because that is the one to act on", () => {
    const s = accountRotationState({
      signedIn: false,
      loginExpired: true,
      duplicate: true,
      manuallyOut: true,
    });
    expect(s).toEqual({ inRotation: false, reason: "not-signed-in", canToggle: false });
  });

  it("reports LOGIN EXPIRED over duplicate and manual", () => {
    const s = accountRotationState({ ...IN, loginExpired: true, duplicate: true, manuallyOut: true });
    expect(s.reason).toBe("login-expired");
    expect(s.canToggle).toBe(false);
  });

  it("reports DUPLICATE over manual, and refuses the toggle — the founder's explicit ask", () => {
    const s = accountRotationState({ ...IN, duplicate: true, manuallyOut: true });
    expect(s).toEqual({ inRotation: false, reason: "duplicate", canToggle: false });
    expect(rotationReasonLabel(s)).toBe("duplicate");
  });

  it("MANUAL is the only out-of-rotation state the user can reverse from this screen", () => {
    const s = accountRotationState({ ...IN, manuallyOut: true });
    expect(s).toEqual({ inRotation: false, reason: "manual", canToggle: true });
    expect(rotationLabel(s)).toBe("out of rotation");
  });
});

describe("manual opt-outs survive a reload", () => {
  it("round-trips, and is idempotent in both directions", () => {
    expect([...rotationOutIds()]).toEqual([]);

    setAccountInRotation("work", false);
    setAccountInRotation("work", false); // twice — a Set, not a list that grows
    expect([...rotationOutIds()]).toEqual(["work"]);

    setAccountInRotation("cloud", false);
    expect(new Set(rotationOutIds())).toEqual(new Set(["work", "cloud"]));

    setAccountInRotation("work", true);
    expect([...rotationOutIds()]).toEqual(["cloud"]);
    setAccountInRotation("work", true); // removing one that is already in
    expect([...rotationOutIds()]).toEqual(["cloud"]);
  });

  // The direction of the failure matters more than the failure. A corrupt entry read as "everything
  // is out of rotation" would silently demote every account in the pool at once, which is invisible
  // on screen and looks exactly like a routing bug. Read as empty, the worst case is that an account
  // you excluded gets a spawn — and the screen shows you that.
  it("reads a corrupt entry as NOTHING excluded, never as everything excluded", () => {
    localStorage.setItem(ROTATION_OUT_STORAGE_KEY, "{not json");
    expect([...rotationOutIds()]).toEqual([]);

    localStorage.setItem(ROTATION_OUT_STORAGE_KEY, JSON.stringify({ work: true }));
    expect([...rotationOutIds()]).toEqual([]);

    // A partially-corrupt array keeps the entries that ARE ids rather than discarding the lot.
    localStorage.setItem(ROTATION_OUT_STORAGE_KEY, JSON.stringify(["work", 7, null, "", "cloud"]));
    expect(new Set(rotationOutIds())).toEqual(new Set(["work", "cloud"]));
  });
});

describe("the fleet-wide pause", () => {
  it("is off by default, and round-trips with the account it froze onto", () => {
    expect(isRotationPaused()).toBe(false);
    expect(rotationPause()).toBeNull();

    pauseRotation("work", 1234);
    expect(isRotationPaused()).toBe(true);
    expect(rotationPause()).toEqual({ at: 1234, accountId: "work" });

    resumeRotation();
    expect(isRotationPaused()).toBe(false);
    expect(rotationPause()).toBeNull();
  });

  it("can be paused with NOTHING to freeze onto, and says so rather than pretending", () => {
    // Reachable: pausing while no account is usable. The pause is still real — the header must say
    // "paused" — but there is no frozen target, and `accountId: null` is how the router learns to
    // fall through to auto-pick instead of honouring an account that does not exist.
    pauseRotation(null, 99);
    expect(isRotationPaused()).toBe(true);
    expect(rotationPause()).toEqual({ at: 99, accountId: null });
  });

  // The mirror image of the opt-out rule above, and it points the OTHER way on purpose. A pause that
  // silently un-pauses itself is the outcome a user would not forgive: they would come back to a
  // fleet they believe is frozen and find it rotating. "Paused, freezing nothing" is the safe half of
  // the state, so a value that is present but unreadable keeps the pause and drops the target.
  it("keeps the pause when the stored shape is unrecognisable, dropping only the frozen target", () => {
    localStorage.setItem(ROTATION_PAUSED_STORAGE_KEY, "true");
    expect(rotationPause()).toEqual({ at: 0, accountId: null });

    localStorage.setItem(ROTATION_PAUSED_STORAGE_KEY, "{not json");
    // Unparseable is the one case that cannot be distinguished from a stray write, so it reads as
    // "not paused" — see the catch in `rotationPause`. Pinned so a future reader knows which way it
    // falls rather than discovering it from a fleet that kept rotating.
    expect(rotationPause()).toBeNull();

    localStorage.setItem(ROTATION_PAUSED_STORAGE_KEY, JSON.stringify(false));
    expect(rotationPause()).toBeNull();

    localStorage.setItem(ROTATION_PAUSED_STORAGE_KEY, JSON.stringify({ at: "soon", accountId: 7 }));
    expect(rotationPause()).toEqual({ at: 0, accountId: null });
  });
});

describe("ROTATION_CHANGED_EVENT", () => {
  it("dispatches on BOTH pause and resume, so a held pane in the same window learns to re-check", () => {
    // localStorage's own `storage` event does not fire in the window that wrote the key, and the
    // accounts toggle and the build-agent panes share one window — so without this same-window event a
    // pane HELD by the pause would never learn that Restart was clicked. Assert both edges: a resume
    // that stayed silent would strand every held agent forever. This suite runs under node (no DOM), so
    // stub `dispatchEvent` — the production guard short-circuits when it is absent, which is why the
    // pause still works headless.
    const types: string[] = [];
    const g = globalThis as unknown as { dispatchEvent?: (e: Event) => boolean };
    const orig = g.dispatchEvent;
    g.dispatchEvent = (e: Event) => {
      types.push(e.type);
      return true;
    };
    try {
      pauseRotation(null, 1);
      resumeRotation();
    } finally {
      g.dispatchEvent = orig;
    }
    expect(types).toEqual([ROTATION_CHANGED_EVENT, ROTATION_CHANGED_EVENT]);
  });
});

describe("electRotationPool", () => {
  // Declared up here because the precedence case below needs it too.
  const row = (id: string) => ({ id });
  /** A login registered twice as `a` and `aa`; `b` is its own login. */
  const GROUPS = new Map([
    ["a", "shared"],
    ["aa", "shared"],
  ]);

  it("counts a login ONCE, whichever registration represents it", () => {
    const { pool, redundant } = electRotationPool(
      [row("a"), row("aa"), row("b")],
      GROUPS,
      new Set(),
    );
    expect(pool.map((r) => r.id)).toEqual(["a", "b"]);
    expect(redundant.map((r) => r.id)).toEqual(["aa"]);
  });

  // ── THE ORDER-DEPENDENCE THIS EXISTS TO KILL ────────────────────────────────────────────────
  // Filtering the representative after the fact gave two different answers for one fleet: taking
  // `a` out dropped the whole shared login, while taking `aa` out changed nothing — decided purely
  // by which row happened to be listed first. Agents can still reach the login through `aa`, so
  // only the second answer was ever right.
  it("keeps a login whose FIRST registration was taken out, promoting the sibling", () => {
    const { pool, redundant } = electRotationPool(
      [row("a"), row("aa"), row("b")],
      GROUPS,
      new Set(["a"]),
    );
    expect(pool.map((r) => r.id)).toEqual(["aa", "b"]);
    // `aa` is IN the pool now, so it must not also be reported as the redundant one — that is the
    // count-contradicts-the-rows defect inside a single login group. `a` IS redundant: its login is
    // represented in the pool by someone else, which is true whether or not `a` is also excluded.
    expect(redundant.map((r) => r.id)).toEqual(["a"]);
  });

  it("gives the same answer when the OTHER registration is the one taken out", () => {
    // The paired case, and the whole point: one fleet, one answer, whichever row was excluded.
    const { pool } = electRotationPool([row("a"), row("aa"), row("b")], GROUPS, new Set(["aa"]));
    expect(pool.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("drops a login only when EVERY registration of it is excluded", () => {
    const { pool, redundant } = electRotationPool(
      [row("a"), row("aa"), row("b")],
      GROUPS,
      new Set(["a", "aa"]),
    );
    expect(pool.map((r) => r.id)).toEqual(["b"]);
    // With BOTH registrations excluded, nothing in the pool represents that login, so neither row is
    // redundant — each is out for its own reason, and calling one a duplicate would name the wrong
    // one on its card.
    expect(redundant).toEqual([]);
  });

  it("treats an ungrouped row as its own login", () => {
    // `duplicateAccountGroups` only groups on positive evidence, so "no group" means "nothing proved
    // it shares a login" — never "unknown, merge it".
    const { pool } = electRotationPool([row("x"), row("y")], new Map(), new Set());
    expect(pool.map((r) => r.id)).toEqual(["x", "y"]);
  });
});

describe("electRotationPool — redundancy is about the LOGIN, not the exclusion", () => {
  const row = (id: string) => ({ id });
  const GROUPS = new Map([
    ["a", "shared"],
    ["aa", "shared"],
  ]);

  // The three-click path: take `a` out (promoting `aa`), take `aa` out, put `a` back. `aa` is then
  // both a duplicate AND manually out. Reporting only the manual reason gives its card a live "Put
  // in rotation" whose click re-runs the election, hands the login back to `a`, and returns `aa` to
  // "duplicate" — a control that did nothing, which is what the disabled toggle exists to prevent.
  it("reports a row that is BOTH a duplicate and excluded as redundant", () => {
    const { pool, redundant } = electRotationPool(
      [row("a"), row("aa")],
      GROUPS,
      new Set(["aa"]),
    );
    expect(pool.map((r) => r.id)).toEqual(["a"]);
    expect(redundant.map((r) => r.id)).toEqual(["aa"]);
  });
});
