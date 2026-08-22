// @vitest-environment jsdom
//
// The credential row for one publish destination (bead `sparkle-131ms.3`).
//
// NONE OF THESE CAN PASS AGAINST THE CODE AS IT STOOD, because as it stood no line of the webview
// called `publish_token_set` / `_clear` / `_source` at all — the four commands were registered,
// tested host-side, and unreachable. So every assertion below is on an OUTCOME the user or the host
// can observe: the command that was invoked, the ARGUMENT KEYS it carried, the ORDER of the calls
// (a mutation is worthless if the row never re-reads the state it just changed), and the words that
// end up on screen as a result.
//
// `invoke` is mocked rather than the service module, deliberately: that is the production seam, so
// these tests also pin the row's composition with `publishCredential.ts` rather than a stand-in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  PUBLISH_TOKEN_CLEAR_TESTID,
  PUBLISH_TOKEN_ERROR_TESTID,
  PUBLISH_TOKEN_INPUT_TESTID,
  PUBLISH_TOKEN_RECHECK_TESTID,
  PUBLISH_TOKEN_REPLACE_TESTID,
  PUBLISH_TOKEN_SAVE_TESTID,
  PUBLISH_TOKEN_STATUS_TESTID,
  PublishTokenRow,
} from "./PublishTokenRow";
import type { TokenSource } from "../services/publishCredential";

const DESTINATION = "drodio";
/** The variable `env_var_name("drodio")` derives host-side. Written out rather than derived, so a
 *  bug in the derivation cannot make the assertion agree with it. */
const ENV_VAR = "SPARKLE_PUBLISH_TOKEN_DRODIO";
const PASTED = "sk-live-never-render-me";

/** Either an answer the host gives or a message it rejects with — kept explicit, because a
 *  `TokenSource` and an error string are both strings and conflating them is how a test ends up
 *  asserting the wrong branch. */
type Answer<T> = { ok: T } | { err: string };

/**
 * Stand in for the host. `sources` is consumed one per `publish_token_source` call, with the LAST
 * entry repeating — so a test can say "keychain on mount, environment after the clear" and have the
 * row's own extra re-read land on a stable answer.
 */
function host(opts: {
  sources: Answer<TokenSource>[];
  onSet?: Answer<void>;
  onClear?: Answer<TokenSource>;
}) {
  const sources = [...opts.sources];
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "publish_token_source": {
        const next = sources.length > 1 ? sources.shift()! : sources[0]!;
        return "ok" in next ? Promise.resolve(next.ok) : Promise.reject(next.err);
      }
      case "publish_token_set": {
        const r = opts.onSet ?? { ok: undefined };
        return "ok" in r ? Promise.resolve(undefined) : Promise.reject(r.err);
      }
      case "publish_token_clear": {
        const r = opts.onClear ?? { ok: "none" as TokenSource };
        return "ok" in r ? Promise.resolve(r.ok) : Promise.reject(r.err);
      }
      default:
        return Promise.reject(`unexpected command ${cmd}`);
    }
  });
}

/** Mount and let the on-mount source lookup settle. */
async function mount() {
  await act(async () => {
    render(<PublishTokenRow destinationId={DESTINATION} />);
  });
}

async function click(testId: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

async function type(value: string) {
  await act(async () => {
    fireEvent.change(screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID), { target: { value } });
  });
}

const status = () => screen.getByTestId(PUBLISH_TOKEN_STATUS_TESTID).textContent ?? "";
/** The commands invoked, in order. The ORDER is the point: a set that is never followed by a
 *  re-read is a row rendering its own optimism. */
const commands = () => invoke.mock.calls.map((c) => String(c[0]));
/** Every live input VALUE in the document. React writes a controlled value to the DOM property and
 *  not to an attribute, so an innerHTML scan alone cannot see a token still sitting in the field. */
const liveInputValues = () =>
  Array.from(document.querySelectorAll("input")).map((el) => el.value);

beforeEach(() => {
  invoke.mockReset();
});

describe("the three sources render distinctly", () => {
  it("reads the source on mount with the destinationId key Tauri matches on", async () => {
    host({ sources: [{ ok: "none" }] });

    await mount();

    expect(invoke).toHaveBeenCalledWith("publish_token_source", { destinationId: DESTINATION });
  });

  it("keychain: says it is stored, and offers both Replace and Clear", async () => {
    host({ sources: [{ ok: "keychain" }] });

    await mount();

    expect(status()).toMatch(/keychain/i);
    expect(screen.getByTestId(PUBLISH_TOKEN_REPLACE_TESTID)).toBeTruthy();
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID)).toBeTruthy();
    // Nothing to paste until Replace is pressed, so no field is standing open over a stored token.
    expect(screen.queryByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeNull();
  });

  it("none: offers a password field and a Save, and no Clear", async () => {
    host({ sources: [{ ok: "none" }] });

    await mount();

    const field = screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID);
    expect(field.getAttribute("type")).toBe("password");
    expect(screen.getByTestId(PUBLISH_TOKEN_SAVE_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(PUBLISH_TOKEN_CLEAR_TESTID)).toBeNull();
  });

  it("environment: NAMES the variable, says Sparkle can't clear it, and disables Clear", async () => {
    host({ sources: [{ ok: "environment" }] });

    await mount();

    expect(status()).toContain(ENV_VAR);
    expect(status()).toMatch(/can’t clear it/i);
    // The reason is ON SCREEN, and the control cannot be used to attempt what Sparkle cannot do.
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).hasAttribute("disabled")).toBe(true);
  });

  /** A user who pastes a token over an env-var destination and sees no change has no explanation
   *  unless the row states the precedence. The env var is a FALLBACK, never an override. */
  it("environment: explains that saving a token here takes precedence, and still offers the field", async () => {
    host({ sources: [{ ok: "environment" }] });

    await mount();

    expect(status()).toMatch(/takes precedence/i);
    expect(screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeTruthy();
  });
});

describe("saving a token", () => {
  it("invokes publish_token_set with the trimmed value, THEN re-reads the source", async () => {
    host({ sources: [{ ok: "none" }, { ok: "keychain" }] });
    await mount();

    await type(`  ${PASTED}  `);
    await click(PUBLISH_TOKEN_SAVE_TESTID);

    expect(invoke).toHaveBeenCalledWith("publish_token_set", {
      destinationId: DESTINATION,
      token: PASTED,
    });
    // The whole ordering, not just "a source call happened": the re-read must come AFTER the write,
    // or the row is rendering the state it had before its own mutation.
    expect(commands()).toEqual([
      "publish_token_source",
      "publish_token_set",
      "publish_token_source",
    ]);
  });

  it("re-renders from the host's new answer, not from the assumption that the write worked", async () => {
    host({ sources: [{ ok: "none" }, { ok: "keychain" }] });
    await mount();
    expect(status()).toMatch(/no token is stored/i);

    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID);

    // The state CHANGED, and changed to what the host said — the keychain row, with its Clear.
    expect(status()).toMatch(/keychain/i);
    expect(status()).not.toMatch(/no token is stored/i);
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID)).toBeTruthy();
  });

  /** The field is WRITE-ONLY. Re-opening Replace after a successful save must show an empty field:
   *  a row that kept the previous paste is holding a live credential in the DOM for no reason. */
  it("never renders the pasted value back, and re-opening the field shows it empty", async () => {
    host({ sources: [{ ok: "keychain" }] });
    await mount();

    await click(PUBLISH_TOKEN_REPLACE_TESTID);
    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID);

    // Re-open the field over the same stored token.
    await click(PUBLISH_TOKEN_REPLACE_TESTID);

    expect(screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeTruthy();
    expect(liveInputValues()).toEqual([""]);
    // …and it is nowhere in the markup either — not in a title, a placeholder or an aria attribute.
    expect(document.body.innerHTML).not.toContain(PASTED);
  });

  it("shows the host's rejection and leaves the field and the button reachable to retry", async () => {
    host({ sources: [{ ok: "none" }], onSet: { err: "a token cannot contain a newline" } });
    await mount();

    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID);

    expect(screen.getByTestId(PUBLISH_TOKEN_ERROR_TESTID).textContent).toContain(
      "a token cannot contain a newline",
    );
    // The paste survives a failed save — the user corrects it rather than retyping it.
    expect(liveInputValues()).toEqual([PASTED]);
    expect(screen.getByTestId(PUBLISH_TOKEN_SAVE_TESTID).hasAttribute("disabled")).toBe(false);
  });
});

describe("clearing a token", () => {
  /** THE CASE THAT ACTUALLY BITES. The keychain item is gone and the destination is STILL
   *  CREDENTIALED, because a variable supplies the token and Sparkle cannot unset it. A row that
   *  reports a disconnection here costs somebody a debugging session wondering why a credential
   *  they just revoked keeps publishing. */
  it("does NOT claim the credential is gone when the environment still supplies one", async () => {
    // `sources` deliberately keeps answering "keychain" — the pre-clear reading. So this also pins
    // WHICH answer the row renders: the clear's own return value, not a staler source lookup. A row
    // that threw the return value away and re-read would show the keychain row here and fail.
    host({ sources: [{ ok: "keychain" }], onClear: { ok: "environment" } });
    await mount();

    await click(PUBLISH_TOKEN_CLEAR_TESTID);

    expect(status()).toContain(ENV_VAR);
    expect(status()).toMatch(/can’t clear it/i);
    expect(status()).not.toMatch(/no token is stored/i);
    expect(commands()).toEqual(["publish_token_source", "publish_token_clear"]);
  });

  /** The pair for the test above: the SAME gesture on a machine with no variable really does
   *  disconnect. Without this, "still credentialed" could be a constant rather than an answer. */
  it("does report the destination as uncredentialled when nothing survives the clear", async () => {
    host({ sources: [{ ok: "keychain" }], onClear: { ok: "none" } });
    await mount();

    await click(PUBLISH_TOKEN_CLEAR_TESTID);

    expect(status()).toMatch(/no token is stored/i);
    // Not `not.toContain(ENV_VAR)`: this state names the variable too, on purpose — "and no
    // <VAR> is set" is how the user learns the other route exists. What must NOT appear is the
    // environment state's claim that a variable is currently supplying the credential.
    expect(status()).not.toMatch(/can’t clear it/i);
    expect(screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeTruthy();
  });

  it("invokes publish_token_clear with the destinationId key", async () => {
    host({ sources: [{ ok: "keychain" }], onClear: { ok: "none" } });
    await mount();

    await click(PUBLISH_TOKEN_CLEAR_TESTID);

    expect(invoke).toHaveBeenCalledWith("publish_token_clear", { destinationId: DESTINATION });
  });

  it("shows the host's rejection and keeps the stored-token state it read before", async () => {
    host({ sources: [{ ok: "keychain" }], onClear: { err: "the keychain is locked" } });
    await mount();

    await click(PUBLISH_TOKEN_CLEAR_TESTID);

    expect(screen.getByTestId(PUBLISH_TOKEN_ERROR_TESTID).textContent).toContain(
      "the keychain is locked",
    );
    expect(status()).toMatch(/keychain/i);
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).hasAttribute("disabled")).toBe(false);
  });
});

describe("the could-not-run state is not the no-token state", () => {
  it("says the CHECK failed, and does not assert that no token is configured", async () => {
    host({ sources: [{ err: "the keychain is locked" }] });

    await mount();

    expect(status()).toMatch(/couldn’t check/i);
    expect(status()).toContain("the keychain is locked");
    // The distinction this row exists to draw: a failed lookup is not an answer about the token.
    expect(status()).not.toMatch(/no token is stored/i);
    // …and it offers no paste field, because the right remedy is unknown until the check runs.
    expect(screen.queryByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeNull();
  });

  it("leaves a retry that recovers into the real answer", async () => {
    host({ sources: [{ err: "the keychain is locked" }, { ok: "keychain" }] });
    await mount();

    await click(PUBLISH_TOKEN_RECHECK_TESTID);

    expect(status()).toMatch(/keychain/i);
    expect(status()).not.toMatch(/couldn’t check/i);
    expect(screen.queryByTestId(PUBLISH_TOKEN_RECHECK_TESTID)).toBeNull();
  });
});

// ── THE DESTINATION CHANGING UNDER THE ROW (roborev 67321) ─────────────────────────────────────
// A parent rendering `[publish.destinations]` as a list reconciles by POSITION, so the same element
// is handed a new `destinationId` rather than being remounted. Everything the row holds is
// per-destination, so none of it may survive that.

function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    settle = res;
  });
  return { promise, settle };
}

describe("when the destinationId prop changes", () => {
  /** THE LEAK. Without the reset, the pasted secret survives the swap and the next Save writes one
   *  host's bearer into ANOTHER host's keychain slot — the cross-destination class
   *  `publish_credential.rs` removed the generic env var to close. */
  it("drops the pasted token, so it cannot be saved against the new destination", async () => {
    host({ sources: [{ ok: "keychain" }] });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<PublishTokenRow destinationId="drodio" />);
    });

    await click(PUBLISH_TOKEN_REPLACE_TESTID);
    await type(PASTED);

    await act(async () => {
      view.rerender(<PublishTokenRow destinationId="linkedin" />);
    });

    expect(invoke).toHaveBeenCalledWith("publish_token_source", { destinationId: "linkedin" });
    // The field is closed and the secret is gone from the tree entirely.
    expect(screen.queryByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeNull();
    expect(document.body.innerHTML).not.toContain(PASTED);
    // …and re-opening it over the NEW destination starts empty.
    await click(PUBLISH_TOKEN_REPLACE_TESTID);
    expect(liveInputValues()).toEqual([""]);

    // THE ASSERTION THAT COVERS THE ACTUAL DAMAGE, and the one this test's title promises
    // ("so it cannot be SAVED against the new destination"). Everything above is about the DOM, and
    // a row that emptied the visible field while retaining the old value — in a ref, or through a
    // stale closure — satisfies every one of them and still writes host A's bearer into host B's
    // keychain slot. Only driving a save after the swap and reading the ARGUMENT PAIR can tell
    // those two apart (roborev 67341, Medium: this assertion existed on the other side of the merge
    // and was lost when the worker's test file was taken wholesale).
    await type("second-token");
    await click(PUBLISH_TOKEN_SAVE_TESTID);
    const set = invoke.mock.calls.find((c) => c[0] === "publish_token_set");
    expect(set?.[1]).toEqual({ destinationId: "linkedin", token: "second-token" });
  });

  /** THE STALE ANSWER. The lookup for the old destination is still in flight when the prop flips;
   *  if it is allowed to land it wins by arriving last, and the row renders the OLD destination's
   *  source beside the NEW destination's variable name. */
  it("ignores an in-flight lookup that resolves after the destination moved on", async () => {
    const first = deferred<TokenSource>();
    const second = deferred<TokenSource>();
    invoke.mockImplementation((cmd: string, args: { destinationId: string }) => {
      if (cmd !== "publish_token_source") return Promise.reject(`unexpected ${cmd}`);
      return args.destinationId === "drodio" ? first.promise : second.promise;
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<PublishTokenRow destinationId="drodio" />);
    });
    await act(async () => {
      view.rerender(<PublishTokenRow destinationId="linkedin" />);
    });

    // The NEW destination answers first, then the OLD one lands late with a different answer.
    await act(async () => {
      second.settle("environment");
      first.settle("keychain");
      await Promise.resolve();
    });

    expect(status()).toContain("SPARKLE_PUBLISH_TOKEN_LINKEDIN");
    // The late answer belonged to another destination and must not be rendered as this one's.
    expect(status()).not.toMatch(/stored for this destination in this Mac’s keychain/i);
  });
});

describe("the two controls report their own action, not each other's", () => {
  /** `busy` used to be one boolean driving both labels, so saving a token announced "Clearing…" on
   *  the Clear button — a user-facing claim that a credential DELETION was under way when only a
   *  write was. */
  it("a save in flight does not tell the user a clear is happening", async () => {
    const write = deferred<void>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "publish_token_source") return Promise.resolve("keychain" as TokenSource);
      if (cmd === "publish_token_set") return write.promise;
      return Promise.reject(`unexpected ${cmd}`);
    });
    await mount();

    await click(PUBLISH_TOKEN_REPLACE_TESTID);
    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID);

    expect(screen.getByTestId(PUBLISH_TOKEN_SAVE_TESTID).textContent).toBe("Saving…");
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).textContent).toBe("Clear");
    // Both stay disabled for either action — this is about the WORDS, not about reachability.
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      write.settle(undefined);
      await Promise.resolve();
    });
  });

  /** The inverse, and it needs Replace OPEN so that BOTH controls are on screen at once — with the
   *  field closed the Save button does not exist, and an assertion about its label would be about a
   *  node that is never rendered while a clear runs. */
  it("a clear in flight does not tell the user a save is happening", async () => {
    const erase = deferred<TokenSource>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "publish_token_source") return Promise.resolve("keychain" as TokenSource);
      if (cmd === "publish_token_clear") return erase.promise;
      return Promise.reject(`unexpected ${cmd}`);
    });
    await mount();

    await click(PUBLISH_TOKEN_REPLACE_TESTID);
    await type(PASTED);
    await click(PUBLISH_TOKEN_CLEAR_TESTID);

    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).textContent).toBe("Clearing…");
    expect(screen.getByTestId(PUBLISH_TOKEN_SAVE_TESTID).textContent).toBe("Save");

    await act(async () => {
      erase.settle("none");
      await Promise.resolve();
    });
  });

  /** A save that resolves AFTER the destination moved on must not act on the row at all. The
   *  visible cost of letting it through is a second credential lookup fired at the destination the
   *  row has already abandoned. */
  it("a save that lands after the destination changed does not re-probe the old one", async () => {
    const write = deferred<void>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "publish_token_source") return Promise.resolve("none" as TokenSource);
      if (cmd === "publish_token_set") return write.promise;
      return Promise.reject(`unexpected ${cmd}`);
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<PublishTokenRow destinationId="drodio" />);
    });
    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID);

    await act(async () => {
      view.rerender(<PublishTokenRow destinationId="linkedin" />);
    });
    await act(async () => {
      write.settle(undefined);
      await Promise.resolve();
    });

    const probesOfOldDestination = invoke.mock.calls.filter(
      (c) => c[0] === "publish_token_source" && c[1]?.destinationId === "drodio",
    );
    expect(probesOfOldDestination).toHaveLength(1); // the mount's, and nothing after the swap
  });
});

// ── AN IN-FLIGHT ACTION MUST NOT CROSS THE DESTINATION BOUNDARY EITHER (roborev 67332) ─────────
// `pending` is as per-destination as the token is. Left standing across a swap it disables the new
// destination's field and paints the previous destination's action onto its buttons.

describe("an action still in flight when the destination changes", () => {
  it("does not paint the old destination's action onto the new one", async () => {
    const erase = deferred<TokenSource>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "publish_token_source") return Promise.resolve("keychain" as TokenSource);
      if (cmd === "publish_token_clear") return erase.promise;
      return Promise.reject(`unexpected ${cmd}`);
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<PublishTokenRow destinationId="drodio" />);
    });
    await click(PUBLISH_TOKEN_CLEAR_TESTID);
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).textContent).toBe("Clearing…");

    // The row is handed a different destination while drodio's clear is still in flight.
    await act(async () => {
      view.rerender(<PublishTokenRow destinationId="linkedin" />);
    });

    // Nothing is being cleared for linkedin, and its field must be usable — not disabled behind an
    // unrelated write that may never resolve.
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).textContent).toBe("Clear");
    await click(PUBLISH_TOKEN_REPLACE_TESTID);
    expect(screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID).hasAttribute("disabled")).toBe(false);

    // …and when the abandoned clear finally lands it must not narrate itself onto this row.
    await act(async () => {
      erase.settle("environment");
      await Promise.resolve();
    });
    expect(status()).toMatch(/keychain/i);
    expect(status()).not.toContain("SPARKLE_PUBLISH_TOKEN_DRODIO");
  });

  /** The symmetric half: an abandoned operation must not clear a SUCCESSOR's label. Without the
   *  epoch check in `finally`, A's clear resolving wipes B's "Saving…" and re-enables its controls
   *  while B's write is still in flight. */
  it("does not clear a successor's in-flight label when it finally lands", async () => {
    const erase = deferred<TokenSource>();
    const write = deferred<void>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "publish_token_source") return Promise.resolve("none" as TokenSource);
      if (cmd === "publish_token_clear") return erase.promise;
      if (cmd === "publish_token_set") return write.promise;
      return Promise.reject(`unexpected ${cmd}`);
    });

    // Start a clear on drodio. Its source is "none", so drive the clear through a keychain read
    // first by mounting with keychain, then switching the answer.
    let view!: ReturnType<typeof render>;
    invoke.mockImplementationOnce(() => Promise.resolve("keychain" as TokenSource));
    await act(async () => {
      view = render(<PublishTokenRow destinationId="drodio" />);
    });
    await click(PUBLISH_TOKEN_CLEAR_TESTID);

    // Swap to linkedin (source "none" -> a field), and start a SAVE there.
    await act(async () => {
      view.rerender(<PublishTokenRow destinationId="linkedin" />);
    });
    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID);
    expect(screen.getByTestId(PUBLISH_TOKEN_SAVE_TESTID).textContent).toBe("Saving…");

    // Now drodio's abandoned clear lands. linkedin's save is still in flight and must stay so.
    await act(async () => {
      erase.settle("none");
      await Promise.resolve();
    });

    expect(screen.getByTestId(PUBLISH_TOKEN_SAVE_TESTID).textContent).toBe("Saving…");
    expect(screen.getByTestId(PUBLISH_TOKEN_INPUT_TESTID).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      write.settle(undefined);
      await Promise.resolve();
    });
  });

  /** The mirror image, which pins the guard in `save`'s `finally` specifically: an abandoned SAVE
   *  landing must not wipe a successor's "Clearing…". Written separately because each `finally`
   *  carries its own guard and one test can only ever exercise one of them. */
  it("an abandoned save does not clear a successor's Clearing… label", async () => {
    const write = deferred<void>();
    const erase = deferred<TokenSource>();
    invoke.mockImplementation((cmd: string, args: { destinationId: string }) => {
      if (cmd === "publish_token_source")
        return Promise.resolve((args.destinationId === "drodio" ? "none" : "keychain") as TokenSource);
      if (cmd === "publish_token_set") return write.promise;
      if (cmd === "publish_token_clear") return erase.promise;
      return Promise.reject(`unexpected ${cmd}`);
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<PublishTokenRow destinationId="drodio" />);
    });
    await type(PASTED);
    await click(PUBLISH_TOKEN_SAVE_TESTID); // drodio's save, left in flight

    await act(async () => {
      view.rerender(<PublishTokenRow destinationId="linkedin" />);
    });
    await click(PUBLISH_TOKEN_CLEAR_TESTID); // linkedin's clear, also in flight
    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).textContent).toBe("Clearing…");

    await act(async () => {
      write.settle(undefined);
      await Promise.resolve();
    });

    expect(screen.getByTestId(PUBLISH_TOKEN_CLEAR_TESTID).textContent).toBe("Clearing…");

    await act(async () => {
      erase.settle("none");
      await Promise.resolve();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `readSeq` — ORDERING WITHIN ONE DESTINATION (roborev 67360 / 67366, Medium).
//
// The counter split is `epoch` (destination changes) + `readSeq` (lookup order within one
// destination). Only the first half was covered: every out-of-order case in this file crosses a
// destination boundary, where `epoch` alone already drops the loser. So mutating the
// `readSeq.current === mySeq` conjunct away left the whole file green, and the property that was
// the stated reason for preferring this design over a bare destination check was unfalsifiable —
// one "two counters is over-engineering" edit from being silently collapsed.
//
// The overlap is REACHABLE, not theoretical: "Check again" is `disabled={busy}`, and a bare lookup
// never sets `pending`, so the button stays live while its own lookup is outstanding.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("two lookups for the SAME destination cannot land out of order", () => {
  it("renders the NEWER answer when an older re-check resolves last", async () => {
    // ONE DEFERRED PER CALL, never an ordinal tail-case. Distinguishing the two racing reads by
    // "call === 2 → first, anything later → second" holds only while exactly one lookup precedes
    // the clicks: add a retry, a second effect pass, or StrictMode and BOTH clicks receive the same
    // promise, so settling it hands both reads the identical value and dropping the `readSeq`
    // conjunct changes nothing — the suite goes green and the collapse this test exists to catch is
    // silently restored (roborev 67384, Medium).
    const answers: Array<ReturnType<typeof deferred<TokenSource>>> = [];
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== "publish_token_source") return Promise.reject(`unexpected ${cmd}`);
      // The mount lookup fails, putting the row in its could-not-run state with a "Check again".
      // Its message deliberately does NOT contain "keychain": the success copy does, and an error
      // string sharing that word would let the two states satisfy one regex — which is exactly how
      // the first version of this test could pass with "Check again" completely dead.
      if (answers.length === 0) {
        answers.push(deferred<TokenSource>());
        return Promise.reject("the item could not be read");
      }
      const d = deferred<TokenSource>();
      answers.push(d);
      return d.promise;
    });

    await mount();
    // Two re-checks, both for THIS destination, both outstanding at once.
    await act(async () => {
      fireEvent.click(screen.getByTestId(PUBLISH_TOKEN_RECHECK_TESTID));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(PUBLISH_TOKEN_RECHECK_TESTID));
    });

    // The mount plus exactly two re-checks. If this is not 3, the two clicks did not produce two
    // DISTINCT outstanding reads and the race below is not the race being described.
    expect(answers.length).toBe(3);

    // Settle NEWEST first, then let the stale one land last — the losing interleaving.
    await act(async () => {
      answers[2]!.settle("keychain");
      await answers[2]!.promise;
    });
    await act(async () => {
      answers[1]!.settle("none");
      await answers[1]!.promise;
    });

    // `epoch` never changes here (same destination), so ONLY `readSeq` can reject the older reply.
    // Assert the POSITIVE outcome, not merely the absence of the loser: a row that discarded BOTH
    // answers sits in could-not-run, which the previous phrasing also accepted.
    expect(status()).toMatch(/stored for this destination in this Mac’s keychain/i);
    expect(status()).not.toMatch(/couldn’t check/i);
    // …and the stale "none" did not win, which would have offered a paste field.
    expect(screen.queryByTestId(PUBLISH_TOKEN_INPUT_TESTID)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OTHER ARM OF THE STALENESS GUARD (roborev 67371, Medium).
//
// `readSource` guards both its resolve and its catch, and only the resolve arm was pinned: every
// rejection in this file is a first/only lookup or a _set/_clear failure, and both out-of-order
// tests settle with `resolve`. Deleting the guard from the catch left the suite green.
//
// The scenario lands in the component's WORST state — could-not-run painted over a
// ran-and-said-yes, which is the exact distinction the module doc says this row is built around.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("a superseded lookup that REJECTS is dropped too", () => {
  it("does not paint could-not-run over an answer it already has", async () => {
    // A keychain that unlocks between two polls, then a transient error on the straggler.
    const answers: Array<{ resolve: (v: TokenSource) => void; reject: (e: string) => void; promise: Promise<TokenSource> }> = [];
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== "publish_token_source") return Promise.reject(`unexpected ${cmd}`);
      if (answers.length === 0) {
        answers.push({ resolve: () => {}, reject: () => {}, promise: Promise.resolve("none" as TokenSource) });
        return Promise.reject("the item could not be read");
      }
      let resolve!: (v: TokenSource) => void;
      let reject!: (e: string) => void;
      const promise = new Promise<TokenSource>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Swallow the rejection here so an unhandled one cannot fail the run; the component's own
      // catch is what this test is about.
      promise.catch(() => undefined);
      answers.push({ resolve, reject, promise });
      return promise;
    });

    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId(PUBLISH_TOKEN_RECHECK_TESTID));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(PUBLISH_TOKEN_RECHECK_TESTID));
    });
    expect(answers.length).toBe(3);

    // The NEWER lookup succeeds…
    await act(async () => {
      answers[2]!.resolve("keychain");
      await answers[2]!.promise;
    });
    expect(status()).toMatch(/stored for this destination in this Mac’s keychain/i);

    // …then the OLDER one rejects. Without the guard on the catch arm, this repaints the row as
    // could-not-run with a stale error string and re-offers the recheck button — a "the check never
    // ran" message over a check that ran and said yes.
    await act(async () => {
      answers[1]!.reject("a transient failure");
      await answers[1]!.promise.catch(() => undefined);
    });

    expect(status()).toMatch(/stored for this destination in this Mac’s keychain/i);
    expect(status()).not.toMatch(/couldn’t check/i);
    expect(status()).not.toContain("a transient failure");
  });
});
