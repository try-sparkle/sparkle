// ESLint 9 flat config for the desktop app (sparkle-w124; enrolled in the gate under ).
//
// Extends the shared base and adds the React rule set the base deliberately omits — the base serves
// plain-TypeScript packages, and desktop is React/TSX.
//
// ENROLLMENT (): CI runs `pnpm -r lint`, a wildcard over every workspace that DECLARES a
// lint script. desktop now declares `"lint"`, so it IS in the gate. Enrollment was gated on the
// tree being green first (per ci.yml: a permanently-red gate teaches everyone to ignore it), which
// is why the react-hooks rule set below is CURATED rather than the blanket `recommended` spread.
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
      // Curated to the two STABLE rules that match the documented intent of this config: a hook
      // called conditionally (rules-of-hooks), and an effect whose dependency list has drifted from
      // its body (exhaustive-deps). Both catch a class of bug tsc cannot.
      //
      // Deliberately NOT `...reactHooks.configs.recommended.rules`: react-hooks v7 expanded
      // `recommended` from those two into 16 rules, adding an experimental static-analysis suite
      // (set-state-in-effect, refs, purity, immutability, globals, static-components, ...). Enabled
      // wholesale that suite reported ~38 errors across shipped desktop UI, each demanding a
      // behavioral rewrite decided on a theory about the running app — the exact kind of change the
      // HintOverlay note in ci.yml warns against making just to satisfy a linter, and more than
      // enough to keep the gate permanently red. Those rules are DEFERRED (bead );
      // re-enable them one at a time behind their own fixes, not by restoring the blanket spread.
      "react-hooks/rules-of-hooks": "error",
      // warn, not error: a drifted dependency list is worth surfacing but is often an intentional
      // run-once effect. A single warning does not error, but the desktop lint script caps the
      // total (`eslint src --max-warnings 12`), so NEW drift beyond today's 12 fails the gate.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Test files legitimately reach for `any` to assemble partial mocks and to poke at internals a
    // production caller never would. The base rule (error) is right for shipped code but noise here,
    // so it is relaxed for tests only; production .ts/.tsx stays covered.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];
