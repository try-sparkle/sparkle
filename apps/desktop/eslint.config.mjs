// ESLint 9 flat config for the desktop app (sparkle-w124).
//
// Extends the repo's shared base and adds the React rule set the base deliberately omits — the base
// serves plain-TypeScript packages, and desktop is React/TSX.
//
// NOTE ON ENROLLMENT: CI runs `pnpm -r lint`, a wildcard over every workspace that DECLARES a lint
// script. So adding `"lint"` to this package's package.json is not a neutral act — it enrolls
// desktop in the gate immediately. This config exists so the violation backlog can be MEASURED
// first; the script is added only once the tree is green, per the rationale in ci.yml (a
// permanently-red gate teaches everyone to ignore it).
import base from "../../eslint.config.base.mjs";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...base,
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**", "*.config.*", "scripts/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The rules that catch what tsc cannot: a hook called conditionally, or an effect whose
      // dependency list has drifted from its body. Both are silent-wrong-behavior bugs, which is
      // exactly the class this gate is for.
      ...reactHooks.configs.recommended.rules,
    },
  },
];
