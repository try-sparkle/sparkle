// Mic-hot ("audio is active") copy, kept in ONE place so every composer that surfaces the voice
// affordance reads identically. The global dictation pipeline is shared across the build Composer
// and the Think composer, so the placeholder wording must not drift between them.
//
// STOP_PHRASE is the spoken command that ends active dictation (the wake matcher in
// voice/wakeWords.ts recognizes it). The build Composer paints it as a teal→cyan gradient in its
// styled overlay; the native-textarea fallback and the Think composer use the assembled
// MIC_HOT_PLACEHOLDER string verbatim.
//
// The default phrases are re-exported from voiceDefaults.ts — the SINGLE source of the built-in
// words shared with the matcher, store, and configActions — so the on-screen copy defaults can
// never drift from the actually-recognized words.
import { DEFAULT_WAKE_WORD, DEFAULT_STOP_WORD } from "./voiceDefaults";
export const STOP_PHRASE = DEFAULT_STOP_WORD;
// ACTIVE phase (the wake word was heard; dictation is live). Only show this when the backend is
// BOTH capturing (status "listening") AND in the active phase — never while merely waiting for
// the wake word, or the composer lies about being in dictation mode (sparkle voice-status bug).
export const MIC_HOT_PREFIX = "I'm listening, so just start talking. Say ";
export const MIC_HOT_SUFFIX = " to finish.";
/** Assemble the mic-hot placeholder around the CONFIGURED stop phrase. Defaults to STOP_PHRASE so
 *  `micHotPlaceholder()` === the old MIC_HOT_PLACEHOLDER constant (back-compat). */
export function micHotPlaceholder(stopPhrase: string = STOP_PHRASE): string {
  return `${MIC_HOT_PREFIX}${stopPhrase}${MIC_HOT_SUFFIX}`;
}
export const MIC_HOT_PLACEHOLDER = micHotPlaceholder();

// PASSIVE phase (capturing, but listening for the wake word — NOT yet dictating). Mirrors the
// sidebar caption so the composer's status is honest: it is not in active dictation, it is waiting
// for "Hey Sparkle", which reads as "Mic paused. Say Hey Sparkle to activate." Here "paused" means
// "not actively dictating yet", not "mic off" — the live wake phrase in the same line makes that
// clear. The "(or you can type here instead)" tail subsumes the typing hint,
// like the mic-hot copy does, so it stays put on focus.
export const WAKE_PHRASE = DEFAULT_WAKE_WORD;
export const WAKE_PREFIX = "Mic paused. Say ";
export const WAKE_SUFFIX = " to activate (or you can type here instead).";
/** Assemble the passive placeholder around the CONFIGURED wake word. Defaults to WAKE_PHRASE so
 *  `wakePlaceholder()` === the old WAKE_PLACEHOLDER constant (back-compat). */
export function wakePlaceholder(wakeWord: string = WAKE_PHRASE): string {
  return `${WAKE_PREFIX}${wakeWord}${WAKE_SUFFIX}`;
}
export const WAKE_PLACEHOLDER = wakePlaceholder();

// FOCUS-PAUSED (armed, but the backend is NOT capturing — window unfocused/muted, or capture hasn't
// started yet). The mic can't hear anything here, so BOTH surfaces must say so rather than one of
// them inviting the wake word. This is the composer's wording for the state the sidebar captions as
// "Listening paused: Will auto-resume…" (LogoWaveform.captionFor). Both open with "Listening paused"
// so they read as the same state; the composer's adds the reassurance that the box still works.
// deriveMicPresentation === "focusPaused" is the shared signal that selects this on both surfaces.
export const PAUSED_COMPOSER_PLACEHOLDER = "Listening paused — you can type here meanwhile.";

// PREPARING (the mic is armed but the one-time voice-model download is still running). On a first
// run this takes MINUTES, and we used to spend all of it painting the passive wake-word copy —
// inviting the user to say "Hey Sparkle" at a model that didn't exist yet. This copy replaces it so
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
  | "no-device"
  | "unsupported-format"
  | "download"
  | "disk-space"
  | "permission"
  | "unknown";

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
    case "no-device":
      return {
        kind,
        headline: "No microphone found.",
        detail: "Connect a microphone (or pick an input device in System Settings → Sound), then turn the mic back on.",
      };
    case "unsupported-format":
      return {
        kind,
        headline: "This microphone's audio format isn't supported.",
        detail: "Pick a different input device in System Settings → Sound, then turn the mic back on.",
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
