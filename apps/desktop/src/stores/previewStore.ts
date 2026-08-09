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

/** The server-side state machine (design §5), verbatim from the Rust contract. `starting` →
 *  `listening` → `ready` → `serving` on the happy path; `failed` is reachable from `starting` /
 *  `listening` (the process exited, or no port inside the timeout) and `crashed` from `serving`. */
export type PreviewState =
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
  setPreview: (agentId: string, next: PreviewUpdate) => void;
  clearPreview: (agentId: string) => void;
  bumpReload: (agentId: string) => void;
  setCapability: (projectId: string, cap: PreviewCapability) => void;
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
  // THE UNCHANGED-VALUE BAIL IS LOAD-BEARING, not a micro-optimisation. `preview:state` is emitted
  // on every transition and a dev server's readiness probe can repeat a state several times over;
  // returning `s` unchanged means a repeat costs zero subscriber wake-ups, and — the part that
  // matters more — the iframe's surrounding React tree does not re-render, so a redundant event can
  // never cost the framed page anything.
  setPreview: (agentId, next) =>
    set((s) => {
      const prev = s.byAgent[agentId];
      if (prev && sameUpdate(prev, next)) return s;
      const entry: PreviewEntry = {
        ...next,
        // Both carried forward. `startedAt` is when THIS preview appeared, not when the last event
        // did; `reloadNonce` belongs to the user's reload button and a server event must never
        // reset it (that would silently re-create the frame under them).
        startedAt: prev?.startedAt ?? Date.now(),
        reloadNonce: prev?.reloadNonce ?? 0,
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
}));
