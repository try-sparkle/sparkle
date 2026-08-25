// TYPES FOR THE SHIM STRING, so `vite.config.ts` (which is inside the typechecked program — a test
// imports it) can inject the SAME source the visual harness installs, instead of restating it.
// Same reasoning as surfaces.d.mts: the alternative is a second copy of the shim, which is the
// outcome bead sparkle-bg6868 explicitly set out to avoid.

/** The dev-only `window.__TAURI_INTERNALS__` bridge, as JavaScript source to evaluate. */
export const TAURI_SHIM: string;
