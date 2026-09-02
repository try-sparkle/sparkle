// WhatsNewPanel — the in-app "What's New", the answer to "I just restarted onto a new build, what's
// different?" without leaving the app.
//
// TWO ENTRY POINTS, one panel:
//   1. AUTO, once per new version. When the app relaunches onto a version newer than the last one
//      we showed, the panel opens unprompted and dismissible. `lastSeenChangelogVersion` is advanced
//      the moment it opens, so a dismissal is final for that release.
//   2. ON DEMAND, always. The StatusStrip's existing "Changelog" link routes through the shared
//      `openChangelog` helper, which now opens this instead of the browser.
//
// WHAT IT LEADS WITH. The running release sits at the top; earlier releases scroll below it. When
// the user skipped versions (was on v0.99.0, is now on v0.102.0) the top section holds EVERY release
// in that gap — "what changed since the version I was on", not "what's in the newest release". The
// partition itself lives in services/changelogService (`partitionEntries`) so it is pinned by tests
// without rendering anything.
//
// IT NEVER SHOWS AN ERROR WALL. Offline, or with the endpoint unreachable, it renders the last
// successful fetch with a quiet "may be out of date" note. A slightly stale What's New beats a
// panel that fails closed — see `loadChangelog`.
//
// NO NEW CHROME. The dialog is `ModalShell` — the app's one dialog card — so the scrim, the dialog
// plane, the modal radius/shadow, the portal out of every stacking context, and Escape/backdrop
// dismissal are all inherited rather than re-typed. Type, radius, spacing and the section labels
// come from theme/scale + labelTreatment for the same reason.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FiChevronDown, FiChevronRight, FiExternalLink, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI, LINE_READ, RADIUS, SPACE, TYPE, WEIGHT } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import { getDateTimeFormat } from "../services/intlFormatCache";
import { ModalShell } from "./ModalShell";
import { log } from "../logger";
import { useSettingsStore } from "../stores/settingsStore";
import { useWhatsNewStore } from "../stores/whatsNewStore";
import { openChangelogInBrowser, useAppInfo } from "./appChrome";
import {
  autoOpenDecision,
  displayVersion,
  loadChangelog,
  partitionEntries,
  type ChangelogEntry,
  type ChangelogSnapshot,
} from "../services/changelogService";

const SCOPE = "whatsnew";

/** Wide enough for a release summary to read as prose rather than a column of two-word lines. */
const PANEL_WIDTH = 620;

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  paddingBottom: SPACE.md,
  borderBottom: `1px solid ${C.barSurface}`,
};

const sectionLabel: CSSProperties = {
  ...SECTION_LABEL,
  margin: `${SPACE.xl}px 0 ${SPACE.sm}px`,
};

const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  padding: 4,
  borderRadius: RADIUS.sm,
  color: C.muted,
  cursor: "pointer",
};

const quietNote: CSSProperties = {
  marginTop: SPACE.md,
  fontSize: TYPE.small,
  color: C.muted,
};

/** Human date, or "" when the wire sent nothing parseable (never render "Invalid Date"). */
function formatShippedAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return getDateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(t));
}

const CHANGE_TYPE_LABEL: Record<ChangelogEntry["changeType"], string> = {
  feature: "New",
  enhancement: "Improved",
  bug_fix: "Fixed",
};

/**
 * One release: version + date + title + summary always visible (so it reads in about five seconds),
 * bullets and links behind a disclosure (so the interesting one can be opened).
 */
function ReleaseRow({
  entry,
  initialExpanded,
}: {
  entry: ChangelogEntry;
  initialExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const hasDetail = entry.bullets.length > 0 || entry.links.length > 0;
  const date = formatShippedAt(entry.shippedAt);
  const Chevron = expanded ? FiChevronDown : FiChevronRight;

  return (
    <div
      data-testid="whats-new-entry"
      data-version={entry.releaseVersion ?? ""}
      style={{
        padding: `${SPACE.md}px 0`,
        borderTop: `1px solid ${C.barSurface}`,
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        // aria-disabled rather than disabled: a release with no bullets is still a focusable row,
        // it just has nothing to open.
        aria-disabled={!hasDetail}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: SPACE.sm,
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: 0,
          color: C.cream,
          fontFamily: FONT_UI,
          cursor: hasDetail ? "pointer" : "default",
        }}
      >
        <Chevron
          aria-hidden
          size={14}
          style={{ marginTop: 3, flex: "0 0 auto", opacity: hasDetail ? 1 : 0.25 }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: SPACE.sm, flexWrap: "wrap" }}>
            <span style={{ fontSize: TYPE.small, color: C.accentInk, fontWeight: WEIGHT.bold }}>
              {displayVersion(entry.releaseVersion)}
            </span>
            <span style={{ ...SECTION_LABEL }}>{CHANGE_TYPE_LABEL[entry.changeType]}</span>
            {date && <span style={{ fontSize: TYPE.small, color: C.muted }}>{date}</span>}
          </span>
          <span
            style={{
              display: "block",
              marginTop: 2,
              fontSize: TYPE.body,
              fontWeight: WEIGHT.bold,
            }}
          >
            {entry.title}
          </span>
          {entry.summary && (
            <span
              style={{ display: "block", marginTop: 3, fontSize: TYPE.body, color: C.muted }}
            >
              {entry.summary}
            </span>
          )}
        </span>
      </button>
      {expanded && hasDetail && (
        <div style={{ margin: `${SPACE.sm}px 0 0 22px` }}>
          {entry.bullets.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: TYPE.body, lineHeight: LINE_READ }}>
              {entry.bullets.map((b, i) => (
                <li key={`${entry.id}-b${i}`}>{b}</li>
              ))}
            </ul>
          )}
          {entry.links.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.nav, marginTop: SPACE.sm }}>
              {entry.links.map((l) => (
                <a
                  key={`${entry.id}-${l.href}`}
                  href={l.href}
                  // Same rule as the StatusStrip's Changelog anchor: a real href for the accessible
                  // name, but the webview must never navigate away from the app.
                  onClick={(e) => {
                    e.preventDefault();
                    openChangelogInBrowser(SCOPE);
                  }}
                  style={{ fontSize: TYPE.small, color: C.accentInk }}
                >
                  {l.label}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WhatsNewPanel() {
  const open = useWhatsNewStore((s) => s.open);
  const openWhatsNew = useWhatsNewStore((s) => s.openWhatsNew);
  const closeWhatsNew = useWhatsNewStore((s) => s.closeWhatsNew);
  const setLastSeen = useSettingsStore((s) => s.setLastSeenChangelogVersion);
  const { version } = useAppInfo();

  // The last-seen version AS OF MOUNT. Opening the panel ADVANCES the stored value (that is what
  // makes auto-open fire once per release and never again after a dismissal), and re-partitioning
  // against the advanced value would immediately collapse the "new for you" section to nothing. So
  // the sections are computed against the version the user actually came from.
  const sinceRef = useRef(useSettingsStore.getState().lastSeenChangelogVersion);

  const [snapshot, setSnapshot] = useState<ChangelogSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // --- Entry point 1: the post-update moment -------------------------------------------------
  // Reads the stored version through getState() rather than a subscription on purpose: this effect
  // WRITES that value, so subscribing would re-run it against its own write.
  useEffect(() => {
    if (!version) return; // useAppInfo reports "" until Rust answers
    const decision = autoOpenDecision(version, useSettingsStore.getState().lastSeenChangelogVersion);
    if (decision === "none") return;
    if (decision === "open") {
      log.info(SCOPE, `showing what's new for ${version} (was ${sinceRef.current ?? "unknown"})`);
      openWhatsNew();
    }
    // "seed" and "open" both record the running version. Seeding is the FIRST-RUN RULE: with no
    // stored value we cannot know what they came from, so we record where they are and show only
    // this release rather than dumping the whole backlog at someone who just installed.
    setLastSeen(version);
  }, [version, openWhatsNew, setLastSeen]);

  // Fetch lazily — only once the panel is actually opened, so a launch that never shows it costs
  // no network at all.
  useEffect(() => {
    if (!open || snapshot || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    void loadChangelog().then((s) => {
      loadingRef.current = false;
      if (!mountedRef.current) return;
      setSnapshot(s);
      setLoading(false);
    });
  }, [open, snapshot]);

  // Escape and backdrop-click come from ModalShell (below) — no private copy of either here.
  const sections = useMemo(
    () => partitionEntries(snapshot?.entries ?? [], version, sinceRef.current),
    [snapshot, version],
  );

  if (!open) return null;

  const caughtUp = Boolean(sinceRef.current) && sections.highlighted.length > 0;
  const newHeading = caughtUp
    ? `New since ${displayVersion(sinceRef.current)}`
    : `What's new in ${displayVersion(version)}`;
  const outOfDate = Boolean(snapshot && (snapshot.stale || snapshot.degraded));

  return (
    // ModalShell, not a hand-rolled overlay: it carries the themed SCRIM, the dialog plane, the
    // modal radius and shadow, the portal out of every stacking context, backdrop-click and Escape.
    // A tenth private copy of that chrome is exactly what modalChrome.test.ts exists to stop — and
    // the scrim is the sharpest case, since a hand-typed `rgba(0,0,0,…)` washes light mode in
    // half-black.
    <ModalShell width={PANEL_WIDTH} onCancel={closeWhatsNew}>
      <div data-testid="whats-new-panel" role="dialog" aria-modal="true" aria-label="What's New">
        <div style={header}>
          <span style={{ flex: 1, minWidth: 0, fontSize: TYPE.title, fontWeight: WEIGHT.bold }}>
            What&rsquo;s New
          </span>
          <span style={{ fontSize: TYPE.small, color: C.muted }}>{displayVersion(version)}</span>
          <button type="button" aria-label="Close" onClick={closeWhatsNew} style={iconBtn}>
            <FiX aria-hidden size={16} />
          </button>
        </div>

        {outOfDate && (
          <div data-testid="whats-new-stale-note" style={quietNote}>
            Showing the last copy we downloaded — this may be out of date.
          </div>
        )}

        {loading && !snapshot && <div style={quietNote}>Loading…</div>}

        {snapshot && sections.highlighted.length === 0 && sections.history.length === 0 && (
          // Not an error wall: a plain statement plus the one thing that might still help.
          <div style={quietNote}>
            <div>No release notes to show yet.</div>
            <button
              type="button"
              onClick={() => openChangelogInBrowser(SCOPE)}
              style={{
                marginTop: SPACE.nav,
                display: "inline-flex",
                alignItems: "center",
                gap: SPACE.xs,
                background: C.teal,
                color: ON_BRAND_FILL,
                border: "none",
                // RADIUS.input, never the modal step — an inner control must not echo the card.
                borderRadius: RADIUS.input,
                padding: `5px ${SPACE.md}px`,
                fontSize: TYPE.small,
                fontFamily: FONT_UI,
                fontWeight: WEIGHT.bold,
                cursor: "pointer",
              }}
            >
              <FiExternalLink aria-hidden size={13} />
              View online
            </button>
          </div>
        )}

        {sections.highlighted.length > 0 && (
          <section data-testid="whats-new-current">
            <h2 style={sectionLabel}>{newHeading}</h2>
            {sections.highlighted.map((e) => (
              // The releases the user has NOT seen open expanded — this is the part they came for.
              <ReleaseRow key={e.id} entry={e} initialExpanded />
            ))}
          </section>
        )}

        {sections.history.length > 0 && (
          <section data-testid="whats-new-history">
            <h2 style={sectionLabel}>Earlier releases</h2>
            {sections.history.map((e) => (
              <ReleaseRow key={e.id} entry={e} initialExpanded={false} />
            ))}
          </section>
        )}
      </div>
    </ModalShell>
  );
}
