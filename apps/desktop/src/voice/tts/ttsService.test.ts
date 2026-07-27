import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ttsService is the overlay's ONE voice pipeline: ElevenLabs clone when configured, system
// voice when not (or when the network fails), silence when the gate is off — and it must
// NEVER throw, because a voice hiccup must never take the overlay down with it. These tests
// pin the four contracts the swarm/overlay callers depend on:
//   1. the ElevenLabs request carries the PRD §5 tuned settings verbatim (they were
//      validated by ear on the prototype — a drive-by "cleanup" here is a regression),
//   2. the cache replays a repeated line without a second network hit,
//   3. missing key and failed fetch both degrade to the system voice and REPORT that path,
//   4. getVoiceLevel always yields 0..1 with motion on either path (real RMS or sinusoid).
//
// Everything platform-y (fetch, Audio, AudioContext, speechSynthesis, Date.now) is stubbed,
// and the module is re-imported per test so its playback/cache state starts cold.

class MockAudio {
  static instances: MockAudio[] = [];
  /** Set to make the NEXT play() reject, e.g. a blocked-autoplay policy (NotAllowedError). */
  static rejectNextPlay = false;
  src: string;
  preservesPitch = false;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => {
    if (MockAudio.rejectNextPlay) {
      MockAudio.rejectNextPlay = false;
      throw new Error("NotAllowedError");
    }
  });
  pause = vi.fn();
  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }
}

class MockAnalyser {
  fftSize = 2048;
  connect = vi.fn();
  // A loud-ish steady waveform: |v| = 0.5 everywhere → RMS 0.5 → target level clamps to 1.
  getByteTimeDomainData = vi.fn((arr: Uint8Array) => arr.fill(192));
}

class MockAudioContext {
  state = "running";
  destination = {};
  resume = vi.fn(async () => {});
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => new MockAnalyser());
}

class MockUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  voice: unknown = undefined;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** speechSynthesis stub whose utterances the test finishes by hand (u.onend()). */
function makeSynth() {
  const utterances: MockUtterance[] = [];
  return {
    utterances,
    speak: vi.fn((u: MockUtterance) => {
      utterances.push(u);
      u.onstart?.();
    }),
    cancel: vi.fn(),
    getVoices: vi.fn(() => []),
  };
}

/** Drain the microtask chain speak() awaits through (fetch → blob → play). */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, blob: async () => new Blob(["mp3"]) }));
}

let synth: ReturnType<typeof makeSynth>;
let fetchMock: ReturnType<typeof vi.fn>;
let nowMs: number;
let urlCount: number;

async function loadService() {
  vi.resetModules();
  return await import("./ttsService");
}

beforeEach(() => {
  MockAudio.instances = [];
  MockAudio.rejectNextPlay = false;
  synth = makeSynth();
  fetchMock = okFetch();
  nowMs = 1_000_000;
  urlCount = 0;
  vi.stubGlobal("Audio", MockAudio);
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mock-${++urlCount}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubElevenEnv(model?: string): void {
  vi.stubEnv("VITE_ELEVENLABS_API_KEY", "sk_test_not_a_real_key");
  vi.stubEnv("VITE_ELEVENLABS_VOICE_ID", "voice123");
  if (model !== undefined) vi.stubEnv("VITE_ELEVENLABS_MODEL", model);
}

describe("speak — ElevenLabs path", () => {
  it("builds the request with the PRD §5 tuned settings, verbatim", async () => {
    stubElevenEnv();
    const svc = await loadService();
    const p = svc.speak("Hello ✦ Sparkle");
    await flush();
    expect(MockAudio.instances).toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "xi-api-key": "sk_test_not_a_real_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hello  Sparkle", // ✦ glyph stripped before synthesis
      model_id: "eleven_multilingual_v2", // PRD default when no env override
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.85,
        style: 0.55,
        use_speaker_boost: true,
        speed: 1.2,
      },
    });

    // ~1.5× perceived speed = ElevenLabs' native 1.2× cap × pitch-preserving 1.25× playback.
    const audio = MockAudio.instances[0]!;
    expect(audio.preservesPitch).toBe(true);
    expect(audio.playbackRate).toBe(1.25);

    audio.onended?.();
    await expect(p).resolves.toBe("elevenlabs");
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("a stopVoice() DURING the fetch cancels the clip — it never plays (roborev 48171)", async () => {
    // Barge-in: the user hits Send (or the mic) while a reply's audio is still generating.
    // Interruption is deferred until the fetch resolves so the PREVIOUS clip's tail isn't cut —
    // but that must not mean the cancelled clip starts a second later anyway.
    stubElevenEnv();
    const svc = await loadService();
    let release!: (v: { ok: boolean; blob: () => Promise<Blob> }) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((res) => { release = res; }),
    );

    const p = svc.speak("the reply nobody waited for");
    await flush();
    expect(MockAudio.instances).toHaveLength(0); // still generating

    svc.stopVoice();
    release({ ok: true, blob: async () => new Blob(["mp3"]) });

    await expect(p).resolves.toBe("cancelled");
    expect(MockAudio.instances).toHaveLength(0); // and nothing was ever played
  });

  it("a REJECTED fetch after a stopVoice() stays cancelled — no system-voice consolation prize", async () => {
    // The flaky-ElevenLabs branch: without the same check in the catch, the clip the user just
    // barged in on gets read aloud by the system voice instead (roborev 52362/52363).
    stubElevenEnv();
    const svc = await loadService();
    let fail!: (e: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise((_res, rej) => { fail = rej; }));

    const p = svc.speak("the reply nobody waited for");
    await flush();
    svc.stopVoice();
    fail(new Error("offline"));

    await expect(p).resolves.toBe("cancelled");
    expect(synth.speak).not.toHaveBeenCalled();
    expect(MockAudio.instances).toHaveLength(0);
  });

  it("a BLOCKED autoplay still falls back to the system voice — not silence (roborev 53004)", async () => {
    // The failure that happens AFTER speak()'s own stopVoice(). Comparing against a generation
    // captured before that self-stop would read it as "someone cancelled me" and return silence,
    // with voiceActive left true so the overlay keeps pulsing for a clip that never played.
    stubElevenEnv();
    const svc = await loadService();
    MockAudio.rejectNextPlay = true;

    const p = svc.speak("say this out loud");
    await flush();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    synth.utterances[0]!.onend?.();
    await expect(p).resolves.toBe("system-fallback");
  });

  it("a stopVoice() BEFORE the clip is asked for doesn't cancel the next one", async () => {
    // The counter must gate on "stopped while I was fetching", not "stopped at any point".
    stubElevenEnv();
    const svc = await loadService();
    svc.stopVoice();
    const p = svc.speak("say this");
    await flush();
    expect(MockAudio.instances).toHaveLength(1);
    MockAudio.instances[0]!.onended?.();
    await expect(p).resolves.toBe("elevenlabs");
  });

  it("honors a VITE_ELEVENLABS_MODEL override", async () => {
    stubElevenEnv("eleven_turbo_v2_5");
    const svc = await loadService();
    const p = svc.speak("hi");
    await flush();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model_id).toBe("eleven_turbo_v2_5");
    MockAudio.instances[0]!.onended?.();
    await p;
  });

  it("replays a repeated line from cache: one fetch, one object URL, same src", async () => {
    stubElevenEnv();
    const svc = await loadService();

    const p1 = svc.speak("again and again");
    await flush();
    MockAudio.instances[0]!.onended?.();
    await p1;

    const p2 = svc.speak("again and again");
    await flush();
    MockAudio.instances[1]!.onended?.();
    await expect(p2).resolves.toBe("elevenlabs");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(MockAudio.instances[1]!.src).toBe(MockAudio.instances[0]!.src);
  });

  it("stopVoice pauses in-flight audio and resolves the pending speak", async () => {
    stubElevenEnv();
    const svc = await loadService();
    const p = svc.speak("interrupt me");
    await flush();
    const audio = MockAudio.instances[0]!;
    svc.stopVoice();
    expect(audio.pause).toHaveBeenCalled();
    expect(synth.cancel).toHaveBeenCalled();
    await expect(p).resolves.toBe("elevenlabs");
    expect(svc.isSpeaking()).toBe(false);
  });

  it("stopVoice interrupts the SYSTEM-FALLBACK path: cancels synthesis and resolves the pending speak", async () => {
    // No key → system voice. stopVoice() must cancel synthesis AND release the awaiter even
    // though a mock synth never fires onend on cancel (real engines do; mocks/platforms may not).
    const svc = await loadService();
    const p = svc.speak("interrupt the fallback");
    await flush();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(svc.isSpeaking()).toBe(true);
    svc.stopVoice();
    expect(synth.cancel).toHaveBeenCalled();
    await expect(p).resolves.toBe("system-fallback");
    expect(svc.isSpeaking()).toBe(false);
  });

  it("a second speak while one is in flight resolves the first cleanly (currentAudio superseded)", async () => {
    // The first clip's element is replaced by the second speak's stopVoice()+new Audio; the
    // first speak() must take its `currentAudio !== a` early return and resolve, not hang.
    stubElevenEnv();
    const svc = await loadService();
    const first = svc.speak("first line");
    await flush();
    expect(MockAudio.instances).toHaveLength(1);

    const second = svc.speak("second line");
    await flush();
    // Second speak created a fresh element and superseded the first.
    expect(MockAudio.instances).toHaveLength(2);
    await expect(first).resolves.toBe("elevenlabs");

    // The second still finishes normally on its own end event.
    MockAudio.instances[1]!.onended?.();
    await expect(second).resolves.toBe("elevenlabs");
    expect(svc.isSpeaking()).toBe(false);
  });
});

describe("speak — fallback and gate", () => {
  it("no key configured → system voice, reported as such, no network call", async () => {
    const svc = await loadService();
    const p = svc.speak("no key here");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    synth.utterances[0]!.onend?.();
    await expect(p).resolves.toBe("system-fallback");
  });

  it("fetch rejection → system voice, never a thrown error", async () => {
    stubElevenEnv();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const svc = await loadService();
    const p = svc.speak("network down");
    await flush();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    synth.utterances[0]!.onend?.();
    await expect(p).resolves.toBe("system-fallback");
  });

  it("non-2xx response → system voice too", async () => {
    stubElevenEnv();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const svc = await loadService();
    const p = svc.speak("bad key");
    await flush();
    synth.utterances[0]!.onend?.();
    await expect(p).resolves.toBe("system-fallback");
  });

  it("system fallback strips glyphs/smart quotes and tunes rate/pitch", async () => {
    const svc = await loadService();
    const p = svc.speak("✦ “Hello” there");
    await flush();
    const u = synth.utterances[0]!;
    expect(u.text).toBe(" Hello there");
    expect(u.rate).toBe(1.4);
    expect(u.pitch).toBe(1.05);
    u.onend?.();
    await p;
  });

  it("VITE_SPARKLE_VOICE_ENABLED=0 disables voice entirely (text-only)", async () => {
    stubElevenEnv();
    vi.stubEnv("VITE_SPARKLE_VOICE_ENABLED", "0");
    const svc = await loadService();
    await expect(svc.speak("should be silent")).resolves.toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(synth.speak).not.toHaveBeenCalled();
    expect(svc.isVoiceEnabled()).toBe(false);
  });

  it("setVoiceEnabled overrides the env flag in both directions", async () => {
    vi.stubEnv("VITE_SPARKLE_VOICE_ENABLED", "0");
    const svc = await loadService();

    svc.setVoiceEnabled(true); // runtime ON despite build-time off (no key → fallback)
    const p = svc.speak("forced on");
    await flush();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    synth.utterances[0]!.onend?.();
    await expect(p).resolves.toBe("system-fallback");

    svc.setVoiceEnabled(false); // runtime OFF wins over everything
    await expect(svc.speak("muted")).resolves.toBe("disabled");

    svc.setVoiceEnabled(null); // back to deferring to the env flag
    expect(svc.isVoiceEnabled()).toBe(false);
  });
});

describe("getVoiceLevel", () => {
  it("is 0 when idle", async () => {
    const svc = await loadService();
    expect(svc.getVoiceLevel()).toBe(0);
  });

  it("tracks real analyser RMS during ElevenLabs playback, always within 0..1", async () => {
    stubElevenEnv();
    const svc = await loadService();
    const p = svc.speak("measure me");
    await flush();
    expect(svc.isSpeaking()).toBe(true);

    // The stub waveform's RMS target clamps to 1; smoothing should climb toward it, bounded.
    let prev = 0;
    for (let i = 0; i < 5; i++) {
      const level = svc.getVoiceLevel();
      expect(level).toBeGreaterThan(prev);
      expect(level).toBeLessThanOrEqual(1);
      prev = level;
    }
    expect(prev).toBeGreaterThan(0.3);

    MockAudio.instances[0]!.onended?.();
    await p;
  });

  it("synthesizes a plausible moving level on the system fallback (no analyser there)", async () => {
    const svc = await loadService();
    const p = svc.speak("fake waveform");
    await flush();
    expect(svc.isSpeaking()).toBe(true);

    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) {
      nowMs += 73; // stride chosen to sample distinct points of the sinusoid
      const level = svc.getVoiceLevel();
      expect(level).toBeGreaterThanOrEqual(0.35);
      expect(level).toBeLessThanOrEqual(0.65);
      seen.add(level);
    }
    expect(seen.size).toBeGreaterThan(1); // it moves — callers get motion, not a flat line

    synth.utterances[0]!.onend?.();
    await p;
  });

  it("decays back to 0 after speech stops", async () => {
    stubElevenEnv();
    const svc = await loadService();
    const p = svc.speak("then silence");
    await flush();
    svc.getVoiceLevel(); // spin the level up while playing
    MockAudio.instances[0]!.onended?.();
    await p;

    let level = 1;
    for (let i = 0; i < 20 && level > 0; i++) {
      nowMs += 100;
      level = svc.getVoiceLevel();
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
    expect(level).toBe(0);
  });
});
