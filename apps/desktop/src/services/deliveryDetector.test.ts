import { describe, it, expect } from "vitest";
import { classifyEvidence, type DeliveryEvidence } from "./deliveryDetector";

/** A fully-empty evidence bundle; fixtures override just the fields they exercise. */
function emptyEvidence(over: Partial<DeliveryEvidence> = {}): DeliveryEvidence {
  return {
    hasVercel: false,
    hasFly: false,
    hasNetlify: false,
    hasDockerfile: false,
    hasEas: false,
    hasServerless: false,
    npmPublishable: false,
    packageName: null,
    packageVersion: null,
    packagePrivate: false,
    hasPublishConfig: false,
    releaseScript: null,
    workflowDeployVerbs: [],
    workflowFiles: [],
    hasSemverTags: false,
    tagCount: 0,
    remotes: [],
    defaultBranch: null,
    ...over,
  };
}

describe("classifyEvidence", () => {
  it("release-based: a GitHub Release workflow ⇒ release_tag / high", () => {
    const ev = emptyEvidence({
      workflowDeployVerbs: ["gh release"],
      workflowFiles: ["release.yml"],
      hasSemverTags: true,
      tagCount: 12,
    });
    const p = classifyEvidence(ev);
    expect(p.method).toBe("release_tag");
    expect(p.confidence).toBe("high");
    // Delivered criteria: one auto in_release + one manual verify.
    expect(p.criteria.some((c) => c.kind === "auto" && c.signal === "in_release")).toBe(true);
    expect(p.criteria.some((c) => c.kind === "manual")).toBe(true);
  });

  it("vercel merge-is-deploy: vercel.json, no deploy workflow ⇒ merge_is_deploy / medium", () => {
    const ev = emptyEvidence({ hasVercel: true });
    const p = classifyEvidence(ev);
    expect(p.method).toBe("merge_is_deploy");
    expect(p.confidence).toBe("medium");
    expect(p.note).toMatch(/Vercel/i);
  });

  it("ci-deploy (fly): a fly deploy verb in a workflow ⇒ ci_deploy / high", () => {
    const ev = emptyEvidence({
      hasFly: true,
      workflowDeployVerbs: ["fly deploy"],
      workflowFiles: ["deploy.yml"],
    });
    const p = classifyEvidence(ev);
    expect(p.method).toBe("ci_deploy");
    expect(p.confidence).toBe("high");
    expect(p.note).toMatch(/fly deploy/i);
  });

  it("empty ⇒ unknown / none with a single manual criterion (honest fallback)", () => {
    const p = classifyEvidence(emptyEvidence());
    expect(p.method).toBe("unknown");
    expect(p.confidence).toBe("none");
    expect(p.criteria).toHaveLength(1);
    expect(p.criteria[0]?.kind).toBe("manual");
  });

  // --- Extra coverage for the middle tiers, to lock the decision table ---

  it("package publish: publishable + npm publish verb ⇒ package_publish / medium", () => {
    const ev = emptyEvidence({
      npmPublishable: true,
      packageName: "my-lib",
      workflowDeployVerbs: ["npm publish"],
    });
    const p = classifyEvidence(ev);
    expect(p.method).toBe("package_publish");
    expect(p.confidence).toBe("medium");
  });

  it("weak hint: only a Dockerfile ⇒ ci_deploy / low, flagged for confirmation", () => {
    const p = classifyEvidence(emptyEvidence({ hasDockerfile: true }));
    expect(p.method).toBe("ci_deploy");
    expect(p.confidence).toBe("low");
    expect(p.note).toMatch(/confirm|correct/i);
  });

  it("cut-dmg release script ⇒ release_tag / high", () => {
    const p = classifyEvidence(emptyEvidence({ releaseScript: "cut-dmg.sh" }));
    expect(p.method).toBe("release_tag");
    expect(p.confidence).toBe("high");
  });

  it("release workflow OUTRANKS a co-present vercel.json (precedence)", () => {
    const ev = emptyEvidence({
      hasVercel: true,
      workflowDeployVerbs: ["action-gh-release"],
      workflowFiles: ["release.yml"],
    });
    const p = classifyEvidence(ev);
    expect(p.method).toBe("release_tag");
    expect(p.confidence).toBe("high");
  });

  // --- Auto-signal must match the method's real observability (roborev #27349) ---
  // Seeding `in_release` for every method left non-release methods with a structurally
  // unsatisfiable auto criterion. Only release_tag and merge_is_deploy are observable today.

  it("merge_is_deploy watches merged_to_main (the merge IS the deploy), not in_release", () => {
    const p = classifyEvidence(emptyEvidence({ hasVercel: true }));
    const auto = p.criteria.filter((c) => c.kind === "auto");
    expect(auto).toHaveLength(1);
    expect(auto[0]?.signal).toBe("merged_to_main");
    expect(p.criteria.some((c) => c.signal === "in_release")).toBe(false);
  });

  it("ci_deploy has NO auto criterion — a CI deploy's success isn't observable (manual)", () => {
    const ev = emptyEvidence({ hasFly: true, workflowDeployVerbs: ["fly deploy"], workflowFiles: ["d.yml"] });
    const p = classifyEvidence(ev);
    expect(p.criteria.every((c) => c.kind === "manual")).toBe(true);
    expect(p.criteria.some((c) => c.signal === "in_release")).toBe(false);
  });

  it("package_publish has NO auto criterion — a registry publish isn't observable (manual)", () => {
    const ev = emptyEvidence({ npmPublishable: true, packageName: "x", workflowDeployVerbs: ["npm publish"] });
    const p = classifyEvidence(ev);
    expect(p.criteria.every((c) => c.kind === "manual")).toBe(true);
  });

  it("release_tag is the ONLY method that seeds an in_release auto criterion", () => {
    const p = classifyEvidence(emptyEvidence({ workflowDeployVerbs: ["gh release"], workflowFiles: ["r.yml"] }));
    expect(p.criteria.some((c) => c.kind === "auto" && c.signal === "in_release")).toBe(true);
  });
});
