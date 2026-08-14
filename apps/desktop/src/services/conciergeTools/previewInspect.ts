// The PREVIEW INSPECT domain — "agent eyes" over an already-open live preview (Phase 3 of
// docs/live-browser-preview.md). Two ops: `screenshot` and `query_dom`. Click-to-instruct is
// explicitly NOT here — see bead sparkle-51pwp, deferred pending its own design pass and founder
// sign-off, and because it would touch `PreviewSlot.tsx`, which this domain never does.
//
// ---------------------------------------------------------------------------------------------
// ADDITIVE, NOT A REBIND. This domain never opens, closes, or lists a preview (that is the
// `preview` domain's `sparkle_preview` tool, tracked separately) — it only reads from a preview an
// interactive agent already opened. The Rust side (`preview_capture.rs`) resolves the agent's
// current preview port through `preview::preview_status` and launches its OWN throwaway headless
// browser pointed at that port; it never touches the pane the human watches.
//
// ---------------------------------------------------------------------------------------------
// WHY `read-only`, UNLIKE `screenshot.ts`'s `capture_agent`/`capture_window`.
//
// Those ops photograph the HUMAN'S SCREEN — whatever happens to be on top of Sparkle at that
// moment — which is why they are `privacy-sensitive` and need explicit approval every time (see
// that file's header). This domain looks at neither the human's screen nor Sparkle's own UI: it
// reads the OUTPUT OF THE AGENT'S OWN DEV SERVER, content the agent already has full access to via
// `curl`/`fetch`/Bash against the same loopback port. A screenshot or DOM query of it exposes
// nothing the agent could not already read; it is a more convenient RENDERING of data already in
// its hands, which is exactly what `read-only` means here.
//
// ---------------------------------------------------------------------------------------------
// WHERE THE SCREENSHOT BYTES GO: A PATH, NOT A PAYLOAD — same rule as `screenshot.ts`, same reason.
// The Rust side writes a PNG to `window_screenshot::capture_dir()` and returns
// `{ path, width, height, bytes }`; the pixels never cross the tool envelope. See that module's
// header for the cost math this avoids.
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const PREVIEW_INSPECT_OPS = ["screenshot", "query_dom"] as const;

export type PreviewInspectOp = (typeof PREVIEW_INSPECT_OPS)[number];

/** Both ops read the agent's own dev-server output — see the header for why that is `read-only`
 *  and not `privacy-sensitive`, unlike the human-screen `screenshot` domain. */
export type PreviewInspectRisk = "read-only";

/** EXHAUSTIVE by construction — a `Record<PreviewInspectOp, …>`, so an op added to
 *  `PREVIEW_INSPECT_OPS` without a classification fails `tsc` rather than defaulting to something
 *  permissive. */
export const PREVIEW_INSPECT_RISK: Record<PreviewInspectOp, PreviewInspectRisk> = {
  screenshot: "read-only",
  query_dom: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/diff/screenshot convention
// ---------------------------------------------------------------------------------------------

export interface PreviewInspectOk<T> {
  ok: true;
  op: PreviewInspectOp;
  risk: PreviewInspectRisk;
  data: T;
}

export interface PreviewInspectRefusal {
  ok: false;
  op: PreviewInspectOp;
  risk: PreviewInspectRisk;
  reason: string;
  message: string;
}

export type PreviewInspectResult<T> = PreviewInspectOk<T> | PreviewInspectRefusal;

function ok<T>(op: PreviewInspectOp, data: T): PreviewInspectOk<T> {
  return { ok: true, op, risk: PREVIEW_INSPECT_RISK[op], data };
}

function refuse(op: PreviewInspectOp, reason: string, message: string): PreviewInspectRefusal {
  return { ok: false, op, risk: PREVIEW_INSPECT_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Wire shapes (mirrors of the Rust structs in preview_capture.rs)
// ---------------------------------------------------------------------------------------------

/** What a capture produced. Measurements plus a path — never the pixels. See the header. */
export interface PreviewCapture {
  /** Absolute path to the PNG. */
  path: string;
  width: number;
  height: number;
  bytes: number;
}

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One matched element. `id`/`className` are `T | null`, not `T | undefined` — a Rust `Option`
 *  crosses the wire as an explicit `null`, never an omitted key (serde's derive default). See
 *  preview_capture.rs's `DomMatch`. */
export interface DomMatch {
  tag: string;
  id: string | null;
  className: string | null;
  text: string;
  rect: DomRect;
}

// ---------------------------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------------------------

async function attempt<T>(
  op: PreviewInspectOp,
  run: () => Promise<T>,
): Promise<PreviewInspectResult<T>> {
  try {
    return ok(op, await run());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("no preview is open")) {
      return refuse(op, "no-preview", message);
    }
    if (message.includes("not yet serving anything") || message.includes("no port yet")) {
      return refuse(op, "preview-not-ready", message);
    }
    if (message.includes("Playwright's headless Chromium isn't installed")) {
      return refuse(op, "headless-browser-missing", message);
    }
    return refuse(op, "capture-failed", message);
  }
}

/**
 * Screenshot the agent's currently-open preview.
 *
 * Requires a preview already opened for `agentId` (via the `preview` domain, not this one) and in
 * one of the "framable" states — see `PreviewSlot.tsx`'s `PREVIEW_PANE_FOR_STATE`. Refuses with
 * `no-preview` when none is open and `preview-not-ready` when one is open but has nothing rendered
 * yet, rather than returning a blank or stale image labelled as current.
 */
export async function previewScreenshot(agentId: string): Promise<PreviewInspectResult<PreviewCapture>> {
  if (!agentId?.trim()) {
    return refuse("screenshot", "bad-args", "Which agent's preview? Pass `agentId`.");
  }
  return attempt("screenshot", () => invoke<PreviewCapture>("preview_screenshot", { agentId }));
}

/**
 * Query the DOM of the agent's currently-open preview with a CSS selector.
 *
 * Bounded on the Rust side to at most 20 matches and 300 characters of text per match — see
 * preview_capture.rs's `DOM_QUERY_MAX_MATCHES`/`DOM_QUERY_TEXT_MAX_CHARS` — so a broad selector
 * cannot flood the reply the way an unbounded query would.
 */
export async function previewQueryDom(
  agentId: string,
  selector: string,
): Promise<PreviewInspectResult<DomMatch[]>> {
  if (!agentId?.trim()) {
    return refuse("query_dom", "bad-args", "Which agent's preview? Pass `agentId`.");
  }
  if (!selector?.trim()) {
    return refuse("query_dom", "bad-args", "Which elements? Pass a CSS `selector`.");
  }
  return attempt("query_dom", () =>
    invoke<DomMatch[]>("preview_query_dom", { agentId, selector }),
  );
}

// NO DESCRIPTOR ARRAY HERE, for the reason screenshot.ts states: the registry derives this
// domain's ops and write flags from `PREVIEW_INSPECT_OPS`/`PREVIEW_INSPECT_RISK`, and the prose a
// model actually reads before calling is the `sparkle_preview_inspect` description in
// mcp-control's server.ts. A second, unread copy here is how those two drift apart.
