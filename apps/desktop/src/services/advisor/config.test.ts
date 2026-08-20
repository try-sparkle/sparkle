import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ADVISOR_DEFAULTS, ADVISOR_MODEL_UNSET, resolveAdvisorConfig } from "./config";
import { resolveAdvisorModel } from "./model";
import { CLAUDE_MODELS } from "../models";

describe("resolveAdvisorConfig", () => {
  it("reads an ABSENT section as the shipped defaults, not as disabled", () => {
    // The OPPOSITE of `[pushers]`, whose absent section reads as off. That reasoning does not
    // transfer: the pass is compiled into any frontend holding this module, so treating "the Rust
    // side is older than the section" as off would silently stop a pass this build IS running, with
    // no switch to turn back on. Safe only because the zero-spend gate — not this flag — bounds spend.
    for (const absent of [undefined, null, {}]) {
      expect(resolveAdvisorConfig(absent).enabled).toBe(ADVISOR_DEFAULTS.enabled);
    }
    expect(ADVISOR_DEFAULTS.enabled).toBe(true);
  });

  it("honours an explicit false", () => {
    expect(resolveAdvisorConfig({ enabled: false }).enabled).toBe(false);
  });

  it("DROPS a wrong-typed enabled rather than coercing it", () => {
    // Coercing `"no"` to truthy would turn an off switch ON. Rust already recognises the unambiguous
    // off-spellings before this sees them, so anything non-boolean arriving here is genuinely
    // unreadable and must leave the shipped default alone.
    for (const bad of ["no", "false", 0, 1, null]) {
      expect(resolveAdvisorConfig({ enabled: bad as unknown as boolean }).enabled).toBe(true);
    }
  });

  it("honours a configured model", () => {
    expect(resolveAdvisorConfig({ model: "claude-fable-5" }).model).toBe("claude-fable-5");
    // Vacuous unless it differs from the shipped id.
    expect("claude-fable-5").not.toBe(ADVISOR_DEFAULTS.model);
  });

  it("resolves a BLANK or wrong-typed model to null — 'unset', not the shipped id", () => {
    // The distinction is behavioural. `null` is what `resolveAdvisorModel` reads as "use the CATALOG
    // rule"; re-supplying the shipped id here would make that branch unreachable from production
    // config — and a user who blanked the line specifically to get off Opus would have
    // `claude-opus-5` handed straight back as a `source: "configured"` pick. Matches `config.rs`'s
    // own wording and `AdvisorConfigView.model`'s `string | null`.
    for (const blank of ["", "   ", undefined, null, 3]) {
      expect(resolveAdvisorConfig({ model: blank as unknown as string }).model).toBe(
        ADVISOR_MODEL_UNSET,
      );
    }
  });

  it("…and that null REACHES the catalog rule, which yields a non-planner model", () => {
    // The paired half: proving the value is `null` says nothing about what `null` then DOES. This is
    // the branch the old expectation made unreachable.
    const unset = resolveAdvisorConfig({ model: "  " });
    const r = resolveAdvisorModel({
      configured: unset.model,
      catalog: CLAUDE_MODELS,
      plannerModel: plannerModelFromRust(),
    });
    expect(r.model).not.toBeNull();
    expect(r.model === null ? null : r.source).toBe("catalog");
    expect(r.model).not.toBe(plannerModelFromRust());
  });
});

// ── THE CROSS-LANGUAGE PINS ─────────────────────────────────────────────────────────────────────
//
// `ADVISOR_DEFAULTS` is a hand-copied mirror of `AdvisorConfig::default()`, and the "never the
// planner's model" rule is about `ai.rs`'s `CHAT_MODEL`. Both were asserted against LITERALS, which
// cannot detect the drift they exist to name: change `CHAT_MODEL` and a literal comparison stays
// green while the advisor quietly starts reviewing plans with the model that wrote them.
//
// So both are read out of the Rust sources, the same way `research/store.test.ts` pins the research
// command surface. Reading files off disk in a unit test is unusual and deliberate — it is the only
// thing here that can fail when the two languages disagree.

const rust = (rel: string) => readFileSync(resolve(__dirname, "../../../src-tauri/src", rel), "utf8");

/** `CHAT_MODEL` as `ai.rs` actually declares it. Throws rather than defaulting: a pin that silently
 *  fell back to a literal would be the very thing it is replacing. */
function plannerModelFromRust(): string {
  const m = /pub const CHAT_MODEL: &str = "([^"]+)"/.exec(rust("ai.rs"));
  if (!m?.[1]) throw new Error("could not read CHAT_MODEL from ai.rs — the pin is broken");
  return m[1];
}

/** `AdvisorConfig::default()`'s model, as `config.rs` declares it. */
function advisorDefaultModelFromRust(): string {
  const m = /Self \{ enabled: true, model: "([^"]+)"\.to_string\(\) \}/.exec(rust("config.rs"));
  if (!m?.[1]) throw new Error("could not read AdvisorConfig::default() from config.rs");
  return m[1];
}

describe("the TS mirror of the Rust config cannot drift", () => {
  it("ADVISOR_DEFAULTS.model IS AdvisorConfig::default()'s model", () => {
    expect(ADVISOR_DEFAULTS.model).toBe(advisorDefaultModelFromRust());
  });

  it("the shipped advisor model is NOT the planner's, read live from ai.rs", () => {
    // The one configuration that would make the whole feature self-review. `config.rs` asserts the
    // same relation on its side against `ai::CHAT_MODEL`; this is the TS half, and it reads the real
    // constant so changing `CHAT_MODEL` to the advisor's id fails HERE rather than shipping.
    expect(ADVISOR_DEFAULTS.model).not.toBe(plannerModelFromRust());
  });

  it("the shipped advisor model is one the frontend catalog can name", () => {
    // Rule 1 of `resolveAdvisorModel` takes a configured id only if it is IN the catalog. A shipped
    // default absent from `CLAUDE_MODELS` would fall through to the catalog rule on every install —
    // the config line would be inert, and nothing would say so.
    expect(CLAUDE_MODELS.map((m) => m.id)).toContain(ADVISOR_DEFAULTS.model);
  });
});
