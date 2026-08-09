// PreviewSlot — the live dev-server preview, covering one pair.
//
// STRUCTURALLY A NEAR-COPY OF `PlanBoardSlot` (Workspace.tsx), in its own file because Workspace is
// already 2300+ lines. Everything that file's header argues about the board applies here verbatim:
//
//   IT COVERS, IT DOES NOT RE-FLOW. `position: absolute; inset: 0` over the pair's `paircols` box,
//   rendered as a SIBLING of the build column and the terminal stage — not inside the stage. An
//   absolute child takes no part in that flex row, so neither column is unmounted, resized, or
//   asked to give up its width, and leaving Preview restores the layout exactly because nothing
//   ever changed it.
//
//   THE GOVERNING RULE IS "COVER, NEVER UNMOUNT". A Terminal unmount kills its PTY — the agent's
//   session, not just its pixels — and `display: none` would zero every measured size in the
//   subtree, which is how a column comes back at the wrong width. Both failures are invisible in a
//   screenshot and expensive in use.
//
//   IT CARRIES ITS OWN PLAN/BUILD TOGGLE, and it has to: covering the Build column takes the
//   sidebar's copy off screen with it, so without one there is no way back to Build.
//
// IT REUSES `PLAN_COLUMN_Z` rather than declaring an equal constant beside it. The board and the
// preview are mutually exclusive by construction — one `workMode` per side, and they are two of its
// three values — so they can never be on screen together and there is no ordering between them to
// express. A second number with the same value would be pure drift surface: the pair would have to
// be kept equal by hand forever, and the first time they diverged nothing would be able to tell you
// which one was right. See the note in `layers.ts`.
import { useMemo, useState } from "react";
export { PREVIEW_PERMISSIONS_POLICY } from "./previewPermissionsPolicy";
import { PREVIEW_PERMISSIONS_POLICY } from "./previewPermissionsPolicy";
import { FiAlertTriangle, FiRefreshCw, FiSlash } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { PLAN_COLUMN_Z } from "./layers";
import { PlanBuildToggle } from "./PlanBuildToggle";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePreviewStore, type PreviewState } from "../stores/previewStore";
import { isLoopbackPreviewUrl } from "../services/preview";
import type { PairSide } from "../engine/pairs";
import type { Project } from "../types";

/** The five sandbox tokens, as ONE list so the component and its test read the same source.
 *
 * `allow-same-origin` IS REQUIRED AND IS SAFE HERE, and both halves need saying because the
 * combination `allow-scripts allow-same-origin` is the classic sandbox escape — *when the framed
 * content is same-origin with the parent*, in which case the frame can reach into the parent and
 * dissolve its own sandbox. That is not this: the frame is `http://127.0.0.1:N` and Sparkle's
 * document is `tauri://localhost`, so they are cross-origin whatever the tokens say — a property
 * the landed `frame-src` GUARANTEES by never naming Sparkle's own origin. Without the token the
 * page gets an opaque origin and ordinary dev servers break (storage and same-origin `fetch` fail,
 * and HMR's websocket dies), for no security gain at all.
 *
 * NEVER ADD `allow-top-navigation`. It would let an agent-authored page navigate the whole Sparkle
 * webview away from the app.
 */
export const PREVIEW_SANDBOX_TOKENS = [
  "allow-scripts",
  "allow-forms",
  "allow-popups",
  "allow-modals",
  "allow-same-origin",
] as const;

/**
 * WHICH PANE A STATE GETS — the ONE mapping, and the thing that actually decides what renders.
 *
 * Previously this was a conditional chain plus a separate exhaustive `switch` that shadowed it. The
 * shadow was worse than nothing: the pairing lived in trailing comments, so DELETING a JSX branch
 * still typechecked (the `case` remained), and when the union grew, the one-keystroke way to clear
 * the compile error was to add the new member to the fall-through group — satisfying `tsc` while the
 * pane rendered "Sparkle does not recognise this state" for a state this build names. A second copy
 * of a list is not a pin on the first.
 *
 * `Record<PreviewState, …>` is total, so a new union member fails to compile HERE, at the thing that
 * decides what renders — not in a shadow list beside it. What this does NOT do, said plainly rather
 * than claimed away: deleting one of the JSX branches below still typechecks, because the map only
 * says which pane a state wants, not that the pane exists. That half is covered by tests instead —
 * `Workspace.previewSlot.test.tsx` asserts `stopped`, `starting`, the three framable states, an
 * unrecognised state and no-entry each render their own testid, so a deleted branch reds there.
 *
 * `"framable"` is a REQUEST, not a verdict: the url still has to pass `isLoopbackPreviewUrl`, and a
 * listening server whose url is refused renders the refusal instead. That is why this maps to a pane
 * KIND rather than to a testid.
 */
type PreviewPane = "framable" | "starting" | "stopped" | "failed";

const PANE_FOR: Record<PreviewState, PreviewPane> = {
  starting: "starting",
  listening: "framable",
  ready: "framable",
  serving: "framable",
  failed: "failed",
  crashed: "failed",
  stopped: "stopped",
};

/**
 * The pane for a status the wire actually sent. `undefined` means THIS BUILD HAS NO NAME FOR IT —
 * `applyPreviewStatus` writes `state` into the store unvalidated, so a desktop older than the agent
 * that started the server lands here, and no compile-time check can see a value from another
 * process.
 */
function paneFor(status: string | undefined): PreviewPane | undefined {
  return status === undefined ? undefined : PANE_FOR[status as PreviewState];
}

export function PreviewSlot({ project, side }: { project: Project; side: PairSide }) {
  const mode = useUiStore((s) => s.workModeBySide[side]);
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const openPlanBoard = useUiStore((s) => s.openPlanBoard);
  const showBuildStage = useUiStore((s) => s.showBuildStage);
  const openPreview = useUiStore((s) => s.openPreview);
  const agentId = project.selectedAgentId;
  const entry = usePreviewStore((s) => (agentId ? s.byAgent[agentId] : undefined));
  const bumpReload = usePreviewStore((s) => s.bumpReload);
  const previewable = usePreviewStore((s) => s.capability[project.id]?.previewable === true);

  // WHETHER WE WILL FRAME THIS URL AT ALL, decided here rather than trusted from the payload. The
  // url reached us over a bridge from another process; that process's gate is a claim about a
  // different binary's build, and this side is what actually renders. See `isLoopbackPreviewUrl`.
  const url = entry?.url ?? null;
  const loopbackOk = useMemo(() => isLoopbackPreviewUrl(url), [url]);

  const pane = paneFor(entry?.status);
  const failed = pane === "failed";
  // A refusal is about the ADDRESS, so it is judged on the url alone — a server that is merely not
  // up yet has not been refused anything.
  const refused = !!url && !loopbackOk;
  // WE ONLY FRAME A SERVER THAT IS ACTUALLY LISTENING, which is a separate question from whether
  // the address is allowed. Rust knows the url before the server is up ("the URL is knowable
  // because the port was FORCED"), so gating the iframe on the url's presence mounted it against a
  // dead port: the user got the webview's connection-refused page, and since `src` and `key` never
  // change afterwards it STAYED there — a preview that looks broken for the entire cold start,
  // recoverable only by pressing Reload by hand. `preview-starting` was unreachable on that path.
  const framable = loopbackOk && pane === "framable";

  return (
    <div
      data-testid="preview-column"
      data-preview-project={project.id}
      data-preview-agent={agentId ?? ""}
      data-preview-state={entry?.status ?? "none"}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: C.deepForest,
        zIndex: PLAN_COLUMN_Z,
      }}
    >
      {/* THE SAME HEADER ROW THE BOARD USES — top right, `mini` chiclet — so the way out of a
          covering surface is in one place whichever surface is covering. The reload control sits
          LEFT of the toggle for the board's own reason: the toggle is the exit and stays pinned to
          the corner it has always been in, so anything that grows pushes inward instead of moving
          the way out. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          padding: "12px 12px 8px",
        }}
      >
        {framable && <ReloadButton onClick={() => agentId && bumpReload(agentId)} />}
        <PlanBuildToggle
          mode={mode}
          beadsEnabled={beadsEnabled}
          previewEnabled={previewable}
          variant="mini"
          onPickPlan={() => openPlanBoard(side)}
          onPickBuild={() => showBuildStage(side)}
          onPickPreview={() => openPreview(side)}
        />
      </div>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {failed ? (
          <PreviewMessage
            testId="preview-failed"
            icon={<FiAlertTriangle size={18} color={C.dangerInk} />}
            title={entry?.status === "crashed" ? "The dev server crashed" : "The dev server failed to start"}
            detail={entry?.error ?? "No error output was captured."}
          />
        ) : refused ? (
          // A NON-LOOPBACK URL IS A REFUSAL WITH WORDS, not a blank frame. CSP would refuse the
          // navigation anyway, but a CSP refusal paints an empty rectangle — indistinguishable from
          // a broken feature — and this is the only layer that can say which happened.
          <PreviewMessage
            testId="preview-refused"
            icon={<FiSlash size={18} color={C.dangerInk} />}
            title="Refused to show this address"
            detail={`A preview may only point at a local dev server (http://localhost, 127.0.0.1 or [::1]). This one was ${url}.`}
          />
        ) : framable ? (
          <iframe
            data-testid="preview-frame"
            // THE RELOAD MECHANISM, and it is the whole of it. React leaves an element with an
            // unchanged key alone, so re-rendering with the same `src` does not re-fetch anything;
            // changing the key makes React destroy and recreate the element, which is a fresh load.
            key={entry?.reloadNonce ?? 0}
            title="Live preview"
            src={url ?? undefined}
            sandbox={PREVIEW_SANDBOX_TOKENS.join(" ")}
            referrerPolicy="no-referrer"
            // ── THE PERMISSIONS POLICY. See PREVIEW_PERMISSIONS_POLICY for why it is not "". ───
            allow={PREVIEW_PERMISSIONS_POLICY}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: "none",
              // The framed page paints its own background; white underneath keeps a page that has
              // not painted yet from flashing the shell's dark ground through it.
              background: "#fff",
            }}
          />
        ) : pane === "stopped" ? (
          // STOPPED IS ITS OWN ANSWER, and it must not fall into the branch below. `stopped` is a
          // RETAINED entry — `clearPreview` runs only from `stopPreviewForAgent`, and the stopped
          // event still carries the loopback url — so once framing became conditional on a live
          // state, a stopped server matched "entry exists, not framable" and the pane claimed to be
          // starting a server nobody had asked for, permanently. The cost of getting this wrong is
          // not cosmetic: it is the pane asserting work that is not happening.
          <PreviewMessage
            testId="preview-stopped"
            icon={null}
            title="The dev server was stopped"
            detail="Open the preview again from that agent's card in the Build column to start a fresh one."
          />
        ) : pane === "starting" ? (
          <PreviewMessage
            testId="preview-starting"
            icon={null}
            title="Starting the dev server…"
            // GATED ON `starting` BY NAME, not on "an entry exists". This used to branch on
            // `listening`/`ready` for "It is up and compiling the first page" — copy that became
            // unreachable when those states started framing — and the fall-through it left behind
            // then swallowed `stopped` (above). Naming the state is what keeps the title honest.
            detail="This takes a few seconds on a cold start, and longer if dependencies are still installing."
          />
        ) : entry ? (
          // AN ENTRY WE DO NOT RECOGNISE IS NOT "no preview running", and telling the user there is
          // none — with no Reload button, since that is gated on `framable` — is the worse half of
          // the bug the `stopped` branch just fixed: a live server reported as absent. This is
          // reachable rather than theoretical: `applyPreviewStatus` passes the wire's `state`
          // straight into the store with no validation, so a state this build's union does not name
          // lands HERE. Two other mechanisms cover the neighbouring halves, and this comment named
          // neither correctly until now — it cited `PREVIEW_STATE_IS_HANDLED`, a symbol that no
          // longer exists, and claimed nothing ties the Rust enum to this union, which stopped
          // being true in the same commit that deleted it:
          //   * `PANE_FOR` (ABOVE) is a total `Record<PreviewState, …>`, so adding a union member
          //     without deciding what it renders is a COMPILE error.
          //   * `previewSeam.test.ts` reads `pub enum PreviewState` out of preview.rs and compares
          //     it to the union, so a Rust variant added without updating the union REDS.
          // What neither can cover is the wire arriving ahead of the types — an older desktop build
          // talking to a newer agent — which is this branch.
          <PreviewMessage
            testId="preview-unknown"
            icon={null}
            title="This preview is in a state Sparkle does not recognise"
            detail={`The server reported "${String(entry.status)}". It may still be running — reopen the preview from that agent's card, and if this persists the desktop app is older than the agent that started it.`}
          />
        ) : (
          // No entry at all is a DIFFERENT fact from `stopped`, and the copy says so rather than
          // implying something went wrong. This is the state a column lands in when the mode is
          // entered before (or without) anything asking for a server.
          <PreviewMessage
            testId="preview-empty"
            icon={null}
            title="No preview running"
            detail={
              previewable
                ? "Open one from an agent's card in the Build column — the preview follows that agent's worktree."
                : "This project has no dev server Sparkle can start."
            }
          />
        )}
      </div>
    </div>
  );
}

/** Bumps the nonce that the iframe's `key` is wired to. A separate component only so the hover
 *  treatment does not re-render the frame's parent on every pointer move. */
function ReloadButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="preview-reload"
      title="Reload the preview"
      aria-label="Reload the preview"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flex: "0 0 auto",
        background: "transparent",
        color: hover ? C.cream : C.muted,
        border: `1px solid ${C.pillFill}`,
        borderRadius: RADIUS.sm,
        padding: "2px 7px",
        cursor: "pointer",
        fontFamily: FONT_UI,
        // `small` (12), not `micro` (10): scale.ts assigns micro to "the tracked mono LABELS, badges,
        // stage ticks" — the treatment `LABEL` pairs with FONT_MONO and 0.1em tracking, which is
        // what makes 10px legible. This is an interactive control in FONT_UI with no tracking, and
        // small's own register is "chips, hints, most controls". At micro the word would also have
        // rendered smaller than the 11px icon beside it.
        fontSize: TYPE.small,
        lineHeight: 1.4,
      }}
    >
      <FiRefreshCw size={11} />
      Reload
    </button>
  );
}

/** The pane's non-frame states. One component so "failed", "refused", "starting" and "empty" are
 *  visibly the same kind of thing — a sentence about the server — rather than three ad-hoc layouts
 *  that drift. */
function PreviewMessage({
  testId,
  icon,
  title,
  detail,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        textAlign: "center",
        padding: 24,
      }}
    >
      {icon}
      {/* `body` (13) semibold, NOT `title` (17). `title` is scale.ts's CEILING — "section and dialog
          titles" — and every other call site for it is a modal or dialog heading. This is an
          in-pane state card ("starting…", "failed", "refused") inside a column that can be narrow;
          at 17 a routine "no dev server here" would render at the same size as the Settings dialog
          heading. 13 semibold is the step its own 12px detail text is scaled against. */}
      <div style={{ fontSize: TYPE.body, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
        {title}
      </div>
      {/* The stderr tail, when there is one. `pre-wrap` so a multi-line stack keeps its shape —
          this is the text that tells the user WHY, and reflowing it into a paragraph is how a
          stack trace becomes unreadable. */}
      <div
        data-testid={`${testId}-detail`}
        style={{
          color: C.muted,
          maxWidth: 520,
          maxHeight: "40%",
          overflow: "auto",
          lineHeight: 1.5,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          textAlign: "left",
        }}
      >
        {detail}
      </div>
    </div>
  );
}
