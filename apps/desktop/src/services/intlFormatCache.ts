// Cached `Intl.DateTimeFormat` instances, shared by every date/time render in the desktop app.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// Building an `Intl.DateTimeFormat` (or calling `date.toLocaleDateString/toLocaleTimeString/
// toLocaleString` WITH an options object, which builds one internally) constructs a fresh ICU
// formatter every time — measurably the single largest co-located cost in the renderer's
// main-thread hang dumps (`IntlDateTimeFormat::initializeDateTimeFormat`, `udat_open`). Done
// per-call or per-row in a list, it burns the main thread for output that never changes for a
// given (locale, options) pair.
//
// The fix is to construct each distinct formatter ONCE and reuse it. Callers ask for a formatter by
// (locale, options); identical requests return the same instance. This is behavior-preserving: the
// formatter is fully determined by its locale and options, so `getDateTimeFormat(l, o).format(d)`
// yields the same string as `new Intl.DateTimeFormat(l, o).format(d)` — only the construction is
// amortized.
//
// `HistorySearch.tsx` already hoists a module-scoped `Intl.RelativeTimeFormat` for the same reason;
// this generalizes that shape so scattered date renders don't each re-derive it.

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached `Intl.DateTimeFormat` for the given locale + options. Identical arguments return the
 * SAME instance, so the ICU formatter is built once and reused across every call and every row.
 *
 * `locale` is passed through unchanged: `undefined` means "the runtime's default locale", exactly
 * as `new Intl.DateTimeFormat(undefined, …)` and `date.toLocale*String(undefined, …)` mean it. Pass
 * `undefined` where the old code passed `undefined` or `[]` (an empty locale list is also "default")
 * so the output is identical.
 *
 * The cache key stringifies the options; two calls with the same option keys in a different order
 * would miss into two entries holding equivalent formatters — correct, just not maximally shared.
 * Every caller here uses a fixed literal, so keys are stable.
 */
export function getDateTimeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? ""}${JSON.stringify(options)}`;
  let fmt = dateTimeCache.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateTimeCache.set(key, fmt);
  }
  return fmt;
}
