import { useState, useEffect, memo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT, ON_BRAND_FILL, DANGER } from "../theme/colors";
import {
  listMyTickets,
  bannerFromTickets,
  TICKET_CREATED_EVENT,
  type TicketStatus,
} from "../services/supportApi";
import { shouldPollTickets, ticketsSignature } from "./supportTicketPoll";
import { WEB_BASE_URL } from "../services/sparkleApi";

/** Red Feather `alert-circle`, inline (no emoji — house rule). Sized to the caller. */
function AlertCircleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      // `currentColor` IN THE ATTRIBUTE, THE TOKEN IN A CSS PROPERTY — never the token here.
      // `stroke` is an SVG PRESENTATION ATTRIBUTE, and `var()` is not substituted in those (WebKit,
      // which is what Tauri renders with on macOS, does not support it). Passing `stroke={DANGER}`
      // once DANGER became `var(--c-danger-ink)` made the attribute invalid, so it fell back to the
      // initial `none` and this icon rendered INVISIBLE — with the whole suite green, because
      // nothing measured attribute-vs-property usage (roborev 54231).
      //
      // Routing through `color` works because that IS a CSS property, where var() resolves, and
      // `currentColor` reads it back out. theme/svgTokens.test.ts now sweeps for the broken form.
      stroke="currentColor"
      style={{ color: DANGER }}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/** Open a ticket's web thread in the system browser — same `/support/t/[token]` link + opener
 *  hand-off SupportModal uses for "View your ticket". */
function openTicketThread(token: string) {
  openUrl(`${WEB_BASE_URL}/support/t/${token}`).catch((err) =>
    console.error("Failed to open support ticket:", err),
  );
}

/** Pinned status banner for the signed-in user's OPEN support tickets, shown between the "Improve
 *  Sparkle" row and the footer StatusBar. Renders nothing when there are no open tickets. Polls
 *  every 60s while the window is visible — a hidden window skips the tick and catches up on
 *  `visibilitychange`, so a backgrounded app doesn't fetch once a minute for hours nobody sees.
 *  Also refetches on window focus and when a ticket is created (via TICKET_CREATED_EVENT). An
 *  unchanged poll result is dropped rather than re-set, so the memo'd row doesn't re-render every
 *  minute for identical tickets (see supportTicketPoll). One open ticket → click opens its thread;
 *  many → click toggles an
 *  expanded per-ticket list directly beneath the banner. `memo`'d (no props) so unrelated sidebar
 *  re-renders don't churn it. *
 *  ── THIS IS THE ONE SUPPORT SLOT IN THE BUILDER COLUMN ────────────────────────────────────────
 *  Social Coding gives the Sparkle Support Agent a seat in the social graph (design §7): a
 *  `kind: "support"` conversation, seeded on the user's first username claim. **That is not a
 *  second row and must never become one** — open question 15 is explicit that this row and a
 *  Support Agent chat row "must be one thing, not two shipped side by side".
 *
 *  The mechanism that holds it is in `services/socialApi.ts`: `getConversations()` returns a
 *  PARTITION, so the support thread is never in a list a chat row can be built from. Do not
 *  reach around it, and do not add a support row anywhere else in the sidebar.
 *
 *  The migration path, when the agent can actually answer: this component renders
 *  `partition.support` instead of `listMyTickets()`, in this same slot, with the same click
 *  target. See PRD/social-coding-support-agent-seam.md. */
export const SupportTicketRow = memo(function SupportTicketRow() {
  const [tickets, setTickets] = useState<TicketStatus[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    // Last signature we applied. Kept in a ref-like closure rather than state so comparing it
    // never itself triggers the render it exists to avoid.
    let lastSig = ticketsSignature([]);
    const refetch = () => {
      listMyTickets()
        .then((t) => {
          if (!alive) return;
          const sig = ticketsSignature(t);
          if (sig === lastSig) return; // same tickets as last poll — don't churn the memo'd row
          lastSig = sig;
          setTickets(t);
        })
        .catch(() => {
          // Signed-out / offline / transient — leave the last-known list; the banner just hides
          // when there are no open tickets. Not worth surfacing an error in the sidebar chrome.
        });
    };
    // A hidden window gets no scheduled polls; onVisible catches it up on the way back. The
    // event-driven paths (focus, ticket-created) always fetch — they only fire when someone is
    // actually here, and a just-created ticket should appear without waiting for the next tick.
    const onTick = () => {
      if (shouldPollTickets()) refetch();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    refetch();
    const timer = window.setInterval(onTick, 60_000);
    window.addEventListener("focus", refetch);
    window.addEventListener(TICKET_CREATED_EVENT, refetch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refetch);
      window.removeEventListener(TICKET_CREATED_EVENT, refetch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const banner = bannerFromTickets(tickets);
  if (!banner) return null;
  const { label, alert, openTickets } = banner;
  const multiple = openTickets.length > 1;

  const onBannerClick = () => {
    if (multiple) {
      setExpanded((e) => !e);
    } else {
      openTicketThread(openTickets[0]!.token);
    }
  };

  return (
    <div style={{ flex: "0 0 auto", margin: "0 8px 6px" }}>
      {/* The blue status banner. Mirrors SparkleAgentRow's inline-styled pill idiom. */}
      <div
        onClick={onBannerClick}
        title={
          multiple
            ? `${openTickets.length} open support tickets — click to ${expanded ? "hide" : "show"}`
            : "View your support ticket"
        }
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: expanded ? "6px 6px 0 0" : 6,
          cursor: "pointer",
          background: C.teal,
          color: ON_BRAND_FILL,
          fontSize: 13,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Ticket: {label}
        </span>
        {multiple && (
          <span style={{ flex: "0 0 auto", fontSize: 12, opacity: 0.85 }}>{openTickets.length}</span>
        )}
        {alert && (
          // Top-right corner alert marker (support replied, waiting on the user). A white halo keeps
          // the red glyph legible against the blue fill.
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              display: "inline-flex",
              borderRadius: "50%",
              background: ON_BRAND_FILL,
              padding: 1,
            }}
          >
            <AlertCircleIcon size={15} />
          </span>
        )}
      </div>

      {/* Expanded per-ticket list, directly beneath the banner (only when >1 open ticket). */}
      {multiple && expanded && (
        <div
          style={{
            border: `1px solid ${C.teal}`,
            borderTop: "none",
            borderRadius: "0 0 6px 6px",
            overflow: "hidden",
          }}
        >
          {openTickets.map((t, i) => {
            const rowAlert = t.status === "awaiting_user";
            return (
              <div
                key={t.id}
                onClick={() => openTicketThread(t.token)}
                title={t.subject}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  cursor: "pointer",
                  background: C.deepForest,
                  // A row separator, not a seam: one near-black plane ruled onto another is the
                  // exact "plane used as a divider" defect `hairline` exists to remove (1.08:1).
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
                    fontSize: 12,
                    color: C.cream,
                  }}
                >
                  {t.subject}
                </span>
                {rowAlert ? (
                  <span style={{ flex: "0 0 auto", display: "inline-flex" }}>
                    <AlertCircleIcon size={13} />
                  </span>
                ) : (
                  <span
                    style={{
                      flex: "0 0 auto",
                      fontSize: 10,
                      fontWeight: FONT_WEIGHT.semibold,
                      color: C.muted,
                      letterSpacing: 0.2,
                    }}
                  >
                    Submitted
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
