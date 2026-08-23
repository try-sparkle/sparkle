/**
 * Sample sources for the `design-for-equity-and-inclusion` detectors.
 *
 * Each detector gets a FIRES fixture and at least one NEAR MISS: a source that differs
 * only in the thing the detector is supposed to key on. A test that only proves a detector
 * fires also passes for a detector that fires on everything, so the pair is what pins the
 * cause. The `alt=""` pair below is the canonical one.
 */

// --- interactive-no-keyboard-path ------------------------------------------------------

export const interactiveNoKeyboardFires = `
export function RowActions({ onOpen }) {
  return (
    <div className="row-actions" onClick={onOpen}>
      Open
    </div>
  );
}
`;

/** Same click target, reachable and operable from a keyboard. */
export const interactiveNoKeyboardNearMiss = `
export function RowActions({ onOpen }) {
  return (
    <div
      className="row-actions"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      Open
    </div>
  );
}
`;

/** A real button already has the keyboard path built in. */
export const interactiveNoKeyboardNearMissButton = `
export function RowActions({ onOpen }) {
  return (
    <button className="row-actions" onClick={onOpen}>
      Open
    </button>
  );
}
`;

/** Only ONE of the three escape hatches. Still fine: any of them is enough to suppress. */
export const interactiveNoKeyboardNearMissTabIndexOnly = `
export function RowActions({ onOpen }) {
  return (
    <div className="row-actions" tabIndex={0} onClick={onOpen}>
      Open
    </div>
  );
}
`;

// --- meaningful-image-no-alt -----------------------------------------------------------

export const imageNoAltFires = `
export function Avatar({ user }) {
  return <img className="avatar" src={user.photoUrl} />;
}
`;

/**
 * THE CANONICAL PAIR. An explicitly empty alt is the deliberate, correct way to mark an
 * image decorative. Firing here would train people to write alt="Image", which is worse
 * than nothing.
 */
export const imageNoAltNearMissDecorative = `
export function Divider() {
  return <img className="divider" src="/img/rule.svg" alt="" />;
}
`;

export const imageNoAltNearMissDescribed = `
export function Avatar({ user }) {
  return <img className="avatar" src={user.photoUrl} alt={user.displayName} />;
}
`;

/** A spread could be carrying alt. Unknowable, so say nothing. */
export const imageNoAltNearMissSpread = `
export function Avatar(props) {
  return <img className="avatar" {...props} />;
}
`;

// --- state-by-color-alone --------------------------------------------------------------

export const stateByColorFires = `
export function HealthGrid({ nodes }) {
  return (
    <div className="grid">
      {nodes.map((n) => (
        <div key={n.id} className="h-3 w-3 rounded-full bg-red-500" />
      ))}
    </div>
  );
}
`;

/** The same dot, but it also says what it means. */
export const stateByColorNearMissLabelled = `
export function HealthGrid({ nodes }) {
  return (
    <div className="grid">
      {nodes.map((n) => (
        <div key={n.id} className="h-3 w-3 rounded-full bg-red-500" aria-label={n.status} />
      ))}
    </div>
  );
}
`;

/** Colour plus the word. Not colour alone. */
export const stateByColorNearMissText = `
export function HealthGrid({ nodes }) {
  return (
    <div className="grid">
      {nodes.map((n) => (
        <span key={n.id} className="text-red-500">Offline</span>
      ))}
    </div>
  );
}
`;

/** Blue is not a status colour, so a blue swatch is just a swatch. */
export const stateByColorNearMissNeutralColour = `
export function BrandSwatches() {
  return (
    <div className="grid">
      <div className="h-3 w-3 rounded-full bg-blue-500" />
    </div>
  );
}
`;
