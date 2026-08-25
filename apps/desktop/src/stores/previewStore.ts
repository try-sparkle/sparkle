// previewStore — the live state of each agent's dev-server preview, and which projects can have one.
//
// IN-MEMORY ONLY, AND THAT IS A DESIGN DECISION RATHER THAN AN OMISSION (design doc §8: "never in
// the persisted `uiStore` blob"). Every field here describes a CHILD PROCESS that belongs to this
// run of the app: a port allocated at runtime, a url that names it, a state machine that ends at
// `stopped`. The preview registry is swept at startup precisely because none of it survives. A
// persisted copy would therefore restore a url to a port that either answers nothing or — worse —
// now belongs to something else entirely, and the pane would render that with no way for the user
// to tell. `terminalOverlayStore` is the shape this follows: plain `create`, no `persist`, and an
// unchanged-value bail in every setter.
//
// KEYED BY agentId, not by pair side. A preview belongs to the agent whose worktree it serves, and
// the pane that shows it is looked up FROM the selected agent — so moving a project between pairs,
// or selecting a different row, changes which preview is on screen without touching any of this.
// Keying by side would have made "the left pane's preview" a fact about the layout.
import { create } from "zustand";

/** The server-side state machine (design §5), verbatim from the Rust contract.
 *
 *  WHAT THE ENGINE ACTUALLY DRIVES: `installing` → `starting` → `listening` → `ready`, and then
 *  nothing until the process dies. `installing` is reachable only when `node_modules` was not yet
 *  on disk at open time (Phase 2 — most opens skip straight to `starting`, since `deps_bootstrap`
 *  usually finished long before anyone clicks Preview). `failed` is reachable from `installing`
 *  (the deps wait timed out) / `starting` / `listening` (the process exited, or no port inside the
 *  timeout); `crashed` is what a server that HAD bound a port becomes when it exits, so it follows
 *  `listening` or `ready`.
 *
 *  `serving` IS PART OF THE WIRE TYPE AND HAS NO WRITER (bead `sparkle-l7cihu`). This doc used to
 *  put it at the end of the happy path and to hang `crashed` off it; `supervise` reaches `ready`
 *  and stops, and `http_probe` is never retried, so a server that binds before it can answer HTTP
 *  latches at `listening` permanently. Keep parsing and handling `"serving"` anyway — see
 *  `SURFACING_STATES` below for why the set must not be narrowed. */
export type PreviewState =
  | "installing"
  | "starting"
  | "listening"
  | "ready"
  | "serving"
  | "failed"
  | "crashed"
  | "stopped";

/**
 * One `preview:state` payload, as Rust emits it.
 *
 * EVERY OPTIONAL FIELD IS `T | null`, NOT `T | undefined`, AND THAT IS THE WHOLE CONTRACT (bead
 * `sparkle-16y6h`). serde's derive emits an `Option::None` as the key with a `null` value — it
 * omits the key only under `#[serde(skip_serializing_if)]`, which this payload does not use. So a
 * type written `url?: string` describes a shape the wire CANNOT PRODUCE. That mistake does not fail
 * loudly: an all-or-nothing parser rejects the whole payload, falls back to its "we did not look"
 * default, and the feature is permanently inert with nothing logged — for everyone, because `None`
 * is what the common case (a server that has not bound a port yet) sends. Fixtures must carry
 * `null` too, or they test a case production never produces.
 */
export interface PreviewStatus {
  id: string;
  agentId: string;
  projectId: string;
  url: string | null;
  port: number | null;
  state: PreviewState;
  error: string | null;
}

/** `preview_capability`'s answer for a worktree. `target` describes WHAT would be run; the UI needs
 *  only `previewable`, but the decline reason is what makes a missing affordance explicable. */
/** MIRRORS `preview.rs`'s `PreviewTarget` field for field. Do not add a field the Rust struct
 *  cannot emit.
 *
 *  This previously declared `{ command, port, path }`. `command` exists in NO payload the Rust side
 *  can produce, so any read of `target.command` would have been `undefined` while typechecking
 *  clean — and `path` is a plain `String` in Rust (empty means the worktree root), so typing it
 *  `string | null` invited a null branch that can never be taken. It was inert only because nothing
 *  reads `target` yet, which is exactly when this is cheapest to fix and hardest to notice.
 *
 *  The durable fix is a generated type or one shared fixture both suites parse (`ts-rs`/`specta`),
 *  so the Rust test asserting serde's output and the TS test asserting the parser fail TOGETHER.
 *  Until that exists this comment is the guard. */
export interface PreviewTarget {
  framework: string;
  /** Program NAME (e.g. `pnpm`), resolved to an absolute path at spawn. */
  program: string;
  /** Everything before the injected port flags, e.g. `["run", "dev"]`. */
  args: string[];
  /** Whether a `--` must separate the script's own args from the injected flags. */
  needsArgSeparator: boolean;
  /** Directory to run in, relative to the worktree root. EMPTY STRING = the root, never null. */
  path: string;
  /** Which detection rule produced this, so a wrong answer is traceable to a rule. */
  source: string;
  /** A port pinned by project config; `null` = Sparkle allocates one. Rust `Option<u16>` crosses
   *  the wire as an explicit `null`, never as an absent key. */
  port: number | null;
}
export interface PreviewCapability {
  previewable: boolean;
  target?: PreviewTarget | null;
  declineReason?: string | null;
}

/** What the pane needs to know about one agent's preview. A projection of the last `PreviewStatus`
 *  seen for that agent, plus the two facts that are ours rather than Rust's. */
export interface PreviewEntry {
  /** The server's id, for `preview_stop({ id })`. Null until the first event arrives. */
  id: string | null;
  status: PreviewState;
  url: string | null;
  port: number | null;
  error: string | null;
  /** When this agent's preview first appeared in the store, for a "starting…" elapsed readout.
   *  PRESERVED across `setPreview`, so a status tick does not reset it — and so an identical
   *  update can bail out by identity (see below). */
  startedAt: number;
  /** Bumped by `bumpReload`, wired to the iframe's `key`. React recreates an element whose key
   *  changed, which is what makes "Reload" actually re-fetch rather than being a no-op that looks
   *  fine: the same element with the same `src` is left alone. */
  reloadNonce: number;
  /**
   * When this preview last became WORTH SURFACING — the moment it entered `ready`/`serving`. Null
   * until it ever has.
   *
   * This is condition 5's clock (design §10: "the request is fresher than a TTL (5s, matching
   * `REVEAL_REQUEST_TTL_MS`)"), and it is a TRANSITION stamp rather than a last-seen-at. That
   * conclusion is right; the reason this comment used to give for it was not, and the wrong reason
   * propagated (bead `sparkle-l7cihu`). It said "a dev server re-emits `serving` on every hot
   * reload". It does not. `preview.rs`'s `supervise` runs its discovery block at most once (`if
   * bound.is_none()`) and afterwards only checks for death, so a HEALTHY preview emits nothing
   * further at all — which is stated correctly 30-odd lines below, on `lastActivityAt`, and was
   * simply not read here.
   *
   * THE REAL REASON is that the repeats which DO exist are the app's own re-reads, and they are
   * exactly the ones a freshness clause must not be fooled by. `preview_list` re-folds every live
   * preview through `applyPreviewStatus` whenever a window mounts and reconciles, and
   * `fetchPreviewStatus` does the same for one agent — including from `resolvePreviewOpenTarget`,
   * i.e. from the act of opening itself. A last-seen stamp would therefore mark a server that has
   * sat `ready` for an hour as freshly surfaced the moment anything looked at it, and the freshness
   * clause — the one thing standing between "a build finished" and "a pane opened three minutes
   * later" — would never bind. A transition stamp cannot be moved by a re-read, because a re-read
   * carries the state it already had.
   *
   * `setPreview`'s unchanged-value bail already gives this for free on an identical repeat; the
   * explicit `prev.status !== next.status` test below covers the repeat that carries a new url or
   * port, which is not identical but is not a fresh surfacing either.
   *
   * OPTIONAL, unlike its two neighbours, and NOT for the `T | null` wire reason stated at the top
   * of this file — this field never crosses the Rust boundary; `setPreview` is its only writer and
   * always populates it. It is optional so a hand-built fixture that predates it keeps compiling,
   * and because omitting it fails CLOSED: an absent stamp reads as "never surfaced", which makes
   * `previewOpenOutcomeFor` decline. The direction matters more than the strictness here — the
   * value's whole job is to withhold permission to open a pane unasked.
   */
  surfacedAt?: number | null;
  /**
   * When this preview last showed a SIGN OF LIFE — the clock `previewIdleGrace` measures against
   * `[preview] idle_grace_min`. Null on a hand-built fixture that predates it.
   *
   * ══ A LAST-SEEN-AT, WHICH IS EXACTLY WHAT `surfacedAt` REFUSES TO BE ════════════════════════
   * Its neighbour above is a TRANSITION stamp and says why at length: a last-seen-at there would
   * hold the auto-open freshness TTL permanently open. This field wants the opposite, because it
   * answers the opposite question — not "did something just become worth showing" but "has
   * anything happened to this server lately". So it is written on EVERY `setPreview`, including
   * the ones the unchanged-value bail throws away.
   *
   * ══ WRITTEN THROUGH THE BAIL, IN PLACE, AND THAT IS THE WHOLE TRICK ═════════════════════════
   * "Record the activity" and "re-render the card" are two different things, and the bail exists
   * only for the second. So the bail path MUTATES this one field on the entry it is about to
   * return unchanged: `byAgent` keeps its identity, the entry keeps its identity, zustand's
   * `Object.is` short-circuit fires, no subscriber wakes, and nothing re-renders — while the
   * timestamp still moves. Nothing renders from this field, by construction; its only reader is
   * the idle clock, which polls the store rather than subscribing to it.
   *
   * ══ WHAT COUNTS AS ACTIVITY IS BROADER THAN THE WIRE ════════════════════════════════════════
   * `preview.rs`'s `supervise()` stops emitting once a server is `Ready` — it sleeps on a liveness
   * check and transitions again only to `Crashed`/`Failed`. So a healthy preview produces NO
   * further events at all, and a wire-only clock would be a max-lifetime cap wearing an idle
   * clock's name. {@link notePreviewActivity} is the seam for the rest: the card's ⟳, a click
   * through to the url, an agent's `preview_inspect`. Each of those is a human or an agent saying
   * "this preview is still wanted", which is precisely what the grace window is asking about.
   */
  lastActivityAt?: number | null;
}

/** The states in which a preview is worth putting in front of the user: it has compiled and is
 *  answering. `listening` is deliberately NOT one — a port is bound before the first build
 *  finishes, so surfacing there shows the framework's own "compiling" page, which is the "several
 *  of them showing a broken build" outcome §10 exists to prevent.
 *
 *  `serving` IS IN THIS SET AND MUST STAY IN IT, EVEN THOUGH NOTHING PRODUCES IT TODAY — recorded
 *  here rather than acted on (bead `sparkle-l7cihu`). Grep both languages: every construction of
 *  `PreviewState::Serving` outside a test fixture is a PREDICATE reading it, never a writer.
 *  `supervise` drives `listening` → `ready` and then only terminal failure; the enum's own doc
 *  comment says "`serving` is set by the frontend once its frame is actually showing the page",
 *  and that is false too — no frontend code writes `"serving"` outside test fixtures either.
 *  Several predicates nonetheless treat it as live, and all of them are correct to: this set,
 *  `previewIdleGrace`'s `LIVE_STATES`, `AgentRow`'s preview affordance, and on the Rust side
 *  `is_framable` (preview_capture.rs) and `live_for_reattach` (preview.rs).
 *
 *  DO NOT NARROW ANY OF THEM ON THE STRENGTH OF THAT. The wire type still ADMITS `"serving"` — it
 *  is a variant of the serialized `PreviewState`, so a future writer (or an older/newer build on
 *  the other side of the IPC boundary) can send it at any time, and a frontend that had quietly
 *  dropped the state would then paint a live preview as nothing at all. Handling a state nobody
 *  sends costs one set member; failing to handle one somebody sends costs the feature. The real
 *  hazard is the opposite direction, and it is why the false header above survived a full green
 *  suite: EVERY existing test feeds `"serving"` in BY HAND, so the dead variant looks thoroughly
 *  exercised. A fixture using `serving` is not evidence that anything emits it. */
const SURFACING_STATES: ReadonlySet<PreviewState> = new Set<PreviewState>(["ready", "serving"]);

/** Is this a state whose ARRIVAL should arm the auto-open predictor? See `surfacedAt`. */
export function isSurfacingState(state: PreviewState): boolean {
  return SURFACING_STATES.has(state);
}

/** The fields an update carries. `startedAt` / `reloadNonce` are ours and are never overwritten by
 *  a wire event, which is why this is a distinct shape rather than `Partial<PreviewEntry>`. */
export type PreviewUpdate = Pick<PreviewEntry, "id" | "status" | "url" | "port" | "error">;

interface PreviewStoreState {
  /** agentId -> that agent's live preview. A MISSING key means "no preview", which is a different
   *  fact from `stopped` (a server that ran and has since been stopped) and is why `clearPreview`
   *  deletes rather than writing a tombstone. */
  byAgent: Record<string, PreviewEntry>;
  /** projectId -> what `preview_capability` said. `undefined` means NOT ASKED YET — deliberately
   *  distinct from `{ previewable: false }`, so a UI that hides an affordance on a false can tell
   *  "we know this project cannot be previewed" from "the probe has not answered". */
  capability: Record<string, PreviewCapability | undefined>;
  /**
   * projectId -> "the USER has opened a preview here at least once THIS SESSION" — condition 2 of
   * the auto-open conjunction (design §10).
   *
   * IN-MEMORY AND PER-SESSION BY DESIGN, not by omission, and for a stronger reason than the rest
   * of this store. The other fields describe child processes that cannot outlive the app; this one
   * describes a *permission to interrupt*, and persisting it would mean a preview the founder
   * opened once, weeks ago, silently licenses a pane to pop on its own every launch afterwards.
   * "Returning" means returning within this sitting. It is deliberately NOT in the persisted
   * `uiStore` blob.
   *
   * A RECORD RATHER THAN A `Set` because zustand's state is compared and serialized in places a
   * `Set` degrades to `{}` — the same reason `byAgent` is a record.
   */
  openedProjects: Record<string, true>;
  setPreview: (agentId: string, next: PreviewUpdate) => void;
  clearPreview: (agentId: string) => void;
  bumpReload: (agentId: string) => void;
  setCapability: (projectId: string, cap: PreviewCapability) => void;
  /** Record that the user asked for a preview in this project. Called from
   *  `services/preview.openPreviewServer` on a `user`-initiated open ONLY — an agent opening its
   *  own preview through the control bridge must not forge the returning-user signal that gates an
   *  unasked pane. */
  markPreviewOpenedForProject: (projectId: string) => void;
}

/** True when a wire update says nothing new. Compared field-by-field rather than by object
 *  identity, because every event arrives as a freshly-deserialized object. */
function sameUpdate(a: PreviewEntry, b: PreviewUpdate): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.url === b.url &&
    a.port === b.port &&
    a.error === b.error
  );
}

export const usePreviewStore = create<PreviewStoreState>((set) => ({
  byAgent: {},
  capability: {},
  openedProjects: {},
  // THE UNCHANGED-VALUE BAIL IS LOAD-BEARING, not a micro-optimisation. `preview:state` is emitted
  // on every transition and a dev server's readiness probe can repeat a state several times over;
  // returning `s` unchanged means a repeat costs zero subscriber wake-ups, and — the part that
  // matters more — the iframe's surrounding React tree does not re-render, so a redundant event can
  // never cost the framed page anything.
  setPreview: (agentId, next) =>
    set((s) => {
      const prev = s.byAgent[agentId];
      if (prev && sameUpdate(prev, next)) {
        // IN-PLACE, AND ONLY THIS FIELD. A repeat event is still a sign of life, so the idle clock
        // must see it — but the projection is unchanged, so the card must not re-render. Mutating
        // the entry rather than replacing it is what separates those two: `s` is returned by
        // identity, zustand's `Object.is` check short-circuits, and no subscriber is woken. See
        // `lastActivityAt`'s note on PreviewEntry.
        prev.lastActivityAt = Date.now();
        return s;
      }
      const entry: PreviewEntry = {
        ...next,
        // Both carried forward. `startedAt` is when THIS preview appeared, not when the last event
        // did; `reloadNonce` belongs to the user's reload button and a server event must never
        // reset it (that would silently re-create the frame under them).
        startedAt: prev?.startedAt ?? Date.now(),
        reloadNonce: prev?.reloadNonce ?? 0,
        // STAMPED ON THE TRANSITION INTO a surfacing state, and carried forward otherwise. A
        // status that arrives already equal to the previous one is not a fresh surfacing however
        // else the payload differs — see the `surfacedAt` note on PreviewEntry for why a
        // last-seen-at here would make condition 5 permanently true.
        surfacedAt:
          isSurfacingState(next.status) && prev?.status !== next.status
            ? Date.now()
            : (prev?.surfacedAt ?? null),
        // A LAST-SEEN-AT, unlike its neighbour: every update is activity, including one that only
        // moved the url. The bail above stamps the repeats this branch never sees.
        lastActivityAt: Date.now(),
      };
      return { byAgent: { ...s.byAgent, [agentId]: entry } };
    }),
  // DELETES THE KEY, rather than writing `undefined` into it. `agentId in byAgent` is the honest
  // spelling of "does this agent have a preview", and a key holding `undefined` answers that with
  // `true` — so a tombstone would leave the pane believing there is a preview whose every field is
  // missing. It also survives serialization boundaries differently, which is the kind of difference
  // that only shows up somewhere far away.
  clearPreview: (agentId) =>
    set((s) => {
      if (!(agentId in s.byAgent)) return s;
      const { [agentId]: _removed, ...byAgent } = s.byAgent;
      return { byAgent };
    }),
  // A no-op when there is nothing to reload: bumping a nonce for an absent preview would create a
  // half entry with no status, which the pane would then have to defend against.
  bumpReload: (agentId) =>
    set((s) => {
      const prev = s.byAgent[agentId];
      if (!prev) return s;
      return {
        byAgent: { ...s.byAgent, [agentId]: { ...prev, reloadNonce: prev.reloadNonce + 1 } },
      };
    }),
  setCapability: (projectId, cap) =>
    set((s) => {
      const prev = s.capability[projectId];
      if (
        prev &&
        prev.previewable === cap.previewable &&
        (prev.declineReason ?? null) === (cap.declineReason ?? null)
      ) {
        return s;
      }
      return { capability: { ...s.capability, [projectId]: cap } };
    }),
  // The unchanged-value bail, same as every setter above: this is written on each manual open, and
  // after the first one every later call is a no-op that must not wake a subscriber.
  markPreviewOpenedForProject: (projectId) =>
    set((s) =>
      s.openedProjects[projectId]
        ? s
        : { openedProjects: { ...s.openedProjects, [projectId]: true } },
    ),
}));

/**
 * Record that something still wants this agent's preview, WITHOUT changing what anything renders.
 *
 * The seam named in `lastActivityAt`'s note: `preview.rs` goes silent once a server is `Ready`, so
 * every remaining sign of life is a human's or an agent's, and each one arrives through a caller
 * that is not a wire event — the card's ⟳ refresh and its click-through (`PreviewCards.tsx`), an
 * agent's `preview_inspect` capture. Call this from any of them and the idle-grace window restarts.
 *
 * WRITES NOTHING TO ZUSTAND. It mutates the one non-rendered field on the existing entry, exactly
 * as `setPreview`'s bail does, so it can be called from a click handler or a render-adjacent effect
 * without costing a re-render — and so it cannot loop by waking the subscription that called it.
 * A no-op when there is no entry: activity on a preview that does not exist is not a fact worth
 * inventing an entry for.
 *
 * @returns whether there was an entry to stamp — so a caller that cares can tell "recorded" from
 *          "there is no preview here", rather than having to re-read the store to find out.
 */
export function notePreviewActivity(agentId: string, at: number = Date.now()): boolean {
  const entry = usePreviewStore.getState().byAgent[agentId];
  if (!entry) return false;
  entry.lastActivityAt = at;
  return true;
}
