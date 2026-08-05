// @vitest-environment jsdom
//
// The TWO create affordances — "+ Local Agent" and "+ Cloud Agent" — that replaced the single
// "+ New Build Agent" row plus its hidden Local/Cloud radio toggle (founder, 2026-08-04: "Where it
// currently says 'New Build Agent' there should be TWO options: '+ Local Agent' and '+ Cloud
// Agent'").
//
// The load-bearing assertion in this file is that the CLOUD button is ALWAYS RENDERED. Its
// predecessor returned null whenever the server had not advertised the capability, which is the
// exact shape of sparkle-lcx8y: a control that vanishes on scope teaches the founder the feature
// was deleted. Disabled-with-the-real-reason is the contract; absent is a defect. Every test below
// asserts a SIDE EFFECT (the dialog opened, Settings was asked to open, the spawn callback fired)
// rather than the precondition that produced it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/sparkleApi", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, openSignIn: vi.fn(async () => true) };
});

import { NewAgentButtons } from "./NewAgentButtons";
import { openSignIn } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import { useUiStore } from "../stores/uiStore";

/** `/me` as the server returns it. `cloud` = the account has the capability advertised. */
const me = (over: Partial<{ cloud: boolean; entitled: boolean; balanceCents: number }> = {}) => ({
  clerkUserId: "u",
  entitled: over.entitled ?? true,
  balanceCents: over.balanceCents ?? 5000,
  tokenVersion: 1,
  ...(over.cloud ?? true ? { cloudAgentsEnabled: true } : {}),
});

/** The happy path: capability advertised, signed in, paid, Claude auth saved, credits in hand. */
function signedInWithCloud() {
  useAuthStore.setState({ me: me(), tokenPresent: true, loading: false });
  // `loaded: true` is the probe having ALREADY landed. It must be stated, not inherited: `method`
  // is meaningless until `loaded` (cloudAuthStore's own words), and the cold-store case below is
  // an entirely different assertion.
  useCloudAuthStore.setState({ method: "byok", loaded: true });
}

beforeEach(() => {
  useUiStore.setState({ cloudCreateProjectId: null, settingsRequest: null });
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
  useCloudAuthStore.getState().reset();
});
afterEach(cleanup);
beforeEach(() => vi.mocked(openSignIn).mockClear());

/** The project the rows belong to — captured at click time so the singleton dialog creates HERE. */
const PROJECT = "p-left";

const cloudBtn = () => screen.getByTestId("new-cloud-agent") as HTMLButtonElement;
const localBtn = () => screen.getByTestId("new-local-agent") as HTMLButtonElement;

/** Each gate state, and the two things the pair must show for it. `authLoaded` says whether the
 *  server has been asked yet — `method` is meaningless before that (cloudAuthStore's own words). */
const GATE_STATES: Array<{
  name: string;
  seed: () => void;
  cloudDisabled: boolean;
  reason: RegExp | null;
}> = [
  {
    name: "no capability advertised (a local-only account)",
    seed: () => useAuthStore.setState({ me: me({ cloud: false }), tokenPresent: true }),
    cloudDisabled: true,
    reason: /aren't available on your account yet/,
  },
  {
    name: "signed out with a stale capability still in the store",
    seed: () => useAuthStore.setState({ me: me(), tokenPresent: false }),
    cloudDisabled: true,
    reason: /Sign in to run agents in the cloud/,
  },
  {
    // THE REAL SIGNED-OUT SHAPE — a trial user reaches the Workspace with no `/me` at all. Before
    // the gate put `signedIn` first, this read as "Cloud agents aren't available on your account
    // yet": a false claim about an account nobody had looked at, and unactionable, when the fix is
    // one click (knightwatch probe 3).
    name: "signed out for real (no /me at all)",
    seed: () => useAuthStore.setState({ me: null, tokenPresent: false }),
    cloudDisabled: true,
    reason: /Sign in to run agents in the cloud/,
  },
  {
    name: "no credits",
    seed: () => {
      useAuthStore.setState({ me: me({ balanceCents: 0 }), tokenPresent: true });
      useCloudAuthStore.setState({ method: "byok", loaded: true });
    },
    cloudDisabled: true,
    reason: /credits/i,
  },
  {
    name: "no Claude auth, and the probe has LANDED saying so",
    seed: () => {
      useAuthStore.setState({ me: me(), tokenPresent: true });
      useCloudAuthStore.setState({ method: null, loaded: true });
    },
    cloudDisabled: true,
    reason: /Add your Claude authentication/,
  },
  { name: "every precondition met", seed: signedInWithCloud, cloudDisabled: false, reason: null },
];

describe("NewAgentButtons — both options are always offered", () => {
  it.each(GATE_STATES)(
    "renders both rows for $name, with the right availability and reason",
    ({ seed, cloudDisabled, reason }) => {
      seed();
      render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

      // THE ASSERTION THIS FILE EXISTS FOR: the cloud row is present in EVERY state. Its
      // predecessor rendered nothing at all whenever the capability was absent — sparkle-lcx8y,
      // where a control that vanishes on scope reads as a deleted feature.
      expect(cloudBtn().disabled).toBe(cloudDisabled);
      // …and the local row is never collateral damage of a cloud block.
      expect(localBtn().disabled).toBe(false);

      const line = screen.queryByTestId("new-cloud-agent-reason");
      if (reason) expect(line?.textContent ?? "").toMatch(reason);
      // No reason line when nothing is wrong — the row is not permanently noisy.
      else expect(line).toBeNull();
    },
  );
});

describe("NewAgentButtons — what a click DOES", () => {
  it("'+ Local Agent' runs the local spawn and never opens the cloud dialog", () => {
    const onLocalClick = vi.fn();
    signedInWithCloud();
    render(<NewAgentButtons onLocalClick={onLocalClick} projectId={PROJECT} />);

    fireEvent.click(localBtn());

    expect(onLocalClick).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().cloudCreateProjectId).toBeNull();
  });

  it("'+ Cloud Agent' opens the cloud create dialog and never spawns a local agent", () => {
    const onLocalClick = vi.fn();
    signedInWithCloud();
    render(<NewAgentButtons onLocalClick={onLocalClick} projectId={PROJECT} />);

    fireEvent.click(cloudBtn());

    expect(useUiStore.getState().cloudCreateProjectId).toBe(PROJECT);
    expect(onLocalClick).not.toHaveBeenCalled();
  });

  it("a BLOCKED cloud click cannot open the dialog — the billed action stays shut", () => {
    // Paid, signed in, capability on — and the probe LANDED saying no credential is saved.
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: true });
    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    fireEvent.click(cloudBtn());

    expect(useUiStore.getState().cloudCreateProjectId).toBeNull();
  });
});

describe("NewAgentButtons — a COLD auth store is not evidence of missing auth", () => {
  // THE REGRESSION THIS SUITE ORIGINALLY PINNED BACKWARDS (roborev 58255, High).
  //
  // cloudAuthStore is deliberately not persisted, so every launch starts at
  // `{ method: null, loaded: false }`. The dialog was the only thing that ever read the gate, and it
  // probes on open — but this button reads it at APP START. Taken literally, a signed-in, paid,
  // credited user WITH a credential saved server-side would see "+ Cloud Agent" disabled under
  // "Add your Claude authentication", and being disabled, could never open the dialog whose probe
  // would correct it. Once per launch, for exactly the users entitled to the feature.
  it("stays ENABLED on a cold store — 'we have not looked' is not 'there is none'", () => {
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: false });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    expect(cloudBtn().disabled).toBe(false);
    expect(screen.queryByTestId("new-cloud-agent-reason")).toBeNull();
  });

  it("probes the server once so the cold state RESOLVES instead of lingering", async () => {
    const refresh = vi.fn(async () => {
      useCloudAuthStore.setState({ method: "byok", loaded: true, attempted: true, busy: false });
    });
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: false, attempted: false, refresh });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("probes ONCE even when the probe FAILS — the retry loop that shipped for a moment", async () => {
    // THE MOCK MUST MOVE THE STORE THE WAY THE REAL ONE DOES (roborev 58470), and that means an
    // AWAIT BETWEEN THE TWO WRITES. The real `refresh` sets `busy: true`, awaits the GET, then sets
    // `busy: false` — two SEPARATE commits, so `busy` genuinely goes false→true→false and anything
    // depending on it re-runs. Written synchronously, React coalesces them into no net change and
    // the loop never starts: verified by mutation, a synchronous mock passes against the bug.
    //
    // SELF-BOUNDING on purpose. Against the buggy gate this is an unbounded render→effect→setState
    // cycle that starves the event loop, so an unguarded mock HANGS the suite instead of failing it
    // — the worst outcome, since it costs the whole run and yields no signal. Breaking the loop on
    // the second call turns that into a fast, readable assertion failure.
    let calls = 0;
    const refresh = vi.fn(async () => {
      calls += 1;
      if (calls > 1) {
        // Escape hatch: stop the bleeding so the count below is what fails, not the timeout.
        useCloudAuthStore.setState({ busy: false, attempted: true, loaded: true });
        return;
      }
      useCloudAuthStore.setState({ busy: true });
      await Promise.resolve();
      useCloudAuthStore.setState({ busy: false, attempted: true, error: "offline" });
    });
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: false, attempted: false, refresh });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    // A COUNT, not "was called". Gating the effect on `!loaded` with `busy` in its deps hammers
    // GET /claude-auth for the whole session for anyone offline or behind a 5xx.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a failed probe leaves the button USABLE rather than falsely blocked", async () => {
    const refresh = vi.fn(async () => {
      useCloudAuthStore.setState({ busy: false, attempted: true, error: "offline" });
    });
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: false, attempted: false, refresh });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    // We never learned whether auth is saved, so we must not assert it is missing. The dialog and
    // POST /sessions/start remain the definitive checks.
    expect(cloudBtn().disabled).toBe(false);
  });

  it("does NOT probe for a user who cannot have cloud at all (no capability, or signed out)", async () => {
    const refresh = vi.fn(async () => {});
    useAuthStore.setState({ me: me({ cloud: false }), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: false, attempted: false, refresh });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("still blocks on the reasons that need NO probe — those come from persisted /me", () => {
    // Cold auth store AND no credits: the credits block is knowable offline and must survive.
    useAuthStore.setState({ me: me({ balanceCents: 0 }), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: false });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    expect(cloudBtn().disabled).toBe(true);
    expect(screen.getByTestId("new-cloud-agent-reason").textContent).toMatch(/credits/i);
  });

  it("blocks on missing auth ONCE the probe has landed", () => {
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useCloudAuthStore.setState({ method: null, loaded: true });

    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    expect(cloudBtn().disabled).toBe(true);
  });
});

describe("NewAgentButtons — the reason line is a live way OUT, not just copy", () => {
  it("the SIGNED-OUT reason offers sign-in — the gate's other kind of self-serve fix", () => {
    // `signed_out` carries `needsSignIn: true` and NO deepLink (gating.ts), so a reason line that
    // handled only `deepLink` left the most common blocked state as inert copy beside a disabled
    // button — a complete dead end (roborev 58255, Medium).
    useAuthStore.setState({ me: me(), tokenPresent: false });
    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    fireEvent.click(screen.getByTestId("new-cloud-agent-reason"));

    expect(openSignIn).toHaveBeenCalled();
  });

  it("a block with no self-serve fix does not pretend to be actionable", () => {
    // feature_disabled carries no deepLink — clicking must not open a Settings section.
    useAuthStore.setState({ me: me({ cloud: false }), tokenPresent: true });
    render(<NewAgentButtons onLocalClick={() => {}} projectId={PROJECT} />);

    fireEvent.click(screen.getByTestId("new-cloud-agent-reason"));

    expect(useUiStore.getState().settingsRequest).toBeNull();
    expect(openSignIn).not.toHaveBeenCalled();
  });
});

describe("the cloud dialog is targeted at the project that was CLICKED", () => {
  // A boolean could only say "something is open", so the singleton dialog fell back to whatever
  // project was in front. With two columns those differ: clicking "+ Cloud Agent" in the LEFT pair
  // opened a dialog that would create in the RIGHT one, and switching the right tab while it was
  // open silently retargeted it — a billed action landing in a repo the user did not choose
  // (knightwatch probe). The id is captured at click time instead.
  it("stores the CLICKED project's id, not merely 'open'", () => {
    signedInWithCloud();
    render(<NewAgentButtons onLocalClick={() => {}} projectId="p-left" />);

    fireEvent.click(cloudBtn());

    expect(useUiStore.getState().cloudCreateProjectId).toBe("p-left");
  });

  it("two columns capture their OWN project — the second click retargets to ITS project", () => {
    signedInWithCloud();
    const left = render(<NewAgentButtons onLocalClick={() => {}} projectId="p-left" />);
    fireEvent.click(cloudBtn());
    expect(useUiStore.getState().cloudCreateProjectId).toBe("p-left");
    left.unmount();

    render(<NewAgentButtons onLocalClick={() => {}} projectId="p-right" />);
    fireEvent.click(cloudBtn());

    expect(useUiStore.getState().cloudCreateProjectId).toBe("p-right");
  });

  it("cannot open a billed dialog with no project to create in", () => {
    signedInWithCloud();
    render(<NewAgentButtons onLocalClick={() => {}} projectId={null} />);

    expect(cloudBtn().disabled).toBe(true);
    fireEvent.click(cloudBtn());
    expect(useUiStore.getState().cloudCreateProjectId).toBeNull();
  });
});
