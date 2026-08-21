import { useCallback, useEffect, useState } from "react";
import { FiRefreshCw } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { getConfig, type PublishDestination } from "../services/config";
import { probeDestination, type DestinationCapabilities } from "../services/publishCapabilities";
import { PublishDestinationCard } from "./PublishDestinationCard";

// The "Publishing" settings pane (bead `sparkle-131ms.5`) — the home of the capability probe.
//
// It is deliberately READ-ONLY for now. Configuring a destination is a `config.toml` edit plus a
// token paste (`publish_token_set`, bead `sparkle-131ms.3`), and composing/publishing happens in
// the concierge chat (`sparkle-131ms.6`). What was missing, and what this supplies, is the ANSWER
// to "did that work" — a destination that is configured but whose tool set Sparkle cannot use is
// otherwise indistinguishable from one that is fine, right up until a publish fails.
//
// The probe is a `tools/list` call and nothing else, so re-running it is free of side effects.

interface Row {
  id: string;
  destination: PublishDestination;
  /** null while the probe is in flight. */
  capabilities: DestinationCapabilities | null;
  /** The host's message when the probe could not run at all — a bad URL, no credential, a dead
   *  host. Distinct from an INVALID destination, which is a probe that succeeded and said no. */
  error: string | null;
}

export function PublishPane() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [probing, setProbing] = useState(false);
  /** A failure to read the CONFIG AT ALL — distinct from `Row.error`, which is one destination's
   *  probe failing. Without this the pane had no third state: a rejected `getConfig()` left `rows`
   *  null forever, so "Sparkle could not read your config" rendered identically to "still working",
   *  the rejection escaped `void load()` unhandled, and the early return below meant there was no
   *  "Check again" button to recover with. That is the same could-not-run vs. ran-and-said-no
   *  distinction this pane exists to draw, one level up (roborev 66504/66535, Medium). */
  const [paneError, setPaneError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setProbing(true);
    // NOT `setPaneError(null)` here. Clearing it optimistically drops the pane into the
    // `rows.length === 0` branch — which asserts "No publish destination is configured" about a
    // config Sparkle has just FAILED to read, and renders no retry button, so a slow or wedged
    // `getConfig()` strands the user on a false statement with no way out. That is the exact
    // could-not-run vs. ran-and-said-no confusion this state exists to remove, reintroduced on the
    // recovery path (roborev 66549, Medium). The error stays on screen with its button in the
    // disabled "Checking…" form until the retry actually succeeds.
    try {
      const cfg = await getConfig();
      const destinations = Object.entries(cfg.config.publish?.destinations ?? {});
      const probed = await Promise.all(
        destinations.map(async ([id, destination]): Promise<Row> => {
          try {
            return { id, destination, capabilities: await probeDestination(id), error: null };
          } catch (e) {
            // The host rejects with a plain string, already scrubbed of the bearer. Shown as-is:
            // it names the specific rule that failed, which is the whole of what makes it useful.
            return { id, destination, capabilities: null, error: String(e) };
          }
        }),
      );
      setRows(probed);
      setPaneError(null);
    } catch (e) {
      // Reading the config failed, so there is nothing to probe and nothing to render per row.
      // Say so and leave the retry reachable: `setRows([])` (rather than leaving it null) is what
      // takes the pane out of "Checking…" and past the early return to the button.
      setPaneError(String(e));
      setRows([]);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (rows === null) {
    return <div style={{ fontFamily: FONT_UI, fontSize: TYPE.body, color: C.muted }}>Checking…</div>;
  }

  if (paneError !== null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT_UI }}>
        <div style={{ fontSize: TYPE.body, color: C.muted, lineHeight: 1.5 }}>
          Sparkle couldn’t read its configuration, so it can’t tell you which destinations are set
          up. This is not a statement about any destination — the check never ran.{" "}
          <span style={{ fontFamily: FONT_MONO }}>{paneError}</span>
        </div>
        <RetryButton probing={probing} onClick={() => void load()} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div style={{ fontFamily: FONT_UI, fontSize: TYPE.body, color: C.muted, lineHeight: 1.5 }}>
        No publish destination is configured, so Sparkle can’t post anywhere — which is the right
        default for an outward-facing action. Add one under <span style={{ fontFamily: FONT_MONO }}>[publish]</span> in
        Settings › Advanced, then paste its token here.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT_UI }}>
      {rows.map((row) => (
        <div key={row.id}>
          {row.capabilities ? (
            <PublishDestinationCard name={row.destination.name} capabilities={row.capabilities} />
          ) : (
            <section
              style={{
                border: `1px solid ${C.hairline}`,
                borderRadius: RADIUS.modal,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
              aria-label={`Publish destination ${row.destination.name}`}
            >
              <div style={{ fontSize: TYPE.body, fontWeight: 600, color: C.cream }}>
                {row.destination.name}
              </div>
              <div style={{ fontSize: TYPE.small, color: C.dangerInk }}>{row.error}</div>
            </section>
          )}
        </div>
      ))}

      <RetryButton probing={probing} onClick={() => void load()} />
    </div>
  );
}

/** The pane's one retry control, shared by the error state and the normal state so the two cannot
 *  drift apart.
 *
 *  `RADIUS.input`, NOT `RADIUS.modal`. `scale.ts` reserves `input` for "inputs, buttons, cards —
 *  the workhorse" and `modal` for "the largest surfaces. THE CEILING", and `WhatsNewPanel` states
 *  the rule outright: an inner control must not echo the card that contains it. The scale ratchet
 *  only counts numeric literals, so a call site on the wrong STEP is invisible to it — this is a
 *  review-time-only check (roborev 66526, Medium). */
function RetryButton({ probing, onClick }: { probing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={probing}
      style={{
        alignSelf: "flex-start",
        display: "flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.input,
        padding: "6px 10px",
        background: "transparent",
        color: C.muted,
        cursor: probing ? "default" : "pointer",
        fontSize: TYPE.small,
        fontFamily: FONT_UI,
      }}
    >
      <FiRefreshCw size={12} aria-hidden />
      {probing ? "Checking…" : "Check again"}
    </button>
  );
}
