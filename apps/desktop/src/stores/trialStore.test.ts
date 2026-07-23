// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
const start = vi.fn();
const sync = vi.fn();
const consume = vi.fn();
vi.mock("../services/trialApi", () => ({
  TRIAL_LIMIT: 100,
  fetchTrial: () => status(),
  startTrial: () => start(),
  syncTrial: () => sync(),
  consumeTrial: () => consume(),
}));

import { useTrialStore, trialPromptsLeft, trialExhausted } from "./trialStore";

/** A meter reading as Rust returns it. */
const meter = (o: Partial<Parameters<typeof useTrialStore.setState>[0]> & Record<string, unknown>) => ({
  started: true,
  promptsUsed: 0,
  remaining: null,
  cap: null,
  blocked: false,
  serverConfirmed: false,
  ...o,
});

const RESET = {
  started: false,
  promptsUsed: 0,
  remaining: null,
  cap: null,
  blocked: false,
  loading: true,
  error: false,
};

afterEach(() => {
  useTrialStore.setState(RESET);
  vi.clearAllMocks();
});

describe("trialStore — local refresh", () => {
  it("refresh loads the cached mirror (no network) and clears loading", async () => {
    status.mockResolvedValue(meter({ promptsUsed: 5, remaining: 95, cap: 100 }));
    await useTrialStore.getState().refresh();
    const s = useTrialStore.getState();
    expect(s.started).toBe(true);
    expect(s.promptsUsed).toBe(5);
    expect(s.remaining).toBe(95);
    expect(s.loading).toBe(false);
    expect(s.error).toBe(false);
  });

  it("refresh RESOLVES (never hangs) and clears loading when the read throws (corrupt trial.json)", async () => {
    // Rust treats a corrupt trial.json as a HARD error, so fetchTrial rejects. Before the fix,
    // refresh() had no catch → the promise rejected, `loading` stayed true forever, and the gate
    // was pinned on the "Loading…" screen.
    status.mockRejectedValue("parse trial.json: expected value");
    await expect(useTrialStore.getState().refresh()).resolves.toBeUndefined();
    expect(useTrialStore.getState().loading).toBe(false); // no longer stuck
    expect(useTrialStore.getState().started).toBe(false);
    expect(useTrialStore.getState().error).toBe(true);
  });

  it("a failed local read never CLEARS an existing hard block", async () => {
    // A read failure is not the server saying "you're fine" — losing the block here would hand a
    // spent device a fresh workspace just by corrupting a file.
    useTrialStore.setState({ blocked: true });
    status.mockRejectedValue("read trial.json: EIO");
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().blocked).toBe(true);
  });

  it("a later successful refresh clears a prior error", async () => {
    status.mockRejectedValueOnce("boom");
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().error).toBe(true);
    status.mockResolvedValue(meter({ promptsUsed: 2 }));
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().error).toBe(false);
    expect(useTrialStore.getState().started).toBe(true);
  });

  it("start that throws flips error without an unhandled rejection", async () => {
    start.mockRejectedValue("write trial.json tmp: EACCES");
    await expect(useTrialStore.getState().start()).resolves.toBeUndefined();
    expect(useTrialStore.getState().error).toBe(true);
  });
});

describe("trialStore — server reconcile", () => {
  it("syncRemote clamps every number to the server's answer", async () => {
    useTrialStore.setState({ promptsUsed: 3, remaining: 97 });
    sync.mockResolvedValue(meter({ promptsUsed: 40, remaining: 60, cap: 100, serverConfirmed: true }));
    await useTrialStore.getState().syncRemote();
    expect(useTrialStore.getState().promptsUsed).toBe(40);
    expect(useTrialStore.getState().remaining).toBe(60);
  });

  it("a fresh install whose SERVER counter is spent lands blocked before a single send", async () => {
    // The revenue invariant: trial.json was deleted (or never existed after a reinstall), so the
    // local mirror is pristine — and the server still says no.
    status.mockResolvedValue(meter({ started: false, promptsUsed: 0, remaining: null }));
    await useTrialStore.getState().refresh();
    expect(useTrialStore.getState().blocked).toBe(false); // nothing local remembers it…
    sync.mockResolvedValue(
      meter({ started: false, promptsUsed: 100, remaining: 0, cap: 100, blocked: true, serverConfirmed: true }),
    );
    await useTrialStore.getState().syncRemote();
    expect(useTrialStore.getState().blocked).toBe(true); // …the server does.
  });

  it("syncRemote that throws keeps the cached meter rather than downgrading the UI", async () => {
    useTrialStore.setState({ started: true, promptsUsed: 7, remaining: 93, loading: false });
    sync.mockRejectedValue(new Error("ipc gone"));
    await expect(useTrialStore.getState().syncRemote()).resolves.toBeUndefined();
    expect(useTrialStore.getState().remaining).toBe(93);
    expect(useTrialStore.getState().error).toBe(false);
  });
});

describe("trialStore — consume (the hot path)", () => {
  it("a successful debit takes the server's decremented count", async () => {
    consume.mockResolvedValue(meter({ promptsUsed: 6, remaining: 94, cap: 100, serverConfirmed: true }));
    await useTrialStore.getState().consume();
    expect(useTrialStore.getState().promptsUsed).toBe(6);
    expect(useTrialStore.getState().remaining).toBe(94);
    expect(useTrialStore.getState().blocked).toBe(false);
  });

  it("an affirmative 402 flips the hard block", async () => {
    consume.mockResolvedValue(
      meter({ promptsUsed: 100, remaining: 0, cap: 100, blocked: true, serverConfirmed: true }),
    );
    await useTrialStore.getState().consume();
    expect(trialExhausted(useTrialStore.getState())).toBe(true);
  });

  it("offline fails open: the cached count drops, nothing blocks", async () => {
    // Rust already debited the durable cache and reported serverConfirmed:false.
    consume.mockResolvedValue(meter({ promptsUsed: 11, remaining: 89, cap: 100, serverConfirmed: false }));
    await useTrialStore.getState().consume();
    expect(useTrialStore.getState().remaining).toBe(89);
    expect(useTrialStore.getState().blocked).toBe(false);
  });

  it("a failed debit swallows without blocking or raising the entry-gating error flag", async () => {
    // `error` gates the token-less Welcome banner. A best-effort metering call that throws must not
    // become an unhandled rejection, must not flip that flag, and must NEVER hard-block.
    useTrialStore.setState({ error: false });
    consume.mockRejectedValue(new Error("meter call failed"));
    await expect(useTrialStore.getState().consume()).resolves.toBeUndefined();
    expect(useTrialStore.getState().error).toBe(false);
    expect(useTrialStore.getState().blocked).toBe(false);
  });
});

describe("trialPromptsLeft / trialExhausted", () => {
  it("prefers the server's remaining count when it exists", () => {
    expect(trialPromptsLeft({ promptsUsed: 0, remaining: 3, cap: 100 })).toBe(3);
  });
  it("falls back to cap-minus-used before the first server answer", () => {
    expect(trialPromptsLeft({ promptsUsed: 5, remaining: null })).toBe(95);
    expect(trialPromptsLeft({ promptsUsed: 5, remaining: null, cap: 20 })).toBe(15);
  });
  it("floors at 0", () => {
    expect(trialPromptsLeft({ promptsUsed: 101, remaining: null })).toBe(0);
    expect(trialPromptsLeft({ promptsUsed: 0, remaining: -1 })).toBe(0);
  });
  it("exhaustion is the server's verdict, not a count", () => {
    // 0 left with no affirmative server answer (offline drift) must NOT read as exhausted.
    expect(trialExhausted({ blocked: false })).toBe(false);
    expect(trialExhausted({ blocked: true })).toBe(true);
  });
});
