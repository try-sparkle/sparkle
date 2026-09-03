// The one literal Rust and TypeScript must agree on for inbox CAPACITY refusals.
//
// WHY A TAG EXISTS AT ALL. A capacity refusal from `src-tauri/src/inbox.rs::enqueue` already names
// the recipient's live depth and the ceiling it was judged against. The peer-send path in
// `services/controlListener.ts` appends a generic depth note to refusals that do NOT carry one — and
// appending it to a capacity refusal produces the `sparkle-8bvh` shape: Rust's "nothing was queued,
// do not re-send" answered by "your next `fyi` evicts and succeeds", i.e. a remedy that is unsafe
// under exactly the condition that triggered the refusal. So the append has to be suppressed for
// that class, and the suppression needs a signal it can trust.
//
// WHY IT IS NOT PROSE. The first version tested `/ceiling|undelivered|queued/i` against Rust's
// wording. Roborev graded that High and was right: rewording either refusal, or adding a capacity
// refusal on another path, silently flips the test to `false` and re-appends the contradiction. The
// single test covering the area passed only because its fixture said "queue" rather than "queued" —
// a one-character margin — and deleting the guard outright left the whole suite GREEN, so it was
// unverified in both directions.
//
// WHY IT LIVES HERE. `PEER_MESSAGE_MAX_CHARS` is the precedent: a literal two packages must agree on
// belongs in `@sparkle/core` so there is ONE of it rather than two that look like one. Rust cannot
// import from here, so that half is mirrored by hand in `inbox.rs::CAPACITY_TAG` — and
// `scripts/inbox-capacity-tag-check.sh` fails CI if the two ever differ, which turns a silent drift
// into a red build. Detecting the drift is weaker than making it unrepresentable; across a language
// boundary it is the strongest form available.

/**
 * Prefix carried by EVERY capacity refusal `inbox_send` can return, marking a message that already
 * states the recipient's depth and ceiling.
 *
 * Human-readable on purpose: it is shown to an agent, and a bare error code would be one more thing
 * a reader cannot act on. Reword the refusal sentences freely — keep the tag.
 */
export const INBOX_CAPACITY_TAG = "[inbox-capacity]";

/** Does this `inbox_send` error already name the recipient's depth, so a caller must not append its
 *  own note? Keyed on {@link INBOX_CAPACITY_TAG}, never on the surrounding prose. */
export function namesInboxDepth(errorText: string): boolean {
  return errorText.includes(INBOX_CAPACITY_TAG);
}
