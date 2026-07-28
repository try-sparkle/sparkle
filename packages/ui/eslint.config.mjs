// ESLint 9 flat config for @sparkle/ui. Enrolls the package in `pnpm -r lint` ().
//
// @sparkle/ui is design tokens plus a barrel export (tokens.ts, index.ts) — plain TypeScript with
// no React component/hook code — so the shared base applies verbatim. Both files lint clean under
// it today. If real .tsx components land here later, mirror the desktop config and add the
// react-hooks layer at that point.
import base from "../../eslint.config.base.mjs";

export default base;
