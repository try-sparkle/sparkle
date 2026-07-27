// Shared helpers for asserting on a row's rendered status dot.
//
// Extracted so the two files that pin dot appearance — AgentSidebar.liveStatusDots.test.tsx (no
// filter may hide the color) and AgentSidebar.redWorker.test.tsx (the head's color agrees with the
// concierge feed) — compare colors the same way. Two hand-rolled hex→rgb converters drifting is a
// silly way to lose a regression guard.
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";

/** `#34c759` → `rgb(52, 199, 89)`. jsdom normalizes inline colors to rgb(), so comparing against
 *  the raw token fails on FORM rather than on value — and a test that fails for the wrong reason
 *  can't tell you the dot went gray. Only the 6-digit hex the AGENT_STATUS tokens use is handled. */
export function asRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The rendered background of the StatusDot for `status`, as jsdom reports it. */
export function expectedDotColor(status: AgentTabStatus): string {
  return asRgb(AGENT_STATUS[status].color);
}

/** Any inline `filter` on `el` or an ancestor within a few levels — the row treatment that used to
 *  gray every dot was applied via inline style on an ANCESTOR of the dot, so checking the dot alone
 *  would miss a revert. Returns the offending value rather than a boolean so a failure names what
 *  came back instead of just "expected false". */
export function filterOn(el: HTMLElement | null): string {
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
    const f = cur.style.filter ?? "";
    if (f !== "") return f;
  }
  return "";
}
