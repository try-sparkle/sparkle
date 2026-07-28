// ESLint 9 flat config for @sparkle/core. Enrolls the package in `pnpm -r lint` ().
//
// A plain-TypeScript package (no React), so it uses the shared base verbatim. The base already
// ignores dist/build/node_modules and `*.config.*` (this file included), and its tseslint layer
// only visits `.ts` sources — analytics.ts, classifier.ts, risk.ts, index.ts and the two *.test.ts
// suites all lint clean under it today, which is why enrolling here adds a real gate rather than a
// red one.
import base from "../../eslint.config.base.mjs";

export default base;
