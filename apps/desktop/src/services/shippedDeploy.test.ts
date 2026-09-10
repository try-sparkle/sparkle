// The PROVENANCE layer, asserted against the two urls that made it necessary.
//
// ══ THE FIXTURES ARE MEASURED, NOT IMAGINED (bead ``) ════════════════════════════════
// Increment 1 (`scripts/deploy-url-for-pr.sh`, PR #3072) resolved a real pull request in this repo
// and recorded three urls verbatim. All three are reproduced below, because the whole difficulty of
// this module is that TWO OF THEM ARE WRONG AND NOTHING ABOUT THE STRINGS SAYS SO:
//
//   • `https://sparkle-gxh98nicm-drodio1s-projects.vercel.app` — the real one. A GitHub
//     `deployment_status` with `state: "success"` named it as the `environment_url`, and `curl -L`
//     on it answered HTTP 200 with no login wall.
//   • `https://vercel.com/drodio1s-projects/sparkle/Pe5mf3eRW1MMt5UVDkBCsanpTcuB` — the rollup's
//     `targetUrl`, reported alongside `state: SUCCESS`. It is the login-walled INSPECTOR.
//   • `https://-feature-activity-narration-drodio1s-projects.vercel.app` — the
//     `vercel[bot]` comment's `previewUrl`, advertised while that same comment read "1 Skipped
//     Deployment · Ignored" and the Deployments API returned `[]` for the head sha. A branch alias.
//
// Note what the last one proves, and it is the point of this file: it is INDISTINGUISHABLE from the
// first by any test on the string — same scheme, same provider suffix, same shape — so the tests
// below assert that the URL FLOOR does not separate them and the PROVENANCE GATE does.
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearShippedDeploy,
  decideShippedOpen,
  isShareableDeployUrl,
  recordShippedDeploy,
  resolveShippedOpenTarget,
  SHIPPED_DEPLOY_PROVENANCE,
} from "./shippedDeploy";
import { usePreviewStore, type ShippedDeploy } from "../stores/previewStore";

/** The measured verdict-0 answer. */
const PROVEN_URL = "https://sparkle-gxh98nicm-drodio1s-projects.vercel.app";
/** The measured trap A — a public https url that is the provider's own console. */
const INSPECTOR_URL = "https://vercel.com/drodio1s-projects/sparkle/Pe5mf3eRW1MMt5UVDkBCsanpTcuB";
/** The measured trap B — a branch alias for a deployment that was never built. */
const BRANCH_ALIAS_URL =
  "https://-feature-activity-narration-drodio1s-projects.vercel.app";

function reset(): void {
  usePreviewStore.setState({ shippedByAgent: {} });
}

beforeEach(reset);

describe("isShareableDeployUrl — the FLOOR, and what it deliberately cannot do", () => {
  it("admits the measured proven url", () => {
    expect(isShareableDeployUrl(PROVEN_URL)).toBe(true);
  });

  it("admits a project on its own custom domain — the case a provider-suffix allowlist would break", () => {
    // THE REASON THE HOST TEST IS A DENYLIST. Anything a person would actually share sits on its own
    // domain and carries no `.vercel.app`/`.netlify.app` suffix at all, so an allowlist would refuse
    // exactly the best answers. Asserted rather than commented, so a later "tighten it to known
    // providers" change reds here instead of shipping.
    expect(isShareableDeployUrl("https://app.example.com/")).toBe(true);
  });

  it("refuses the provider's login-walled dashboard, which reports SUCCESS and is not the work", () => {
    expect(isShareableDeployUrl(INSPECTOR_URL)).toBe(false);
    // …and every other console this repo has met.
    expect(isShareableDeployUrl("https://app.netlify.com/sites/x/deploys/y")).toBe(false);
    expect(isShareableDeployUrl("https://www.vercel.com/x")).toBe(false);
  });

  it("CANNOT tell the branch alias from the real url — which is why provenance is the gate", () => {
    // THE LOAD-BEARING NEGATIVE RESULT. This is not a gap to close later: the branch alias is a
    // perfectly ordinary public https url on the same host suffix as the proven one, and no
    // predicate over the string can know that the provider skipped the deployment behind it. A
    // future reader who "fixes" this by adding a pattern for `-git-` would be encoding a Vercel
    // naming convention as a security boundary. The next `describe` is where that url is refused.
    expect(isShareableDeployUrl(BRANCH_ALIAS_URL)).toBe(true);
  });

  for (const [label, url] of [
    ["a null url", null],
    ["an unparseable url", "not a url"],
    ["plain http", "http://example.com/"],
    ["a loopback url — the very thing a shipped card is not", "https://127.0.0.1:5173/"],
    ["an RFC1918 host", "https://10.0.0.5/"],
    ["a link-local host", "https://169.254.10.1/"],
    ["a 172.16/12 host", "https://172.20.3.4/"],
    ["a .local host", "https://build.local/"],
    ["a .internal host", "https://web.internal/"],
    ["a bare host with no dot", "https://intranet/"],
    ["an IPv6 literal", "https://[::1]/"],
    // USERINFO. `https://sparkle.vercel.app@evil.example/` renders as the trustworthy half in most
    // surfaces a person would paste it into, and a substring test on the host passes it.
    ["a userinfo url wearing a provider host", "https://sparkle.vercel.app@evil.example/"],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(isShareableDeployUrl(url)).toBe(false);
    });
  }

  // ══ THE OTHER DIRECTION OF THE SAME PROPERTY — a parse, not a substring match ═════════════════
  // The refusals above are what a substring test would MISS. These two are what it would wrongly
  // REFUSE: both carry a disqualifying string in a position where it is not the host, and both are
  // perfectly ordinary public addresses. A guard that reds correct urls gets loosened by whoever
  // hits it next, so the false-positive direction is asserted rather than assumed — this is the
  // WIDENING half of the pair AGENTS.md asks for on any predicate that both blocks and allows.
  for (const [label, url] of [
    ["a dashboard name in the FRAGMENT, where it is not the host", "https://real.example/#vercel.com"],
    ["a loopback-looking SUBDOMAIN of a real host", "https://127.0.0.1.real.example/"],
  ] as const) {
    it(`admits ${label}`, () => {
      expect(isShareableDeployUrl(url)).toBe(true);
    });
  }
});

describe("recordShippedDeploy — the WRITER, and what it refuses by name", () => {
  it("stores a proven url so the card projection can read it", () => {
    const res = recordShippedDeploy("ag-1", {
      url: PROVEN_URL,
      provenance: SHIPPED_DEPLOY_PROVENANCE,
      prNumber: 3067,
      sha: "543021e0543021e0543021e0543021e0543021e0",
      environment: "Preview",
    }, 5_000);
    expect(res.ok).toBe(true);
    // THE SIDE EFFECT, not the return value: the store is what the card reads.
    const stored = usePreviewStore.getState().shippedByAgent["ag-1"];
    expect(stored).toEqual({
      url: PROVEN_URL,
      provenance: SHIPPED_DEPLOY_PROVENANCE,
      prNumber: 3067,
      sha: "543021e0543021e0543021e0543021e0543021e0",
      environment: "Preview",
      recordedAt: 5_000,
    });
  });

  it("REFUSES the branch alias when it arrives without the provenance token, and writes NOTHING", () => {
    // The url the floor above could not refuse. This is the whole mechanism: it is turned away here,
    // by where it came from, and the store is left empty — so no card can be built from it.
    const res = recordShippedDeploy("ag-1", { url: BRANCH_ALIAS_URL, provenance: "vercel-bot-comment" });
    expect(res).toEqual({ ok: false, reason: "unproven" });
    expect(usePreviewStore.getState().shippedByAgent).toEqual({});
  });

  it("refuses a claim with no provenance at all", () => {
    const res = recordShippedDeploy("ag-1", { url: PROVEN_URL, provenance: undefined });
    expect(res).toEqual({ ok: false, reason: "unproven" });
    expect(usePreviewStore.getState().shippedByAgent).toEqual({});
  });

  it("refuses the dashboard url even WITH the provenance token", () => {
    // BOTH gates, not either: the token is not a skeleton key. A resolver that regressed into
    // reporting `targetUrl` under the right provenance still cannot produce a card.
    const res = recordShippedDeploy("ag-1", {
      url: INSPECTOR_URL,
      provenance: SHIPPED_DEPLOY_PROVENANCE,
    });
    expect(res).toEqual({ ok: false, reason: "not-shareable" });
    expect(usePreviewStore.getState().shippedByAgent).toEqual({});
  });

  it("reports 'unproven' rather than 'not-shareable' when BOTH are wrong", () => {
    // THE ORDER OF THE REFUSALS IS A PRODUCT DECISION, and it is pinned. The caller is an agent:
    // told its url is malformed it goes and finds a different url, which is the wrong move when the
    // real problem is that nothing proved anything was deployed. Told 'unproven' it runs the
    // resolver, which is the only thing that helps.
    const res = recordShippedDeploy("ag-1", { url: INSPECTOR_URL, provenance: "guessed" });
    expect(res).toEqual({ ok: false, reason: "unproven" });
  });

  it("refuses an empty or missing url", () => {
    expect(recordShippedDeploy("ag-1", { url: "   ", provenance: SHIPPED_DEPLOY_PROVENANCE }))
      .toEqual({ ok: false, reason: "no-url" });
    expect(recordShippedDeploy("ag-1", { url: undefined, provenance: SHIPPED_DEPLOY_PROVENANCE }))
      .toEqual({ ok: false, reason: "no-url" });
    expect(usePreviewStore.getState().shippedByAgent).toEqual({});
  });

  it("drops caption fields it cannot trust rather than rendering them", () => {
    // `prNumber` and `sha` end up on screen. A "PR #-1" or a truncated sha is worse than no caption,
    // and both are shapes a hand-typed agent call can produce.
    recordShippedDeploy("ag-1", {
      url: PROVEN_URL,
      provenance: SHIPPED_DEPLOY_PROVENANCE,
      prNumber: -1,
      sha: "543021e0",
      environment: "   ",
    }, 1);
    const stored = usePreviewStore.getState().shippedByAgent["ag-1"]!;
    expect(stored.prNumber).toBeNull();
    expect(stored.sha).toBeNull();
    expect(stored.environment).toBeNull();
  });

  it("RE-RECORDS the same url with a fresh instant — a new deploy is news again", () => {
    // The store's setter has no unchanged-value bail, deliberately: re-proving the same address
    // after a new deployment is exactly the event that should re-date the card, and a bail keyed on
    // the url would swallow it.
    recordShippedDeploy("ag-1", { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 1_000);
    recordShippedDeploy("ag-1", { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 9_000);
    expect(usePreviewStore.getState().shippedByAgent["ag-1"]!.recordedAt).toBe(9_000);
  });

  it("clearShippedDeploy retires the entry", () => {
    recordShippedDeploy("ag-1", { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 1);
    clearShippedDeploy("ag-1");
    expect(usePreviewStore.getState().shippedByAgent).toEqual({});
  });

  it("does not touch ANOTHER agent's dev-server preview state", () => {
    // The two maps are separate for a reason (see `ShippedDeploy`'s docstring); this pins that the
    // writer stays on its own side of the line.
    const before = usePreviewStore.getState().byAgent;
    recordShippedDeploy("ag-1", { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 1);
    expect(usePreviewStore.getState().byAgent).toBe(before);
  });
});

describe("decideShippedOpen — the gates, re-asked at click time", () => {
  const live = (over: Partial<ShippedDeploy> = {}): ShippedDeploy => ({
    url: PROVEN_URL,
    provenance: SHIPPED_DEPLOY_PROVENANCE,
    prNumber: 3067,
    sha: null,
    environment: "Preview",
    recordedAt: 1_000,
    ...over,
  });

  it("opens when the card and the store agree", () => {
    expect(decideShippedOpen({ url: PROVEN_URL }, live())).toEqual({ ok: true, url: PROVEN_URL });
  });

  it("refuses when the entry was retired under the card", () => {
    expect(decideShippedOpen({ url: PROVEN_URL }, null)).toEqual({
      ok: false,
      reason: "gone",
      heldUrl: PROVEN_URL,
      liveUrl: null,
    });
  });

  it("refuses rather than silently following a newer url", () => {
    // Following it would be a second destination from one gesture and would hide the fact that the
    // card is describing a different build — the same argument `decidePreviewOpen` makes.
    const decision = decideShippedOpen({ url: PROVEN_URL }, live({ url: "https://newer.example/" }));
    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ reason: "moved", liveUrl: "https://newer.example/" });
  });

  it("refuses a stored entry whose provenance no longer qualifies", () => {
    // THE LAST THING BETWEEN A STORED URL AND A BROWSER. Only `recordShippedDeploy` writes this map
    // today, so this branch is unreachable through the app's own writer — which is exactly why it is
    // asserted: it must not depend on that remaining true.
    expect(
      decideShippedOpen({ url: PROVEN_URL }, live({ provenance: "vercel-bot-comment" })),
    ).toMatchObject({ ok: false, reason: "unsafe" });
  });

  it("refuses a stored entry whose url no longer clears the floor", () => {
    expect(
      decideShippedOpen({ url: INSPECTOR_URL }, live({ url: INSPECTOR_URL })),
    ).toMatchObject({ ok: false, reason: "unsafe" });
  });

  it("resolveShippedOpenTarget reads the live store", () => {
    recordShippedDeploy("ag-1", { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 1);
    expect(resolveShippedOpenTarget("ag-1", { url: PROVEN_URL })).toEqual({
      ok: true,
      url: PROVEN_URL,
    });
    clearShippedDeploy("ag-1");
    expect(resolveShippedOpenTarget("ag-1", { url: PROVEN_URL })).toMatchObject({
      ok: false,
      reason: "gone",
    });
  });
});
