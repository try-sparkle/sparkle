// Structural guards on AgentPane that cannot be asserted by rendering it: the pane pulls the
// spawn / worktree / preflight tree, which needs the Tauri runtime, so there is no way to mount the
// root and read its computed style. The alternative is asserting nothing about the pane's surface —
// which is exactly how six releases shipped against this direction without matching it. So these
// read the source.
//
// A source assertion is a blunt instrument and is used only where the property is genuinely
// structural: which token paints the surface, that no rule is drawn on the build boundary, and that
// nothing in the render can remount the Terminal. Everything with a rendered surrogate is asserted
// on the surrogate instead (AgentPane.blueprint.test.tsx).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./AgentPane.tsx", import.meta.url)), "utf8");

// The same source with line, block and JSX comments removed. Every guard below is about what the
// component DECLARES, and the component's own explanatory prose names the very properties these
// forbid — matching the raw text would fail on the comment describing a rule rather than on a rule.
const code = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
  .join("\n");

describe("AgentPane — the pane's surface and the build boundary", () => {
  it("paints the pane in the spec's `term` plane", () => {
    expect(code).toContain("background: TERM_PLANE,");
    // The literal it replaced. Same value today, but the point of the token is that the pane's
    // surface is stated as "the term plane" rather than as "whatever forest happens to be".
    expect(code).not.toMatch(/background:\s*C\.forest,/);
  });

  it("draws NO vertical rule between the build column and the terminal", () => {
    // "NO divider inside a pair — build and terminal are one thing" (rev4.html). The selected agent
    // row bleeds 9px across this boundary; a border on either side of it turns that opening into a
    // dock and the concave fillets curve into nothing.
    expect(code).not.toMatch(/borderLeft\s*:/);
    expect(code).not.toMatch(/borderRight\s*:/);
  });

  it("never clips the row's overhang with `overflow: hidden` on the pane's own chain", () => {
    // The first of the two adjacent bugs that make a CORRECT fillet look wrong (MAPPING.md,
    // "Geometry vocabulary"): an ancestor hiding overflow clips the 9px the row runs into the pane.
    // The pane's own root and stage must never be that ancestor. (`overflow: "hidden"` on small
    // inner spans — text ellipsis — is fine and is matched separately below.)
    const rootish = code.match(/style=\{\{[^}]*position: "absolute",\s*inset: 0,[\s\S]{0,600}?\}\}/g) ?? [];
    expect(rootish.length).toBeGreaterThan(0);
    for (const block of rootish) {
      expect(block, "the pane root must not clip the row's overhang").not.toMatch(
        /overflow:\s*"hidden"/,
      );
    }
  });
});

describe("AgentPane — a theme flip must not remount the Terminal (an unmount kills the PTY)", () => {
  it("keys the Terminal on the chosen ACCOUNT only — never on the theme", () => {
    // `termInk`/`termMuted` have no CSS variable to ride, so reading them costs a re-render on a
    // theme flip. React reconciles a re-render in place; it REMOUNTS on a changed key or element
    // type. Every key in this file must therefore be theme-independent.
    const keys = [...code.matchAll(/key=\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k, `a React key must not depend on the theme: ${k}`).not.toMatch(/[Tt]heme/);
    }
    expect(code).toContain('key={chosenAccount?.id ?? "default"}');
  });

  it("reads the theme with a plain hook, not by re-structuring the tree on it", () => {
    // The dangerous shape is a theme-conditional wrapper or a themed <Terminal> variant: either
    // changes the element type and remounts. A hook read at the top of render cannot.
    expect(code).toContain("const resolvedTheme = useResolvedTheme();");
    expect(code).not.toMatch(/resolvedTheme\s*===\s*"(light|dark)"\s*\?\s*</);
  });
});
