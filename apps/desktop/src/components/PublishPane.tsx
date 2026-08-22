import { useCallback, useEffect, useState } from "react";
import { FiRefreshCw } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import {
  getConfig,
  setConfigValue,
  setConfigValues,
  unsetConfigValue,
  type PublishDestination,
} from "../services/config";
import { probeDestination, type DestinationCapabilities } from "../services/publishCapabilities";
import { clearPublishToken, publishTokenEnvVarName } from "../services/publishCredential";
import { PublishDestinationCard } from "./PublishDestinationCard";
import { PublishDestinationForm, type PublishDestinationDraft } from "./PublishDestinationForm";
import { PublishTokenRow } from "./PublishTokenRow";

// The "Publishing" settings pane (bead `sparkle-131ms.5`) — the home of the capability probe, and
// since `sparkle-131ms.9` the place destinations are ADDED, REMOVED and SWITCHED BETWEEN.
//
// It used to be read-only, which meant configuring a destination was a hand edit of the machine-wide
// `config.toml` — so the feature shipped and was never once used. The backend was multi-destination
// from the start (`publish.destinations` is a map, and the keychain stores one item per id); only
// the UI was single-destination and read-only.
//
// The probe is a `tools/list` call and nothing else, so re-running it is free of side effects.
//
// ── `[publish]` IS GLOBAL-ONLY ────────────────────────────────────────────────────────────────
// Every write below uses the GLOBAL setters (`setConfigValue`/`setConfigValues`/`unsetConfigValue`)
// and never `setProjectConfigValue`. That is not a convenience: a per-repo `.sparkle/config.toml`
// that sets `[publish]` is IGNORED with a warning by the Rust layer, because a destination is a
// network egress target Sparkle sends a bearer token to and a cloned repo must not be able to grant
// itself one. A project write here would land in a file nothing reads.

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
  /** `publish.active` as last READ from config — never set optimistically. A picker that moved on
   *  click would show the user a destination they had switched to when the write that switches it
   *  had failed. Same principle as `writeError` below, in the other direction. */
  const [active, setActive] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  /** A failure to read the CONFIG AT ALL — distinct from `Row.error`, which is one destination's
   *  probe failing. Without this the pane had no third state: a rejected `getConfig()` left `rows`
   *  null forever, so "Sparkle could not read your config" rendered identically to "still working",
   *  the rejection escaped `void load()` unhandled, and the early return below meant there was no
   *  "Check again" button to recover with. That is the same could-not-run vs. ran-and-said-no
   *  distinction this pane exists to draw, one level up (roborev 66504/66535, Medium). */
  const [paneError, setPaneError] = useState<string | null>(null);

  /** A failure to WRITE the config — the same distinction again, on the new mutating paths. A
   *  rejected `setConfigValues` must render as "that did not save", never as a destination that
   *  now exists: the form stays mounted with what was typed still in it, and nothing is added to
   *  the list, because the list only ever comes from a re-READ of the config. */
  const [writeError, setWriteError] = useState<string | null>(null);
  /** A destination was removed but its keychain token could NOT be cleared — a locked keychain, a
   *  `keyring` error other than `NoEntry`. Kept SEPARATE from `writeError` because the two say
   *  opposite things about whether the action worked: the removal SUCCEEDED, so rendering this as a
   *  write failure would be wrong in the other direction.
   *
   *  It exists because swallowing this was a lie the user could not detect. The confirmation they
   *  had just read states as FACT that removal "clears its saved token from your keychain", and
   *  once the destination is gone from `publish.destinations` no `PublishTokenRow` is rendered for
   *  it — so there is no surface left that could report the token's fate, and no in-app route back
   *  to a Clear button short of re-adding the id. A live bearer the UI affirmatively said was
   *  deleted is exactly the outcome the whole credential surface exists to prevent
   *  (roborev 67335, Medium). It names the destination, because by the time it is read the row it
   *  refers to is gone. */
  const [clearFailure, setClearFailure] = useState<{ id: string; message: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The id whose removal is awaiting confirmation, so the keychain warning is read before the
   *  destination goes rather than after. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  /** Does `publish.active` name a destination that ACTUALLY EXISTS?
   *
   *  Not the same question as `active !== null`, and the difference is the whole of roborev 67318:
   *  a non-null id pointing at nothing is a reachable state (a hand edit, or a removal by a build
   *  that did not repoint), and publish ops refuse on it exactly as they do on null. Every place
   *  that asks "is a destination chosen" must ask THIS, or it answers yes about a config that
   *  cannot publish. Derived, never stored, so it cannot drift from `rows`. */
  const activeExists = active !== null && (rows ?? []).some((r) => r.id === active);

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
      // `?? null` because `active` is a Rust `Option<String>` with no `skip_serializing_if`: the
      // key arrives PRESENT AND null, and an older backend omits `[publish]` altogether. Both mean
      // "no destination chosen", and publish ops then refuse rather than guessing.
      setActive(cfg.config.publish?.active ?? null);
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

  /** Add a destination in ONE atomic write, `publish.active` included when there is nothing chosen
   *  yet. Two separate writes would leave a window in which the destination exists and no
   *  destination is active — and publish ops REFUSE on a null `active` rather than guessing, so
   *  that window is a destination that is configured and cannot be published to. */
  const addDestination = useCallback(
    async (draft: PublishDestinationDraft) => {
      setWriteError(null);
      // Re-adding the destination RETRACTS the still-live claim about it. The notice asserts a
      // present-tense fact ("that credential is still live") about a destination that no longer
      // exists — and the pane itself points at re-adding the id as the way back to a Clear button.
      // Follow that advice and the row reports the stored token while the notice below it insists
      // the credential is live and must be revoked at the destination: two contradictory statements
      // on one screen, the surviving one false, and the remedy it prescribes destructive to a
      // bearer the user has just legitimately re-saved (roborev 67382, Medium).
      //
      setWriting(true);
      try {
        // The id is [a-z0-9-] only (the form mirrors Rust's rule), so it can never contain a dot
        // and this dotted path can never be ambiguous. That is a second reason the id rule is a
        // whitelist rather than a blacklist.
        const base = `publish.destinations.${draft.id}`;
        const values: Record<string, string> = {
          [`${base}.name`]: draft.name,
          [`${base}.url`]: draft.url,
        };
        // Claim `active` when nothing holds it — and ALSO when what holds it does not exist. A
        // hand-edited config.toml can name a destination that was never added (or was removed by
        // an older build), and `active === null` alone does not see that: it is a non-null string
        // pointing at nothing, so the first destination the user adds would leave the config still
        // dangling and every publish still refusing. Same repair as `removeDestination`, at the
        // other end of the lifecycle.
        if (!activeExists) values["publish.active"] = draft.id;
        await setConfigValues(values);
        // RETRACTED ON SUCCESS, NOT ON THE ATTEMPT. The justification for dropping it — "a mounted
        // PublishTokenRow is about to answer the question properly" — holds only if the add
        // actually lands. When `setConfigValues` rejects (a read-only config.toml), nothing is
        // re-added, no row mounts, `load()` is never reached, and the standing warning that a live
        // bearer exists at the destination is gone for the session with nothing to replace it: the
        // user is told the credential is live, then quietly un-told (roborev 67391, Medium).
        if (clearFailure?.id === draft.id) setClearFailure(null);
        // Only past the await. Closing the form before the write resolves would render the add as
        // done while it was still in flight — and as done, permanently, if it then failed.
        setAdding(false);
        await load();
      } catch (e) {
        setWriteError(String(e));
      } finally {
        setWriting(false);
      }
    },
    // NOT [active, rows, …]: hoisting `activeExists` out of this callback removed the only direct
    // reads of either, so listing them is now stale noise the exhaustive-deps rule flags.
    [activeExists, clearFailure, load],
  );

  /** Remove a destination, REPOINTING `publish.active` FIRST when it is the one going.
   *
   *  Order is the whole of this function. Leaving `active` naming a destination that no longer
   *  exists is not cosmetic: publish ops resolve their target as "the caller's explicit id, else
   *  `[publish] active`", so a dangling `active` is a publish that fails at call time with an error
   *  about a destination the user has already deleted. Repointing before the removal means there is
   *  no instant at which the config is in that state, even if the second write fails. */
  const removeDestination = useCallback(
    async (id: string) => {
      setWriteError(null);
      setWriting(true);
      try {
        const remaining = (rows ?? []).filter((r) => r.id !== id).map((r) => r.id);
        // Two reasons to repoint, not one. The obvious: the destination going away is the active
        // one. The other: `active` is ALREADY dangling — non-null and naming nothing — in which
        // case removing some OTHER destination used to leave it dangling forever (roborev 67318).
        //
        // `active !== null && !activeExists` rather than bare `!activeExists`, because a deliberate
        // null is not a defect: publish ops refuse on it, the picker spells it "choose a
        // destination", and silently choosing one on the user's behalf during a REMOVE would be a
        // surprising place to make that decision. A dangling id has no such defence — nobody chose
        // it and nothing can use it.
        if (active === id || (active !== null && !activeExists)) {
          if (remaining.length > 0) {
            await setConfigValue("publish.active", remaining[0]!);
          } else {
            // `unsetConfigValue`, not `setConfigValue(…, "")`. `active` is an `Option<String>` and
            // the absent key is how "none" is spelled; an empty string is a destination id that
            // matches nothing, which is the dangling case wearing a different hat.
            await unsetConfigValue("publish.active");
          }
        }
        await unsetConfigValue(`publish.destinations.${id}`);
        // The credential goes with the destination. Ordered AFTER the config write on purpose: the
        // keychain item is unreachable once the destination is gone, so a failure here strands a
        // secret rather than a usable credential — whereas clearing FIRST and then failing the
        // config write would leave a configured destination whose token had silently vanished.
        //
        // NOT folded into the failure path: `unsetConfigValue` already succeeded, so the
        // destination IS removed and rejecting here would render "remove failed" over a removal
        // that happened. But it is not DISCARDED either — see `clearFailure`. There is no row left
        // to report the token's fate once the destination is gone, so if this is dropped the user
        // is told the credential was deleted and never learns otherwise.
        const clearErr = await clearPublishToken(id).then(
          () => null,
          (e: unknown) => String(e),
        );
        setClearFailure(clearErr === null ? null : { id, message: clearErr });
        setConfirmRemove(null);
        await load();
      } catch (e) {
        setWriteError(String(e));
      } finally {
        setWriting(false);
      }
    },
    [rows, active, activeExists, load],
  );

  const chooseActive = useCallback(
    async (id: string) => {
      setWriteError(null);
      setWriting(true);
      try {
        await setConfigValue("publish.active", id);
        await load();
      } catch (e) {
        // `active` is untouched, so the picker snaps back to what the config still says. The user
        // is not left believing they switched destination when they did not.
        setWriteError(String(e));
      } finally {
        setWriting(false);
      }
    },
    [load],
  );

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
        {/* Deliberately NO add form in this branch. Adding a destination is a read-modify-write of
            a file Sparkle has just failed to read; offering it here would invite a write on top of
            a config whose current contents are unknown. */}
        <RetryButton probing={probing} onClick={() => void load()} />
      </div>
    );
  }

  const addAffordance = adding ? (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <PublishDestinationForm
        takenIds={rows.map((r) => r.id)}
        busy={writing}
        onSubmit={addDestination}
        onCancel={() => {
          setAdding(false);
          setWriteError(null);
        }}
      />
      {writeError !== null ? <WriteError message={writeError} /> : null}
      {clearFailure !== null ? (
        <ClearFailure
          id={clearFailure.id}
          message={clearFailure.message}
          onDismiss={() => setClearFailure(null)}
        />
      ) : null}
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={() => {
          setWriteError(null);
          setAdding(true);
        }}
        style={{
          alignSelf: "flex-start",
          border: `1px solid ${C.hairline}`,
          borderRadius: RADIUS.input,
          padding: "6px 10px",
          background: "transparent",
          color: C.cream,
          cursor: "pointer",
          fontSize: TYPE.small,
          fontFamily: FONT_UI,
        }}
      >
        Add destination
      </button>
      {/* The form owns its own error while it is open; once it has closed, a failed REMOVE or
          SWITCH still needs somewhere to be said. */}
      {writeError !== null ? <WriteError message={writeError} /> : null}
      {clearFailure !== null ? (
        <ClearFailure
          id={clearFailure.id}
          message={clearFailure.message}
          onDismiss={() => setClearFailure(null)}
        />
      ) : null}
    </div>
  );

  if (rows.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT_UI }}>
        <div style={{ fontSize: TYPE.body, color: C.muted, lineHeight: 1.5 }}>
          No publish destination is configured, so Sparkle can’t post anywhere — which is the right
          default for an outward-facing action. Add one below, then paste its token.
        </div>
        {addAffordance}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT_UI }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: TYPE.small, color: C.muted }}>
        <span>Publish to</span>
        <select
          data-testid="publish-active-picker"
          aria-label="Active destination"
          value={activeExists ? active! : ""}
          disabled={writing}
          onChange={(e) => void chooseActive(e.target.value)}
          style={{
            border: `1px solid ${C.inputEdge}`,
            borderRadius: RADIUS.input,
            padding: "6px 10px",
            background: C.inputSurface,
            color: C.cream,
            fontSize: TYPE.small,
            fontFamily: FONT_UI,
          }}
        >
          {/* Rendered whenever nothing VALID is chosen, which is two states, not one — and gating it
              on `active === null` covered only the harmless half (roborev 67318, Medium).

              The other half is `active` naming a destination that does not exist: reachable by a
              hand edit, or a removal by a build that did not repoint. There `value` matched no
              `<option>`, so the browser painted the FIRST destination as selected — the pane said
              "Publish to drodio.com" while the config said `ghost`, every publish op refused citing
              a destination the user had never heard of, and there was no way out, because
              re-picking the entry already displayed fires no `change` event. Naming the dangling id
              is the difference between a mystery and a one-click repair. */}
          {!activeExists ? (
            <option value="">
              {active === null
                ? "— choose a destination —"
                : `— ${active} is not configured; choose one —`}
            </option>
          ) : null}
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.destination.name}
            </option>
          ))}
        </select>
      </label>

      {rows.map((row) => (
        <div key={row.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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

          {/* The credential, per destination. Mounted for a row whose probe FAILED as well as one
              that succeeded — "could not run" is very often exactly this: no token yet, or the
              wrong one. Hiding the field until the probe passes would hide the fix for the most
              common cause of the probe failing. */}
          <PublishTokenRow key={`token-${row.id}`} destinationId={row.id} />

          {confirmRemove === row.id ? (
            <div
              data-testid={`publish-remove-confirm-${row.id}`}
              style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: TYPE.small }}
            >
              {/* Said before the deletion, not after. This copy is LOAD-BEARING and moved once
                  already: it used to promise the token stayed behind, which was true only while
                  this pane could not reach the credential service. It can now, so the sentence had
                  to move with the behaviour — telling a user to go revoke a token Sparkle had just
                  deleted would send them hunting for something that is not there.

                  The environment half is NOT hedging. `SPARKLE_PUBLISH_TOKEN_<ID>` is a fallback
                  Sparkle cannot unset, so on a machine that exports one the destination keeps
                  working after both the config entry and the keychain item are gone — and that is
                  the case where a user most needs to be told, because everything on screen says
                  removed. */}
              <div style={{ color: C.amberInk, lineHeight: 1.5 }}>
                Removing <span style={{ fontFamily: FONT_MONO }}>{row.id}</span> deletes it from your
                config and clears its saved token from your keychain. If you also export{" "}
                <span style={{ fontFamily: FONT_MONO }}>{publishTokenEnvVarName(row.id)}</span>,
                that one still works and only you can unset it. Revoking the token at the destination
                is what stops it for good.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  disabled={writing}
                  onClick={() => void removeDestination(row.id)}
                  style={{
                    border: `1px solid ${C.hairline}`,
                    borderRadius: RADIUS.input,
                    padding: "6px 10px",
                    background: "transparent",
                    color: C.dangerInk,
                    cursor: writing ? "default" : "pointer",
                    fontSize: TYPE.small,
                    fontFamily: FONT_UI,
                  }}
                >
                  {writing ? "Removing…" : `Remove ${row.id}`}
                </button>
                <button
                  type="button"
                  disabled={writing}
                  onClick={() => setConfirmRemove(null)}
                  style={{
                    border: "none",
                    borderRadius: RADIUS.input,
                    padding: "6px 10px",
                    background: "transparent",
                    color: C.muted,
                    cursor: writing ? "default" : "pointer",
                    fontSize: TYPE.small,
                    fontFamily: FONT_UI,
                  }}
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setWriteError(null);
                setConfirmRemove(row.id);
              }}
              style={{
                alignSelf: "flex-start",
                border: "none",
                borderRadius: RADIUS.input,
                padding: "2px 0",
                background: "transparent",
                color: C.muted,
                cursor: "pointer",
                fontSize: TYPE.small,
                fontFamily: FONT_UI,
              }}
            >
              Remove {row.id}
            </button>
          )}
        </div>
      ))}

      {addAffordance}

      <RetryButton probing={probing} onClick={() => void load()} />
    </div>
  );
}

/** A config WRITE that failed. Its own component so every mutating path says it the same way, and
 *  so the wording stays a statement about the CONFIG FILE rather than about the destination — which
 *  Sparkle learned nothing new about. */
/** A destination was removed and its keychain token could NOT be cleared.
 *
 *  EXTRACTED, not inlined twice. It renders in both the `adding` and non-`adding` halves of the
 *  pane, and it is load-bearing user-facing copy that states a credential is still live — exactly
 *  the text AGENTS.md means by "user-facing copy is code". Two verbatim copies sharing one
 *  `data-testid` is a standing invitation for one to be edited and the other to keep saying
 *  something else under the same assertion (roborev 67382, Medium). `WriteError` below is the same
 *  pattern for the same reason. */
function ClearFailure({
  id,
  message,
  onDismiss,
}: {
  id: string;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="publish-clear-failure"
      style={{
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.input,
        padding: "8px 10px",
        color: C.amberInk,
        fontSize: TYPE.small,
        lineHeight: 1.5,
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <span>
        Removed <span style={{ fontFamily: FONT_MONO }}>{id}</span>, but its saved token could NOT be
        cleared from your keychain: <span style={{ fontFamily: FONT_MONO }}>{message}</span> — that
        credential is still live. Revoke it at the destination.
      </span>
      {/* A dismiss, because the notice asserts a PRESENT-TENSE fact the user can go and resolve
          outside Sparkle. Without one it is permanent for the session, and a claim that cannot be
          retracted eventually contradicts the screen around it. */}
      <button
        type="button"
        data-testid="publish-clear-failure-dismiss"
        onClick={onDismiss}
        style={{
          marginLeft: "auto",
          border: "none",
          background: "transparent",
          color: C.muted,
          cursor: "pointer",
          fontSize: TYPE.small,
          fontFamily: FONT_UI,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

function WriteError({ message }: { message: string }) {
  return (
    <div
      data-testid="publish-write-error"
      style={{ fontSize: TYPE.small, color: C.dangerInk, lineHeight: 1.5 }}
    >
      Sparkle couldn’t save that to its configuration, so nothing changed.{" "}
      <span style={{ fontFamily: FONT_MONO }}>{message}</span>
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
