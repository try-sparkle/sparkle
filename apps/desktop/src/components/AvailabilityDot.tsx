import { memo } from "react";
import { C } from "../theme/colors";
import type { Availability } from "../engine/social";

/**
 * A colored mark conveying a PERSON's availability. Design:
 * docs/superpowers/specs/2026-08-05-social-coding-design.md §6.3, §10.
 *
 * ══ WHY THIS IS NOT `StatusDot` ═════════════════════════════════════════════════════════════════
 * `StatusDot` looks a lot like this and is the wrong component. It takes an `AgentTabStatus` and
 * looks up `AGENT_STATUS[status]` — a **PTY taxonomy** (`working` / `waiting` / `approval` /
 * `blocked` / `errored`), describing what a child process is doing. A human is not a process. The
 * tempting shortcut is to map `available` onto `working` to steal the green, and that is exactly the
 * second-derivation mistake `SparkleAgentRow`'s docstring warns about: the dot would then be a
 * *rendering of an agent status*, so a human would answer to the sidebar's status-filter chips,
 * appear in "Running", and vanish when the user filters to "Needs you". The taxonomies must stay
 * separate all the way down, so this is a sibling with its OWN label map and no shared lookup.
 *
 * The two files are deliberately structurally identical otherwise — same `memo`, same
 * inline-styled `<span>`, same `title` — so a reader who knows one knows this one.
 *
 * ══ NO MOTION ══════════════════════════════════════════════════════════════════════════════════
 * Same reason `StatusDot` gave up its pulse: a column of blinking dots is motion that is always on,
 * which stops reading as "look here" and becomes the background.
 *
 * ══ COLOUR IS NEVER THE ONLY CHANNEL ═══════════════════════════════════════════════════════════
 * The dot is decorative on its own. `title` carries the words for a mouse, and every composing
 * surface must put {@link availabilityLabel} into an accessible name — see `PersonAvatar`, which
 * does exactly that. WCAG 1.4.1: colour alone is not information.
 */
export interface AvailabilityMeta {
  /** The word. This IS the accessible content wherever the dot appears; never paraphrase it at a
   *  call site, or two surfaces end up naming the same state differently. */
  label: string;
  color: string;
}

/**
 * The one label/colour map, keyed on {@link Availability}.
 *
 * `offline` uses the same muted ink an idle agent uses, which is intentional: "no signal" should
 * read as absence in both taxonomies. `available` and `away` do NOT reuse an agent status colour —
 * they name the theme tokens directly, so a future change to the PTY palette cannot silently repaint
 * a human.
 */
export const AVAILABILITY: Record<Availability, AvailabilityMeta> = {
  available: { label: "Available", color: C.successInk },
  away: { label: "Away", color: C.amberInk },
  offline: { label: "Offline", color: C.muted },
};

/**
 * Look up an availability, FAIL-CLOSED to `offline` for anything outside the union.
 *
 * The `??` is not dead code even though the parameter is typed, and the asymmetry it fixes is worth
 * stating: `socialStore.availabilityRank` already widens for exactly this reason (a value can reach
 * the UI through `socialApi`'s unchecked `as T`, and `setPeople`'s `?? DEFAULT_AVAILABILITY` only
 * rescues `null`/`undefined`, not a bogus string like `"busy"`). A store that fails closed paired
 * with a component that dereferences blind is the worst combination of the two: the bad row sorts
 * fine, reaches here, and `AVAILABILITY["busy"].label` throws a TypeError **during render** — and an
 * uncaught throw in render unmounts the whole subtree, taking the chat column down. Degrading to
 * `offline` is both the safe direction and the same default the store writes.
 */
export function availabilityMeta(availability: Availability): AvailabilityMeta {
  return (
    (AVAILABILITY as Record<string, AvailabilityMeta | undefined>)[availability] ??
    AVAILABILITY.offline
  );
}

/** The default ring thickness, in px. Exported so the tests that pin the border-cost arithmetic in
 *  {@link AvailabilityDot}'s `ringColor` docstring read the real default instead of a literal 2. */
export const DEFAULT_RING_WIDTH = 2;

/** The word for an availability — the single source for every accessible name and tooltip. */
export function availabilityLabel(availability: Availability): string {
  return availabilityMeta(availability).label;
}

/**
 * `React.memo`'d for the same reason `StatusDot` is: the props are all primitives, so one peer's
 * presence flip re-renders only its own dot rather than every dot in the chat column.
 */
export const AvailabilityDot = memo(function AvailabilityDot({
  availability,
  size = 8,
  ringColor,
  ringWidth = DEFAULT_RING_WIDTH,
  title,
}: {
  availability: Availability;
  /** Diameter in px. `PersonAvatar` derives this from the avatar size so the two can never
   *  disagree; a standalone caller may pass its own. */
  size?: number;
  /**
   * Paint a ring of the SURFACE colour around the dot so it does not merge into whatever it
   * overlaps (the avatar fill, in the composed case). Omitted → no ring, for a dot that sits on
   * its own.
   *
   * ══ WHY A `box-shadow` AND NOT A BORDER ═══════════════════════════════════════════════════════
   * THE reason, stated once, and the arrangement matters as much as the content. `PersonAvatar`'s
   * header points here and states no reason and no number; its test points here and does not
   * *restate* the numbers either — it **asserts** them, which is the one kind of second copy that
   * cannot drift, because a drifted number there fails. Three prose copies of this paragraph is
   * what produced four review rounds on this branch.
   *
   * **It is a COLOUR argument, not a layout one.** `index.css` sets `* { box-sizing: border-box }`,
   * so a border is carved OUT of the mark rather than added to it, taking `ringWidth` from each of
   * two opposing edges. The surviving core of availability colour is therefore
   *
   *     d − 2·ringWidth
   *
   * which is a function of BOTH diameters and not a fixed ratio — at `ringWidth = 2` it costs half
   * the mark at the row size (`8 → 4`) but only a third at the top-bar size (`12 → 8`). Both are
   * pinned in `PersonAvatar`'s suite against {@link DEFAULT_RING_WIDTH} and `availabilityDotSize`,
   * so a drifted number here fails a test rather than misleading a reader. A shadow rings the mark
   * from OUTSIDE, so every pixel of `d` stays colour at every size.
   *
   * This docstring previously said a shadow was chosen because it "has no layout effect". That was
   * false, and worse, it sanctioned the swap it existed to prevent — a reader who checks whether a
   * border has a layout effect here correctly finds it does not (the dot is `position: absolute`
   * inside a wrapper with an explicit width/height, so nothing on it can reach the composed box)
   * and changes it. `PersonAvatar`'s header states those layout facts; it does not state this one.
   */
  ringColor?: string;
  ringWidth?: number;
  /** Tooltip override. Defaults to the label; a caller that already names the state in a richer
   *  accessible name (e.g. "Ada — Available") passes it here so the two never disagree. */
  title?: string;
}) {
  const meta = availabilityMeta(availability);
  return (
    <span
      // Decorative by itself: the words live in the composing surface's accessible name. A dot that
      // ALSO announced itself would double up on every screen reader pass.
      aria-hidden
      data-availability={availability}
      title={title ?? meta.label}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: meta.color,
        flex: "0 0 auto",
        ...(ringColor ? { boxShadow: `0 0 0 ${ringWidth}px ${ringColor}` } : {}),
      }}
    />
  );
});
