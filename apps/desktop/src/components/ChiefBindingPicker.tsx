import { useCallback, useEffect, useMemo, useState } from "react";
import { FiCheckSquare, FiSquare, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import type { ChiefProject } from "../services/chiefScope";
import { useProjectStore } from "../stores/projectStore";

// THE CHIEF BINDING PICKER — which Chief projects the agents in THIS Sparkle project may reach
// (bead `sparkle-8rr0c`).
//
// WHY THE SHAPE IS WHAT IT IS:
//
// * MANY, NOT ONE. The founder's call is that a Sparkle project binds to as many Chief projects as
//   the work needs; a strict 1:1 is just the case where the set holds one id. So this is a
//   multi-select, and the store field is an array.
//
// * EXACTLY ONE PRIMARY, LABELLED IN THE TERMS IT IS USED IN. The primary is what an agent gets
//   when it names NO project — that is the whole of its meaning, and calling it a "default" invites
//   the reading that it is a fallback for a lookup that missed, which is the exact behaviour
//   `chiefScope.ts` exists to refuse. The control says so in words.
//
// * A FILTER IS NOT A NICETY. The token reaches 348 projects. An unfiltered list of 348 opaque ids
//   is not a picker, it is a wall — so the list is filtered and capped, with the count of what is
//   hidden stated rather than silently truncated.
//
// * NAME + DESCRIPTION LEAD, `project_id` TRAILS. Nobody recognises a project by `project_id`; it
//   is carried because it is what a refusal message quotes back, not because it identifies anything
//   to a human.
//
// * THE LIST ARRIVES THROUGH AN INJECTED LOADER, never a module singleton — same reasoning as the
//   `ChiefClient` seam in `services/chiefScope.ts`. A defaulted-at-the-call-site seam is the shape
//   that leaves the production path untested by construction (bead `sparkle-lgbwf`), so the loader
//   is a required prop and the mount site supplies it.
//
// * THE PAT IS NEVER HERE. It lives in the OS keychain, the loader closes over it at the mount
//   site, and nothing in this component renders, logs, accepts or can reach it.

/** How many candidate rows render before the list asks the human to narrow it. */
export const CHIEF_PICKER_VISIBLE_CAP = 40;

/** Case-insensitive substring match across the three fields a human might type. */
function matches(p: ChiefProject, needle: string): boolean {
  if (!needle) return true;
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return (
    p.name.toLowerCase().includes(n) ||
    (p.description ?? "").toLowerCase().includes(n) ||
    p.project_id.toLowerCase().includes(n)
  );
}

const chip: React.CSSProperties = {
  fontSize: 10,
  fontWeight: FONT_WEIGHT.semibold,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  borderRadius: RADIUS.sm,
  padding: "2px 6px",
  whiteSpace: "nowrap",
};

const NO_IDS: readonly string[] = [];

export function ChiefBindingPicker({
  projectId,
  loadChiefProjects,
}: {
  /** The SPARKLE project being bound. Taken as an id, not as a `Project` object, so the binding is
   *  read live from the store — a snapshot passed down by a parent that doesn't itself subscribe
   *  would leave this control rendering the pre-click state after every click, which is the shape
   *  that reads as "the checkbox doesn't work". */
  projectId: string;
  /** Fetch every Chief project the configured token can reach. Injected so this renders — and is
   *  tested — without a network or a token. Rejecting is a first-class outcome: the error state
   *  below exists precisely so a failed fetch cannot be mistaken for "no projects exist". */
  loadChiefProjects: () => Promise<ChiefProject[]>;
}) {
  const setChiefBinding = useProjectStore((s) => s.setChiefBinding);
  const bound =
    useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.chiefProjectIds) ?? NO_IDS;
  const primary =
    useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.chiefPrimaryId) ?? null;

  const [catalog, setCatalog] = useState<ChiefProject[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setCatalog(await loadChiefProjects());
    } catch (e) {
      // `catalog` is deliberately left as it was. A failed REFRESH must not empty a list the human
      // is mid-choice in, and an emptied list would render as the "no projects" state — the exact
      // confusion the two distinct states below exist to prevent.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadChiefProjects]);

  useEffect(() => {
    void load();
  }, [load]);

  const byId = useMemo(() => {
    const m = new Map<string, ChiefProject>();
    for (const p of catalog ?? []) m.set(p.project_id, p);
    return m;
  }, [catalog]);

  const filtered = useMemo(
    () => (catalog ?? []).filter((p) => matches(p, filter)),
    [catalog, filter],
  );
  const visible = filtered.slice(0, CHIEF_PICKER_VISIBLE_CAP);
  const hidden = filtered.length - visible.length;

  const toggle = (id: string) => {
    if (bound.includes(id)) {
      const next = bound.filter((x) => x !== id);
      // Un-checking the CURRENT primary clears it rather than promoting a neighbour. Promoting one
      // would silently change which project an unnamed call reads — the one thing this feature is
      // built to never do. `null` costs the agent a question; a wrong promotion costs a wrong
      // answer against live client work.
      setChiefBinding(projectId, {
        chiefProjectIds: next,
        chiefPrimaryId: primary === id ? null : primary,
      });
    } else {
      const next = [...bound, id];
      // Binding the FIRST project makes it primary: a lone bound project with no primary is a
      // binding that still refuses every unnamed call, which reads as the control not working.
      setChiefBinding(projectId, {
        chiefProjectIds: next,
        chiefPrimaryId: primary ?? id,
      });
    }
  };

  const makePrimary = (id: string) => {
    // Marking an unbound project primary binds it too — the store would otherwise correct the
    // primary straight back to null, and a control that quietly does nothing is worse than absent.
    const next = bound.includes(id) ? [...bound] : [...bound, id];
    setChiefBinding(projectId, { chiefProjectIds: next, chiefPrimaryId: id });
  };

  const unbindAll = () =>
    setChiefBinding(projectId, { chiefProjectIds: [], chiefPrimaryId: null });

  return (
    <div data-testid="chief-binding" style={{ marginBottom: 18 }}>
      <div style={{ ...SECTION_LABEL, marginBottom: 6 }}>Chief projects</div>

      {/* ── THE CURRENT BINDING ─────────────────────────────────────────────────────────────────
          Stated in full and independently of the filter/cap below: the answer to "what can my
          agents reach right now" must never depend on what happens to be scrolled into view. */}
      {bound.length === 0 ? (
        <div
          data-testid="chief-binding-unbound"
          style={{ color: C.muted, fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}
        >
          Not bound. Agents in this project are <strong style={{ color: C.cream }}>refused</strong>{" "}
          every Chief call until you bind at least one project here. (The concierge still reaches
          everything — this scopes build agents only.)
        </div>
      ) : (
        <div data-testid="chief-binding-current" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {bound.map((id) => {
              const p = byId.get(id);
              const isPrimary = id === primary;
              return (
                <span
                  key={id}
                  data-testid={`chief-binding-chip-${id}`}
                  title={id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: C.forest,
                    border: `1px solid ${isPrimary ? C.teal : C.muted}`,
                    borderRadius: RADIUS.input,
                    padding: "4px 8px",
                    fontSize: 12,
                    color: C.cream,
                  }}
                >
                  {p?.name ?? id}
                  {isPrimary && (
                    <span style={{ ...chip, background: C.teal, color: C.forest }}>Primary</span>
                  )}
                  <button
                    data-testid={`chief-binding-remove-${id}`}
                    aria-label={`Unbind ${p?.name ?? id}`}
                    onClick={() => toggle(id)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      background: "transparent",
                      border: "none",
                      color: C.muted,
                      cursor: "pointer",
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    <FiX size={12} aria-hidden />
                  </button>
                </span>
              );
            })}
          </div>
          <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>
            {primary ? (
              <>
                An agent that names no project gets{" "}
                <span style={{ color: C.cream }}>{byId.get(primary)?.name ?? primary}</span>.
              </>
            ) : (
              <span style={{ color: C.sienna }}>
                No primary set — an agent that names no project is refused and told to ask. Mark one
                below.
              </span>
            )}
            {"  "}
            <button
              data-testid="chief-binding-unbind-all"
              onClick={unbindAll}
              style={{
                background: "transparent",
                border: "none",
                color: C.accentInk,
                cursor: "pointer",
                fontSize: 12,
                padding: 0,
                textDecoration: "underline",
              }}
            >
              Unbind all
            </button>
          </div>
        </div>
      )}

      {/* ── THE PICKER ──────────────────────────────────────────────────────────────────────── */}
      <input
        data-testid="chief-binding-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter Chief projects…"
        aria-label="Filter Chief projects"
        style={{
          width: "100%",
          background: C.forest,
          color: C.cream,
          border: `1px solid ${C.muted}`,
          borderRadius: RADIUS.input,
          padding: "7px 10px",
          fontSize: 13,
          outline: "none",
          boxSizing: "border-box",
          marginBottom: 8,
        }}
      />

      {/* THREE DISTINCT STATES, and keeping them distinct is the requirement. "The fetch failed"
          and "this token reaches no projects" are opposite facts that a single empty list would
          render identically — and the second one is a lie that reads as a finished answer. */}
      {loadError ? (
        <div
          data-testid="chief-binding-error"
          style={{ color: C.sienna, fontSize: 12, lineHeight: 1.5 }}
        >
          Couldn’t load Chief projects: {loadError}
          <br />
          <span style={{ color: C.muted }}>
            This is a failed request, not an empty account — your existing binding above is
            untouched.
          </span>{" "}
          <button
            data-testid="chief-binding-retry"
            onClick={() => void load()}
            style={{
              background: "transparent",
              border: "none",
              color: C.accentInk,
              cursor: "pointer",
              fontSize: 12,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div data-testid="chief-binding-loading" style={{ color: C.muted, fontSize: 12 }}>
          Loading Chief projects…
        </div>
      ) : filtered.length === 0 ? (
        <div data-testid="chief-binding-empty" style={{ color: C.muted, fontSize: 12 }}>
          {(catalog ?? []).length === 0
            ? "This Chief token reaches no projects."
            : `No project matches “${filter}”.`}
        </div>
      ) : (
        <>
          <div
            data-testid="chief-binding-list"
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: `1px solid ${C.dialogEdge}`,
              borderRadius: RADIUS.input,
            }}
          >
            {visible.map((p) => {
              const isBound = bound.includes(p.project_id);
              const isPrimary = p.project_id === primary;
              return (
                <div
                  key={p.project_id}
                  data-testid={`chief-binding-row-${p.project_id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 9px",
                    borderBottom: `1px solid ${C.dialogEdge}`,
                  }}
                >
                  <button
                    role="checkbox"
                    aria-checked={isBound}
                    data-testid={`chief-binding-toggle-${p.project_id}`}
                    onClick={() => toggle(p.project_id)}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: C.cream,
                      cursor: "pointer",
                      padding: 0,
                      font: "inherit",
                    }}
                  >
                    <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        aria-hidden
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          color: isBound ? C.teal : C.muted,
                        }}
                      >
                        {isBound ? <FiCheckSquare size={13} /> : <FiSquare size={13} />}
                      </span>
                      {p.name}
                      {p.default && (
                        <span style={{ ...chip, background: C.forest, color: C.muted }}>
                          Chief default
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <div
                        style={{
                          fontSize: 12,
                          color: C.muted,
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.description}
                      </div>
                    )}
                    {/* The opaque id, last and quiet — it identifies nothing to a human, but it is
                        what a scope refusal quotes back, so it has to be findable. */}
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 2, opacity: 0.75 }}>
                      {p.project_id}
                    </div>
                  </button>
                  <button
                    data-testid={`chief-binding-primary-${p.project_id}`}
                    aria-pressed={isPrimary}
                    title="An agent that names no project gets this one"
                    onClick={() => makePrimary(p.project_id)}
                    disabled={isPrimary}
                    style={{
                      ...chip,
                      background: isPrimary ? C.teal : "transparent",
                      color: isPrimary ? C.forest : C.accentInk,
                      border: `1px solid ${isPrimary ? C.teal : C.muted}`,
                      cursor: isPrimary ? "default" : "pointer",
                    }}
                  >
                    {isPrimary ? "Primary" : "Make primary"}
                  </button>
                </div>
              );
            })}
          </div>
          {hidden > 0 && (
            <div data-testid="chief-binding-overflow" style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
              Showing {visible.length} of {filtered.length} — type to narrow the list.
            </div>
          )}
        </>
      )}
    </div>
  );
}
