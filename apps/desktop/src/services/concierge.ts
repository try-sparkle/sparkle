// Frontend driver for the Concierge brain (PRD/sparkle/concierge-mode.md §5, bead sparkle-ma6e).
//
// The Rust side (`src-tauri/src/concierge.rs`) runs the user's own headless `claude -p` over a
// snapshot prompt and streams the reply back as Tauri events; this service is the thin,
// never-throwing seam the concierge UI (U1) and the integrator (U7) drive:
//
//   - `startConciergeTurn(prompt)` invokes `concierge_turn`. Session continuity is automatic:
//     the manager below remembers the `sessionId` from each `concierge:done` and passes it as
//     `resume_session_id` on the next turn, so the concierge holds ONE ongoing conversation.
//   - `cancelConciergeTurn()` kills the in-flight turn (whole process group, Rust side).
//   - `onConciergeDelta/Done/Error(cb)` subscribe to the stream; each returns a synchronous
//     unsubscribe. Callbacks are fanned out from ONE internal Tauri listener per event, which
//     is what lets the manager capture the session id even when no UI is subscribed, and lets
//     an invoke failure surface as a normal error event instead of a thrown rejection.
//
// Error posture (mirrors improvementPass.ts): nothing here throws to callers. A failed invoke
// or listen is logged and delivered to `onConciergeError` subscribers as a synthetic event, so
// the concierge column always has something to render.
import { invoke } from "@tauri-apps/api/core";
import { conciergeAiEnabled } from "./conciergeTools/policyBinding";
import { drainConciergeInbox } from "./conciergeInbox";
import { listen } from "@tauri-apps/api/event";
import { conciergeSessionInfo, type ClaudeSessionInfo } from "../preflight";
import {
  accountConfigDirFor,
  conciergeFallbackConfigDirs,
  CONCIERGE_ACCOUNT_KEY,
  type ResolvedConfigDir,
} from "./accountSelection";

/** Incremental assistant text for the turn `id` (`concierge:delta`). */
export interface ConciergeDeltaEvent {
  id: string;
  text: string;
}

/** One tool call the concierge made during the turn: the tool `name` and its FULL arguments,
 *  as `serde_json`'s compact serialization of the call's `input` (`"{}"` when it had none).
 *
 *  A string, not a parsed object, because the consumer scans it for verbatim overlap with the
 *  reply rather than navigating it — and because a very large payload is truncated at capture
 *  (Rust: `MAX_TOOL_USE_INPUT_CHARS`), which leaves it valid text but not necessarily valid JSON.
 *  Do not `JSON.parse` it without guarding.
 *
 *  This is deliberately NOT `conciergeAudit.ts`'s record of the same calls: that store truncates
 *  every argument value at 220 characters, far below the length of a relayed message, so it cannot
 *  answer "did the reply paste back the text we sent?". */
export interface ConciergeToolCall {
  name: string;
  input: string;
}

/** Final reply for the turn `id` (`concierge:done`). `sessionId` is the Claude Code session to
 *  resume next turn — the manager stores it automatically. `toolCalls` is what the turn actually
 *  SENT, correlated to this reply by construction (Rust captures both from the one stream parse). */
export interface ConciergeDoneEvent {
  id: string;
  sessionId: string;
  text: string;
  toolCalls: ConciergeToolCall[];
}

/**
 * ONE tool call, delivered WHILE THE TURN IS STILL RUNNING (`concierge:tool`).
 *
 * ══ WHY THIS EXISTS ALONGSIDE `ConciergeDoneEvent.toolCalls` ════════════════════════════════════
 * They carry the same facts at opposite ends of a turn, for opposite consumers. `toolCalls` rides
 * the `done` event and is a COMPLETE, correlated record for after-the-fact analysis (the concierge
 * lint reads it to ask "did the reply paste back the text we relayed?"), which is why its `input`
 * is kept at full length. That record is worthless for a status line: it arrives when the turn is
 * over and there is nothing left to report.
 *
 * This one is the live half. Rust emits it from the same drain loop that emits `concierge:delta`,
 * the moment a `tool_use` block is parsed, so the column can say what the concierge is doing while
 * it is still doing it. Its `input` is clamped much shorter (512 chars, Rust's
 * `MAX_LIVE_TOOL_INPUT_CHARS`) because the only consumer sniffs the leading verb of a command or
 * the kind of a path — it never renders the payload.
 *
 * CONSEQUENCE FOR CALLERS: `input` MAY BE TRUNCATED AND THEREFORE NOT VALID JSON. Do not
 * `JSON.parse` it without a guard — see `engine/conciergeNativeToolLine`, which owns that parse.
 *
 * `name` is the tool's name verbatim as Claude Code reported it — "Bash", "Read", "Grep",
 * "mcp__sparkle-control__sparkle_terminal". It is NOT filtered here: the `mcp__sparkle-control__*`
 * calls also arrive on this channel, and dropping them is a POLICY decision that belongs with the
 * phrasing (those calls are already described far better by the control path, which has resolved
 * agent names and clickable pills). Transport reports; policy decides.
 */
export interface ConciergeToolEvent {
  id: string;
  name: string;
  input: string;
}

/** A failed turn (`concierge:error`). `detail` is the most specific reason available (claude's
 *  own error text, stderr, or an exit-status phrase). */
export interface ConciergeErrorEvent {
  id: string;
  detail: string;
}

/** The Rust side's sentinels for "this send was superseded / cancelled" (concierge.rs). Matched as
 *  substrings because Tauri wraps a command's Err string. Kept in one place so the silent-outcome
 *  rule is visible next to the error path it bypasses, and EXPORTED so the test matches on these
 *  rather than re-typing them — the Rust side pins its own literals in a sibling test, so a reword
 *  on either side fails somewhere instead of silently un-silencing the outcome (roborev 53205). */
export const SUPERSEDED_DETAILS = [
  "concierge_turn: superseded before install",
  "concierge_turn: cancelled",
] as const;

/** Is this failure detail one of those NON-failures? A real exported function rather than a rule
 *  each site restates (roborev 53460/53462): there are three places that must agree — the
 *  invoke-rejection catch, the `concierge:error` listener that owns `currentSessionId`, and the
 *  host's error handler that owns the thread and the typing indicator — and a fourth will show up.
 *  A site that open-codes `.some(...)` is a site that can be forgotten when the rule changes.
 *
 *  Substring, not equality: Tauri wraps a command's `Err` string, and the retry path can fold the
 *  sentinel into a longer detail. */
export function isSupersededDetail(detail: string): boolean {
  return SUPERSEDED_DETAILS.some((d) => detail.includes(d));
}

/** The `id` used for errors synthesized on THIS side of the bridge (a rejected invoke/listen),
 *  where no Rust turn token exists. */
export const CONCIERGE_LOCAL_ERROR_ID = "local";

/** The Rust side's sentinel for "this PROACTIVE push stood down because the user owns the turn"
 *  (`concierge.rs::PROACTIVE_DECLINED_ERR`). Pinned as a literal on both sides — see the mirrored
 *  tests — because nothing else ties the two languages together. */
export const PROACTIVE_DECLINED_DETAIL =
  "concierge_proactive_turn: declined; the user owns the conversation";

/** Is this failure detail a declined push rather than a real failure? Substring, for the same
 *  reason {@link isSupersededDetail} is: Tauri wraps a command's `Err` string. */
export function isProactiveDeclinedDetail(detail: string): boolean {
  return detail.includes(PROACTIVE_DECLINED_DETAIL);
}

/**
 * How many recent push turn ids to remember. Bounded because nothing else prunes it: a push that
 * neither completes nor errors (the webview reloads, the child is orphaned) would otherwise leave
 * an id behind for the life of the page.
 *
 * Sixteen is far more than can ever be live at once — the channel is capped at six turns an hour
 * and only one is ever in flight — while still outliving any bubble the thread is still rendering,
 * which is what the host reads it for.
 */
export const PROACTIVE_TURN_MEMORY = 16;

/** Turn ids this module opened with `concierge_proactive_turn`, newest last.
 *
 *  WHY THIS EXISTS (roborev 54166-M3). `concierge.rs` streams a push over the SAME
 *  `concierge:delta` / `concierge:done` / `concierge:error` events as a send, under the same turn
 *  token, and the payloads carry nothing that says which command produced them. So a push that
 *  failed AFTER spawning was indistinguishable from a send that failed: the error listener below
 *  rolled the user's live session pointer back for a turn nobody asked for, and the same event fanned
 *  out to every subscriber, where the host posted "I couldn't reach my brain just now" for a message
 *  the user never requested. Neither is filterable by any subscriber, because the information is not
 *  in the event — it is here, at the only place that knows which invoke opened which id. */
const proactiveTurnIds: string[] = [];

/** The `CLAUDE_CONFIG_DIR` each recent turn was actually spawned with, newest last.
 *
 *  A session id is only meaningful together with the account whose transcript tree holds it, and
 *  `concierge:done` — the authoritative writer of that id — carries no account of its own. Keyed by
 *  turn id, so the `done` can stamp the binding with the account ITS turn ran under rather than
 *  whatever the binding happens to say by the time it arrives.
 *
 *  Bounded like {@link PROACTIVE_TURN_MEMORY} and for the same reason: a turn that never reports
 *  (webview reload, orphaned child) would otherwise leave an entry behind for the life of the page. */
const turnAccounts = new Map<string, string | null>();

function rememberTurnAccount(id: string, configDir: string | null): void {
  turnAccounts.set(id, configDir);
  while (turnAccounts.size > PROACTIVE_TURN_MEMORY) {
    const oldest = turnAccounts.keys().next().value;
    if (oldest === undefined) break;
    turnAccounts.delete(oldest);
  }
}

function rememberProactiveTurn(id: string): void {
  if (proactiveTurnIds.includes(id)) return;
  proactiveTurnIds.push(id);
  if (proactiveTurnIds.length > PROACTIVE_TURN_MEMORY) proactiveTurnIds.shift();
}

/** Was this turn started by the PROACTIVE push channel rather than by a user send?
 *
 *  Read by the concierge column to render a push as a push — `proactive` + its digest, so
 *  {@link markStaleProactive} can retract it later — and by the error listener below to keep a
 *  push's failure off both the session pointer and the thread. */
export function isProactiveTurn(id: string): boolean {
  return proactiveTurnIds.includes(id);
}

type Callback<T> = (event: T) => void;

const deltaCallbacks = new Set<Callback<ConciergeDeltaEvent>>();
const doneCallbacks = new Set<Callback<ConciergeDoneEvent>>();
const errorCallbacks = new Set<Callback<ConciergeErrorEvent>>();
const toolCallbacks = new Set<Callback<ConciergeToolEvent>>();

/** The concierge's ongoing Claude Code session, captured from the last `concierge:done`.
 *  Module-level (not store state): it mirrors a real process-side resource, so it is never
 *  serialized — but it IS re-derived at boot from the transcript on disk, see
 *  {@link restoreConciergeSession}. */
let currentSessionId: string | null = null;

/** The last session id we know is RECOVERABLE — one the on-disk transcript reported at boot, or one
 *  a `concierge:done` confirmed actually ran. This is the "on-disk fallback" the error path falls
 *  back to instead of dropping all the way to null (spec §3 subsystem C1).
 *
 *  Why it has to exist separately from `currentSessionId`: that one also advances OPTIMISTICALLY on
 *  an accepted invoke (see `startConciergeTurn`), including an explicit `resumeSessionId` override
 *  the caller passed us. A failed turn must be able to discard THAT without discarding the
 *  conversation the user has actually been having. */
let fallbackSessionId: string | null = null;

/** WHICH ACCOUNT the session pointers above belong to — the `configDir` in force when the session
 *  was probed or last run. `undefined` means "no session is bound to an account yet".
 *
 *  A session id is not portable between accounts. Claude Code files transcripts under
 *  `<config>/projects/<slug>`, so the id the concierge is holding exists in exactly ONE account's
 *  tree; hand it to a child running under a different account and `--resume` simply fails. Before
 *  the spawn was account-aware this could not happen — there was only ever one tree — so nothing
 *  correlated the two. Now it can, and the failure is expensive and silent: the send path burns a
 *  second `claude` on its self-heal and starts over, while a proactive push (which has no retry, by
 *  design) is dropped with no trace.
 *
 *  So the account is remembered next to the id, and a change is handled BEFORE the turn rather than
 *  discovered by failing one. */
let sessionAccountConfigDir: string | null | undefined = undefined;

/** The account a turn (or a probe) will ACTUALLY use, given what resolution returned.
 *
 *  THE INVARIANT THIS EXISTS TO KEEP: the `--resume` id and the `CLAUDE_CONFIG_DIR` handed to the
 *  same `claude` must name the SAME transcript tree. A resume id only exists in one account's tree,
 *  so a turn that pairs them from different accounts is incoherent by construction.
 *
 *  `undefined` (the accounts backend could not be read) must therefore NOT fall to `null`. `null`
 *  means "the default account" — a real, different tree — so falling to it while keeping a pointer
 *  into another account's tree produces exactly the doomed `--resume` this module works to avoid:
 *  the send path pays a wasted `claude` on its self-heal and loses the conversation anyway, and the
 *  proactive path (no retry, by design) dies silently. Strictly worse than either coherent option.
 *
 *  So when the account is unknown, carry on with the one the session already belongs to. "I cannot
 *  read the account list" is not a reason to change accounts. */
function effectiveConfigDir(resolved: ResolvedConfigDir): string | null {
  if (resolved !== undefined) return resolved;
  return sessionAccountConfigDir ?? null;
}

/** Drop the session pointers if the account has moved out from under them, so no doomed `--resume`
 *  is ever issued. Returns nothing; the caller reads `currentSessionId` afterwards as usual.
 *
 *  Losing the pointer means the next turn starts a FRESH conversation on the new account. That is
 *  the honest outcome, not a regression: the old conversation is not lost, it is still sitting in
 *  the old account's transcript tree and comes back if the account does. The alternative — issuing
 *  the resume anyway — reaches the same fresh conversation, just one wasted `claude` process later,
 *  and only on the path that happens to have a retry. */
function rebindSessionToAccount(configDir: ResolvedConfigDir): void {
  // UNRESOLVED IS NOT A CHANGE. `undefined` means the accounts backend could not be read at all —
  // it does NOT mean "moved to the default account", which is `null`. Treating the two alike made
  // a single IPC hiccup discard the live conversation pointer AND the on-disk fallback, the exact
  // loss the error path exists to prevent, and then flip back on the next successful resolve. When
  // we do not know the account, we change nothing — and `effectiveConfigDir` keeps the turn itself
  // on that same account, so the retained pointer and the spawn still agree.
  if (configDir === undefined) return;
  if (sessionAccountConfigDir !== undefined && sessionAccountConfigDir !== configDir) {
    if (currentSessionId !== null || fallbackSessionId !== null) {
      console.info(
        "concierge: account changed; looking for this account's own conversation " +
          "(the previous one remains under the previous account).",
      );
    }
    currentSessionId = null;
    fallbackSessionId = null;
    // RETIRE ANY IN-FLIGHT PROBE, then re-probe.
    //
    // The epoch bump is not bookkeeping: a restore started before the switch captured
    // `startedAt = sessionEpoch` and resolved its own account back then, so if it lands after this
    // it would pass BOTH seed guards (`currentSessionId === null` — we just nulled it — and
    // `sessionEpoch === startedAt`) and seed the OLD account's session id, then stamp the binding
    // with the old account. The next turn would resume cross-tree, which is the failure this whole
    // function exists to prevent, reintroduced by the fix for it. Bumping the epoch makes that
    // stale probe fail its own guard, exactly as a user reset does.
    sessionEpoch++;
    // Clearing the memo is what makes the NEW account's own conversation reachable: the restore is
    // memoized for the life of the page, so without this nothing would ever look in the new tree
    // and the concierge would open a blank conversation on an account that already holds one — the
    // amnesia subsystem C exists to prevent, relocated onto the switch path.
    restoring = null;
  }
  sessionAccountConfigDir = configDir;
}

/** Resolves once the internal Tauri listeners are registered; null until first needed. */
let wiring: Promise<void> | null = null;

/** Resolves once the boot restore below has run (or decided not to); null until first needed. */
let restoring: Promise<void> | null = null;

/** Bumped by every DELIBERATE write to the session id ({@link setConciergeSessionId},
 *  {@link resetConciergeSession}). The boot restore is an async read-modify-write, so it snapshots
 *  this and refuses to apply if anything authoritative moved while its probe was in flight —
 *  otherwise a user who hits "start over" during the first second of app launch gets the old
 *  conversation handed back to them a moment later. */
let sessionEpoch = 0;

/** The epoch value that was IN FORCE when the most recent {@link resetConciergeSession} ran, or null
 *  if none has (per-process, like the epoch itself — a straggler `done` cannot cross a relaunch).
 *
 *  WHY THE EPOCH ALONE IS NOT ENOUGH. Three different things bump `sessionEpoch` and they mean three
 *  different things: an identity reset ("a different human"), {@link setConciergeSessionId} ("the
 *  same conversation, learned from outside the event stream") and {@link rebindSessionToAccount}
 *  ("the same human, a different account"). Only the first is grounds for the durable deny-list, and
 *  "not current" cannot tell them apart. Recording WHEN the reset happened can: epochs only ever
 *  increase, so a turn that started at or below this value was in flight when a reset orphaned it,
 *  and one that started above it was not — whatever the account binding happens to say later. */
let lastResetEpoch: number | null = null;

// ---------------------------------------------------------------------------------------------
// RETIRING A SESSION — the half of "forget this conversation" that outlives the process.
//
// `sessionEpoch` protects in-process writes, but the session pointer has a DURABLE source the epoch
// cannot reach: the on-disk Claude transcript, which {@link restoreConciergeSession} re-probes at
// every boot. So a reset that only cleared module state was undone by the next launch — and after
// `resetConciergeIdentityState` wired this to sign-out, that meant user B's first turn resuming user
// A's conversation with a genuinely empty column in front of it (roborev 55774). That is the
// invisible variant, and it is worse than the visible one.
//
// Retiring is a DENY-LIST rather than a cursor because the probe answers "the newest transcript on
// disk", which is a fact about the filesystem, not a position we can advance past. The list is
// bounded and newest-first: it only has to outlive the transcripts a probe could still surface, and
// an unbounded list of ids in localStorage would be its own slow leak.
//
// It backstops the in-flight race too. Retiring at reset time means a `done` that lands afterwards
// carrying the SAME session id is refused on identity grounds even if its turn was never tracked.
const RETIRED_SESSIONS_KEY = "sparkle-concierge-retired-sessions";
const MAX_RETIRED_SESSIONS = 20;

function readRetiredSessions(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RETIRED_SESSIONS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // A corrupt or unavailable store must not break a turn: treat it as "nothing retired". The cost
    // is the pre-existing behaviour, never a throw on the send path.
    return [];
  }
}

/** Record ids as belonging to a conversation that has been deliberately ended, so no later probe
 *  seeds them back. Silent on a storage failure, for the reason above. */
function retireSessionIds(...ids: Array<string | null>): void {
  const fresh = ids.filter((v): v is string => typeof v === "string" && v !== "");
  if (!fresh.length) return;
  try {
    const merged = [...new Set([...fresh, ...readRetiredSessions()])];
    localStorage.setItem(
      RETIRED_SESSIONS_KEY,
      JSON.stringify(merged.slice(0, MAX_RETIRED_SESSIONS)),
    );
  } catch {
    /* storage unavailable — see readRetiredSessions */
  }
}

/** Whether `id` names a conversation a reset has ended. Exported for the identity-reset test, which
 *  asserts the cross-launch half that an in-process assertion cannot see. */
export function isRetiredConciergeSession(id: string): boolean {
  return readRetiredSessions().includes(id);
}

/**
 * Turn id → the `sessionEpoch` in force when that turn STARTED.
 *
 * The `concierge:done` listener has no other way to tell whether the session it is reporting belongs
 * to the identity that is signed in NOW: it fires for whatever turn was in flight, and a turn started
 * before a sign-out completes after it. Bounded like everything else here — a `done` is the only
 * consumer and it deletes its own entry, so this holds at most the genuinely in-flight turns plus the
 * stragglers of turns that died without one.
 */
const turnEpochs = new Map<string, number>();
const MAX_TRACKED_TURNS = 50;

function rememberTurnEpoch(id: string, epoch: number): void {
  turnEpochs.set(id, epoch);
  // Insertion order is start order, so the first key is the oldest.
  while (turnEpochs.size > MAX_TRACKED_TURNS) {
    const oldest = turnEpochs.keys().next();
    if (oldest.done) break;
    turnEpochs.delete(oldest.value);
  }
}

/**
 * Does this turn still belong to the human who is signed in?
 *
 * READ-ONLY, so `delta` (which fires many times per turn) can ask repeatedly. An UNTRACKED turn
 * answers yes: that is the pre-existing behaviour for anything not started through the two starters,
 * and silently muting such a turn would be a worse failure than the one being fixed.
 */
function turnIsCurrent(id: string): boolean {
  const startedAt = turnEpochs.get(id);
  return startedAt === undefined || startedAt === sessionEpoch;
}

/**
 * "Every turn you were rendering is over, and its terminal event is not coming."
 *
 * THE FAN-OUT GATE NEEDS THIS TO BE HONEST (roborev 55813). `done` and `error` are the only two
 * signals that tear the host's per-turn state down — the typing indicator, the liveness latch, the
 * awaiting-bubble marker — and none of that is store state `resetConciergeIdentityState` can reach.
 * So dropping an orphaned turn's terminal event, which is right for its CONTENT, silently strands
 * all three: the spinner keeps running over a column that will never be answered, and if the
 * liveness bound elapses, a sticky "your concierge isn't answering" latches over a turn that may
 * actually have SUCCEEDED.
 *
 * A lifecycle signal rather than a doctored event, because the two say different things. Delivering
 * a text-free `done` would tell the host "your turn finished"; this says "the turn was abandoned" —
 * carrying no id and no text, so there is nothing of the previous conversation to render.
 *
 * NAMED FOR THE EVENT, NOT FOR ONE OF ITS CAUSES (roborev 55969). This landed as
 * `onConciergeIdentityReset` and was renamed within the hour, because a sign-out is only one of the
 * two things that orphans a turn — see {@link orphanInFlightTurns}. A subscriber that tears down
 * indicator state does so for the same reason either way, and a name that says "identity reset"
 * would have made the second caller look like a category error instead of the same event.
 */
const abandonCallbacks = new Set<Callback<void>>();

export function onConciergeTurnsAbandoned(cb: () => void): () => void {
  abandonCallbacks.add(cb);
  return () => {
    abandonCallbacks.delete(cb);
  };
}

/**
 * Move the epoch, and tell subscribers what moving it just did.
 *
 * THE BUMP AND THE SIGNAL MUST NOT BE SEPARABLE (roborev 55969). The first version of this
 * dispatched from only one of the two writers that orphan a turn on purpose — so a
 * `setConciergeSessionId` during an in-flight turn orphaned it exactly like a sign-out does
 * (`turnIsCurrent()` false, `done` and `error` both swallowed) while the host was told nothing. The
 * spinner stayed up for ever over a turn that had *succeeded*, and the 90s bound then latched "your
 * concierge isn't answering" on top of it. That is the identical one-layer-over leak the gate itself
 * was written to close. So the two are one call, and the only way back to the bug is to write
 * `sessionEpoch++` by hand.
 *
 * {@link rebindSessionToAccount} IS THE THIRD EPOCH WRITER AND DELIBERATELY DOES NOT CALL THIS. It
 * runs INSIDE the send path, before the outgoing turn has an id — so signalling there would stand
 * the indicator down for the turn that is at that moment starting, which is the opposite of the leak
 * being fixed. An account switch does still swallow a *previous* turn's terminal event, so the host
 * can be stranded that way; closing that needs the signal to distinguish "the turn you are rendering
 * is over" from "the turn you just handed me is fine", which this one-bit event cannot. Tracked
 * rather than papered over — do not "unify" it by adding the call.
 *
 * ALWAYS CALLED LAST by its callers, once the pointers are already in their new state — a subscriber
 * tearing its own state down should observe the change as complete, not half-applied.
 */
function orphanInFlightTurns(): void {
  sessionEpoch++;
  dispatch(abandonCallbacks, undefined);
}

function dispatch<T>(callbacks: Set<Callback<T>>, event: T): void {
  for (const cb of callbacks) {
    try {
      cb(event);
    } catch (e) {
      // A throwing subscriber must not break the fan-out for the others.
      console.warn("concierge: subscriber threw", e);
    }
  }
}

/** Deliver a locally-synthesized failure (rejected invoke, dead event bus) as a normal error
 *  event, so callers have exactly one error surface to watch. */
function dispatchLocalError(detail: string): void {
  dispatch(errorCallbacks, { id: CONCIERGE_LOCAL_ERROR_ID, detail });
}

/** Register the three Tauri listeners exactly once, lazily. They intentionally live for the
 *  webview's lifetime — the concierge column is persistent, and the manager must see every
 *  `done` to keep `currentSessionId` fresh even while no UI subscription exists. */
function ensureWired(): Promise<void> {
  if (!wiring) {
    const w = (async () => {
      const results = await Promise.allSettled([
        // THE FAN-OUT IS GATED ON IDENTITY TOO, not just the session pointer (roborev 55794).
        // `ConciergeHost` is mounted throughout — sign-out is a SettingsDialog action, not an
        // unmount — and it upserts streamed text straight into `conciergeThreadStore`, which
        // persists. So a pre-reset turn's deltas would re-populate the column `clearConciergeThread`
        // had just emptied, with the PREVIOUS human's answer, and it would survive relaunch. Gating
        // the pointer alone fixes what the model remembers and leaves what the human SEES.
        listen<ConciergeDeltaEvent>("concierge:delta", (ev) => {
          if (turnIsCurrent(ev.payload.id)) dispatch(deltaCallbacks, ev.payload);
        }),
        // GATED ON `turnIsCurrent` EXACTLY LIKE THE DELTA ABOVE, and for the identical reason.
        // Rust already refuses to emit for a superseded turn; this is the same belt-and-braces the
        // delta path keeps (roborev 53088/53105/53130), and it additionally covers the identity
        // reset the comment above describes — a pre-sign-out turn must not narrate the new human's
        // column any more than it may write text into it.
        //
        // A stale tool line is the specific lie this feature must not tell: the whole point of the
        // status line is that it distinguishes a working concierge from a wedged one, and a line
        // left over from a turn the user already replaced reads exactly like live work.
        listen<ConciergeToolEvent>("concierge:tool", (ev) => {
          if (turnIsCurrent(ev.payload.id)) dispatch(toolCallbacks, ev.payload);
        }),
        listen<ConciergeDoneEvent>("concierge:done", (ev) => {
          // A turn that COMPLETED is the strongest evidence a session exists and is resumable, so it
          // refreshes the fallback too — including after Rust's stale-resume self-heal, where the id
          // that comes back is a brand-new session and the old fallback now points at the transcript
          // claude just abandoned.
          const current = turnIsCurrent(ev.payload.id);
          if (ev.payload.sessionId) {
            if (!current) {
              // RETIRE WHAT IT LANDED ON. Refusing in-process is only half: a turn that MINTED a
              // session — a first turn with no resume target, or the stale-resume self-heal — ends on
              // an id `resetConciergeSession` never saw, so nothing put it on the deny-list. Its
              // transcript is now the newest on disk, and the next launch would seed it.
              //
              // ONLY WHEN A RESET IS WHAT ORPHANED IT, and never on "not current" alone. Three
              // things bump `sessionEpoch` and only one of them is a sign-out:
              //
              //  • `setConciergeSessionId` — a deliberate set during an in-flight turn (roborev
              //    55813). Retiring there deny-lists the LIVE conversation.
              //  • `rebindSessionToAccount` — an account switch, which nulls BOTH pointers too, so
              //    it manufactures this exact shape while meaning the SAME human. That id is their
              //    live conversation in the other account's tree, still resuming fine where it sits.
              //  • `resetConciergeSession` — the actual end of a conversation, and the only one
              //    whose ids belong on a durable deny-list.
              //
              // `lastResetEpoch` is what separates them, and it has to be the REASON rather than a
              // snapshot of the account binding. The binding is a live value that moves back: a
              // switch away and back again (a human, or Phase 2 rotation, which needs no gesture at
              // all) leaves the turn's account equal to the current one, so an account comparison
              // reads "no switch happened" and retires the very conversation it exists to protect —
              // permanently, since the id is by then the newest transcript in that tree and every
              // future restore refuses it. It fails the other way too: after a sign-out the next
              // human's first turn installs a binding, and if that resolves to a different account
              // than the previous human's turn ran under, the comparison waves the retirement
              // through and the relaunch hands over their conversation (roborev 55774/55794).
              const startedAt = turnEpochs.get(ev.payload.id);
              const orphanedByReset =
                startedAt !== undefined && lastResetEpoch !== null && startedAt <= lastResetEpoch;
              if (
                orphanedByReset &&
                ev.payload.sessionId !== currentSessionId &&
                ev.payload.sessionId !== fallbackSessionId
              ) {
                retireSessionIds(ev.payload.sessionId);
              }
            } else if (!isRetiredConciergeSession(ev.payload.sessionId)) {
              currentSessionId = ev.payload.sessionId;
              fallbackSessionId = ev.payload.sessionId;
              // AND THE ACCOUNT IT WAS MINTED UNDER. This handler is an independent writer of the
              // session pointer, so without this the id and the binding could describe different
              // accounts: a turn spawned under the old account can land its `done` after a switch
              // has already moved the binding, and because the two then LOOK consistent the change
              // detector sees nothing to fix and the next turn resumes cross-tree. Recording it
              // here is what makes the post-preamble `rebindSessionToAccount` able to catch that.
              //
              // Only on the branch that INSTALLS the pointer: a retired or superseded id is not
              // this module's session, so moving the binding to its account would describe a tree
              // nothing is pointing at.
              const turnAccount = turnAccounts.get(ev.payload.id);
              if (turnAccount !== undefined) sessionAccountConfigDir = turnAccount;
            }
          }
          turnEpochs.delete(ev.payload.id);
          if (current) dispatch(doneCallbacks, ev.payload);
        }),
        listen<ConciergeErrorEvent>("concierge:error", (ev) => {
          // The Rust side already retried a stale --resume once; if the turn still failed, drop the
          // session id so the NEXT turn starts fresh rather than resuming into the same failure.
          //
          // UNLESS it is a supersession sentinel (roborev 53460/53462): that turn did not fail, the
          // user displaced it, and the turn that displaced it is still talking IN THAT SESSION.
          // Dropping the id there costs the concierge its whole conversation — the next turn starts
          // a fresh Claude session and forgets everything the user has said. The session is this
          // module's to protect; the host filters the same sentinels for the UI.
          //
          // And "start fresh" means BACK TO THE ON-DISK FALLBACK, not back to nothing (spec §3 C1).
          // Once the boot restore exists, nulling here would re-orphan the conversation the restore
          // just recovered — the very bug this subsystem fixes — on the first transient error of the
          // session. Resuming a genuinely dead id is not the risk it looks like either: `concierge.rs`
          // already re-runs a failed resuming turn ONCE without `--resume`
          // (`should_retry_without_resume`), so a stale fallback self-heals on the next turn and the
          // `done` above replaces it with the fresh id. With no fallback (no transcript on disk yet)
          // the behavior is unchanged: null, and the next turn starts fresh.
          //
          // AND UNLESS IT IS A PUSH (roborev 54166-M3). A proactive turn is one nobody asked for,
          // so its failure owns neither of the two things this branch does. It must not roll the
          // user's live conversation pointer back — the push rides the user's session, and a turn
          // they did not request has no business rewriting where their next one resumes. And it
          // must not reach the fan-out, where the host renders "I couldn't reach my brain just now"
          // and clears the typing indicator for a message the user never requested. That is the
          // "silent on every failure" contract this command promises; it used to hold only on the
          // invoke-rejection path, which covers a push that never started and not one that died
          // after spawning.
          if (isProactiveTurn(ev.payload.id)) {
            console.debug("concierge: proactive turn failed after spawning:", ev.payload.detail);
            return;
          }
          // AND UNLESS IT BELONGS TO A PREVIOUS IDENTITY (roborev 55794), for both halves and for
          // the same reasons: rolling `currentSessionId` back to a fallback the reset cleared would
          // undo the reset, and the fan-out would apologise — "I couldn't reach my brain just now" —
          // to the human who has just signed IN, about a turn the one who signed out had sent.
          if (!turnIsCurrent(ev.payload.id)) {
            turnEpochs.delete(ev.payload.id);
            console.debug("concierge: dropping an error from a previous identity's turn");
            return;
          }
          if (!isSupersededDetail(ev.payload.detail)) currentSessionId = fallbackSessionId;
          dispatch(errorCallbacks, ev.payload);
        }),
      ]);
      const rejected = results.find((r) => r.status === "rejected");
      if (rejected) {
        // PARTIAL failure: some listeners registered before another rejected. Unlisten the ones
        // that DID register so a retry starts clean — otherwise the survivors stack and every
        // subsequent event dispatches twice. Then surface the failure (the .catch drops the cache).
        for (const r of results) {
          if (r.status === "fulfilled") {
            try {
              r.value();
            } catch {
              /* already gone */
            }
          }
        }
        throw (rejected as PromiseRejectedResult).reason;
      }
    })();
    // Don't cache a REJECTED wiring promise — a transient listen() failure would otherwise brick
    // the concierge for the webview's life. Drop the cache on rejection so the next call retries.
    w.catch(() => {
      if (wiring === w) wiring = null;
    });
    wiring = w;
  }
  return wiring;
}

/**
 * Re-derive the ongoing session from the transcript on disk, ONCE per page.
 *
 * This is the whole of C1. The concierge's conversation was never actually lost across an app
 * restart — `claude -p` writes a real transcript under the app-data dir's slug, the same as any
 * build agent's — but the only pointer to it lived in the module-level `let` above and died with the
 * webview. Build agents already re-discover their session by probing the transcript dir at spawn
 * (`AgentPane` → `claudeSessionInfo`); nobody ran that probe for the concierge's cwd. That asymmetry
 * WAS the bug (spec §3 subsystem C).
 *
 * Deliberately non-destructive and never throwing:
 *   - it only SEEDS. If a `concierge:done` already landed (a turn finished before the probe
 *     returned), that id is live process state and outranks anything on disk.
 *   - a rejected invoke (no Tauri, an unresolvable app-data dir) leaves the session null, i.e. the
 *     pre-restore behavior — a fresh conversation, not a broken one.
 *
 * Only the pointer is restored, not the visible bubbles; those persist separately
 * (`stores/conciergeThreadStore`). The two can drift — the resumed session remembers turns the
 * capped bubble log has evicted, and vice versa. Rehydrating both from the transcript would fix that
 * but needs an NDJSON reader; the design defers it as a follow-up.
 */
export function restoreConciergeSession(probeConfigDir?: string | null): Promise<void> {
  if (restoring) return restoring;
  {
    const startedAt = sessionEpoch;
    let failed = false;
    const r = (async () => {
      try {
        // Typed as possibly-absent on purpose: the Rust command always returns the struct, but this
        // module must survive a bridge that isn't there (a mocked invoke, a non-Tauri host) without
        // throwing a destructuring TypeError into the console on every page load.
        // UNDER THE CONCIERGE'S OWN ACCOUNT, not Sparkle's ambient env. The spawn sets
        // `CLAUDE_CONFIG_DIR` from the selected account, so the transcript this probe is looking for
        // lives in THAT account's tree. Probing the default tree instead would either find nothing
        // (an amnesiac concierge after every restart — the exact bug this restore exists to fix) or
        // find a stale id belonging to a different account and seed it, which is worse: the next
        // turn would spawn `--resume <foreign-id>`, fail, and self-heal into a fresh conversation
        // having burnt two `claude` processes.
        //
        // Resolved here rather than passed in so every call site is correct by construction — this
        // is called from three mount-time sites as well as the send path, and an argument would be
        // one more thing each of them could get wrong. It is cheap: the account snapshot is
        // TTL-cached and the selection is sticky.
        // The CALLER's account when it has one, so the probe and the spawn are provably the same
        // tree rather than two independent resolutions that "should" agree. They did not: a turn
        // whose own resolve hiccupped would fall to the default while this probe's succeeded,
        // seeding an id from the other account's tree — and the turn then paired that id with the
        // default's config dir. The mount-time subscribers pass nothing and resolve for themselves.
        const configDir =
          probeConfigDir ?? effectiveConfigDir(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY));
        const info: ClaudeSessionInfo | undefined = await conciergeSessionInfo(configDir);
        // `hasSession` is deliberately not consulted: the id is the thing we need, and a truthy id
        // already implies a transcript was found. Trusting `hasSession` separately would let the two
        // halves disagree (Rust pins that they cannot — see `session_info_halves_agree...`).
        const latestSessionId = info?.latestSessionId;
        // Seed only. A `concierge:done` that landed while the probe was in flight is live process
        // state and wins; a deliberate set/reset in that window (epoch moved) wins too.
        // …and a RETIRED id is refused outright, however fresh the transcript is. This is the only
        // guard that survives a relaunch: `restoring` and `sessionEpoch` are both process state, so
        // without it a quit-and-relaunch after sign-out hands the next human the previous one's
        // conversation (roborev 55774).
        if (
          latestSessionId &&
          !isRetiredConciergeSession(latestSessionId) &&
          currentSessionId === null &&
          sessionEpoch === startedAt
        ) {
          currentSessionId = latestSessionId;
          fallbackSessionId = latestSessionId;
          // The id came out of THIS account's tree, so that is the account it belongs to.
          sessionAccountConfigDir = configDir;
        }
      } catch (e) {
        console.warn("concierge: session restore failed; starting a fresh conversation:", e);
        failed = true;
      }
    })();
    restoring = r;

    // DROP THE CACHE ON FAILURE, so a later call retries (roborev 53666-M).
    //
    // A resolved-but-failed promise is indistinguishable from "probed, found nothing", so caching
    // it meant one bad probe left the concierge amnesiac for the whole page — the exact bug this
    // subsystem exists to fix. That got worse when the probe moved from the first send (a user
    // gesture on a settled webview, seconds after launch) to three MOUNT-time call sites, where a
    // transient failure during window init is far likelier. `startConciergeTurn` awaits this, so
    // without the drop it would just await an already-resolved failure and never recover.
    //
    // Same policy `ensureWired` states 120 lines above, for the same reason.
    //
    // Checked TWICE, and both are load-bearing. A probe that throws SYNCHRONOUSLY (no bridge at
    // all, so `conciergeSessionInfo()` throws before its first await) runs the catch before
    // `restoring = r` executes, so the post-settle callback would find the cache already set and
    // clear nothing was ever wrong — hence the immediate call. Everything else fails after an
    // await, hence the `.then`. Guarded on identity so a stale probe cannot clear a newer one's
    // cache.
    //
    // AND GUARDED ON THE EPOCH, which is what keeps this from re-opening the reset hole (roborev
    // 53689-M). `resetConciergeSession` deliberately marks `restoring` DONE rather than null —
    // `restoring ??= Promise.resolve()` — precisely so a probe already in flight cannot land after
    // the reset and undo it. A bare identity check would hand that protection straight back: the
    // user hits "start over" while the bridge is still coming up, the in-flight probe rejects, the
    // cache is dropped, and the NEXT call re-probes with an epoch captured after the reset — so
    // both of the body's guards pass and it seeds the very conversation the user just discarded,
    // installing the old id as the fallback too. Retry only when no reset (and no explicit
    // `setConciergeSessionId`) happened while this probe was running.
    const dropIfFailed = () => {
      if (failed && restoring === r && sessionEpoch === startedAt) restoring = null;
    };
    dropIfFailed();
    void r.then(dropIfFailed);
    return r;
  }
}

/**
 * Run one concierge turn over `prompt` (a snapshot of app state, or the user's message).
 * Continuity is automatic: the session id from the last `done` is passed as the resume target
 * unless `resumeSessionId` explicitly overrides it. Never rejects — failures surface on
 * `onConciergeError`.
 *
 * RESOLVES WITH THE TURN'S ID — the same id its `concierge:*` events carry — or `null` when the
 * turn never started (a rejected invoke). Callers key supersession bookkeeping on it, so the null
 * contract matters: no id means there is no turn to attribute anything to (roborev 53088).
 */
/** Thrown when a concierge turn is asked for while AI enhancements are off. Carried as a typed
 *  error rather than a silent `null` so the column can render the upsell instead of a dead send —
 *  a send that quietly does nothing is the worst of the three outcomes. */
export class ConciergeAiDisabledError extends Error {
  constructor() {
    super("AI enhancements are off, so the concierge can't think or act.");
    this.name = "ConciergeAiDisabledError";
  }
}

export async function startConciergeTurn(
  prompt: string,
  resumeSessionId?: string,
): Promise<string | null> {
  // THE AI-ENHANCEMENTS GATE (bead sparkle-4562), checked before anything is spawned.
  //
  // A concierge turn is a `claude -p` CHILD PROCESS and it costs money, so the gate has to stop it
  // HERE rather than let the turn run and refuse its tools: the thinking is itself the paid part,
  // and `resolve_concierge_mcp_config` would also mint a privileged control socket for a surface
  // the human has turned off. Refusing at the door means neither happens.
  //
  // Also the open-source case: a build with no Sparkle backend has no signed-in `me`, so this reads
  // false and the concierge never spawns — no separate open-source code path to keep in step.
  if (!conciergeAiEnabled()) throw new ConciergeAiDisabledError();
  try {
    // Wire listeners BEFORE the invoke so a fast first delta/done can't slip past the manager, and
    // finish the boot restore before `resume` is computed — a probe still in flight would let the
    // FIRST turn after a restart start a fresh session, which is exactly the symptom (the user's
    // opening message is the one that most needs the prior context). Both are once-per-page and
    // cached, so this costs one extra IPC round-trip on the first turn only.
    // ORDER IS THE CONTRACT HERE, so this is deliberately not one Promise.all.
    //
    // Account FIRST: `rebindSessionToAccount` may invalidate the memoized restore, and it has to do
    // that BEFORE the restore runs or the re-probe lands a turn late — the user would get a fresh
    // conversation on this turn and their real one only on the next. Cheap enough to serialize: the
    // snapshot is TTL-cached and the selection is sticky, so on the hot path it is already resolved.
    //
    // Then wiring + restore together, and the restore resolves the same account internally — same
    // cache, same sticky selection, so the tree it probes cannot disagree with the tree this turn
    // spawns into.
    // `avoidClobberedDefault`: the concierge default (`$HOME/.claude`) is shared with the terminal
    // `claude` CLI, so a terminal login clobbers the OAuth Sparkle expects. Prefer a dedicated account
    // and route away from a clobbered default — recorded state still reads it healthy, so nothing else
    // would (see accountSelection `clobberedDefaultIds`).
    const resolved = await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, {
      avoidClobberedDefault: true,
    });
    // `effectiveConfigDir`, not `resolved`: an unreadable accounts backend must not silently move
    // the turn to the DEFAULT account while the session pointer still names another one.
    rebindSessionToAccount(resolved);
    await Promise.all([ensureWired(), restoreConciergeSession(effectiveConfigDir(resolved))]);
    // AGAIN, after the preamble. Those two awaits are several IPC hops wide, and `concierge:done`
    // is an independent writer of the session pointer — a turn spawned under the OLD account can
    // land its `done` right here, installing an id from that account's tree. The second check is
    // what keeps the id and the config dir below on one tree; the first exists to drop the restore
    // memo before the probe runs, so both are load-bearing.
    rebindSessionToAccount(resolved);
    const configDir = effectiveConfigDir(resolved);
    // Snapshot BEFORE the await: a sign-out landing while the invoke is in flight must not have its
    // reset undone by the write below (roborev 55774).
    //
    // And AFTER the rebind above, not before it: `rebindSessionToAccount` moves `sessionEpoch`
    // itself, so a snapshot taken earlier would compare unequal for an account change this turn
    // has already absorbed — and every turn following a switch would decline to record its own
    // resume target.
    const startedAt = sessionEpoch;
    const resume = resumeSessionId ?? currentSessionId ?? undefined;
    // RECIPIENT-HALF INBOX DRAIN (bead sparkle-179b2s, Phase A2). The concierge is not a worktree
    // agent, so neither the hook nor the PTY delivery path reaches it — its inbox is drained HERE, at
    // turn assembly. Read the pending messages, frame them into the prompt as data (never as
    // instruction), and ack them so the next turn does not re-inject them. Never throws and returns
    // "" on any failure, so a broken inbox cannot stop a turn; see `services/conciergeInbox.ts`.
    const inboxText = await drainConciergeInbox();
    const turnPrompt = inboxText ? `${prompt}\n\n${inboxText}` : prompt;
    // The healthy DEDICATED accounts Rust may rotate to if THIS account's OAuth has expired — ranked
    // best-first, excluding this account's login group and any clobbered default. When the turn fails
    // with the auth-expiry signature, `concierge_turn` retries on the first of these instead of
    // re-running the dead account, so a single auth failure becomes a rotated retry rather than a
    // "sign in to Claude" dead-end (see accountSelection `conciergeFallbackConfigDirs` and
    // `concierge.rs::plan_retry`). Empty (one healthy account, or an unreadable backend) = sign-in as
    // before, which is the last-account guard: never bench the only account.
    const fallbackConfigDirs = await conciergeFallbackConfigDirs();
    // `configDir` binds this turn to an account. Before it existed the concierge always ran as
    // `$HOME/.claude`, so an exhausted default account failed every turn with no way for the human
    // to move it — see PRD/sparkle/account-rotation.md §2.
    const id = await invoke<string>("concierge_turn", {
      prompt: turnPrompt,
      resumeSessionId: resume ?? null,
      configDir,
      fallbackConfigDirs,
    });
    // Only advance the session id once the turn was ACCEPTED — a rejected invoke must not leave a
    // resume target (esp. an explicit override) for a turn that never ran — and only while the
    // identity that started it is still the one signed in.
    if (resume && sessionEpoch === startedAt) currentSessionId = resume;
    // Tag the turn either way, so its `done` can be judged on the same basis — by epoch, for whether
    // it is still the current human's, and by account, for which tree its session id lives in.
    if (typeof id === "string") {
      rememberTurnEpoch(id, startedAt);
      rememberTurnAccount(id, configDir);
    }
    // The turn's id — the same one its `concierge:*` events carry. Callers use it to tell this
    // turn's events from a SUPERSEDED turn's stragglers (concierge.rs emits deltas unconditionally;
    // only the reap is token-gated), which they cannot do from the ids they happen to have seen
    // when the previous turn produced no event at all before this send (roborev 53051).
    return typeof id === "string" ? id : null;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // NOT a failure: the user sent again (or cancelled) before this turn could start. Both are
    // ordinary outcomes of two fast sends, and surfacing them would post "I couldn't reach my
    // brain just now" AND clear the typing indicator — for the live turn that is still streaming,
    // since a local error carries no turn id and so bypasses supersededTurn (roborev 53186).
    if (isSupersededDetail(detail)) {
      console.warn("concierge: turn superseded before it started:", detail);
      return null;
    }
    console.warn("concierge: failed to start turn:", e);
    dispatchLocalError(detail);
    return null;
  }
}

/**
 * Start one PROACTIVE turn — the brain speaking first, with no user message behind it
 * (PRD/sparkle/concierge-proactive-push.md; the gap is PRD/sparkle/concierge-mode.md §2a).
 *
 * SAME TRANSPORT as {@link startConciergeTurn}: it resolves with the Rust turn token, and the reply
 * arrives on the same `concierge:delta` / `concierge:done` / `concierge:error` stream under that id.
 * Only the command differs, and the difference is the whole safety property — `concierge_proactive_turn`
 * publishes no retirement floor and stands down for any user turn, in flight or merely preparing.
 *
 * SAME SESSION, deliberately: it resumes the ongoing conversation, so the push sees what the user has
 * been saying and the user's next turn remembers what the concierge volunteered.
 *
 * SILENT ON EVERY FAILURE, which is where it parts company with the send path. That path synthesizes
 * a local error event so the column can say "I couldn't reach my brain just now" — correct when the
 * user is waiting on an answer, and wrong here: nobody asked for this, so an apology for failing to
 * deliver it is noise the user cannot act on. Resolves null instead.
 */
export async function startProactiveConciergeTurn(prompt: string): Promise<string | null> {
  if (!prompt.trim()) return null;
  try {
    // Same order, same reason, as `startConciergeTurn` — and it matters MORE here, not less: a push
    // has no stale-resume retry by design (see `concierge_proactive_turn`), so a resume aimed at the
    // wrong account's tree is never self-healed; the push just dies silently.
    // `avoidClobberedDefault`: the concierge default (`$HOME/.claude`) is shared with the terminal
    // `claude` CLI, so a terminal login clobbers the OAuth Sparkle expects. Prefer a dedicated account
    // and route away from a clobbered default — recorded state still reads it healthy, so nothing else
    // would (see accountSelection `clobberedDefaultIds`).
    const resolved = await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, {
      avoidClobberedDefault: true,
    });
    // `effectiveConfigDir`, not `resolved`: an unreadable accounts backend must not silently move
    // the turn to the DEFAULT account while the session pointer still names another one.
    rebindSessionToAccount(resolved);
    await Promise.all([ensureWired(), restoreConciergeSession(effectiveConfigDir(resolved))]);
    // AGAIN, after the preamble. Those two awaits are several IPC hops wide, and `concierge:done`
    // is an independent writer of the session pointer — a turn spawned under the OLD account can
    // land its `done` right here, installing an id from that account's tree. The second check is
    // what keeps the id and the config dir below on one tree; the first exists to drop the restore
    // memo before the probe runs, so both are load-bearing.
    rebindSessionToAccount(resolved);
    const configDir = effectiveConfigDir(resolved);
    // Same snapshot as the send path, taken at the same point and for the same two reasons, and it
    // matters MORE here: a proactive push starts on its own schedule, so the window where a sign-out
    // can land mid-turn is not user-driven at all.
    const startedAt = sessionEpoch;
    const resume = currentSessionId ?? undefined;
    // Same account as a user send — a push spends the same subscription, so it must not be the one
    // call that keeps burning an account the human has rotated away from.
    const id = await invoke<string>("concierge_proactive_turn", {
      prompt,
      resumeSessionId: resume ?? null,
      configDir,
    });
    if (resume && sessionEpoch === startedAt) currentSessionId = resume;
    if (typeof id !== "string") return null;
    rememberTurnEpoch(id, startedAt);
    rememberTurnAccount(id, configDir);
    // Record it BEFORE returning, so the first event this turn produces already resolves as a push.
    // Rust emits deltas as soon as claude speaks, and the caller has not run a line yet.
    rememberProactiveTurn(id);
    return id;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Declined (or superseded) is the channel doing its job: the user owns the conversation.
    if (isProactiveDeclinedDetail(detail) || isSupersededDetail(detail)) {
      console.debug("concierge: proactive turn stood down:", detail);
    } else {
      console.warn("concierge: proactive turn failed to start:", e);
    }
    return null;
  }
}

/** Cancel the in-flight turn (harmless no-op when none). Never rejects. */
export async function cancelConciergeTurn(): Promise<void> {
  try {
    await invoke("concierge_cancel");
  } catch (e) {
    console.warn("concierge: cancel failed:", e);
  }
}

/** Subscribe to incremental reply text. Returns a synchronous unsubscribe. */
/**
 * Subscribe to LIVE tool calls — every `tool_use` block the turn emits, as it emits it. Returns a
 * synchronous unsubscribe.
 *
 * Deliberately does NOT start the session probe the delta subscriber does: this is a passive
 * observer of a turn somebody else started, and a status line must never be the thing that causes a
 * disk probe.
 */
export function onConciergeTool(cb: Callback<ConciergeToolEvent>): () => void {
  toolCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  return () => toolCallbacks.delete(cb);
}

export function onConciergeDelta(cb: Callback<ConciergeDeltaEvent>): () => void {
  deltaCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  // Start the disk probe at MOUNT rather than leaving it on the first send's critical path.
  // `startConciergeTurn` still awaits it — this only moves the latency off the send, it does not
  // replace the guarantee. Fire-and-forget is safe: the function never rejects, and it is cached, so
  // the three subscribe helpers racing here still produce exactly one probe.
  void restoreConciergeSession();
  return () => deltaCallbacks.delete(cb);
}

/** Subscribe to completed turns. Returns a synchronous unsubscribe. */
export function onConciergeDone(cb: Callback<ConciergeDoneEvent>): () => void {
  doneCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  void restoreConciergeSession();
  return () => doneCallbacks.delete(cb);
}

/** Subscribe to failed turns (including locally-synthesized invoke failures, id
 *  {@link CONCIERGE_LOCAL_ERROR_ID}). Returns a synchronous unsubscribe. */
export function onConciergeError(cb: Callback<ConciergeErrorEvent>): () => void {
  errorCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  void restoreConciergeSession();
  return () => errorCallbacks.delete(cb);
}

/** The session id the next turn will resume (null = the next turn starts a fresh session). */
export function getConciergeSessionId(): string | null {
  return currentSessionId;
}

/** Point the next turn at `id` (the boot restore's seam, and anything else that learns the session
 *  from outside the event stream). Treated as KNOWN-GOOD: it becomes the on-disk fallback too, so a
 *  later failed turn drops back to it rather than to a fresh conversation.
 *
 *  Pass "" or null to mean "no session" — same as {@link resetConciergeSession}, so a caller
 *  forwarding a probe result straight through can't accidentally set an empty resume target that
 *  `concierge.rs` would then have to treat as no-resume anyway. */
export function setConciergeSessionId(id: string | null): void {
  if (!id) {
    resetConciergeSession();
    return;
  }
  currentSessionId = id;
  fallbackSessionId = id;
  // A turn already in flight is orphaned by this exactly as a sign-out orphans one — its `done` will
  // be refused so it cannot overwrite the pointer just installed — so the host has to hear about it.
  orphanInFlightTurns();
}

/** Forget the ongoing session so the next turn starts fresh (e.g. a user-requested reset).
 *
 *  Clears the FALLBACK as well, and that is the point: a user asking to start over must not have the
 *  old conversation resurrected by the next transient error, and the boot restore must not run after
 *  it and undo it either (hence `restoring` is marked done rather than left null).
 *
 *  AND THE IDS ARE RETIRED, which is that same intent carried past process exit. Suppressing
 *  `restoring` only silences the probe for THIS run; the transcript is still the newest one on disk,
 *  so the next launch re-seeded exactly the conversation the user (or a sign-out) just ended. Both
 *  callers want the durable meaning — see {@link retireSessionIds}. */
export function resetConciergeSession(): void {
  retireSessionIds(currentSessionId, fallbackSessionId);
  // BEFORE the bump — which now happens inside `orphanInFlightTurns()` at the end of this function —
  // so this still names the epoch the reset ENDED: every turn in flight started at or below it, and
  // that is what lets a straggler `done` be judged on the reason its epoch moved rather than on the
  // account binding it happens to find. Nothing between here and that call reads or writes
  // `sessionEpoch`, so the deferral is not observable. See {@link lastResetEpoch}.
  lastResetEpoch = sessionEpoch;
  currentSessionId = null;
  fallbackSessionId = null;
  // No session, so no account owns one. Leaving a stale binding here would make the next turn look
  // like an account CHANGE (and log one) when it is simply the first turn of a new conversation.
  sessionAccountConfigDir = undefined;
  restoring ??= Promise.resolve();
  // LAST, so a subscriber tearing its state down observes the reset as already complete. Any turn
  // still in flight is orphaned by the epoch bump inside this call, and its terminal event will be
  // dropped — see {@link onConciergeTurnsAbandoned} for why silence alone would strand the host.
  orphanInFlightTurns();
}

/**
 * Test-only: drop all module state (subscribers, wiring, session, restore) between vitest cases.
 *
 * `keepRetiredSessions` makes this a faithful RELAUNCH rather than a clean slate: module state is
 * what a fresh webview starts with, while the durable retirement list survives — which is exactly
 * what distinguishes a relaunch from a first run, and the only way to assert that a retired session
 * stays retired across one. Default false, so ordinary cases still get full isolation.
 */
export function _resetConciergeForTests(opts?: { keepRetiredSessions?: boolean }): void {
  deltaCallbacks.clear();
  doneCallbacks.clear();
  errorCallbacks.clear();
  toolCallbacks.clear();
  abandonCallbacks.clear();
  currentSessionId = null;
  fallbackSessionId = null;
  sessionAccountConfigDir = undefined;
  // Process state, so a "relaunch" (`keepRetiredSessions`) clears it too: a straggler `done` cannot
  // survive one, and carrying a reset epoch into the next case would retire ids that case never ended.
  lastResetEpoch = null;
  wiring = null;
  restoring = null;
  proactiveTurnIds.length = 0;
  turnEpochs.clear();
  turnAccounts.clear();
  // The retired list is DURABLE by design, so it is the one piece of this module's state that would
  // otherwise survive into the next case (and, within a worker, the next FILE) and start refusing
  // session ids that case never retired. Kept only when the caller is simulating a relaunch.
  if (!opts?.keepRetiredSessions) {
    try {
      localStorage.removeItem(RETIRED_SESSIONS_KEY);
    } catch {
      /* storage unavailable */
    }
  }
}
