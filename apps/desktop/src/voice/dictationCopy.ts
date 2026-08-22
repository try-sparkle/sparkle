// Voice copy, kept in ONE place so every composer that surfaces the voice affordance reads
// identically. The global dictation pipeline is shared across the build Composer and the Think
// composer, so the placeholder wording must not drift between them.
//
// ── EVERY SENTENCE HERE IS TRUE OF THE TRAY POSITION ALONE ──────────────────────────────────────
// This module used to assemble its live copy around two SPOKEN PHRASES — a wake word to start
// dictation and a stop word to end it. Both are gone (the founder: "We're no longer doing the wake
// word. We now have push to talk or speak buttons; SPEAK SHOULD BE ALWAYS ON"), and with them the
// class of defect they produced: `micCaptionKind` had only two branches, so PUSH TO TALK — a mode
// with no wake word at all — fell through to the wake copy and told the founder "Mic paused. Say
// Hey Sparkle to activate" while he was holding the talk key. He reported it three times.
//
// The constraint that replaces them is voice/micPresentation's own rule: the caption follows the
// TRAY POSITION and nothing else, so every string below must be true whether or not the key is
// held and whether or not anything is being said right now. "Hold ⌘ to talk" is true at rest and
// mid-hold; "Say Hey Sparkle to activate" was true in neither. That is what stops a caption
// contradicting the glyph beside it, which is the invariant this whole file family protects.
//
// The advanced opt-in's own label, single-sourced. This module INSTRUCTS the user to turn that
// control on, and a remedy naming a control by a label it no longer carries is exactly the dead end
// the no-device branch below exists to fix.
import { ALLOW_VIRTUAL_LABEL, INPUT_PICKER_LOCATION } from "../services/audioInputs";
import { TALK_KEY_GLYPH } from "./sendMode";
import type { PauseReason } from "./dictationFocus";

// ══ ONE STATUS LINE PER MODE, AND IT IS NOW LIVE (bead sparkle-bbfsx) ═══════════════════════════
//
// This file used to hold TWO strings per position, a HEADLINE and an ACTION, drawn as two lines with
// a device caption under them — three rows of chrome under the waveform. The founder cut it to one:
//
//   *"it still says push to talk in gray. And then it says hold command to talk in blue, and then it
//   says listening MacBook microphone. So I wanna take out the listening Mac microphone completely…
//   Let's just remove push to talk completely. So where it says hold command to talk, when I am
//   holding command, it should say release command to send… It says hold command to talk, when I'm
//   not talking. And it should be instead of in blue, it should be in gray… And then when I am
//   actually holding it, that's when it should be blue."*
//
// …and, for Speak: *"it says in gray, actively listening. Let's take that out. And actually, it says
// just pause when you're done in blue, so let's take that out. Let's make actively listening be the
// blue color when it's active."*
//
// So `PTT_CAPTION_HEADLINE` ("Push to talk") and `SPEAK_CAPTION_ACTION` ("Just pause when you're
// done") are GONE — not renamed, deleted — and the two that survive changed colour rather than
// wording. The rule that picks between them is `voice/voiceStatusLine`; the component that draws it
// is `components/VoiceStatusLine`.
//
// ── AND THE FILE HEADER'S "TRUE OF THE POSITION ALONE" RULE HAS ONE DELIBERATE EXCEPTION ───────
// Everything above says a caption must be true whether or not the key is down, which is what kept
// it a pure read of the tray. `PTT_CAPTION_HELD` is the exception the founder asked for by name: it
// is true ONLY while the key is down, so the line now takes the GESTURE as a second input. That is
// safe here in a way the wake-word copy never was, because the gesture is a fact this app owns
// synchronously — `useSendMode.held` is written by the keydown listener itself (voice/usePushToTalk)
// BEFORE the microphone is asked to do anything. Keying it on the mic's own liveness instead would
// make the words lag his finger by the capture start-up, which is the one thing he would notice.

// ── SPEAK (the tray is on Speak: dictation is ON, continuously) ─────────────────────────────────
// No spoken command starts it and none ends it. What ends an UTTERANCE is silence — Speak is the
// one position that runs the auto-send countdown (voice/sendMode `modeCountsDown`, voice/useAutoSend),
// so stopping talking is what dispatches the message. What ends DICTATION is moving the tray.
export const SPEAK_CAPTION_HEADLINE = "Actively listening";
export const SPEAK_COMPOSER_PLACEHOLDER =
  "I'm listening, so just start talking — pause when you're done.";

// ── PUSH TO TALK (the tray is on Push to talk) ──────────────────────────────────────────────────
// TWO STATES OF ONE LINE, and which one shows is the key, not the microphone. The glyph comes from
// `TALK_KEY_GLYPH`, never a literal, so this copy and the tray's own keycap chiclet cannot name
// different keys.
export const PTT_CAPTION_ACTION = `Hold ${TALK_KEY_GLYPH} to talk`;
/** WHILE THE KEY IS DOWN. The founder's words were "release command to send"; the line renders the
 *  glyph he was reading on screen rather than the word he spoke, exactly as its resting twin does —
 *  the two are one sentence in two tenses and must name the key the same way. */
export const PTT_CAPTION_HELD = `Release ${TALK_KEY_GLYPH} to send`;
/** THE WHOLE SENTENCE, with no typing tail. It read `… — or type here instead.` and the founder
 *  trimmed it (sparkle-u81cz): *"it should only say the 'Hold X to talk' part."* He can see the
 *  box, so the tail was noise. This SUPERSEDES the copy table agreed in sparkle-6hu3c's comments,
 *  which is the only other place that tail is written down. The two constants above are unchanged
 *  and still correct. */
export const PTT_COMPOSER_PLACEHOLDER = `Hold ${TALK_KEY_GLYPH} to talk.`;

// ── EVERY OTHER COMPOSER (an agent's own box, the capture window) ───────────────────────────────
// THE TRAY GOVERNS THE CONCIERGE BOX, AND ONLY IT. The two sentences above are true there and
// nowhere else, for two separate reasons:
//
//  1. AUTO-SEND. `useAutoSend` is mounted exactly once, by ConciergeHost. "Pause when you're done"
//     is a promise that stopping talking DISPATCHES the message — false in an agent composer and in
//     the capture window, where the draft would just sit in the box. Telling someone to stop talking
//     and then not sending is the same class of defect this whole change exists to delete: copy
//     describing a mode the surface is not in.
//  2. WHERE A HOLD ROUTES. The push-to-talk gesture is bound by `useSendMode`, which claims
//     `voiceSurface: "concierge"` on the same action that arms the mic — so a hold's speech goes to
//     the concierge box, never to the agent composer reading this. Offering "Hold ⌘ to talk" here
//     would point at a gesture that fills a different column.
//
// So these surfaces get ONE sentence, true whenever capture is live and independent of the tray:
// it says the mic is hot and nothing else. It deliberately names no send gesture — each of these
// composers has its own, and this slot is about the microphone.
export const LIVE_COMPOSER_PLACEHOLDER = "I'm listening, so just start talking.";

// FOCUS-PAUSED (armed, but the backend is NOT capturing). ONE state, but it now has a REASON, and
// the reason is the whole point: "paused" with no cause is what left the terminal case reading as a
// bug. deriveMicPresentation === "focusPaused" still selects the state on both surfaces — that
// single-decision property is what stops the sidebar and the composer contradicting each other —
// and dictationPauseReason (voice/dictationFocus) says WHY, so each surface picks its own words for
// the same cause rather than each re-deciding the state.
//
// Every string below opens with "Listening paused" so the two surfaces read as one state, then
// names what has focus and what will give it back. The sidebar has no box to point at, so it names
// the box; the composer IS the box, so it points at itself.
export const PAUSED_COMPOSER_PLACEHOLDER = "Listening paused — you can type here meanwhile.";

/** WINDOW pause, sidebar. Unchanged wording — this is the case it was always right for, and the
 *  terminal case is what it was wrongly being reused for. */
export const PAUSED_WINDOW_CAPTION =
  "Listening paused: Will auto-resume when you re-focus on this project.";
/** TERMINAL pause, sidebar. Names the thing that took the keyboard ("a terminal") and the single
 *  gesture that hands it back ("click the message box") — a terminal does NOT auto-resume the way a
 *  window does, so promising that it will would be the same lie in the other direction. */
export const PAUSED_TERMINAL_CAPTION =
  "Listening paused: Your cursor is in a terminal. Click the message box to resume.";
/** TERMINAL pause, BUILD-AGENT composer. Same cause, but the remedy is "here" because this copy is
 *  painted inside the very box the user needs to click.
 *
 *  NOT the concierge's wording, deliberately — see the two constants below. This surface is a build
 *  agent's own composer, so it must point at ITSELF; telling that box to "re-engage the Sparkle
 *  Concierge" would send the user to a different column entirely. It also renders as a NATIVE
 *  textarea placeholder on the fallback path (Composer.tsx), which cannot do two lines, bold, or
 *  centering — so a single sentence is the only shape available to it. */
export const PAUSED_TERMINAL_COMPOSER_PLACEHOLDER =
  "Listening paused — your cursor is in a terminal. Click here to resume.";

/** TERMINAL pause, CONCIERGE composer — TWO LINES, not a sentence (founder's copy).
 *
 *  The reason is deliberately GONE. "Your cursor is in a terminal" was there because "paused" with
 *  no cause read as a broken mic; the founder's judgement is that on this surface he already knows
 *  why, so the notice only has to say WHAT HAPPENED and WHAT TO DO. That reasoning is specific to
 *  the terminal-focus case and does NOT generalise: a HARD failure (no device, permission denied)
 *  must still name itself, which it does through `voiceErrorNotice` on the `error` presentation —
 *  a different branch entirely, untouched by this. The non-terminal focus pause keeps its own
 *  sentence in PAUSED_COMPOSER_PLACEHOLDER above.
 *
 *  Split into two constants rather than one string with a newline because the rendering needs them
 *  as separate elements — the first bold, both centered — and a `\n` in a JSX text node collapses
 *  to a space. RichPlaceholder's `focusPaused` arm is the only consumer. */
export const PAUSED_TERMINAL_HEADLINE = "Listening paused";
/** ══ NAMES NO DESTINATION, AND THAT IS THE FIX (bead sparkle-wj3ya) ═══════════════════════════════
 *  This read "Click to re-engage the Sparkle Concierge", and while the concierge is MOUNTED to a
 *  build agent that is FALSE — resuming there talks to the agent's terminal, not to Sparkle.
 *
 *  The founder caught it on a screenshot where "ESC to unmount" was rendering two lines above this
 *  one, so the pane simultaneously knew it was mounted and offered to re-engage the concierge. That
 *  is worse than a missing indicator: a missing indicator is an absence, this is an ASSERTION, and
 *  it is wrong at the exact moment the words would be routed into a live PTY — the one failure mode
 *  `composerRoute`'s header calls unrecoverable.
 *
 *  SAYING NOTHING ABOUT THE DESTINATION is the bead's own sanctioned option ("or say nothing about
 *  the concierge at all"), and it is the one that is TRUE IN BOTH STATES. The alternative — naming
 *  the agent when mounted — needs the mount threaded into `RichPlaceholder`, which today knows only
 *  its own geometry and pause reason; a placeholder that has to be told where words go is a second
 *  source of truth for the routing, and it would be wrong whenever it drifted. Where the words are
 *  going is the composer's own job to show (the terminal typeface, and the chip this bead still
 *  wants); this line only has to say what happened and how to undo it. */
export const PAUSED_TERMINAL_ACTION = "Click here to resume";

/** The sidebar caption for a focus-paused mic, by cause. `null` (paused for a reason we don't have
 *  a specific story for — e.g. capture simply hasn't started yet) keeps the long-standing window
 *  wording, which is the honest general case: it will come back on its own. */
export function pausedCaption(reason: PauseReason | null): string {
  return reason === "terminal" ? PAUSED_TERMINAL_CAPTION : PAUSED_WINDOW_CAPTION;
}

/** The composer placeholder for a focus-paused mic, by cause. Same fallback rule as
 *  {@link pausedCaption}: only the terminal case gets the terminal words. */
export function pausedComposerPlaceholder(reason: PauseReason | null): string {
  return reason === "terminal" ? PAUSED_TERMINAL_COMPOSER_PLACEHOLDER : PAUSED_COMPOSER_PLACEHOLDER;
}

// PREPARING (the mic is armed but the one-time voice-model download is still running). On a first
// run this takes MINUTES, and we used to spend all of it painting the passive listening copy —
// inviting the user to speak at a model that didn't exist yet. This copy replaces it so
// the wait is honest and visible where the user actually is (the composer), not only in the sidebar.
export const PREPARING_PREFIX = "Setting up voice";
export const PREPARING_SUFFIX = " — you can type here meanwhile.";
/** "Setting up voice (42%)" — the bare status, used by the sidebar caption (which has no composer
 *  to point at). Percent is omitted when the backend reports no content-length (`total: null`),
 *  since a made-up number is worse than none. */
export function preparingCaption(pct: number | null): string {
  return `${PREPARING_PREFIX}${pct !== null ? ` (${pct}%)` : "…"}`;
}
/** The composer's version: the same status plus the reassurance that the box still works.
 *  Built FROM preparingCaption so the two surfaces can't drift. */
export function preparingPlaceholder(pct: number | null): string {
  return `${preparingCaption(pct)}${PREPARING_SUFFIX}`;
}

/** Percent complete of the voice-model download, or null when the total is unknown.
 *  NOTE: progress is measured over the COMPRESSED tarball stream (~482 MB), which is what the
 *  backend streams and counts — not the ~631 MB it occupies once unpacked. So this reaching 100%
 *  means "downloaded", with a short unpack still to go; the caption deliberately says "Setting up"
 *  rather than "Downloading" so 100%-then-still-waiting doesn't read as a hang. */
export function modelPercent(p: { done: number; total: number | null } | null): number | null {
  if (!p || !p.total || p.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((p.done / p.total) * 100)));
}

// ---------------------------------------------------------------------------
// Voice error copy
// ---------------------------------------------------------------------------

/** The distinct failure buckets a dictation error can fall into. `unknown` is not a failure of this
 *  classifier — it is the honest answer, and its copy shows the RAW backend string. */
export type VoiceErrorKind =
  // Capture is LIVE but no audio frames are arriving — the frame-liveness watchdog in the backend.
  // This is the one bucket that describes a mic which looks perfectly healthy: the device is open,
  // the stream is running, and it delivers silence forever. See the ordering note on PATTERNS.
  | "no-audio"
  // Same observable symptom as `no-audio`, but the backend has NAMED the cause: macOS reports the
  // mic grant as Authorized and is delivering digital silence anyway (zero_source=Os). A different
  // bucket rather than a variant of `no-audio` because the remedy inverts — nothing is holding the
  // device and no other input will help; the process's grant has to be re-established.
  | "stale-grant"
  // The SAME reading as `stale-grant` with one more fact established: /Applications/Sparkle.app was
  // replaced under the running process (installed mtime > process start). macOS keys a microphone
  // grant to code identity at a path, so that swap kills the running binary's grant while
  // AVCaptureDevice.authorizationStatus keeps answering Authorized from a process-local cache.
  // Its own bucket because the remedy NARROWS to exactly one act — quit and reopen — and the
  // Privacy pane, which `stale-grant` still offers last, is a proven dead end here: it shows
  // Sparkle already switched on, and toggling it re-grants the bundle on disk rather than the
  // unlinked binary the user is talking to. Bead sparkle-1ueh3.
  | "bundle-replaced"
  | "no-device"
  | "unsupported-format"
  | "download"
  | "disk-space"
  | "permission"
  | "unknown";

/** The kinds the frame-liveness WATCHDOG emits — the family that its `dictation://audio-recovered`
 *  all-clear is allowed to retract.
 *
 *  ONE PREDICATE BECAUSE THE SEAM DRIFTED THE MOMENT IT WAS SPLIT. `stale-grant` was added as a
 *  second watchdog kind while `useDictation` still tested `=== "no-audio"` at both ends of the
 *  retraction: the fault was never latched, so the all-clear early-returned, and a stale-grant
 *  notice stayed on screen — with the mic drawn as paused — over a microphone that had recovered.
 *  A third kind added later must land here rather than at those two call sites (knightwatch probe 1
 *  on PR #1344).
 *
 *  Membership is decided by WHO EMITS IT, not by what the copy says: only the watchdog retracts, so
 *  only the watchdog's own notices may be cleared by its all-clear. A model-download failure or a
 *  permission denial is still true when frames resume. */
export function isWatchdogFault(kind: VoiceErrorKind): boolean {
  return kind === "no-audio" || kind === "stale-grant" || kind === "bundle-replaced";
}

export interface VoiceErrorNotice {
  kind: VoiceErrorKind;
  /** One line: what went wrong, in the user's terms. */
  headline: string;
  /** One line: what to DO about it. For `unknown` this is the raw backend error verbatim. */
  detail: string;
}

// Matched against the lower-cased raw error. Deliberately loose — these strings come from ureq,
// std::io and cpal (`e.to_string()`), and a sibling worker is actively rewording the Rust side
// (clearer disk-space copy, retries/timeouts). So we match on the DURABLE noun phrases rather than
// pinning exact sentences, and anything we don't recognize falls through to `unknown` (which shows
// the raw string) rather than being forced into a bucket that would misattribute the cause.
const PATTERNS: [VoiceErrorKind, RegExp][] = [
  // FIRST — but, unlike the entry below it, NOT because correctness depends on winning the race.
  //
  // The backend sentence this matches is LEXICALLY DISJOINT from the stale-grant one: it does not
  // contain "sending silence instead of audio", so `stale-grant` cannot claim it at any position,
  // and it carries no DENIAL word ("revoked" is not one) so it cannot fall into `permission`
  // either. That disjointness is enforced on the Rust side too (watchdog.rs's BUNDLE_REPLACED_
  // MESSAGE doc, constraint 2) precisely so this bucket does not depend on list order — an
  // ordering dependency is a silent failure mode, and this file already carries one it must not
  // add a second to. It leads the list because it is the most specific cause we can name.
  ["bundle-replaced", /updated in the background/],
  // BEFORE EVERYTHING, INCLUDING `no-audio`, AND FOR A SHARPER REASON THAN THE NOTE BELOW.
  //
  // This sentence names microphone permission and the Privacy pane, so it matches MIC_CONTEXT AND
  // DENIAL and would fall into `permission` on its own. That bucket's remedy is "allow it in System
  // Settings → Privacy & Security → Microphone" — and in THIS state the user goes there and finds
  // Sparkle already switched on, because the grant is stale rather than withheld. A remedy that
  // sends someone to a control that is already in the position it recommends is the dead end
  // AGENTS.md's remedy rule exists to prevent, so the specific cause must win over the generic one.
  ["stale-grant", /sending silence instead of audio/],
  // FIRST among the rest, and that placement is load-bearing — not stylistic.
  //
  // The frame-liveness watchdog's message INTERPOLATES A DEVICE NAME the OS handed us verbatim
  // (`No audio from "MacBook Pro Microphone". …`). Device names are arbitrary third-party strings:
  // the very virtual-audio drivers that cause this fault get to name themselves, and nothing stops
  // one calling itself "No Input Device", "Downloads", or "Disk Full". Worse, the message's own
  // remedy names the microphone and the mic menu — precisely the vocabulary `no-device` and
  // `permission` are watching for. Any later position means an arbitrary substring can demote a
  // POSITIVE, observed report ("we watched frames not arrive from THIS device") into one of the
  // guesses below, and the user gets told to plug in a microphone that is already plugged in.
  //
  // That misdiagnosis is the whole bug this bucket exists to kill: a dead mic must never read as a
  // quiet room, and it must not read as a missing one either. Matched on the durable noun phrase
  // only, per this file's convention — the sentence around it is the backend's to reword.
  ["no-audio", /no audio from/],
  // Order matters. no-device / format / disk / download are checked BEFORE permission because
  // permission's own words ("denied", "authorized") are generic enough to appear in their messages.
  ["no-device", /no (default )?input device|no such device|device not available|no microphone/],
  ["unsupported-format", /unsupported (sample )?format|sample format/],
  // "no space left on device (os error 28)" — and the friendlier Rust-side "Need ~1.3 GB free…".
  ["disk-space", /no space left|not enough (disk )?space|insufficient (disk )?space|enospc|gb free|disk full/],
  // The one-time model fetch: ureq transport errors, DNS, TLS, timeouts, and model.rs's own
  // post-unpack integrity check ("model download completed but expected files are missing").
  [
    "download",
    /download|dns|resolve|network|offline|timed? ?out|timeout|unreachable|connection|connect |tls|certificate|lookup address|http[s]?:\/\//,
  ],
];

// Permission is the one bucket that needs BOTH halves to match, so it gets its own pair rather
// than an alternation in PATTERNS above. Only a MIC-scoped denial earns the Privacy-pane remedy: a
// bare "Permission denied (os error 13)" (e.g. failing to write the model dir) must never send the
// user off to fiddle with microphone permissions — that misattribution is the entire bug this
// module exists to kill, so the guard must not be weakenable by a stray word. Requiring both also
// means a denial-flavored word inside an unrelated message (a URL containing "privacy", say) can't
// reach this bucket on its own.
const MIC_CONTEXT = /microphone|\bmic\b|audio|input device|capture|tccservicemicrophone/;
const DENIAL = /permission|denied|deny|not authoriz|unauthoriz|privacy|\btcc\b/;

/** Deep-link to System Settings → Privacy & Security → Microphone, the ONLY remedy once macOS has
 *  recorded a denial (the OS never re-prompts — see src-tauri/src/mic_permission.rs). Opened via
 *  `openUrl` from @tauri-apps/plugin-opener, the same path Markdown.tsx / ToolsPane.tsx use.
 *
 *  Only ever surfaced for a `permission` notice, which only the macOS backend can produce: the
 *  non-macOS mic_permission stub reports Authorized and never emits a denial, so this mac-only URL
 *  cannot be reached from the Windows port.
 *
 *  A NotDetermined user must NEVER be sent here — the backend prompts them instead, and this pane
 *  would show them no Sparkle entry at all to switch on. That split is enforced in Rust (`decide`);
 *  by the time any string reaches this module, the OS has already refused for good. */
export const MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

/** Pull the DEVICE NAME out of the watchdog's dead-mic report, where it arrives quoted
 *  (`No audio from "MacBook Pro Microphone". …`). That name is the one fact only the backend has,
 *  and the remedy is unfollowable without it — "pick a different input" means nothing until the user
 *  knows which input to pick a different one FROM.
 *
 *  Null when the sentence no longer looks the way we expect, which is the honest signal to fall back
 *  to showing the raw string rather than authoring a remedy about an unnamed device. The prefix is
 *  pinned in backendVoiceErrors.ts (BACKEND_NO_AUDIO_PREFIX); see the note there about a backend
 *  reword failing soft. */
function noAudioDevice(text: string): string | null {
  const m = /no audio from\s+"([^"]+)"/i.exec(text);
  return m?.[1] ?? null;
}

/** The device name out of the STALE-GRANT report, which quotes it in a different clause than
 *  {@link noAudioDevice} parses. Same null-means-fall-back-to-raw contract. */
function staleGrantDevice(text: string): string | null {
  const m = /sending silence instead of audio from\s+"([^"]+)"/i.exec(text);
  return m?.[1] ?? null;
}

/** The device name out of the BUNDLE-REPLACED report. Same null-means-fall-back-to-raw contract as
 *  its two siblings — a reworded backend must surface its own string rather than have this module
 *  author a confident remedy about a device it can no longer name.
 *
 *  Note the clause is "sending silence from", NOT "sending silence instead of audio from": the two
 *  sentences are deliberately disjoint, so neither parser can pull a name out of the other's
 *  message and mislabel the bucket. */
function bundleReplacedDevice(text: string): string | null {
  const m = /sending silence from\s+"([^"]+)"/i.exec(text);
  return m?.[1] ?? null;
}

/** Bucket a raw backend error string. Pure + exported so the mapping is unit-tested directly
 *  (this codebase's convention — cf. deriveMicState / shouldBlockMicArm in MicButton). */
export function classifyVoiceError(raw: string): VoiceErrorKind {
  const s = (raw ?? "").toLowerCase();
  if (!s.trim()) return "unknown";
  for (const [kind, re] of PATTERNS) if (re.test(s)) return kind;
  if (MIC_CONTEXT.test(s) && DENIAL.test(s)) return "permission";
  return "unknown";
}

/** Map a raw error to the copy both mic surfaces render. Null when there's no error to show.
 *  Every branch names a cause the string actually supports; the `unknown` branch names none and
 *  shows the raw text instead, so the user can at least see (and report) what really happened. */
export function voiceErrorNotice(raw: string | null | undefined): VoiceErrorNotice | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const kind = classifyVoiceError(text);
  switch (kind) {
    case "no-audio": {
      // The backend's sentence carries a FACT we cannot reconstruct (which device went silent) and
      // an INSTRUCTION we must not ship unaudited. Those halves are split here, because they belong
      // to different owners: the backend knows the device, this module owns where users are sent.
      //
      // A remedy string is an instruction the user will follow, so it gets the same scrutiny as the
      // code path it replaces (AGENTS.md). This one was written when the mic menu was a three-mode
      // pill (listening / muted / off) with no device list, so the backend's "pick a different
      // input in the mic menu" was overridden here and pointed at System Settings → Sound instead.
      //
      // BOTH halves of that reasoning have since flipped. `AudioInputPicker` exists and now lives
      // in Settings (`INPUT_PICKER_LOCATION`), so the control this names is real and reachable —
      // and System Settings became actively WRONG, because capture no longer follows the system
      // default: automatic selection prefers a physical input over it, and a pinned UID ignores it
      // outright (audio_devices::select_device). Sending someone to change the OS default can leave
      // capture on the very device this notice just named. The picker is the only control that
      // actually rebinds. Named through the SHARED constant, never a hard-coded phrase, because the
      // picker has already moved once (mic hover menu → Settings) and every remedy has to move with
      // it — a remedy naming a control by a location it no longer has is a dead end.
      //
      // `no-device` and `unsupported-format` reach the same conclusion in their own branches; the
      // whole bucket set now names the picker, and only mute still names System Settings.
      const device = noAudioDevice(text);
      return {
        kind,
        // Names the failure the way the user is experiencing it: they have been talking, and
        // nothing is landing. Not "no microphone" (there is one, it's selected, and it's open) and
        // not "voice couldn't start" (it started — that's what makes this invisible).
        headline: "Sparkle isn't hearing your microphone.",
        // The device name is quoted straight from the backend — same precedent as disk-space
        // passing "Need ~1.3 GB free…" through, i.e. keep the specifics we cannot reconstruct.
        // When the sentence no longer parses we show it RAW rather than authoring a remedy about a
        // device we can't name: a wordy string the user can read and report beats a confident one
        // that omits the only detail that mattered.
        detail: device
          ? `Another app may be holding "${device}" — a screen recorder or a virtual audio device. Pick a different input in ${INPUT_PICKER_LOCATION}, or turn the mic off and on.`
          : text,
      };
    }
    case "bundle-replaced": {
      // THE ONE FAULT IN THIS FILE WHOSE CAUSE IS PROVEN RATHER THAN RANKED. Every other branch
      // offers ordered remedies because the reading admits more than one story; this one does not.
      // Bead sparkle-1ueh3's natural experiment: 12 of 12 fault clusters ended in a restart onto a
      // HIGHER version, ZERO successful transcripts followed a swap across six days, and ZERO
      // "audio is arriving again" recoveries have ever been recorded. Nothing but a relaunch has
      // ever ended one of these.
      //
      // SO THIS BRANCH NAMES NO PANE, and that is the entire point of splitting it out of
      // `stale-grant`. That sibling ends at System Settings → Privacy & Security → Microphone,
      // which is defensible for a grant that went stale for an unknown reason. Here the reason is
      // known and the pane is a proven dead end: Sparkle is already switched on in it, and the
      // switch governs the code identity now on disk, not the unlinked binary the user is talking
      // to. AGENTS.md's remedy rule — an instruction the user will follow must name a control that
      // exists AND works — makes mentioning it worse than saying nothing.
      const device = bundleReplacedDevice(text);
      return {
        kind,
        // Leads with the CAUSE, not the symptom, because the cause is the part that makes the
        // remedy make sense: "quit and reopen" reads as a shrug until you know the app on disk is
        // no longer the app that is running.
        headline: "Sparkle updated while it was running.",
        detail: device
          ? `The update replaced Sparkle on disk, so macOS stopped letting the running copy hear "${device}". Quit Sparkle and open it again — that restores the microphone. Nothing on your Mac needs changing.`
          : text,
      };
    }
    case "stale-grant": {
      // THE COPY THE 2026-08-05 SILENCE NEEDED. The founder sat talking to a dead microphone while
      // the app knew, every second, that the OS was handing it pure zeros. What he was shown (the
      // `no-audio` branch above) told him another app might be holding the mic — nothing was.
      //
      // So this branch says the two things the evidence actually supports: it is NOT you and not
      // your hardware, and relaunching is the first thing to try. The Privacy pane is named last and
      // framed as off-and-on rather than "allow it", because the grant is stale rather than missing
      // and the switch is already on — telling someone to enable something they can see is enabled
      // reads as the app being confused, and leaves them with nothing to try.
      //
      // ORDERED, NOT EXCLUSIVE — and that is a correction. `zero_source=Os` says the zeros came from
      // the OS rather than from our downmix; audio.rs's own note spells out that a BUSY device reads
      // the same way ("a muted or busy device, or the very fault this guard was written for"), and
      // muted is already ruled out upstream. So a held device is still on the table, and asserting a
      // stale grant as fact would reproduce the original defect with the blame moved: a confident
      // wrong cause. Relaunch leads because it is free, fixes the case the founder actually hit, and
      // is harmless if the real cause is a held device; the held-device check follows it rather than
      // being denied (knightwatch probe 1).
      const device = staleGrantDevice(text);
      return {
        kind,
        // Names macOS as the actor. The mic is armed, the ring is lit and the user is talking, so
        // the first job of this line is to say the silence is real and it is not theirs.
        headline: "macOS is sending silence, not audio.",
        detail: device
          ? `macOS says Sparkle may use "${device}" and is sending zeros anyway. Quit Sparkle and open it again — that usually fixes it. If it comes back, quit anything else that might be holding the mic (a video call or a screen recorder), then switch Sparkle off and on in System Settings → Privacy & Security → Microphone.`
          : text,
      };
    }
    case "no-device":
      return {
        kind,
        headline: "No microphone found.",
        // The most reachable producer of this bucket is audio.rs's Refuse: inputs WERE enumerated,
        // they were all virtual, and capture refused rather than bind a loopback. The backend's own
        // sentence names the two real ways out — connect a microphone, or turn on the advanced
        // opt-in — and this branch used to discard the second and substitute System Settings, which
        // does nothing in that state: only virtual inputs exist, and select_device refuses a virtual
        // device regardless of the OS default (roborev 55360). Both options, or neither is honest.
        detail:
          `Connect a microphone, then turn the mic back on. To transcribe system audio instead, open ${INPUT_PICKER_LOCATION} and turn on "${ALLOW_VIRTUAL_LABEL}".`,
      };
    case "unsupported-format":
      return {
        kind,
        headline: "This microphone's audio format isn't supported.",
        // The last bucket left on "System Settings → Sound", and the exception was reasoned
        // wrongly (roborev 55413). The comment defending it said the picker "has nothing better to
        // offer" because the device cannot be opened at all — but an unsupported sample format is a
        // property of ONE device and says nothing about the others, so offering another one is
        // exactly what helps. The producer is `audio.rs`'s "unsupported sample format: {other}",
        // raised for the device `resolve_device` already bound, i.e. Sparkle's OWN selection: a
        // pinned UID ignores the system default outright and `auto_select` prefers a physical input
        // over it, so changing the OS default cannot rebind capture away from the failing device.
        detail:
          `Pick a different input in ${INPUT_PICKER_LOCATION}, then turn the mic back on.`,
      };
    case "download":
      return {
        kind,
        headline: "Couldn't download the voice model.",
        detail: "Voice needs a one-time ~482 MB download. Check your internet connection, then turn the mic back on to retry.",
      };
    case "disk-space":
      return {
        kind,
        headline: "Not enough disk space for the voice model.",
        // When the backend quotes an actual size ("Need ~1.3 GB free…") it knows more than we do —
        // pass it through. A bare "no space left on device (os error 28)" is not prose a user can
        // act on, so it gets the generic remedy instead (and stays visible via the sidebar/raw).
        detail: /\d\s*(gb|mb)/i.test(text)
          ? text
          : "Free up some disk space, then turn the mic back on to retry.",
      };
    case "permission":
      return {
        kind,
        headline: "Sparkle can't use the microphone.",
        detail: "Allow it in System Settings → Privacy & Security → Microphone, then turn the mic back on.",
      };
    default:
      return {
        kind: "unknown",
        headline: "Voice couldn't start.",
        // No guess. The raw backend string is the only honest thing we have, and showing it beats
        // inventing a cause the user would then chase (the old hardcoded mic-permission sentence).
        detail: text,
      };
  }
}
