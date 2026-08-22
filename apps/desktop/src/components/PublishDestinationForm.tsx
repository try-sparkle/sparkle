import { useState, type FormEvent } from "react";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";

// The add/edit form for one publish destination (bead `sparkle-131ms.9`).
//
// Deliberately PRESENTATIONAL: it takes an `onSubmit` and never writes config itself, so the
// interesting half — "a bad id is refused before it reaches config.toml" — is testable without
// mocking Tauri. The pane owns the write, and owns what a failed write looks like.
//
// It checks two things before it will hand anything to its caller, and the two are checked for
// very different reasons. Read the reasons before relaxing either.

/** The destination id rule, mirrored from Rust's `publish_credential::destination_id_is_valid`.
 *
 *  **This is a MIRROR, not the authority.** Rust checks it at every path to a keychain item —
 *  `entry()` re-checks before constructing the account key, and `config::apply_publish` re-checks
 *  the config file — precisely so a hand-edited `config.toml` cannot route around whatever the UI
 *  did. What this copy buys is that the user learns the rule while they can still fix it, instead
 *  of writing a destination into config.toml that every keychain call then refuses.
 *
 *  The rule is what it is because **the id is interpolated into a keychain account key**
 *  (`publish-<id>-token`). A permissive rule is what would let a caller name another item's slot,
 *  so the character set is a whitelist and not a blacklist: lowercase ASCII letters, digits and
 *  dashes, 1–64 characters. Uppercase is excluded too — two ids differing only in case would
 *  derive two slots that a case-insensitive store may or may not treat as one. */
export function destinationIdProblem(raw: string, takenIds: readonly string[] = []): string | null {
  const id = raw.trim();
  if (id === "") return "a destination needs an id — it is what names its token in the keychain";
  if (id.length > 64) return "that id is too long — 64 characters at most";
  // Character-by-character against the same whitelist Rust uses, so the message can be specific
  // about what is not allowed rather than just saying the whole value is wrong.
  if (!/^[a-z0-9-]+$/.test(id)) {
    return "ids may only contain lowercase letters, digits and dashes — the id becomes a keychain key";
  }
  if (takenIds.includes(id)) {
    // Not a Rust rule; a UI one. `publish.destinations` is a map, so re-using an id is a silent
    // OVERWRITE of the existing destination's name and URL while its keychain token stays put —
    // the new destination would inherit the old one's bearer.
    return `“${id}” is already configured — pick another id, or edit that destination instead`;
  }
  return null;
}

/** LIGHT client-side URL checking. `publish_url.rs::validate_destination_url` is the authority and
 *  RE-RUNS at call time, so this is a courtesy, not a gate.
 *
 *  It deliberately does NOT reimplement the Rust rule set. A second full copy would drift, and
 *  drift in a rule about where Sparkle sends a bearer token is a security-relevant bug rather than
 *  a cosmetic one. So: does it parse, is it http(s), is it https-or-loopback, and does it carry
 *  userinfo. Everything finer — and the final word on all four — is the capability probe, which is
 *  what the form says on screen. */
export function destinationUrlProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "a publish destination needs a URL";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "that is not a valid URL";
  }

  // Userinfo first, and rejected on the parsed username/password rather than on `includes("@")` —
  // an `@` is legal in a path or query (`/api/mcp?to=a@b.com`), and a URL can carry a password
  // with an EMPTY username, which a check for a non-empty username alone would miss.
  //
  // The reason is Rust's own: Sparkle sends the destination's token from the OS keychain, and a
  // credential written into the URL would sit in config.toml on disk in plaintext — which is to
  // say in backups, in screen shares, and in whatever the user pastes into a bug report.
  if (url.username !== "" || url.password !== "") {
    return "remove the username/password from the URL — a credential written into config.toml would sit on disk in plaintext";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    // The loopback exemption below is for local dev servers, not a licence to hand an arbitrary
    // scheme to the HTTP client: `file://localhost/etc/passwd` parses, has no userinfo, and has a
    // loopback host.
    return `a publish destination must be an http(s) URL — this one uses ${url.protocol.replace(":", "")}`;
  }

  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    return "a publish destination must use https — Sparkle sends a bearer token to it, and over plain http that token is readable by anything on the network. (http is allowed only for localhost.)";
  }

  return null;
}

/** Loopback, matched the way `publish_url.rs` matches it and not the way that is easier.
 *
 *  `URL.hostname` returns an IPv6 literal WITH its brackets (`[::1]`), so the brackets come off
 *  before the compare — a string test against `"::1"` otherwise never matches. `localhost` is
 *  matched EXACTLY (the parser has already lowercased it): `localhost.evil.example.com` is a wholly
 *  different and entirely remote host that a `startsWith`/`includes` test would wave through. And
 *  the IPv4 test takes all of `127.0.0.0/8`, not just `127.0.0.1`. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // ::1 in its expanded spellings too — the WHATWG parser normalizes to "::1", but a value that
  // arrived some other way should not read as remote.
  return host === "::1" || host === "0:0:0:0:0:0:0:1";
}

export interface PublishDestinationDraft {
  id: string;
  name: string;
  url: string;
}

interface Props {
  /** Prefilled values when editing an existing destination. */
  initial?: Partial<PublishDestinationDraft>;
  /** Ids already in `publish.destinations`, so re-using one is refused rather than overwriting.
   *  When editing, the destination's OWN id must not be in this list. */
  takenIds?: readonly string[];
  /** The caller performs the write. It may reject; the caller renders that, not this form — a
   *  failed write is a statement about the config file, not about what was typed. */
  onSubmit: (draft: PublishDestinationDraft) => void | Promise<void>;
  onCancel?: () => void;
  /** True while the caller's write is in flight. Disables the controls so one gesture cannot
   *  produce two writes. */
  busy?: boolean;
  submitLabel?: string;
}

export function PublishDestinationForm({
  initial,
  takenIds = [],
  onSubmit,
  onCancel,
  busy = false,
  submitLabel = "Add destination",
}: Props) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  /** Populated only on a submit ATTEMPT. Validating on every keystroke would paint "a destination
   *  needs an id" at the user before they have typed the first character of one. */
  const [problems, setProblems] = useState<{ id?: string; name?: string; url?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next = {
      id: destinationIdProblem(id, takenIds) ?? undefined,
      name: name.trim() === "" ? "give the destination a name — it is what the pane calls it" : undefined,
      url: destinationUrlProblem(url) ?? undefined,
    };
    setProblems(next);
    // Nothing is handed to the caller unless EVERY field is clean. The id check in particular has
    // to happen here rather than after the write: an invalid id in config.toml is a destination
    // that exists and can never hold a token.
    if (next.id || next.name || next.url) return;
    void onSubmit({ id: id.trim(), name: name.trim(), url: url.trim() });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Add publish destination"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.modal,
        padding: 14,
        fontFamily: FONT_UI,
      }}
    >
      <Field
        label="Id"
        hint="Lowercase letters, digits and dashes. This names the destination’s token in your keychain."
        value={id}
        onChange={setId}
        problem={problems.id}
        testId="publish-form-id"
        mono
        disabled={busy}
      />
      <Field
        label="Name"
        hint="What this pane calls it."
        value={name}
        onChange={setName}
        problem={problems.name}
        testId="publish-form-name"
        disabled={busy}
      />
      <Field
        label="URL"
        hint="The destination’s MCP endpoint. https, or http for localhost."
        value={url}
        onChange={setUrl}
        problem={problems.url}
        testId="publish-form-url"
        mono
        disabled={busy}
      />

      {/* Said plainly, because the form's checks are a courtesy and presenting them as the verdict
          would be a lie the user only discovers when a publish fails. */}
      <div style={{ fontSize: TYPE.small, color: C.muted, lineHeight: 1.5 }}>
        These are quick checks only. Whether Sparkle can actually publish here is answered by the
        capability probe below, after you add the destination and paste its token.
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          disabled={busy}
          style={{
            border: `1px solid ${C.hairline}`,
            borderRadius: RADIUS.input,
            padding: "6px 10px",
            background: "transparent",
            color: C.cream,
            cursor: busy ? "default" : "pointer",
            fontSize: TYPE.small,
            fontFamily: FONT_UI,
          }}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              border: "none",
              borderRadius: RADIUS.input,
              padding: "6px 10px",
              background: "transparent",
              color: C.muted,
              cursor: busy ? "default" : "pointer",
              fontSize: TYPE.small,
              fontFamily: FONT_UI,
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** One labelled input plus its hint and, when the last submit attempt rejected it, its problem.
 *
 *  `RADIUS.input`, not `RADIUS.modal`: `scale.ts` reserves `input` for "inputs, buttons, cards —
 *  the workhorse" and `modal` for the largest surface, and an inner control must not echo the card
 *  containing it. The ratchet only counts numeric literals, so a call site on the wrong STEP is
 *  invisible to it. */
function Field({
  label,
  hint,
  value,
  onChange,
  problem,
  testId,
  mono = false,
  disabled = false,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  problem?: string;
  testId: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: TYPE.small, color: C.cream, fontWeight: 600 }}>{label}</span>
      <input
        data-testid={testId}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        // `aria-invalid` rather than colour alone: the pane's whole register is hairlines, and a
        // red border is not something a screen reader reads out.
        aria-invalid={problem ? true : undefined}
        style={{
          border: `1px solid ${problem ? C.dangerInk : C.inputEdge}`,
          borderRadius: RADIUS.input,
          padding: "6px 10px",
          background: C.inputSurface,
          color: C.cream,
          fontSize: TYPE.small,
          fontFamily: mono ? FONT_MONO : FONT_UI,
        }}
      />
      {problem ? (
        <span data-testid={`${testId}-problem`} style={{ fontSize: TYPE.small, color: C.dangerInk, lineHeight: 1.5 }}>
          {problem}
        </span>
      ) : (
        <span style={{ fontSize: TYPE.small, color: C.muted, lineHeight: 1.5 }}>{hint}</span>
      )}
    </label>
  );
}
