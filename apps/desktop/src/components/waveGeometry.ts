// The one number the waveform and anything drawn ON TOP of it both have to agree about.
//
// It lives in its own module rather than on `LogoWaveform` deliberately. Roughly forty test files
// stub that component with `vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }))`, and a
// module mock is TOTAL — exporting a plain constant from there makes it `undefined` in every one of
// those suites, so the consumer either crashes or silently lays out against nothing. A constants
// module nobody has a reason to mock is immune to that.

/** Height of the wave stage in px. Bars are mirrored about the vertical centre — they grow up AND
 *  down from the middle — so a single bar can reach this full height.
 *
 *  Shared because the concierge's credit pill floats OVER the bars: it centres against the wave
 *  stage's own height rather than the strip's, so it sits on the bars instead of drifting with the
 *  caption block underneath them. Two copies of `56` would drift the first time one changed. */
export const WAVE_HEIGHT = 56;
