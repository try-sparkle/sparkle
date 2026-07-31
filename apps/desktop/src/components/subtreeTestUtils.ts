// Probes for "is this worker subtree actually EXPANDED, or is that just the peek?" — shared by every
// suite that asserts a head stayed shut.
//
// WHY THIS IS ONE MODULE AND NOT A COPY PER FILE. A closed head with a red worker draws a one-line
// PEEK that NAMES that worker, so `queryByText(workerName)` is satisfied by both a peek and a real
// expansion. Three suites independently need to tell those apart, and the first cut copy-pasted the
// helper into all three under two different names. That is worse than duplication for its own sake:
// the probe returns FALSE whenever `#agent-subtree-<id>` is missing for ANY reason, so renaming
// `subtreeDomId` or the `data-hint` attribute would red whichever file happened to have a positive
// case and silently convert the rest to always-pass. One definition means one contract, and the
// positive control below means a broken selector fails loudly instead of passing everything.
//
// Keep in step with AgentSidebar's `subtreeDomId` and the row's `data-hint="agent"`.

/** The DOM id AgentSidebar gives a head's worker `group`. Rendered ONLY when the subtree is open. */
export const subtreeDomIdFor = (headId: string) => `agent-subtree-${headId}`;

/** Is there a REAL child row for `name` under `headId` — i.e. is the subtree actually expanded?
 *
 *  Scoped to the head's `group`, so the peek (a sibling of the head row, outside that group) can
 *  never satisfy it. Deliberately NOT `queryByText(name)`; see the header. */
export function childRowOf(headId: string, name: string): boolean {
  return Array.from(
    document.querySelector(`#${subtreeDomIdFor(headId)}`)?.querySelectorAll('[data-hint="agent"]') ??
      [],
  ).some((el) => el.textContent?.includes(name));
}

/** THE POSITIVE CONTROL for {@link childRowOf}: does the head's subtree group exist at all?
 *
 *  `childRowOf` is a negative-only probe — absent group and absent row are the same `false` — so a
 *  suite whose every case expects `false` cannot tell "the subtree is shut" from "the selector no
 *  longer matches anything". Assert this is TRUE in at least one expanded fixture per suite, and a
 *  renamed id fails there instead of quietly greening every other assertion. */
export const subtreeGroupExists = (headId: string): boolean =>
  document.querySelector(`#${subtreeDomIdFor(headId)}`) !== null;

/** The containers `strayTreeChildren` will ACTUALLY inspect: the tree plus every `role="group"`
 *  inside it, minus anything hidden from the accessibility tree.
 *
 *  Exported so the probe and its positive control share ONE definition of "examined". They used to
 *  disagree: the control counted the unfiltered candidate set, so if `aria-hidden="true"` landed on
 *  the tree itself — the standard background-inert pattern when a modal opens — every container was
 *  skipped, `strayTreeChildren()` returned `[]` while inspecting nothing, and the control still
 *  counted `1 + groups` and passed. A control that cannot observe the filter it exists to guard is
 *  not a control.
 *
 *  `aria-hidden` subtrees are skipped because an aria-hidden element is removed from the
 *  accessibility tree and so is not owned content at all. The stage section header is deliberately
 *  wrapped that way (`<div aria-hidden><StageSectionHeader/></div>`), and counting it is what once
 *  made a test report a "pre-existing violation" that does not exist. Two details matter:
 *    * the ancestor walk STOPS AT THE TREE, then checks the tree itself — walking unbounded to
 *      `<body>` would let any inert ancestor silently empty the candidate set.
 *    * the test is `=== "true"`, not `!== null`. `aria-hidden="false"` IS exposed to the a11y tree,
 *      so treating any present attribute as hidden would skip a real violation. */
export function examinedTreeContainers(): Element[] {
  const tree = document.querySelector('[role="tree"]');
  if (!tree) return [];
  const hidden = (el: Element): boolean => {
    for (let cur: Element | null = el; cur && cur !== tree; cur = cur.parentElement) {
      if (cur.getAttribute("aria-hidden") === "true") return true;
    }
    return tree.getAttribute("aria-hidden") === "true";
  };
  return [tree, ...Array.from(tree.querySelectorAll('[role="group"]'))].filter((c) => !hidden(c));
}

/** Direct children of the tree, or of a `group` inside it, that are neither `treeitem` nor `group`.
 *  A tree may own ONLY treeitems and groups; anything else is content AT drops or misannounces.
 *
 *  THE TREE'S OWN CHILDREN COUNT. An earlier version inspected only `[role="group"]` descendants,
 *  which is blind to exactly the regression this exists to catch — the peek first shipped as a bare
 *  `<button>` placed directly in the tree. Any future column-level signpost dropped in at that level
 *  would have passed silently.
 *
 *  Which containers get inspected — and the aria-hidden rules behind that — is
 *  {@link examinedTreeContainers}, shared with the positive control so the two cannot disagree.
 *  Hidden CHILDREN are dropped here for the same reason: the stage section header is deliberately
 *  `<div aria-hidden>`, and counting it is what once made a test report a violation that does not
 *  exist.
 */
export function strayTreeChildren(): string[] {
  if (!document.querySelector('[role="tree"]')) return ["<no [role=tree] in the document>"];
  const containers = examinedTreeContainers();
  const hiddenChild = (el: Element) => el.getAttribute("aria-hidden") === "true";
  return containers
    .flatMap((c) => Array.from(c.children))
    .filter((el) => !hiddenChild(el))
    .filter((el) => !["treeitem", "group"].includes(el.getAttribute("role") ?? ""))
    .map((el) => `${el.tagName.toLowerCase()}[role=${el.getAttribute("role") ?? "none"}]`);
}

/** THE POSITIVE CONTROL for {@link strayTreeChildren}: how many containers it actually examined.
 *
 *  `strayTreeChildren()` returning `[]` is the pass condition, and an EMPTY candidate set returns
 *  `[]` too. Assert this is non-zero so "the probe found nothing wrong" cannot be "the probe looked
 *  at nothing" — and note it counts POST-filter, so a tree or section marked `aria-hidden="true"`
 *  drives it down rather than leaving it falsely reassuring. */
export const treeContainerCount = (): number => examinedTreeContainers().length;
