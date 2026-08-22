import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  PUBLISH_TOKEN_ENV_PREFIX,
  TOKEN_SOURCES,
  clearPublishToken,
  getPublishTokenSource,
  isPublishTokenPresent,
  publishTokenEnvVarName,
  setPublishToken,
  type TokenSource,
} from "./publishCredential";

// The webview half of the contract with `publish_credential.rs`. These tests pin the four things a
// typecheck cannot see:
//
// 1. the command NAMES — a misnamed or unregistered Tauri command is a RUNTIME-only failure, with
//    no compile error and no warning, which is exactly how these four commands sat registered and
//    uncalled;
// 2. the ARGUMENT KEY SPELLING, which Tauri matches by name — `destinationId`, camelCase, as the
//    host's `destination_id` parameter is bridged;
// 3. the WIRE VALUES of `TokenSource`, which are serde's lowercase renames and not the Rust
//    variant names;
// 4. the environment variable DERIVATION, which is duplicated from Rust's `env_var_name` because
//    no command returns it — so this is the only thing standing between the two copies and drift.

beforeEach(() => {
  invoke.mockReset();
});

describe("setPublishToken", () => {
  it("invokes publish_token_set with the destinationId and token keys Tauri matches on", async () => {
    invoke.mockResolvedValue(undefined);

    await setPublishToken("drodio", "sk-live-abc");

    expect(invoke).toHaveBeenCalledWith("publish_token_set", {
      destinationId: "drodio",
      token: "sk-live-abc",
    });
  });

  /** The host rejects with a plain string it has already scrubbed of the bearer. It must reach the
   *  caller as-is: the message names the specific rule that failed, which is the whole of what
   *  makes it useful to show. */
  it("surfaces the host's rejection rather than swallowing it", async () => {
    invoke.mockRejectedValue("a token cannot contain a newline");

    await expect(setPublishToken("drodio", "a\nb")).rejects.toBe(
      "a token cannot contain a newline",
    );
  });
});

describe("clearPublishToken", () => {
  it("invokes publish_token_clear and returns the source that SURVIVED the clear", async () => {
    // The case the return type exists for: the keychain item is gone and the destination is still
    // credentialed, because a variable supplies the token and Sparkle cannot unset it.
    invoke.mockResolvedValue("environment" satisfies TokenSource);

    const surviving = await clearPublishToken("drodio");

    expect(invoke).toHaveBeenCalledWith("publish_token_clear", { destinationId: "drodio" });
    expect(surviving).toBe("environment");
  });

  it("returns none when nothing is left, so the two outcomes are distinguishable", async () => {
    invoke.mockResolvedValue("none" satisfies TokenSource);

    expect(await clearPublishToken("drodio")).toBe("none");
  });
});

describe("getPublishTokenSource / isPublishTokenPresent", () => {
  it("invokes publish_token_source with the destinationId key", async () => {
    invoke.mockResolvedValue("keychain" satisfies TokenSource);

    const source = await getPublishTokenSource("drodio");

    expect(invoke).toHaveBeenCalledWith("publish_token_source", { destinationId: "drodio" });
    expect(source).toBe("keychain");
  });

  /** The Rust command's return type is a bare `TokenSource`, so it has no failure of its own — but
   *  the IPC hop does, and a rejection must stay distinguishable from `"none"`. A wrapper that
   *  caught this and returned `"none"` would make the row assert "no token configured" about a
   *  destination it never managed to ask about. */
  it("lets an IPC rejection propagate rather than flattening it to none", async () => {
    invoke.mockRejectedValue("the keychain is locked");

    await expect(getPublishTokenSource("drodio")).rejects.toBe("the keychain is locked");
  });

  it("invokes publish_token_present with the destinationId key", async () => {
    invoke.mockResolvedValue(true);

    expect(await isPublishTokenPresent("drodio")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("publish_token_present", { destinationId: "drodio" });
  });
});

describe("the TokenSource wire values", () => {
  /** serde renders `TokenSource` with `#[serde(rename_all = "lowercase")]`, so the wire values are
   *  these three lowercase strings and NOT the Rust variant names. A union written as
   *  `"Keychain" | ...` would typecheck perfectly and match nothing the host can ever send. */
  it("are exactly the three lowercase strings serde emits", () => {
    expect(TOKEN_SOURCES).toEqual(["keychain", "environment", "none"]);
  });
});

describe("publishTokenEnvVarName", () => {
  /** Lifted case for case from `derives_a_legal_env_var_name_for_a_realistic_id` in
   *  `publish_credential.rs`. Two copies of one derivation, one source of truth, and neither
   *  compiler can see the other — so both sides pin the same strings. */
  it("derives the same names the Rust side derives", () => {
    expect(publishTokenEnvVarName("drodio")).toBe("SPARKLE_PUBLISH_TOKEN_DRODIO");
    expect(publishTokenEnvVarName("drodio.com")).toBe("SPARKLE_PUBLISH_TOKEN_DRODIO_COM");
    expect(publishTokenEnvVarName("my-site.co.uk")).toBe("SPARKLE_PUBLISH_TOKEN_MY_SITE_CO_UK");
  });

  it("upper-cases the id, which is what makes a lowercase id resolvable at all", () => {
    // Not a restatement of the case above: it fails if the derivation passes the id through
    // verbatim, which is the mistake that yields a variable nobody can export by that name.
    expect(publishTokenEnvVarName("drodio")).not.toBe("SPARKLE_PUBLISH_TOKEN_drodio");
    expect(publishTokenEnvVarName("aZ9")).toBe("SPARKLE_PUBLISH_TOKEN_AZ9");
  });

  it("is TOTAL — every input yields a legal variable name, even one the host would reject", () => {
    for (const id of ["a b", "üü", "x/y", "", "../chief"]) {
      const name = publishTokenEnvVarName(id);
      expect(name.startsWith(`${PUBLISH_TOKEN_ENV_PREFIX}_`)).toBe(true);
      expect(name).toMatch(/^[0-9A-Za-z_]+$/);
    }
  });

  /** One NON-ASCII character becomes ONE underscore. Rust iterates `chars()` — Unicode scalar
   *  values — so a JS implementation indexing UTF-16 units would emit two underscores for an
   *  astral character and silently name a different variable than the host reads. */
  it("maps one code point to one underscore, not one UTF-16 unit to one", () => {
    expect(publishTokenEnvVarName("üü")).toBe("SPARKLE_PUBLISH_TOKEN___");
    // U+1F600 is a surrogate PAIR in UTF-16: two units, one code point, one underscore.
    expect(publishTokenEnvVarName("a\u{1F600}b")).toBe("SPARKLE_PUBLISH_TOKEN_A_B");
  });
});
