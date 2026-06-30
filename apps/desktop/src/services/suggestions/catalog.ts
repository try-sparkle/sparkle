import type { SuggestionKind } from "./types";

// A small built-in catalog of generic next-actions. These give the feature value from day one
// (before any personal history accumulates). Haiku is told it MAY draw on these WHEN they fit
// the terminal state described by `when` — it does not surface them blindly.
export interface CatalogEntry {
  label: string;
  value: string;
  kind: SuggestionKind;
  when: string; // natural-language hint for Haiku ("offer when ...")
}

export const SEED_CATALOG: CatalogEntry[] = [
  {
    label: "Rebase main, Issue PR, merge",
    value: "Go ahead and rebase main, issue a PR, and merge to main.",
    kind: "prompt",
    when: "code changes are complete and committed but not yet merged to main",
  },
  {
    label: "Cut test DMG",
    value: "Cut a test DMG.",
    kind: "prompt",
    when: "a desktop change is done and the user may want to eyeball it in a build",
  },
  {
    label: "Push to main",
    value: "Push the current branch.",
    kind: "prompt",
    when: "work is committed locally and the user typically pushes next",
  },
];
