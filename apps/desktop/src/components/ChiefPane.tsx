import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiCheck, FiClock, FiLink, FiRefreshCw } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useSettingsStore, effectiveChiefPat, chiefLibraryOwner } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  useChiefSyncStore,
  chiefSyncFor,
  describeChiefSync,
  forgetChiefSync,
} from "../stores/chiefSyncStore";
import { clearChiefSyncBackoff } from "../stores/runtimeStore";
import { listProjects, type ChiefProject } from "../services/chief";
import { SECTION_LABEL } from "./labelTreatment";

// The "Chief" settings pane (sparkle-ojgvp).
//
// It answers two questions that the app previously could not answer at all, and they are different
// questions: IS IT SYNCING (and if not, why) and WHERE IS IT SYNCING TO.
//
// The second one earns its place as much as the first. `ensureChiefProject` links a Sparkle project
// to a Chief project by matching on NAME, silently, on first sync — so two Sparkle projects with
// different names produce two separate Chief libraries, each holding roughly half the docs, with
// nothing anywhere in the UI saying so. A Think agent asked a question against either one sees half
// the picture and cannot tell. Naming the destination per project is what makes that visible, and
// the re-link control is what makes it fixable without hand-editing localStorage.

/** Freshness of the last successful sync, in words. Null when nothing has completed yet. */
function agoLabel(lastSuccessAt: number | null, now: number): string | null {
  if (!lastSuccessAt) return null;
  const mins = Math.floor((now - lastSuccessAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

const PHASE_ICON = {
  unknown: FiClock,
  syncing: FiRefreshCw,
  ok: FiCheck,
  blocked: FiAlertTriangle,
} as const;

export function ChiefPane() {
  const projects = useProjectStore((s) => s.projects);
  const byProject = useChiefSyncStore((s) => s.byProject);
  const links = useSettingsStore((s) => s.chiefProjectByProject);
  const relink = useSettingsStore((s) => s.relinkChiefProject);
  const unlink = useSettingsStore((s) => s.unlinkChiefProject);
  const pat = useSettingsStore((s) =>
    effectiveChiefPat(s.keychainChiefPat, s.chiefPat, s.runtimeChiefPat),
  );

  const [available, setAvailable] = useState<ChiefProject[] | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // A ticker so "12 min ago" and a `syncing` spinner stay honest on a pane the user leaves open.
  // Without it the pane freezes at whatever it rendered on mount, which is exactly the kind of
  // quietly-stale readout this pane exists to replace.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const loadProjects = useCallback(async () => {
    if (!pat) return;
    setLoading(true);
    setLoadError("");
    try {
      setAvailable(await listProjects(pat));
    } catch (e) {
      // Leave `available` as it was: a failed refresh must not empty a list the user is choosing
      // from, and an empty dropdown would read as "you have no Chief projects".
      setLoadError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [pat]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of available ?? []) m.set(p.project_id, p.name);
    return m;
  }, [available]);

  if (!pat) {
    return (
      <div style={{ color: C.cream, fontSize: 13, lineHeight: 1.6 }}>
        <div style={SECTION_LABEL}>Chief</div>
        <p style={{ color: C.muted }}>
          No Chief API key is configured, so no project documents are being sent. Sparkle looks for
          one in the OS keychain, then in <code>CHIEF_API</code> in your <code>.env.local</code>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ color: C.cream, fontSize: 13, lineHeight: 1.6 }}>
      <div style={SECTION_LABEL}>Project documents sent to Chief</div>
      <p style={{ color: C.muted, marginTop: 0 }}>
        Sparkle keeps each project&rsquo;s <code>PRD/</code> and{" "}
        <code>docs/superpowers/specs/</code> markdown mirrored into a Chief library, so the Think
        agent reads what your agents have written. Each project links to one Chief project.
      </p>

      {loadError && (
        <div style={{ color: C.dangerInk, marginBottom: 8 }} role="status">
          Could not load your Chief projects: {loadError}{" "}
          <button type="button" onClick={() => void loadProjects()} style={linkButton}>
            Retry
          </button>
        </div>
      )}

      {projects.length === 0 && <p style={{ color: C.muted }}>No projects open.</p>}

      {projects.map((p) => {
        const rec = chiefSyncFor({ byProject }, p.id);
        const sentence = describeChiefSync(rec);
        const linked = links[p.id];
        const Icon = PHASE_ICON[rec.phase];
        const ago = agoLabel(rec.lastSuccessAt, now);
        const tone =
          rec.phase === "blocked" ? C.dangerInk : rec.phase === "ok" ? C.cream : C.muted;
        return (
          <div key={p.id} style={row} data-testid={`chief-project-${p.id}`}>
            <div style={{ fontWeight: FONT_WEIGHT.medium }}>{p.name}</div>

            <div style={{ display: "flex", alignItems: "center", gap: 6, color: tone }}>
              <Icon size={13} aria-hidden />
              <span data-testid={`chief-status-${p.id}`}>
                {sentence ?? "Not checked yet this session."}
              </span>
              {ago && rec.phase !== "blocked" && (
                <span style={{ color: C.muted }}>· last sync {ago}</span>
              )}
            </div>

            {/* Naming the destination is the point — a split library is invisible without it. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <FiLink size={12} aria-hidden style={{ color: C.muted }} />
              <label htmlFor={`chief-link-${p.id}`} style={{ color: C.muted }}>
                Chief library
              </label>
              <select
                id={`chief-link-${p.id}`}
                data-testid={`chief-link-${p.id}`}
                value={linked ?? ""}
                // Disabled ONLY while a request is in flight. It used to also disable on
                // `available === null`, which left the picker permanently dead exactly when the
                // listing had failed — the unreachable / bad-PAT case a user opens this pane to
                // fix. Unlinking, and re-selecting a known id, must stay possible on that path.
                disabled={loading}
                onChange={(e) => {
                  const next = e.target.value;
                  const before = useSettingsStore.getState().chiefProjectByProject[p.id];
                  if (next === "") unlink(p.id);
                  else relink(p.id, next);
                  // ONLY when the link actually moved. Both actions can refuse — relink rejects a
                  // library another project owns — and clearing on a refusal would erase a real
                  // `project_gone` record and replace it with an honest-looking zero-state that is
                  // false, which is strictly worse than the stale reason it was meant to fix.
                  const after = useSettingsStore.getState().chiefProjectByProject[p.id];
                  if (after === before) return;
                  // The old record describes a link that no longer exists, and a `project_gone`
                  // one parks the retry for an hour — so without both of these the pane would keep
                  // asserting the problem the user just fixed.
                  forgetChiefSync(p.id);
                  clearChiefSyncBackoff(p.id);
                }}
                style={select}
              >
                <option value="">(not linked — the next sync will pick one by name)</option>
                {/* A link absent from the listing still has to be selectable, or the control would
                    render as "not linked" and hide the state the user came to fix. But it is only
                    "no longer exists" when the listing SUCCEEDED and did not contain it — with a
                    failed listing `nameById` is empty, so labelling it that way would call every
                    healthy link deleted, which is both false and alarming. */}
                {linked && !nameById.has(linked) && (
                  <option value={linked}>
                    {available === null ? `${linked} (current link)` : `${linked} — no longer exists`}
                  </option>
                )}
                {(available ?? []).map((cp) => {
                  // A library another project already syncs into cannot be chosen: sharing one is
                  // mutually destructive under the current-state model (each project deletes the
                  // other's docs every round). Marked here so the store's refusal is never a
                  // silent no-op on an option the UI offered.
                  const owner = chiefLibraryOwner(links, cp.project_id, p.id);
                  const ownerName = owner
                    ? (projects.find((x) => x.id === owner)?.name ?? "another project")
                    : null;
                  return (
                    <option key={cp.project_id} value={cp.project_id} disabled={owner !== null}>
                      {cp.name}
                      {ownerName ? ` — already used by ${ownerName}` : ""}
                    </option>
                  );
                })}
              </select>
              {loading && <span style={{ color: C.muted }}>loading…</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const row: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: `1px solid ${C.hairline}`,
};

const select: React.CSSProperties = {
  background: C.inputSurface,
  color: C.cream,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "3px 6px",
  fontSize: 12,
  maxWidth: 320,
};

const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  color: C.accentInk,
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  font: "inherit",
};
