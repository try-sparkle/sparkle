// ARE THIS SURFACE'S NESTED CONTROLS ACTUALLY ANNOUNCED? — the runtime half of the
// `sparkle-a11y/no-presentational-children-role` lint rule.
//
// ══ WHY BOTH HALVES EXIST (bead sparkle-2mwl2m, sparkle-2mwl2m.1) ═══════════════════════════════
// The lint rule catches the shape where it is WRITTEN: a `role="button"` / `role="tab"` element
// that statically contains a `<button>` in the same JSX tree. It is a floor, not a proof — a
// control that arrives through a child component (`<AgentPill/>`, `<TabStaleBadge/>`), a
// `{cond && …}` or a render prop is invisible to it, and by its own header it stays silent rather
// than guessing. These helpers catch the same defect where it is RENDERED, which is the only place
// the child-component half is visible at all.
//
// ══ WHY IT IS COPIED FROM `BeadCard.test.tsx` RATHER THAN IMPORTED FROM IT ══════════════════════
// It is not. `BeadCard.test.tsx` grew these nine lines first and its header says they are written
// to be copied; a fifth verbatim copy is worse than one module, so this is the module. BeadCard
// keeps its own inline pair deliberately — a shared helper that BeadCard also depended on would let
// one edit here silently re-open the exact defect that suite is the last line of defence for.
import { screen } from "@testing-library/react";
import { expect } from "vitest";

/** Roles whose subtree assistive tech flattens to the element's accessible name (WAI-ARIA 1.2,
 *  "Presentational Children: True"). Kept in step with the lint rule's own copy. */
export const PRESENTATIONAL_CHILDREN_ROLES = new Set([
  "button",
  "checkbox",
  "img",
  "math",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "option",
  "progressbar",
  "radio",
  "scrollbar",
  "slider",
  "switch",
  "tab",
]);

/** Native elements that carry one of those roles implicitly, with no `role` attribute to grep for.
 *  `<button>` is the one that actually shipped as a bug; the rest are here so the helper does not
 *  quietly pass a surface that grows a `<progress>` or an `<input type="radio">` wrapper later. */
function implicitPresentationalRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "progress") return "progressbar";
  if (tag === "meter") return "meter";
  if (tag === "img") return "img";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "image") return "button";
    if (type === "button" || type === "submit" || type === "reset") return "button";
  }
  return null;
}

/** The STRICT ANCESTOR (up to and including `root`) that flattens `el` out of the accessibility
 *  tree, described for the failure message — or null when `el` really is announced.
 *
 *  Strict on purpose: an element's own presentational-children role says nothing about whether IT
 *  is announced, only about its descendants. A `role="button"` LEAF must keep passing. */
export function flattenedBy(el: Element, root: Element): string | null {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const explicit = node.getAttribute("role");
    const role =
      explicit !== null && explicit.trim() !== ""
        ? explicit.trim()
        : implicitPresentationalRole(node);
    if (role !== null && PRESENTATIONAL_CHILDREN_ROLES.has(role)) {
      const id = node.getAttribute("data-testid") ?? node.tagName.toLowerCase();
      return `${id} claims role="${role}", whose children are presentational`;
    }
    if (node === root) break;
  }
  return null;
}

/** One control the surface offers, with the role and NAME a reader is actually given for it.
 *  Names are the real ones the component computes — an `aria-label` where it has one, its text
 *  otherwise — so a change that guts a label fails here too, not only one that re-flattens. */
export interface AnnouncedControl {
  /** `data-testid` of the control, so the case names the element rather than fishing for it. */
  testId: string;
  role: string;
  name: string | RegExp;
}

/** Assert every listed control is announced by its own role and name AND genuinely reaches the
 *  accessibility tree. TWO assertions per control, and both are needed: the first proves the
 *  markup is right, the second proves no ancestor between it and `root` erases it. */
export function expectAnnounced(root: Element, controls: readonly AnnouncedControl[]): void {
  expect(controls.length, "expectAnnounced was given nothing to check").toBeGreaterThan(0);
  for (const c of controls) {
    const el = screen.getByTestId(c.testId);
    expect(
      screen.queryAllByRole(c.role, { name: c.name }),
      `${c.testId} is not announced as ${c.role} named ${String(c.name)}`,
    ).toContain(el);
    expect(
      flattenedBy(el, root),
      `${c.testId} is flattened out of the accessibility tree`,
    ).toBeNull();
  }
}
