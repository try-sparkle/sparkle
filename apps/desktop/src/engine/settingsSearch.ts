/** Does ANY single entry match every term?
 *
 *  This is the rail's matcher, and per-ENTRY is the whole point. A category advertises several
 *  entries (its label, plus one per row the pane contains). Matching the concatenation instead —
 *  which is what "join them all into one keyword blob" does — accepts a query whose terms are spread
 *  across DIFFERENT entries: "deepgram beads" has both terms somewhere in Tools' blob, so the rail
 *  surfaces Tools, and then no single row matches and the pane renders "No tools match". Requiring
 *  all terms inside ONE entry is exactly the question the pane will go on to ask of its rows, which
 *  is what makes the two answers agree. */
export function matchesAny(entries: readonly string[], query: string): boolean {
  return entries.some((e) => matchesSearch(e, query));
}

/** The ⋯ settings search matcher — ONE function, used by both the category rail and the panes.
 *
 *  It has to be one function because the two run in series: the rail decides whether a category
 *  survives the query, and only then does that category's pane filter its own rows with the same
 *  query. Any disagreement between them is a dead end the user cannot escape — the category shows
 *  up and its pane says "nothing matches", or (worse) the row would have matched but its category
 *  never surfaced, so the pane is never reached at all.
 *
 *  Matching is per WHITESPACE-DELIMITED TERM, every term required. Substring-matching the raw query
 *  against one joined haystack — what this replaced — got both directions wrong:
 *    • a multi-word query ("push to talk", "beads plan") only matched when the words happened to sit
 *      adjacent and in that order in the haystack, so the rail and a pane could easily disagree;
 *    • and because the haystack is several entries joined with spaces, a query could match a
 *      substring that SPANS two entries (the tail of one row's keywords plus the head of the next
 *      row's name) — matching the category while matching no single row. Terms carry no whitespace,
 *      so they cannot span a join.
 *
 *  Substring within a term is deliberate: "notif" must still find Notifications, and "worktree"
 *  must find "worktrees". This is a settings filter, not a search engine — no stemming, no fuzz. */
export function matchesSearch(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystack.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** The strings the ⋯ rail matches a query against, for one category.
 *
 *  A row-filtering category (one whose PANE filters its own rows with the same query — currently
 *  only Tools) is matched PER ENTRY, each entry being one row's searchable text prefixed with the
 *  label, plus the label alone:
 *    • per-entry is what makes "deepgram beads" — two terms living in different rows — correctly
 *      match nothing, instead of surfacing a category whose pane then says "No tools match";
 *    • the label PREFIX is what keeps "tools github" working. Naming the category and then
 *      narrowing inside it is the most natural way to search, and without the prefix no single
 *      entry holds both terms, so the category vanished from the rail entirely — losing the route
 *      to the thing you just named, which is worse than the empty pane per-entry prevents.
 *
 *  Every other category keeps label and keywords in ONE entry, which gets the same property for
 *  free: no pane filters rows there, so there is nothing for the rail to disagree with. Splitting
 *  them would only lose real matches ("mobile pair", "voice wake", "shortcuts hotkeys"). */
export function categoryEntries(
  label: string,
  keywords: readonly string[],
  filtersRows = false,
): string[] {
  if (!filtersRows) return [`${label} ${keywords.join(" ")}`];
  return [label, ...keywords.map((k) => `${label} ${k}`)];
}

/** The query a PANE should filter its rows by, given the query the rail matched on.
 *
 *  Terms answered by the category's own LABEL are dropped: they are how the user named the
 *  category, and no row inside it contains them. "tools" filters by nothing (every row shows);
 *  "tools github" filters by "github" (one row). Forwarding them verbatim rendered
 *  `No tools match "tools"` — the single most obvious query for a category, dead-ending.
 *
 *  Matched against label WORDS by prefix, not as a substring of the whole label. Substring
 *  semantics swallowed ANY substring — "o", "ol", "ls", and "pass"/"word"/"as" for a label like
 *  "1Password" — out of every query, which for a longer label is a real defect. Prefixes of a label
 *  word ("t", "too", "tool") are still dropped, and that is correct: those keystrokes are the user
 *  naming the category, not filtering inside it. */
export function paneQueryFor(label: string, query: string): string {
  const labelWords = label.toLowerCase().split(/\s+/).filter(Boolean);
  // Lowercased on both sides. The dialog happens to hand this an already-lowercased query, but the
  // function is exported and generic, and a case-sensitive compare let "Tools BEADS" through the
  // strip — the rail accepted it and the pane then filtered every row away. Matching this to
  // `matchesSearch`, which is case-insensitive, is what keeps the two halves in agreement.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !labelWords.some((w) => w.startsWith(t)))
    .join(" ");
}
