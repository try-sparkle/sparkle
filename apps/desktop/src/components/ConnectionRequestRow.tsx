// ConnectionRequestRow — the pinned "someone wants to connect" banner. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §10 ("Inbound connection requests reuse
// the `SupportTicketRow` slot and idiom"). Bead `sparkle-xnjil.12`.
//
// The founder's words: *"as the user receiving that connection request I can choose to accept or
// deny."* This is that surface, and `AgentSidebar` renders it in exactly one line — the third and
// last of the three touches that whole feature is allowed to make to that file.
//
// ══ IT IS THE `SupportTicketRow` IDIOM, ON PURPOSE ═════════════════════════════════════════════
// Structurally identical, and an idiom the founder has already accepted: a pinned, self-refreshing,
// conditionally-rendered banner that renders NOTHING when there is nothing, opens the single case
// directly, and expands into a list when there are several. Reusing a shape he has already read
// once costs nobody a new thing to learn.
//
// ══ NOT `inboxStore`, AND THIS IS THE ONE MISTAKE THE SPEC NAMES BY NAME ═══════════════════════
// `inboxStore` is the per-AGENT Rust `inbox_peek` channel — instructions queued for a build agent,
// delivered at its next turn boundary. A human asking to connect is not a queued instruction for an
// agent, shares none of its lifetime, and putting it there would make `pendingCount` answer for two
// unrelated things. `socialStore` already carries `incoming` / `outgoing` ConnectionRequest arrays;
// those are what this reads.
//
// ══ WHY IT READS THE STORE AND ALSO POLLS ══════════════════════════════════════════════════════
// `services/socialSync` is the roster loop and it already writes `incoming`/`outgoing` on every
// complete pass, so the store is the source of truth and this component never invents one. The poll
// here is the SupportTicketRow half of the idiom and it earns its place on the two paths sync
// cannot serve: immediately after you accept or deny (waiting up to a minute to watch your own
// press take effect is the thing that makes a control feel broken), and on window focus, which is
// exactly when a person comes back to look. It is GATED ON HAVING A HANDLE — with no social
// identity every `/social/*` path 404s, and polling a route that has nothing to say once a minute
// forever is how a feature that is merely off becomes a feature that is noisy.

import { memo, useCallback, useEffect, useState } from "react";

import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { acceptConnection, declineConnection, getConnections } from "../services/socialApi";
import { useSocialStore, type ConnectionRequest } from "../stores/socialStore";

export const CONNECTION_REQUEST_TESTID = "connection-request-banner";
export const CONNECTION_REQUEST_ITEM_TESTID = "connection-request-item";
export const CONNECTION_ACCEPT_TESTID = "connection-request-accept";
export const CONNECTION_DENY_TESTID = "connection-request-decline";

/** The two verbs, exported so the test asserts the shipped words. The founder said "accept or
 *  deny", so the buttons say Accept and Deny — the API calls them accept/decline, and that
 *  asymmetry is deliberate: the wire word is not the user's word. */
export const ACCEPT_LABEL = "Accept";
export const DENY_LABEL = "Deny";

/** How often to re-read connections while the window is visible. Matches `SOCIAL_POLL_MS`. */
export const CONNECTION_POLL_MS = 60_000;

/**
 * The banner's headline.
 *
 * ONE request names the person, because that is the fact worth reading at a glance and it is the
 * one case where the name FITS. Several give the count instead — eleven names in a 200px banner is
 * a truncated first name and nothing else, so the number is strictly more informative. Pure, so the
 * copy is asserted without a tree.
 */
export function requestBannerLabel(requests: readonly ConnectionRequest[]): string {
  if (requests.length === 1) {
    const only = requests[0]!;
    return `${only.displayName?.trim() || only.username} wants to connect`;
  }
  return `${requests.length} connection requests`;
}

/** What one row calls a person. Display name when set, else the handle — the same rule
 *  `personName` applies, restated over the request shape (which is not a `Person`). */
export function requestName(request: ConnectionRequest): string {
  return request.displayName?.trim() || request.username;
}

export const ConnectionRequestRow = memo(function ConnectionRequestRow() {
  const incoming = useSocialStore((s) => s.incoming);
  const setRequests = useSocialStore((s) => s.setRequests);
  // Having a social identity is what makes `/social/connections` answerable at all — see the
  // header. Read off the SOCIAL store's `me`, not auth's: this is the social row's existence
  // server-side, not whether a Clerk session exists.
  const hasHandle = useSocialStore((s) => s.me.username != null);
  const [expanded, setExpanded] = useState(false);
  // Ids with a decision in flight. Keyed by id rather than a single boolean so accepting one
  // request does not freeze the buttons on the other ten.
  const [busy, setBusy] = useState<readonly string[]>([]);

  const refetch = useCallback(() => {
    getConnections()
      .then((rows) =>
        setRequests({ incoming: rows.incoming ?? [], outgoing: rows.outgoing ?? [] }),
      )
      .catch(() => {
        // Signed-out, offline, or a route that does not exist yet — leave the last-known list.
        // The banner simply stays as it was; the roster loop is the durable reader and this is a
        // freshness helper, so an error here must not blank a real request off the screen.
      });
  }, [setRequests]);

  useEffect(() => {
    if (!hasHandle) return;
    const onTick = () => {
      if (document.visibilityState === "visible") refetch();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    const timer = window.setInterval(onTick, CONNECTION_POLL_MS);
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasHandle, refetch]);

  /**
   * Accept or deny ONE request.
   *
   * The store write is not optimism for its own sake — it is what makes the press observable. The
   * server's 2xx carries no body, the roster loop may be up to a minute away, and a banner that
   * sits unchanged after you pressed Accept is indistinguishable from one that did nothing. So the
   * decided row leaves the list on SUCCESS (never before it), and the refetch behind it reconciles
   * with whatever the server actually holds.
   */
  const decide = useCallback(
    (request: ConnectionRequest, accept: boolean) => {
      setBusy((b) => [...b, request.id]);
      const call = accept ? acceptConnection(request.id) : declineConnection(request.id);
      call
        .then(() => {
          setRequests({ incoming: incoming.filter((r) => r.id !== request.id) });
          refetch();
        })
        .catch(() => {
          // Left in place, deliberately. A request that failed to be answered has NOT been
          // answered, and removing it would tell the user they had decided something they had not.
        })
        .finally(() => setBusy((b) => b.filter((id) => id !== request.id)));
    },
    [incoming, refetch, setRequests],
  );

  // NOTHING when there is nothing. The whole banner, not an empty box with a border — this sits in
  // the sidebar's fixed chrome between Improve Sparkle and the footer, where a zero-height
  // placeholder still costs a gap.
  if (incoming.length === 0) return null;

  const multiple = incoming.length > 1;
  const only = incoming[0]!;

  return (
    <div style={{ flex: "0 0 auto", margin: "0 8px 6px" }}>
      <div
        data-testid={CONNECTION_REQUEST_TESTID}
        data-request-count={incoming.length}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: expanded ? "6px 6px 0 0" : 6,
          background: C.teal,
          color: ON_BRAND_FILL,
          fontSize: TYPE.body,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        <span
          // The count is the toggle when there are several; with one request the headline is not a
          // control at all, because the two buttons beside it already are.
          onClick={multiple ? () => setExpanded((e) => !e) : undefined}
          role={multiple ? "button" : undefined}
          tabIndex={multiple ? 0 : undefined}
          onKeyDown={
            multiple
              ? (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setExpanded((v) => !v);
                }
              : undefined
          }
          title={multiple ? `Click to ${expanded ? "hide" : "show"} the requests` : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: multiple ? "pointer" : "default",
          }}
        >
          {requestBannerLabel(incoming)}
        </span>
        {!multiple && (
          <Decide
            request={only}
            busy={busy.includes(only.id)}
            onDecide={decide}
            onBrandFill
          />
        )}
      </div>

      {multiple && expanded && (
        <div
          style={{
            border: `1px solid ${C.teal}`,
            borderTop: "none",
            borderRadius: "0 0 6px 6px",
            overflow: "hidden",
          }}
        >
          {incoming.map((request, i) => (
            <div
              key={request.id}
              data-testid={CONNECTION_REQUEST_ITEM_TESTID}
              data-username={request.username}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 10px",
                background: C.deepForest,
                // A row separator, not a seam — the same rule `SupportTicketRow`'s list follows.
                borderTop: i === 0 ? "none" : `1px solid ${C.hairline}`,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: TYPE.small,
                  color: C.cream,
                }}
              >
                {requestName(request)}
              </span>
              <Decide
                request={request}
                busy={busy.includes(request.id)}
                onDecide={decide}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Accept / Deny for one request. One component so the single-request banner and the expanded list
 *  can never grow two different pairs of buttons. */
function Decide({
  request,
  busy,
  onDecide,
  onBrandFill = false,
}: {
  request: ConnectionRequest;
  busy: boolean;
  onDecide: (request: ConnectionRequest, accept: boolean) => void;
  /** True in the banner, where the buttons sit on the teal fill and must take its ink. */
  onBrandFill?: boolean;
}) {
  const ink = onBrandFill ? ON_BRAND_FILL : C.muted;
  const base = {
    padding: "2px 8px",
    borderRadius: 4,
    border: `1px solid ${onBrandFill ? ON_BRAND_FILL : C.inputEdge}`,
    background: "transparent",
    color: ink,
    fontSize: TYPE.micro,
    fontWeight: FONT_WEIGHT.semibold,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1,
    whiteSpace: "nowrap" as const,
  };
  return (
    <span style={{ flex: "0 0 auto", display: "inline-flex", gap: 6 }}>
      <button
        type="button"
        data-testid={CONNECTION_ACCEPT_TESTID}
        disabled={busy}
        // NAMES THE PERSON. Two rows of "Accept" is two identical controls to anyone navigating by
        // button, and accepting the wrong stranger is not an undoable mistake.
        aria-label={`${ACCEPT_LABEL} — ${request.username}`}
        onClick={() => onDecide(request, true)}
        style={base}
      >
        {ACCEPT_LABEL}
      </button>
      <button
        type="button"
        data-testid={CONNECTION_DENY_TESTID}
        disabled={busy}
        aria-label={`${DENY_LABEL} — ${request.username}`}
        onClick={() => onDecide(request, false)}
        style={base}
      >
        {DENY_LABEL}
      </button>
    </span>
  );
}
