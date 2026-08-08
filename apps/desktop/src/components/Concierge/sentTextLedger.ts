// The bounded ledger of what each sent bubble ORIGINALLY said, so the newest one can be redirected.
//
// Extracted verbatim from ConciergeHost, which re-exports both symbols so existing importers keep
// working. NOTHING ELSE from the host's module scope came with it — in particular the `seq`/`nextId`
// thread-id counter stayed behind, because it is module-level MUTABLE state whose restart-at-zero on
// reload is depended upon (stores/conciergeThreadStore reindexes for exactly that reason), and a
// counter that exists in two modules is two counters.

/** How many sent messages keep their original text for a possible redirect. Only the newest bubble
 *  is ever redirectable, so anything older is dead weight — and without a bound a long session with
 *  pasted content grows the map forever. Kept well above 1 so the map still reads as a short
 *  history rather than a single slot. */
export const SENT_TEXT_LIMIT = 50;

/** Remember `text` for `id`, evicting the oldest entries past the cap (Map preserves insertion
 *  order, so the first keys are the oldest). */
export function rememberSentText(map: Map<string, string>, id: string, text: string): void {
  map.set(id, text);
  while (map.size > SENT_TEXT_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
