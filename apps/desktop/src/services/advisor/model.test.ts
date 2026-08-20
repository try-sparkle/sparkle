// The advisor must NEVER run on the planner's model — a resolution that quietly fell back to it
// would not degrade the feature, it would INVERT it: self-review wearing a second name, with a bead
// comment attesting to a second opinion that never happened.
import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_ID, type ClaudeModelOption } from "../models";
import { resolveAdvisorModel } from "./model";

const PLANNER = "claude-sonnet-4-6";
const opt = (id: string): ClaudeModelOption => ({ id, label: id, short: id });
const catalog: ClaudeModelOption[] = [
  opt(DEFAULT_MODEL_ID),
  opt("claude-opus-5"),
  opt("claude-fable-5"),
  opt(PLANNER),
];

describe("resolveAdvisorModel", () => {
  it("NEVER returns the planner's model, even when it heads the catalog", () => {
    // The planner FIRST, so a resolver that simply took `catalog[1]` (skipping only the sentinel)
    // would return it. That is the exact shape this guards.
    const r = resolveAdvisorModel({
      catalog: [opt(DEFAULT_MODEL_ID), opt(PLANNER), opt("claude-opus-5")],
      plannerModel: PLANNER,
    });
    expect(r.model).toBe("claude-opus-5");
    expect(r.model).not.toBe(PLANNER);
  });

  it("returns NULL when the catalog offers only the planner's model", () => {
    const r = resolveAdvisorModel({
      catalog: [opt(DEFAULT_MODEL_ID), opt(PLANNER)],
      plannerModel: PLANNER,
    });
    expect(r.model).toBeNull();
    expect(r.model === null && r.reason).toBe("no-distinct-model");
  });

  it("returns NULL for an empty catalog, and for one holding only the Default sentinel", () => {
    expect(resolveAdvisorModel({ catalog: [], plannerModel: PLANNER }).model).toBeNull();
    const r = resolveAdvisorModel({ catalog: [opt(DEFAULT_MODEL_ID)], plannerModel: PLANNER });
    expect(r.model).toBeNull();
    expect(r.model === null && r.reason).toBe("empty-catalog");
  });

  it("HONOURS a configured id that is in the catalog", () => {
    const r = resolveAdvisorModel({
      configured: "claude-fable-5",
      catalog,
      plannerModel: PLANNER,
    });
    expect(r).toEqual({ model: "claude-fable-5", source: "configured" });
    // Vacuous unless the configured id differs from what the catalog rule would have picked.
    expect(resolveAdvisorModel({ catalog, plannerModel: PLANNER }).model).toBe("claude-opus-5");
  });

  it("IGNORES a configured id that is absent from the catalog, falling through to the catalog rule", () => {
    const r = resolveAdvisorModel({
      configured: "gpt-4o",
      catalog,
      plannerModel: PLANNER,
    });
    // NOT dispatched: `research.rs` would refuse an off-list id anyway, so obeying it here would
    // only move the failure later and spend a bead label on it.
    expect(r).toEqual({ model: "claude-opus-5", source: "catalog" });
  });

  it("IGNORES a configured id that IS the planner's model", () => {
    // The one configuration that would re-enable self-review through the front door.
    const r = resolveAdvisorModel({ configured: PLANNER, catalog, plannerModel: PLANNER });
    expect(r.model).toBe("claude-opus-5");
    expect(r.model).not.toBe(PLANNER);
  });

  it("never returns the Default sentinel, configured or not", () => {
    // "default" is not a model id — it means "inherit the user's own Claude Code default", which may
    // well BE the planner's model. Admitting it names a value that cannot be compared against the
    // planner's until after the call has already run.
    const only = [opt(DEFAULT_MODEL_ID)];
    expect(resolveAdvisorModel({ configured: DEFAULT_MODEL_ID, catalog: only, plannerModel: PLANNER }).model).toBeNull();
    expect(resolveAdvisorModel({ configured: DEFAULT_MODEL_ID, catalog, plannerModel: PLANNER }).model).toBe(
      "claude-opus-5",
    );
  });

  it("FAILS CLOSED when the planner's model cannot be read", () => {
    // Without a referent, "different from the planner" is unanswerable, and the only available
    // fallback — pick anything — is exactly the self-review case.
    for (const unknown of [null, "", "   "]) {
      const r = resolveAdvisorModel({ catalog, plannerModel: unknown });
      expect(r.model).toBeNull();
      expect(r.model === null && r.reason).toBe("planner-model-unknown");
    }
  });
});
