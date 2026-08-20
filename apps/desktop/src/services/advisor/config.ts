// `[advisor]` as the pass reads it, resolved from the wire payload.
//
// ══ AN ABSENT SECTION READS AS THE SHIPPED DEFAULTS, NOT AS DISABLED ════════════════════════════
//
// The opposite of `[pushers]`, whose absent section reads as OFF because "a backend with no
// `[pushers]` concept cannot be running one". That reasoning does not transfer: the advisor pass is
// compiled into any frontend that has this module at all, so treating "the Rust side is older than
// the section" as off would silently stop a pass this build is in fact running, and the user would
// have no switch to turn back on.
//
// It is only safe to default ON because the ZERO-SPEND GATE — not this flag — is what bounds spend.
// The gate reads the live usage payload every pass and fails closed; the flag exists for reasons
// that have nothing to do with money.
import type { AdvisorConfigPayload } from "../config";
import type { AdvisorConfigView } from "./pass";

/** The shipped envelope. MIRRORS `AdvisorConfig::default()` in `config.rs`; the Rust side is the
 *  authority and `advisor_template_matches_the_default` pins it there. Restated here only for the
 *  case where no payload arrived at all. */
export const ADVISOR_DEFAULTS: AdvisorConfigView = {
  enabled: true,
  model: "claude-opus-5",
};

/** The `model` an ABSENT or blank `[advisor].model` resolves to: `null`, meaning "let the catalog
 *  rule decide". Named so the tests assert the contract rather than a literal, and so this file and
 *  `resolveAdvisorModel` cannot drift on what "unset" means. */
export const ADVISOR_MODEL_UNSET = null;

/**
 * Resolve `[advisor]` from whatever the backend sent.
 *
 * A wrong-typed field is DROPPED to the default rather than coerced, matching `apply_advisor`'s rule
 * on the Rust side: the payload is a hand-editable TOML table two layers up, and coercing
 * `enabled: "no"` to truthy would turn an off switch on. Rust already recognises the unambiguous
 * off-spellings before this sees them, so anything non-boolean arriving here is genuinely
 * unreadable.
 *
 * A BLANK `model` resolves to `null`, not to the empty string: `null` is what
 * `resolveAdvisorModel` reads as "unset, use the catalog rule", where `""` would be compared against
 * catalog ids and match nothing while looking like a configured value.
 */
export function resolveAdvisorConfig(
  payload: AdvisorConfigPayload | null | undefined,
): AdvisorConfigView {
  const enabled =
    typeof payload?.enabled === "boolean" ? payload.enabled : ADVISOR_DEFAULTS.enabled;
  // BLANK / ABSENT / WRONG-TYPED ALL RESOLVE TO `null`, NOT to the shipped id — and the difference
  // is behavioural, not cosmetic. `null` is what `resolveAdvisorModel` reads as "unset, use the
  // CATALOG rule"; re-supplying the default here would make that branch unreachable from production
  // config, and a user who blanked the line specifically to get off Opus would have `claude-opus-5`
  // handed back to them as a `source: "configured"` pick. Matches `config.rs`'s own wording — "a
  // blank string means 'unset', which is the same thing as absent: the catalog rule decides" — and
  // `AdvisorConfigView.model`'s `string | null`.
  //
  // The shipped default still applies: it is written into `[advisor].model` by `DEFAULT_TEMPLATE`,
  // so an ordinary install sends a real id. `null` here means the user actively removed it.
  const raw = typeof payload?.model === "string" ? payload.model.trim() : "";
  return { enabled, model: raw.length > 0 ? raw : null };
}
