// Rule test for no-reexported-security-helper. RuleTester drives the rule directly so the behaviour
// is pinned: importing a protected security helper THROUGH the module that merely re-exports it is
// flagged (that module is stubbed wholesale by ~44 suites, so the helper resolves to `undefined` and
// the guard silently vanishes -- bead sparkle-aw5xn); importing the same name from the LEAF, or
// importing anything else from the re-exporter, passes. Placed beside svgPaintLint.test.ts and
// crossTargetEventDispatch.test.ts so all three eslint-rule tests share one home; not theme-specific.
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../../../../eslint-rules/no-reexported-security-helper.mjs";

const rt = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

// The full rendered diagnostic, transcribed by hand rather than re-derived from the rule's own
// template, so a message edit that drops the "import from the leaf instead" remedy fails here.
const MESSAGE =
  "`stripPasteMarkers` is imported from `../pty`, which only RE-EXPORTS it from the leaf module " +
  "`pasteMarkers`. Many suites stub `pty` with a WHOLESALE vi.mock factory, and a wholesale factory " +
  "replaces the module's entire export surface -- so inside those suites `stripPasteMarkers` " +
  "resolves to `undefined`, this security guard is silently absent, and the tests stay green anyway. " +
  "Import it from `pasteMarkers` instead: that module has no imports of its own, so it cannot be " +
  "collaterally stubbed.";

describe("no-reexported-security-helper rule", () => {
  it("flags a protected helper reached through the re-exporter and passes the leaf import", () => {
    rt.run("no-reexported-security-helper", rule, {
      valid: [
        // The correct form: straight from the leaf, which nothing stubs.
        {
          code: `import { stripPasteMarkers } from "../pasteMarkers";`,
          filename: "/repo/apps/desktop/src/services/relayGate.ts",
        },
        // A DIFFERENT export of the re-exporter is not protected -- the rule is about the specific
        // helpers, not about importing from `pty` at all.
        {
          code: `import { submitPrompt, writePtyStrict } from "../pty";`,
          filename: "/repo/apps/desktop/src/services/conciergeDispatch.ts",
        },
        // The re-exporter's own arrangement — import from the leaf, re-export — passes for the
        // ordinary reason, not via a special case: its SOURCE is `pasteMarkers`, so it never matches
        // the `pty` entry. The rule carries no self-exemption precisely because nothing needs one.
        {
          // Kept on ONE line so the orphan-test guard's own heuristic applies: it skips a specifier
          // preceded by a quote/backtick on the same line, which is how it tells a fixture string
          // from a real import. Split across two lines, the continuation line looks statement-level
          // (the backtick opened on the line above) and the guard flags `./pasteMarkers` as a
          // dangling import of THIS file — which it is not; the path is relative to the fictional
          // `filename` below, and apps/desktop/src/pasteMarkers.ts exists.
          code: `import { stripPasteMarkers } from "./pasteMarkers"; export { stripPasteMarkers } from "./pasteMarkers";`,
          filename: "/repo/apps/desktop/src/pty.ts",
        },
        // A namespace import does not name which export it will reach, and using the module's own
        // API through it is legitimate; staying silent avoids a false positive.
        {
          code: `import * as pty from "../pty";`,
          filename: "/repo/apps/desktop/src/services/x.ts",
        },
        // An unrelated module whose basename merely CONTAINS the re-exporter's name is not it.
        {
          code: `import { stripPasteMarkers } from "../ptyHelpers";`,
          filename: "/repo/apps/desktop/src/services/x.ts",
        },
        // Options are honoured: with a different helper configured, the pasteMarkers names are not
        // protected at all.
        {
          code: `import { stripPasteMarkers } from "../pty";`,
          filename: "/repo/apps/desktop/src/services/x.ts",
          options: [{ helpers: [{ reexporter: "shell", leaf: "quoting", names: ["shellQuote"] }] }],
        },
      ],
      invalid: [
        // The reported bug shape: a non-test module reaching the filter through `pty`. Pin the FULL
        // rendered message -- the remedy sentence is the part a reader acts on.
        {
          code: `import { stripPasteMarkers } from "../pty";`,
          filename: "/repo/apps/desktop/src/services/relayGate.ts",
          errors: [{ message: MESSAGE }],
        },
        // Path depth and alias form must not matter: the source is matched by its final segment.
        {
          code: `import { PASTE_START } from "@/pty";`,
          filename: "/repo/apps/desktop/src/services/nested/deep/x.ts",
          errors: [{ messageId: "viaReexport" }],
        },
        {
          code: `import { PASTE_END } from "../../../pty.ts";`,
          filename: "/repo/apps/desktop/src/a/b/c/x.ts",
          errors: [{ messageId: "viaReexport" }],
        },
        // One declaration pulling two protected names reports both -- fixing only the first would
        // leave the second hole open.
        {
          code: `import { PASTE_START, submitPrompt, stripPasteMarkers } from "../pty";`,
          filename: "/repo/apps/desktop/src/services/x.ts",
          errors: [{ messageId: "viaReexport" }, { messageId: "viaReexport" }],
        },
        // A second module RE-EXPORTING the helper from `pty` propagates the hazard one hop further,
        // so `export … from` is judged the same as `import … from`.
        {
          code: `export { stripPasteMarkers } from "../pty";`,
          filename: "/repo/apps/desktop/src/services/barrel.ts",
          errors: [{ messageId: "viaReexport" }],
        },
        // A renaming import still reaches the same undefined binding; the IMPORTED name is what the
        // rule judges, not the local alias.
        {
          code: `import { stripPasteMarkers as strip } from "../pty";`,
          filename: "/repo/apps/desktop/src/services/x.ts",
          errors: [{ messageId: "viaReexport" }],
        },
        // Options are honoured in the other direction too: a newly configured helper is protected
        // without touching the rule source.
        {
          code: `import { shellQuote } from "../shell";`,
          filename: "/repo/apps/desktop/src/services/x.ts",
          options: [{ helpers: [{ reexporter: "shell", leaf: "quoting", names: ["shellQuote"] }] }],
          errors: [{ messageId: "viaReexport" }],
        },
      ],
    });
  });
});
