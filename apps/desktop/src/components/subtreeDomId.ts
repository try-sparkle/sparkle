// DOM id of a head's worker `group`. One function so the row's aria-owns and the group's own id
// cannot drift — a mismatched pair is a dangling reference that reads as no relationship at all.
//
// It lives in its own module because its two call sites sit on OPPOSITE sides of this sidebar's
// biggest seam: the root component writes the group's `id`, and the row writes the `aria-owns`
// that points at it. Neither of those can import the other, so a shared leaf is the only home
// that keeps the two spellings provably identical.
//
// `subtreeTestUtils.ts` MIRRORS this string rather than importing it (deliberately — see that
// file's header), so the shape `agent-subtree-<id>` must stay stable.
export const subtreeDomId = (headId: string) => `agent-subtree-${headId}`;
