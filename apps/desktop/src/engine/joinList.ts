/**
 * Join names/phrases the way a sentence does: `"a"`, `"a and b"`, `"a, b and c"`.
 *
 * The serial comma is omitted to match the app's existing copy. Extracted from `agentStall.ts`
 * because a plain `.join(" and ")` is the shape this replaces — with three or more items it reads
 * "A and B and C and D", which is how the duplicate-login banner rendered a four-account clash.
 */
export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
