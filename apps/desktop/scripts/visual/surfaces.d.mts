// TYPES FOR THE SURFACE REGISTRY, so a TypeScript test can read it.
//
// The harness is plain ESM JavaScript (it runs under bare `node` as well as vitest), and that is
// not changing — but `Workspace.resize.test.tsx` now imports the registry to check that every
// surface asks for a concierge width the capture viewport can actually PAINT. Without this,
// `noImplicitAny` refuses the import outright, and the alternatives are worse: re-spelling the
// surface list in the test is the exact drift this repo keeps paying for, and silencing the error
// with `@ts-expect-error` would type the whole registry as `any` and let a renamed field through.
//
// Deliberately PARTIAL and structural. It describes the fields consumers actually read rather than
// modelling the step vocabulary exactly; a step union restated here would be a second definition
// free to drift from the interpreter in surfaces.mjs, which is the mistake this file exists to
// avoid making. `harness.test.mjs` remains the guard on the registry's own shape.

export interface Surface {
  name: string;
  description: string;
  /** Extra URL parameters appended after `?visual=1` — state the FIXTURE must seed before mount. */
  query?: string;
  app: { steps: unknown[]; clip: string | null };
  mock: { steps: unknown[]; clip: string | null } | null;
}

export declare const SURFACES: Surface[];
export declare const DEFAULT_VIEWPORT: { width: number; height: number };
export declare const THEMES: string[];
export declare const MOCK_CHROME_SELECTORS: string[];
export declare function surfaceByName(name: string): Surface;
export declare function selectSurfaces(names: string | null): Surface[];
export declare function artifactName(surface: string, theme: string): string;
export declare function stepToExpression(step: unknown): string;
