/** Sample sources for the `enable-meaningful-choices` detectors. */

// --- consent-prechecked ----------------------------------------------------------------

export const consentPrecheckedFires = `
export function SignupExtras() {
  return (
    <label>
      <input type="checkbox" name="marketingConsent" defaultChecked />
      Send me product news and offers
    </label>
  );
}
`;

/** Identical control, shipped off. The person chooses. */
export const consentPrecheckedNearMissUnchecked = `
export function SignupExtras() {
  return (
    <label>
      <input type="checkbox" name="marketingConsent" />
      Send me product news and offers
    </label>
  );
}
`;

/**
 * Pre-ticked, but not a consent control. "Remember me" is a convenience the person can
 * undo at no cost, and firing here is exactly the false positive that gets a gate removed.
 */
export const consentPrecheckedNearMissNotConsent = `
export function SignInExtras() {
  return (
    <label>
      <input type="checkbox" name="rememberMe" defaultChecked />
      Keep me signed in
    </label>
  );
}
`;

/** Bound to state rather than hard-coded on: whatever the person last chose. */
export const consentPrecheckedNearMissBoundToState = `
export function SignupExtras({ prefs, onChange }) {
  return (
    <label>
      <input type="checkbox" name="marketingConsent" checked={prefs.marketing} onChange={onChange} />
      Send me product news and offers
    </label>
  );
}
`;

export const consentDefaultTrueFires = `
export const defaultPreferences = {
  theme: 'system',
  marketingEmails: true,
  productUpdates: false,
};
`;

export const consentDefaultTrueNearMiss = `
export const defaultPreferences = {
  theme: 'system',
  marketingEmails: false,
  rememberMe: true,
};
`;

// --- consent-withdrawal-asymmetry ------------------------------------------------------

export const withdrawalAsymmetryFires = `
import { api } from './api.ts';

export async function unsubscribeFromDigest(userId) {
  const sure = window.confirm('Do you really want to stop the weekly digest?');
  if (!sure) return;
  const reason = await promptForReason();
  await api.post('/prefs', { userId, digest: false, reason });
}

export async function subscribeToDigest(userId) {
  await api.post('/prefs', { userId, digest: true });
}
`;

/** Off is as cheap as on. One call each way. */
export const withdrawalAsymmetryNearMissSymmetric = `
import { api } from './api.ts';

export async function unsubscribeFromDigest(userId) {
  await api.post('/prefs', { userId, digest: false });
}

export async function subscribeToDigest(userId) {
  await api.post('/prefs', { userId, digest: true });
}
`;

/** Both sides confirm. Heavy-handed, perhaps, but not asymmetric. */
export const withdrawalAsymmetryNearMissBothConfirm = `
import { api } from './api.ts';

export async function unsubscribeFromDigest(userId) {
  if (!window.confirm('Stop the weekly digest?')) return;
  await api.post('/prefs', { userId, digest: false });
}

export async function subscribeToDigest(userId) {
  if (!window.confirm('Start the weekly digest?')) return;
  await api.post('/prefs', { userId, digest: true });
}
`;

/**
 * A confirmed opt-out with no opt-in counterpart in the file. There is nothing to compare
 * against, and a lone confirmation is often the right call, so this stays silent.
 */
export const withdrawalAsymmetryNearMissNoCounterpart = `
import { api } from './api.ts';

export async function unsubscribeFromDigest(userId) {
  const sure = window.confirm('Do you really want to stop the weekly digest?');
  if (!sure) return;
  await api.post('/prefs', { userId, digest: false });
}
`;

/**
 * The opt-out is CALLED before it is declared, and the real declaration confirms.
 *
 * A declaration finder that accepts any `name(` line takes the call site for the
 * declaration, collects the CALLER's two lines as the body, finds no confirmation there
 * and goes silent — missing a real asymmetry. The finding must still land on the line
 * `export async function unsubscribeFromDigest` further down.
 */
export const withdrawalAsymmetryFiresBelowCallSite = `
import { api } from './api.ts';

export async function closeAccount(userId) {
  unsubscribeFromDigest(userId);
}

export async function unsubscribeFromDigest(userId) {
  const sure = window.confirm('Do you really want to stop the weekly digest?');
  if (!sure) return;
  await api.post('/prefs', { userId, digest: false });
}

export async function subscribeToDigest(userId) {
  await api.post('/prefs', { userId, digest: true });
}
`;

/**
 * The mirror image: BOTH directions confirm, but the opt-in is called before it is
 * declared. Taking that call site for the declaration reads the opt-in as unconfirmed and
 * reports an asymmetry that is not there — a false positive, the failure this module
 * treats as fatal. Must stay silent.
 */
export const withdrawalAsymmetryNearMissCallSiteBeforeOptIn = `
import { api } from './api.ts';

export async function resumeDigestForReturningUser(userId) {
  subscribeToDigest(userId);
}

export async function unsubscribeFromDigest(userId) {
  if (!window.confirm('Stop the weekly digest?')) return;
  await api.post('/prefs', { userId, digest: false });
}

export async function subscribeToDigest(userId) {
  if (!window.confirm('Start the weekly digest?')) return;
  await api.post('/prefs', { userId, digest: true });
}
`;

/**
 * Same asymmetry, declared as CLASS METHOD SHORTHAND rather than `function` or `const`.
 *
 * Regression fixture. The first binding-only rewrite of BINDING_LINE fixed the call-site bug by
 * requiring `function`/`class`/`const|let|var`, and in doing so silently dropped method shorthand
 * — a form the older shape-based predicate did handle. Neither side is then found, the detector
 * goes quiet, and every existing test stays green because they all declare with `function`.
 */
export const withdrawalAsymmetryFiresAsClassMethods = `
export class PreferenceService {
  async subscribeToDigest(userId) {
    await this.api.post('/prefs', { userId, digest: true });
  }

  async unsubscribeFromDigest(userId) {
    const sure = window.confirm('Do you really want to stop the weekly digest?');
    if (!sure) return;
    const reason = await promptForReason();
    await this.api.post('/prefs', { userId, digest: false, reason });
  }
}
`;

/**
 * The opt-out name appears FIRST as a bare call whose last argument is a function expression —
 * `unsubscribeFromDigest(function () {` — before its real declaration further down.
 *
 * Regression fixture for a bug I introduced while fixing another one. Requiring a trailing `{` was
 * meant to separate a method DECLARATION from a CALL, and it does not: a call taking a callback
 * ends in `{` too. With that weaker rule, findDeclaration returns this CALL as the declaration of
 * `unsubscribeFromDigest` and declarationBody then collects the callback's lines instead of the
 * real method's — so the confirm/prompt guards below are never seen and the detector goes silent.
 *
 * The call must be BARE and at line start: an earlier version of this fixture used
 * `this.bus.subscribe(function () {`, which never matched the line-start pattern under either rule
 * and was therefore vacuous — it passed with the bug present.
 */
export const withdrawalAsymmetryFiresBelowCallback = `
export class DigestPrefs {
  register() {
    unsubscribeFromDigest(function () {
      recordIntent();
    });
  }

  async subscribeToDigest(userId) {
    await this.api.post('/prefs', { userId, digest: true });
  }

  async unsubscribeFromDigest(userId) {
    const sure = window.confirm('Do you really want to stop the weekly digest?');
    if (!sure) return;
    const reason = await promptForReason();
    await this.api.post('/prefs', { userId, digest: false, reason });
  }
}
`;

/**
 * The asymmetry declared with TYPESCRIPT parameter types that contain nested parens.
 *
 * Regression fixture for an over-restriction I shipped while fixing an over-permission. Excluding
 * every nested `(` from the parameter list was justified with "a real method's parameter list
 * cannot contain a nested `(`" — false for the TypeScript this detector scans, so `(cb: () => void)`
 * and `(opts = defaults())` stopped being recognised as declarations and the detector went quiet on
 * them. The discriminator is BALANCED parens before the brace, not the absence of nested ones.
 */
export const withdrawalAsymmetryFiresWithTypedParams = `
export class DigestPrefs {
  async subscribeToDigest(userId: string, onDone: () => void) {
    await this.api.post('/prefs', { userId, digest: true });
    onDone();
  }

  async unsubscribeFromDigest(userId: string, opts = defaultOpts()) {
    const sure = window.confirm('Do you really want to stop the weekly digest?');
    if (!sure) return;
    const reason = await promptForReason();
    await this.api.post('/prefs', { userId, digest: false, reason, ...opts });
  }
}
`;
