import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import {
  clearPublishToken,
  getPublishTokenSource,
  publishTokenEnvVarName,
  setPublishToken,
  type TokenSource,
} from "../services/publishCredential";

// The CREDENTIAL control for one publish destination (bead `sparkle-131ms.3`).
//
// WHY THIS EXISTS: `publish_token_set` / `_clear` / `_source` / `_present` have been registered
// commands with passing Rust tests since the credential store landed, and no line of the webview
// called any of them. The keychain worked and was unreachable. Meanwhile the pane's empty state
// told the user to "paste its token here" — pointing at a field that did not exist, which is why
// the feature has never once been used end to end.
//
// THE ONE IDEA THIS ROW IS BUILT AROUND is `PublishPane`'s own: COULD-NOT-RUN and RAN-AND-SAID-NO
// are different answers and must never render the same. That cuts twice here:
//
//   1. A failed source lookup is a THIRD state, not "no token". Saying "no token is configured"
//      because the check itself failed asserts a fact about a destination Sparkle never managed to
//      ask about — and the remedy it implies (paste a token) is the wrong action if one is stored.
//   2. A CLEAR THAT SUCCEEDS DOES NOT MEAN THE DESTINATION IS DISCONNECTED. `publish_token_clear`
//      removes the keychain item and returns the source that survives; on a machine that also
//      exports `SPARKLE_PUBLISH_TOKEN_<ID>` that is `"environment"`, and the destination is still
//      credentialed by a variable Sparkle cannot unset. Rendering "no token" there is a lie whose
//      cost is somebody debugging why a revoked credential keeps publishing.
//
// THE TOKEN IS WRITE-ONLY. It is never read back from the host (there is no command that would
// return it), never logged, never put in a `title` or an `aria-*` attribute where it would land in
// the accessibility tree, and the field is cleared the moment a save succeeds.
//
// Mounted by `PublishPane`, once per configured destination and KEYED BY DESTINATION ID. The key
// makes React remount rather than reconcile, which closes the cross-destination state carry from
// the parent's side; the epoch counter and the reset effect below close it from this side. Both are
// kept deliberately — a component that can leak a secret when a caller forgets a key is not one
// whose correctness should rest on that key.

export const PUBLISH_TOKEN_ROW_TESTID = "publish-token-row";
export const PUBLISH_TOKEN_STATUS_TESTID = "publish-token-status";
export const PUBLISH_TOKEN_INPUT_TESTID = "publish-token-input";
export const PUBLISH_TOKEN_SAVE_TESTID = "publish-token-save";
export const PUBLISH_TOKEN_CLEAR_TESTID = "publish-token-clear";
export const PUBLISH_TOKEN_REPLACE_TESTID = "publish-token-replace";
export const PUBLISH_TOKEN_RECHECK_TESTID = "publish-token-recheck";
export const PUBLISH_TOKEN_ERROR_TESTID = "publish-token-error";

export interface PublishTokenRowProps {
  /** The destination id, as it is keyed under `[publish.destinations]` in `config.toml`. */
  destinationId: string;
}

export function PublishTokenRow({ destinationId }: PublishTokenRowProps) {
  /** null while the source is unknown — either still in flight, or the lookup failed. */
  const [source, setSource] = useState<TokenSource | null>(null);
  /** The lookup itself failed. Distinct from `source === "none"`, which is an ANSWER. */
  const [lookupError, setLookupError] = useState<string | null>(null);
  /** A save or a clear failed. Distinct again: the source we last read is still valid. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  /**
   * WHICH action is in flight, not merely that one is. A bare boolean shared by both controls made
   * a Save relabel the Clear button "Clearing…" — telling the user a credential DELETION was under
   * way when only a write was, which is a user-facing statement about a revocation that is not
   * happening (roborev 67321, Medium). Both controls still disable for either value; only the
   * labels distinguish.
   */
  const [pending, setPending] = useState<null | "save" | "clear">(null);
  const busy = pending !== null;
  /** Whether the paste field is open over an existing keychain item ("Replace"). */
  const [replacing, setReplacing] = useState(false);

  const envVar = publishTokenEnvVarName(destinationId);

  /**
   * TWO counters, because there are two different questions and one counter cannot answer both.
   *
   * `epoch` changes ONLY when the destination does. Everything in flight for the previous
   * destination — a lookup, a save, a clear, and the labels they drive — is stale the moment it
   * moves, because every piece of this row's state is per-destination.
   *
   * `readSeq` orders lookups WITHIN one destination, so two overlapping re-checks cannot land out
   * of order and leave the older answer showing.
   *
   * Splitting them is not tidiness. A single counter bumped by `readSource` would be bumped by
   * `save`'s OWN re-read, so `save`'s `finally` would find itself superseded and never clear the
   * pending label — leaving the button reading "Saving…" forever after a successful save.
   */
  const epoch = useRef(0);
  const readSeq = useRef(0);

  /**
   * Read the source and render from THAT — the single rendering path for all three entries (mount,
   * after a save, after a clear), so the three cannot drift into disagreeing about what the same
   * host state means. This mirrors the reason Rust's `token_source_with` reuses `resolve_token`'s
   * ordering rather than re-deriving it.
   */
  const readSource = useCallback(async () => {
    const myEpoch = epoch.current;
    const mySeq = ++readSeq.current;
    /** Still the current destination AND still the newest lookup for it. */
    const current = () => epoch.current === myEpoch && readSeq.current === mySeq;
    try {
      const next = await getPublishTokenSource(destinationId);
      if (!current()) return; // a newer read, or a different destination, has superseded this one
      setSource(next);
      setLookupError(null);
    } catch (e) {
      if (!current()) return;
      // Not `setSource("none")`. The check never ran, so there is no answer to render.
      setSource(null);
      setLookupError(String(e));
    }
  }, [destinationId]);

  // Keyed on `readSource`, whose identity changes with `destinationId` — so this is the DESTINATION
  // CHANGE effect, and it must reset every piece of per-destination state, not just re-read.
  //
  // The one that matters is `token`. A parent rendering `[publish.destinations]` as a list
  // reconciles by position, so the same element can be handed a new id; leaving a pasted secret in
  // the field meant the next Save wrote ONE HOST'S BEARER INTO ANOTHER HOST'S KEYCHAIN SLOT — the
  // cross-destination leak class `publish_credential.rs` removed the generic env var to close
  // (roborev 67321, Medium).
  useEffect(() => {
    // Bumped BEFORE the read, so the lookup below is stamped with the new epoch while everything
    // already in flight for the previous destination is stamped with the old one.
    epoch.current += 1;
    setToken("");
    setReplacing(false);
    setActionError(null);
    setSource(null);
    setLookupError(null);
    // `pending` is per-destination like the rest of it. Left standing, an unfinished save or clear
    // for the PREVIOUS destination disables the new destination's field (so the user cannot type a
    // token for it, indefinitely if the old write hangs) and paints "Clearing…" on a Clear button
    // for a destination nothing is being cleared for — the previous finding relocated from the
    // wrong BUTTON to the wrong DESTINATION (roborev 67332, Medium).
    setPending(null);
    void readSource();
  }, [readSource]);

  const trimmed = token.trim();

  async function save() {
    if (trimmed.length === 0 || busy) return;
    setPending("save");
    setActionError(null);
    const myEpoch = epoch.current;
    /** Still the destination this save was started for. */
    const mine = () => epoch.current === myEpoch;
    try {
      await setPublishToken(destinationId, trimmed);
      // Superseded mid-write: the destination changed under us, and the effect above has already
      // reset this row for the new one. Writing any of that state back would resurrect it.
      if (!mine()) return;
      // Clear the field FIRST, and unconditionally on success: the value has done its only job and
      // has no reason to stay in the DOM.
      setToken("");
      setReplacing(false);
      // Then ask the host what the state actually is. `publish_token_set` resolves with nothing —
      // it says the write happened, not that the destination now resolves a token — so assuming
      // "keychain" here would be rendering our own optimism as a reading.
      await readSource();
    } catch (e) {
      // The host's own message, already scrubbed of the bearer. Shown as-is, with the field and the
      // button still reachable so the paste can be corrected and retried.
      if (mine()) setActionError(String(e));
    } finally {
      // Only if this save still owns the row. An abandoned operation clearing the label would wipe
      // a SUCCESSOR's "Saving…" and re-enable its controls mid-write.
      if (mine()) setPending(null);
    }
  }

  async function clear() {
    if (busy) return;
    setPending("clear");
    setActionError(null);
    const myEpoch = epoch.current;
    /** Still the destination this clear was started for. */
    const mine = () => epoch.current === myEpoch;
    try {
      // THE RETURN VALUE IS THE ANSWER, and consuming it is the whole reason the command has one.
      // It is the host's own reading of the state AFTER the erase, taken inside the same blocking
      // closure that did the erasing — so it is the freshest reading obtainable and there is
      // nothing here to assume.
      //
      // A second `publish_token_source` round trip would be strictly STALER than this value, and it
      // would add a failure mode rather than a check: a rejected re-read would drop a clear that
      // SUCCEEDED into the could-not-run state, reporting that Sparkle cannot tell what happened
      // when it has just been told. `"environment"` here means the keychain item is gone and the
      // destination is STILL CREDENTIALED — render that, not a disconnection.
      const surviving = await clearPublishToken(destinationId);
      if (!mine()) return;
      setSource(surviving);
      setLookupError(null);
      setReplacing(false);
    } catch (e) {
      if (mine()) setActionError(String(e));
    } finally {
      if (mine()) setPending(null);
    }
  }

  const showField = source === "none" || source === "environment" || replacing;

  return (
    <div
      data-testid={PUBLISH_TOKEN_ROW_TESTID}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: FONT_UI,
        fontSize: TYPE.small,
      }}
    >
      <div data-testid={PUBLISH_TOKEN_STATUS_TESTID} style={{ color: C.muted, lineHeight: 1.5 }}>
        {source === null && lookupError === null && "Checking for a token…"}

        {lookupError !== null && (
          <>
            Sparkle couldn’t check where this destination’s token comes from, so this is{" "}
            <strong style={{ color: C.cream, fontWeight: 600 }}>not</strong> a statement that there
            is no token — the check never ran.{" "}
            <span style={{ fontFamily: FONT_MONO, color: C.dangerInk }}>{lookupError}</span>
          </>
        )}

        {source === "keychain" && (
          <>
            A token is stored for this destination in this Mac’s keychain. Sparkle reads it
            host-side when it publishes; it is never shown here and never written to{" "}
            <span style={{ fontFamily: FONT_MONO }}>config.toml</span>.
          </>
        )}

        {source === "environment" && (
          <>
            This destination’s token comes from the environment variable{" "}
            <span style={{ fontFamily: FONT_MONO, color: C.cream }}>{envVar}</span>.{" "}
            <strong style={{ color: C.amberInk, fontWeight: 600 }}>
              Sparkle can’t clear it
            </strong>{" "}
            — it can delete a keychain item, but it can’t unset a variable in your shell, so only
            whoever exported it can revoke it. Saving a token below stores it in the keychain, which{" "}
            <strong style={{ color: C.cream, fontWeight: 600 }}>takes precedence</strong> over the
            variable: the environment is a fallback, never an override.
          </>
        )}

        {source === "none" && (
          <>
            No token is stored for this destination and no{" "}
            <span style={{ fontFamily: FONT_MONO }}>{envVar}</span> is set, so Sparkle can’t publish
            to it. Paste the destination’s token below.
          </>
        )}
      </div>

      {showField && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <input
            data-testid={PUBLISH_TOKEN_INPUT_TESTID}
            // `password`, so the value is not readable over the user's shoulder or in a screen
            // share of a settings pane. There is deliberately no reveal toggle: nothing here ever
            // needs to read the value back, so offering to show it would add exposure and no use.
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Publish destination token"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            style={{
              flex: 1,
              minWidth: 180,
              background: C.inputSurface,
              border: `1px solid ${C.inputEdge}`,
              borderRadius: RADIUS.input,
              color: C.cream,
              fontFamily: FONT_MONO,
              fontSize: TYPE.small,
              padding: "6px 9px",
            }}
          />
          <RowButton
            testId={PUBLISH_TOKEN_SAVE_TESTID}
            onClick={() => void save()}
            disabled={busy || trimmed.length === 0}
            label={pending === "save" ? "Saving…" : "Save"}
          />
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {source === "keychain" && !replacing && (
          <RowButton
            testId={PUBLISH_TOKEN_REPLACE_TESTID}
            onClick={() => setReplacing(true)}
            disabled={busy}
            label="Replace"
          />
        )}

        {source === "keychain" && (
          <RowButton
            testId={PUBLISH_TOKEN_CLEAR_TESTID}
            onClick={() => void clear()}
            disabled={busy}
            label={pending === "clear" ? "Clearing…" : "Clear"}
            ink={C.dangerInk}
          />
        )}

        {source === "environment" && (
          // Rendered and DISABLED rather than hidden. The affordance is where the user expects it,
          // and its disabled state is what makes "Sparkle cannot revoke this one" concrete instead
          // of a sentence they have to take on trust. The reason is in the prose above, not in a
          // `title` — a tooltip is unreadable to anyone who cannot hover.
          <RowButton
            testId={PUBLISH_TOKEN_CLEAR_TESTID}
            onClick={() => {
              /* unreachable: there is no keychain item to clear, and Sparkle cannot unset a
                 variable. Kept as a no-op so the disabled control has no live handler at all. */
            }}
            disabled
            label="Clear"
            ink={C.muted}
          />
        )}

        {lookupError !== null && (
          <RowButton
            testId={PUBLISH_TOKEN_RECHECK_TESTID}
            onClick={() => void readSource()}
            disabled={busy}
            label="Check again"
          />
        )}
      </div>

      {actionError !== null && (
        <div
          data-testid={PUBLISH_TOKEN_ERROR_TESTID}
          style={{ color: C.dangerInk, fontFamily: FONT_MONO, lineHeight: 1.5 }}
        >
          {actionError}
        </div>
      )}
    </div>
  );
}

/** The row's one button treatment, so the four controls cannot drift apart. `RADIUS.input` — the
 *  scale reserves it for "inputs, buttons, cards, the workhorse"; a control must not echo the
 *  radius of the card that contains it. */
function RowButton({
  testId,
  onClick,
  disabled,
  label,
  ink,
}: {
  testId: string;
  onClick: () => void;
  disabled: boolean;
  label: string;
  ink?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.input,
        padding: "6px 10px",
        background: "transparent",
        color: disabled ? C.muted : (ink ?? C.cream),
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontSize: TYPE.small,
        fontFamily: FONT_UI,
      }}
    >
      {label}
    </button>
  );
}
