// ElevenLabs text-to-speech for the Living Sparkle Overlay (bead sparkle-zf4d).
//
// speak(text) plays DROdio's ElevenLabs voice clone and resolves — with the path that was
// actually used — when playback finishes. It NEVER throws: no key configured, a network
// failure, or a playback error all degrade to the system voice (SpeechSynthesisUtterance),
// and a disabled voice gate resolves immediately as "disabled". Repeat lines replay
// instantly from an in-memory object-URL cache.
//
// getVoiceLevel() exposes a smoothed 0..1 RMS of the playing audio (an AnalyserNode tapped
// into the <audio> element, ported from the prototype's hookAnalyser) so the overlay swarm
// can pulse with Sparkle's voice. The system fallback gives no analyser access, so there we
// synthesize the prototype's plausible sinusoid — callers always get motion while speech is
// audible.
//
// Voice tuning comes verbatim from PRD/sparkle/living-sparkle-overlay.md §5: expressive
// low-stability settings, ElevenLabs' native speed capped at 1.2×, and pitch-preserving
// 1.25× browser playback on top for ~1.5× perceived speed without chipmunking.
//
// Credentials follow the analytics.ts pattern — build-time Vite env — under
// VITE_ELEVENLABS_API_KEY / VITE_ELEVENLABS_VOICE_ID / VITE_ELEVENLABS_MODEL. Nothing is
// hard-coded and no other repo's .env is read at runtime; with no key the service cleanly
// uses the system fallback. VITE_SPARKLE_VOICE_ENABLED=0 turns voice off entirely
// (text-only), and setVoiceEnabled() lets the app override the flag at runtime.
//
// ⚠️ ACCEPTED RISK (bead sparkle-rmd2): Vite statically inlines VITE_* into the client
// bundle, so a build made WITH VITE_ELEVENLABS_API_KEY set ships that key inside the app —
// and an ElevenLabs key is a *billable* secret (unlike a write-only analytics key). This is
// acceptable ONLY for founder-local dev builds (voice is off by default and the key is
// absent unless the founder sets it locally). A PUBLIC / distributed build MUST NOT embed
// the key: route TTS through a server-side relay that holds the key (client sends text,
// server returns audio), per sparkle-rmd2. Until then, only build with the key set for
// local use, and prefer a restricted/rotatable key.

/** Which pipeline actually produced (or suppressed) the audio for a speak() call. */
export type TtsPath = "elevenlabs" | "system-fallback" | "disabled";

/** PRD §5 "friendlier voice settings" — validated on the prototype; do not tweak casually. */
export const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.3,
  similarity_boost: 0.85,
  style: 0.55,
  use_speaker_boost: true,
  speed: 1.2,
} as const;

/** ElevenLabs caps native `speed` at 1.2×; pitch-preserving playback covers the rest → ~1.5×. */
export const ELEVENLABS_PLAYBACK_RATE = 1.25;

/** PRD §5: env currently pins multilingual v2 (best quality; ~1–2s first token). */
export const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";

// Vite statically replaces `import.meta.env.VITE_*`; the indirection here keeps reads lazy so
// tests can vi.stubEnv per-case, and the casts mirror analytics.ts.
function envString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ElevenConfig {
  apiKey: string;
  voiceId: string;
  model: string;
}

/** The ElevenLabs credentials, or null when the service must use the system fallback. */
function readElevenConfig(): ElevenConfig | null {
  const apiKey = envString(import.meta.env.VITE_ELEVENLABS_API_KEY);
  const voiceId = envString(import.meta.env.VITE_ELEVENLABS_VOICE_ID);
  if (!apiKey || !voiceId) return null;
  return {
    apiKey,
    voiceId,
    model: envString(import.meta.env.VITE_ELEVENLABS_MODEL) || ELEVENLABS_DEFAULT_MODEL,
  };
}

// Runtime override wins over the build-time flag; null = defer to the env flag.
let voiceEnabledOverride: boolean | null = null;

/** Force voice on/off at runtime (e.g. a settings toggle); pass null to defer to the env flag. */
export function setVoiceEnabled(enabled: boolean | null): void {
  voiceEnabledOverride = enabled;
}

/** The VOICE_ENABLED gate: on unless VITE_SPARKLE_VOICE_ENABLED=0/false/off or a runtime override. */
export function isVoiceEnabled(): boolean {
  if (voiceEnabledOverride !== null) return voiceEnabledOverride;
  const flag = envString(import.meta.env.VITE_SPARKLE_VOICE_ENABLED).toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "off";
}

// ---- playback + analyser state (ported from the prototype's voice section) ----

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let analyserData: Uint8Array<ArrayBuffer> | null = null;
// The source node feeding the analyser. Kept so we can disconnect the whole graph
// between clips — a fresh source+analyser per speak() would otherwise pile up on the
// single reused AudioContext over a long, always-on overlay session.
let currentSource: MediaElementAudioSourceNode | null = null;
let currentAudio: HTMLAudioElement | null = null;
// Resolves the in-flight speak() promise so stopVoice() never strands a caller mid-await.
let finishActive: (() => void) | null = null;
let voiceActive = false;
let sysSpeaking = false;

// Object URLs keyed by voice/model/text so repeat lines replay with zero latency. Entries are
// tiny (a URL string; the blob lives until revoked) and the overlay speaks a bounded script,
// so no eviction is needed.
const ttsCache = new Map<string, string>();

/** Tear down the current source→analyser graph so nodes don't accumulate across clips. */
function disconnectAnalyser(): void {
  try {
    currentSource?.disconnect();
  } catch {
    // Already disconnected / never connected — nothing to do.
  }
  try {
    analyser?.disconnect();
  } catch {
    // Same.
  }
  currentSource = null;
  analyser = null;
  analyserData = null;
}

/** Tap an AnalyserNode into the element so getVoiceLevel can read the live waveform. */
function hookAnalyser(audioEl: HTMLAudioElement): void {
  try {
    audioCtx = audioCtx ?? new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    disconnectAnalyser(); // release the prior clip's graph before building a new one
    const src = audioCtx.createMediaElementSource(audioEl);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyserData = new Uint8Array(analyser.fftSize);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    currentSource = src;
  } catch {
    // No analyser (autoplay policy, unsupported context, …) — audio still plays; the level
    // falls back to the decay branch of getVoiceLevel.
    disconnectAnalyser();
  }
}

/** Cancel in-flight ElevenLabs playback AND any system-voice synthesis. Safe to call anytime. */
export function stopVoice(): void {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  try {
    globalThis.speechSynthesis?.cancel();
  } catch {
    // speechSynthesis missing or broken — nothing to cancel.
  }
  disconnectAnalyser();
  voiceActive = false;
  sysSpeaking = false;
  const finish = finishActive;
  finishActive = null;
  finish?.();
}

/** System-voice fallback. Resolves when the utterance ends (or immediately if synthesis is unavailable). */
function sysSpeak(text: string): Promise<void> {
  return new Promise((res) => {
    try {
      const synth = globalThis.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text.replace(/[✦“”]/g, ""));
      u.rate = 1.4;
      u.pitch = 1.05;
      const voices = synth.getVoices();
      u.voice =
        voices.find((v) => /Samantha|Ava|Allison|Karen|Daniel/i.test(v.name)) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        null;
      const done = (): void => {
        sysSpeaking = false;
        voiceActive = false;
        if (finishActive) finishActive = null;
        res();
      };
      u.onstart = () => {
        sysSpeaking = true;
        voiceActive = true;
      };
      u.onend = done;
      u.onerror = done;
      // Lets stopVoice() (which fires synth.cancel → onend on real engines, but not on all
      // mocks/platforms) resolve this promise deterministically.
      finishActive = done;
      synth.speak(u);
    } catch {
      // No speech synthesis at all — degrade to silence rather than throwing.
      res();
    }
  });
}

/** Fetch (or reuse from cache) the ElevenLabs audio for `text`, returning an object URL. */
async function fetchElevenAudio(text: string, cfg: ElevenConfig): Promise<string> {
  const cacheKey = `${cfg.voiceId}|${cfg.model}|${text}`;
  const cached = ttsCache.get(cacheKey);
  if (cached) return cached;
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.replace(/[✦]/g, ""),
        model_id: cfg.model,
        voice_settings: ELEVENLABS_VOICE_SETTINGS,
      }),
    },
  );
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  ttsCache.set(cacheKey, url);
  return url;
}

/**
 * Speak `text` aloud. Resolves when playback finishes (or immediately when voice is disabled)
 * with the path that produced the audio — callers surface this so the user knows whether they
 * heard the ElevenLabs clone or the system fallback. Never rejects.
 */
export async function speak(text: string): Promise<TtsPath> {
  if (!isVoiceEnabled()) return "disabled";
  const cfg = readElevenConfig();
  if (!cfg) {
    await sysSpeak(text);
    return "system-fallback";
  }
  try {
    // Interruption is DEFERRED here by design: we let any prior clip keep playing during
    // the (up to ~1–2s) fetch and only stopVoice() once the next clip is ready, so speech
    // is continuous rather than cutting to silence mid-generation. When the dialogue loop
    // lands (bead sparkle-c9zn / U5) — which owns the "thinking" burst that would mask that
    // silence — revisit whether to stopVoice() *before* the fetch for snappier barge-in.
    const url = await fetchElevenAudio(text, cfg);
    stopVoice();
    const a = new Audio(url);
    a.preservesPitch = true;
    a.playbackRate = ELEVENLABS_PLAYBACK_RATE;
    hookAnalyser(a);
    currentAudio = a;
    voiceActive = true;
    await a.play();
    // stopVoice() may have fired while play() was settling; don't wait on a paused element.
    if (currentAudio !== a) return "elevenlabs";
    await new Promise<void>((res) => {
      const done = (): void => {
        voiceActive = false;
        if (currentAudio === a) currentAudio = null;
        if (finishActive) finishActive = null;
        res();
      };
      finishActive = done;
      a.onended = done;
      a.onerror = done;
    });
    return "elevenlabs";
  } catch {
    // Network refusal, non-2xx, blocked autoplay — anything. Clear any half-started
    // playback, then degrade. Never throw.
    stopVoice();
    await sysSpeak(text);
    return "system-fallback";
  }
}

// ---- voiceLevel signal (ported from the prototype's per-frame smoothing) ----

let level = 0;
let lastLevelAt = 0;

/**
 * Current voice amplitude in 0..1, smoothed — call once per animation frame. Real RMS from the
 * analyser while ElevenLabs audio plays; the prototype's sinusoid while the system voice talks
 * (no analyser is possible there); a quick decay to 0 otherwise.
 */
export function getVoiceLevel(): number {
  const now = Date.now();
  // Clamp dt so a background-tab stall doesn't snap the decay to zero in one frame.
  const dt = Math.min(0.1, Math.max(0, (now - lastLevelAt) / 1000));
  lastLevelAt = now;
  if (analyser && analyserData && voiceActive && !sysSpeaking) {
    analyser.getByteTimeDomainData(analyserData);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < analyserData.length; i += 4) {
      const v = ((analyserData[i] ?? 128) - 128) / 128;
      sum += v * v;
      count++;
    }
    const target = Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 3.2);
    level += (target - level) * 0.35;
  } else if (sysSpeaking) {
    const t = now / 1000;
    level = 0.35 + 0.3 * Math.abs(Math.sin(t * 6.4) * Math.sin(t * 3.1));
  } else {
    level = Math.max(0, level - dt * 3);
  }
  return Math.min(1, Math.max(0, level));
}

/** Whether audio (either path) is currently being produced. */
export function isSpeaking(): boolean {
  return voiceActive;
}
