import { useEffect, useState, type CSSProperties } from "react";
import { FiKey, FiTrash2 } from "react-icons/fi";
import { C, DANGER } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import type { ClaudeAuthMethod } from "../services/cloudAgents/api";

// Settings → "Claude auth for cloud agents" (Service B, W5). A cloud agent runs Claude Code in a
// Sparkle-provisioned sandbox with the USER's own Claude credential, so this pane is where that
// credential is saved — encrypted per-user server-side (W3's vault), injected into that user's
// sandboxes as env only, never logged and never returned.
//
// Two invariants this component must never break:
//   1. THE SECRET IS WRITE-ONLY. The server returns only which METHOD is stored; nothing here ever
//      renders, restores or round-trips the value. The input is a password field, its value lives
//      in local state only, and a successful save clears it immediately.
//   2. THE SUBSCRIPTION OPTION IS LABELED HONESTLY. `claude setup-token` mints a 1-year OAuth token
//      from a Pro/Max subscription, but there is no explicit Anthropic ToS sanction for a
//      third-party product storing customer subscription tokens (spec §"the subscription question")
//      — so BYOK is the default, the subscription path is opt-in, and the server may refuse it
//      outright (403 `subscription_auth_disabled` when SPARKLE_ENABLE_SUBSCRIPTION_AUTH is off).
//      That refusal renders as a plain sentence naming the method that IS available, not a crash
//      and not a vague "unavailable".

const METHOD_LABEL: Record<ClaudeAuthMethod, string> = {
  byok: "Anthropic API key",
  subscription: "Claude subscription token",
};

export function CloudAuthPane() {
  const method = useCloudAuthStore((s) => s.method);
  const loaded = useCloudAuthStore((s) => s.loaded);
  const busy = useCloudAuthStore((s) => s.busy);
  const error = useCloudAuthStore((s) => s.error);
  const refresh = useCloudAuthStore((s) => s.refresh);
  const save = useCloudAuthStore((s) => s.save);
  const remove = useCloudAuthStore((s) => s.remove);

  // Which method the user is about to save (independent of what's stored — you can replace a saved
  // key with a token and vice versa). Defaults to the ToS-clean option.
  const [draftMethod, setDraftMethod] = useState<ClaudeAuthMethod>("byok");
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async () => {
    if (!secret.trim()) return;
    // Trim before sending: a pasted key with a trailing newline would otherwise be encrypted
    // verbatim, unrecoverable to inspect, and rejected by Anthropic inside the sandbox. The server
    // trims too (claudeAuthBody) — this is belt & braces (roborev 46287).
    const ok = await save(draftMethod, secret.trim());
    if (ok) {
      setSecret(""); // write-only: drop the plaintext the instant the server has it
      setSaved(true);
    }
  };

  const onRemove = async () => {
    const ok = await remove();
    if (ok) {
      setConfirmRemove(false);
      setSaved(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── What's stored now ─────────────────────────────────────────────── */}
      <div>
        <div style={subLabel}>Current credential</div>
        <div style={panel}>
          <div style={{ fontSize: 13, color: C.cream }} data-testid="cloudauth-current">
            {!loaded
              ? "Checking…"
              : method
                ? `${METHOD_LABEL[method]} saved`
                : "No Claude credential saved"}
          </div>
          <div style={hint}>
            {method
              ? "Stored encrypted on Sparkle's server and injected only into your own cloud sandboxes. The value itself can't be read back — save a new one to replace it."
              : "Cloud agents need your own Claude authentication. Nothing is stored until you save it below."}
          </div>
          {loaded && method && !confirmRemove && (
            <button type="button" style={actionBtn} onClick={() => setConfirmRemove(true)} disabled={busy}>
              <FiTrash2 size={13} />
              Remove credential…
            </button>
          )}
          {confirmRemove && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={{ ...actionBtn, borderColor: DANGER, color: DANGER }}
                onClick={() => void onRemove()}
                disabled={busy}
              >
                {busy ? "Removing…" : "Remove"}
              </button>
              <button type="button" style={actionBtn} onClick={() => setConfirmRemove(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Save a credential ─────────────────────────────────────────────── */}
      <div>
        <div style={subLabel}>Save a credential</div>
        <div style={panel}>
          <div role="radiogroup" aria-label="Authentication method" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <MethodOption
              id="byok"
              checked={draftMethod === "byok"}
              onSelect={() => setDraftMethod("byok")}
              title="Anthropic API key (recommended)"
              blurb="Your own ANTHROPIC_API_KEY. Billed by Anthropic to you; Sparkle credits pay only for the sandbox minutes."
            />
            <MethodOption
              id="subscription"
              checked={draftMethod === "subscription"}
              onSelect={() => setDraftMethod("subscription")}
              title="Claude subscription token (opt-in)"
              blurb="Run `claude setup-token` locally and paste the token. Anthropic has not confirmed that a third-party product may store subscription tokens, so this path is off by default and the server may decline to save it."
            />
          </div>

          <label htmlFor="cloudauth-secret" style={{ ...hint, color: C.cream }}>
            {draftMethod === "byok" ? "API key" : "Subscription token"}
          </label>
          <input
            id="cloudauth-secret"
            data-testid="cloudauth-secret"
            type="password"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setSaved(false);
            }}
            placeholder={draftMethod === "byok" ? "sk-ant-…" : "sk-ant-oat…"}
            autoComplete="off"
            spellCheck={false}
            style={input}
          />
          <button
            type="button"
            style={actionBtn}
            onClick={() => void onSave()}
            disabled={busy || secret.trim().length === 0}
          >
            <FiKey size={13} />
            {busy ? "Saving…" : "Save credential"}
          </button>
          {saved && !error && (
            <div style={{ ...hint, color: C.cream }} data-testid="cloudauth-saved">
              Saved. Sparkle keeps it encrypted and never shows it again.
            </div>
          )}
          {error && (
            <div style={errorText} data-testid="cloudauth-error">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MethodOption({
  id,
  checked,
  onSelect,
  title,
  blurb,
}: {
  id: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <label htmlFor={`cloudauth-method-${id}`} style={{ display: "flex", gap: 9, cursor: "pointer" }}>
      <input
        id={`cloudauth-method-${id}`}
        type="radio"
        name="cloudauth-method"
        checked={checked}
        onChange={onSelect}
        style={{ marginTop: 3 }}
      />
      <span>
        <span style={{ display: "block", fontSize: 13, color: C.cream }}>{title}</span>
        <span style={{ ...hint, display: "block" }}>{blurb}</span>
      </span>
    </label>
  );
}

// ── styles (inline CSSProperties, matching SettingsDialog's convention) ──────

const subLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 8,
};

const panel: CSSProperties = {
  background: C.forest,
  border: `1px solid ${C.forest}`,
  borderRadius: 9,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "flex-start",
};

const hint: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

const errorText: CSSProperties = {
  fontSize: 12,
  color: DANGER,
  lineHeight: 1.5,
};

const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.barSurface,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

const actionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};
