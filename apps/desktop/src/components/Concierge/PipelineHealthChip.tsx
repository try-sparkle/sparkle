// The concierge header's deployment-pipeline health icon — the founder's ask, beside the merge
// chiclet (bead sparkle-m6jov5).
//
// THE BUG IT EXISTS FOR: a pipeline component can fail with NO surface. The seed case was the
// roborev review daemon wedging (process alive, holding the port, but `roborev status` saying "not
// running"), so code review silently stopped for ~1h36m and PRs merged unreviewed. It was found by
// accident. This icon makes such an outage visible: green check = all pipeline infra healthy, amber
// triangle = a non-blocking issue (review stopped, runners saturated, or a probe we could not read),
// red exclamation = a deployment IS blocked (no CI runner can test, or the release runner is offline
// so no DMG can build). Click it for the per-component breakdown.
//
// Like WindowSpanButton next door, this is a self-contained, store-reading icon — the presentational
// `Concierge/` directory stays free of its wiring. The pure indicator is split out so the render is
// tested with health payloads directly, without a live probe or the project store.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiActivity, FiAlertCircle, FiAlertTriangle, FiCheckCircle } from "react-icons/fi";

import { C, FONT_WEIGHT } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { SECTION_LABEL } from "../labelTreatment";
import { ModalLayer } from "../ModalLayer";
import { useProjectStore } from "../../stores/projectStore";
import {
  type ComponentHealth,
  type HealthState,
  type HealthTone,
  type PipelineHealth,
  setPipelineRoot,
  toneForState,
  usePipelineHealthStore,
} from "../../stores/pipelineHealthStore";

/** The paint + glyph for a tone. Fill for dots/borders, ink for the glyph and text (the ink twins
 *  pass WCAG AA on both planes; the plain fills do not as small marks). */
function tonePaint(tone: HealthTone): { fill: string; ink: string; Icon: typeof FiActivity } {
  switch (tone) {
    case "green":
      return { fill: C.success, ink: C.successInk, Icon: FiCheckCircle };
    case "amber":
      return { fill: C.amber, ink: C.amberInk, Icon: FiAlertTriangle };
    case "red":
      return { fill: C.sienna, ink: C.dangerInk, Icon: FiAlertCircle };
    case "muted":
      return { fill: C.muted, ink: C.muted, Icon: FiActivity };
  }
}

/** A one-word label for a component state, for the panel row and the aria summary. */
function stateLabel(state: HealthState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "blocking":
      return "Blocking";
    case "unknown":
      return "Unknown";
    case "not_applicable":
      return "Off";
  }
}

/** A short summary for the button's title/aria, so the state is legible without opening the panel. */
function overallSummary(health: PipelineHealth | null): string {
  if (health === null) return "Pipeline health: checking…";
  switch (health.overall) {
    case "healthy":
      return "Pipeline health: all systems healthy";
    case "warning":
      return "Pipeline health: a non-blocking issue needs attention";
    case "unknown":
      return "Pipeline health: could not read one or more components";
    case "blocking":
      return "Pipeline health: a deployment is BLOCKED";
    case "not_applicable":
      return "Pipeline health: nothing to monitor";
  }
}

/** One component row in the panel. */
function ComponentRow({ component }: { component: ComponentHealth }) {
  const paint = tonePaint(toneForState(component.state));
  return (
    <div
      data-testid={`pipeline-health-row-${component.id}`}
      data-state={component.state}
      style={{ display: "flex", gap: 8, padding: "8px 4px", alignItems: "flex-start" }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: paint.fill,
          marginTop: 5,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <span style={{ fontWeight: FONT_WEIGHT.bold, fontSize: 12, color: C.cream }}>
            {component.name}
          </span>
          <span style={{ fontSize: 10, color: paint.ink, fontWeight: FONT_WEIGHT.bold }}>
            {stateLabel(component.state)}
          </span>
        </div>
        <div style={{ fontSize: TYPE.small, color: C.muted, lineHeight: 1.35, marginTop: 2 }}>
          {component.detail}
        </div>
      </div>
    </div>
  );
}

/**
 * The pure indicator: an icon button coloured by `health.overall`, plus a click-through panel
 * listing every component. Takes the health payload as a prop so tests drive it directly.
 */
export function PipelineHealthIndicator({ health }: { health: PipelineHealth | null }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);

  // Measure the trigger when the panel opens, and right-hang the panel under it, clamped to the
  // window's left edge. Fixed coords because the panel is portaled to document.body.
  useLayoutEffect(() => {
    if (!open || anchorRef.current === null) {
      setPlacement(null);
      return;
    }
    const r = anchorRef.current.getBoundingClientRect();
    const width = 320;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setPlacement({ top: r.bottom + 6, left });
  }, [open]);

  const tone = toneForState(health?.overall ?? "not_applicable");
  const paint = tonePaint(health === null ? "muted" : tone);
  const summary = overallSummary(health);

  return (
    <div style={{ position: "static", flex: "0 0 auto" }}>
      <button
        ref={anchorRef}
        type="button"
        data-testid="pipeline-health-chip"
        data-tone={health === null ? "muted" : tone}
        data-overall={health?.overall ?? "checking"}
        aria-label={summary}
        title={summary}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 19,
          width: 19,
          padding: 0,
          border: "none",
          background: "transparent",
          color: paint.ink,
          cursor: "pointer",
        }}
      >
        <paint.Icon size={13} aria-hidden />
      </button>

      {open && placement !== null && (
        <ModalLayer>
          {/* click-away backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            data-testid="pipeline-health-panel"
            style={{
              position: "fixed",
              top: placement.top,
              left: placement.left,
              width: 320,
              maxHeight: "min(420px, calc(100vh - 80px))",
              overflowY: "auto",
              zIndex: 41,
              background: C.deepForest,
              border: `1px solid ${C.hairline}`,
              borderRadius: 6,
              boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
              padding: "10px 12px",
            }}
          >
            {/* The panel's section label — the spec's `.grp` treatment (mono, uppercase, tracked
                0.1em, micro, faint). Spread SECTION_LABEL rather than hand-typing the tracking, so
                this can't drift from the shared mark (see components/labelTreatment.test.ts). */}
            <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>Deployment pipeline</div>
            {health === null || health.components.length === 0 ? (
              <div style={{ fontSize: TYPE.small, color: C.muted, padding: "6px 4px" }}>
                {health === null ? "Checking pipeline health…" : "Nothing to monitor."}
              </div>
            ) : (
              health.components.map((c) => <ComponentRow key={c.id} component={c} />)
            )}
          </div>
        </ModalLayer>
      )}
    </div>
  );
}

/**
 * The container: points the poller at the selected project's root and renders the indicator from the
 * store. Icon-only and always present (until no project is open), like WindowSpanButton beside it.
 */
export function PipelineHealthChip() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const health = usePipelineHealthStore((s) => s.health);

  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0];
  const root = selected?.rootPath ?? null;

  useEffect(() => {
    setPipelineRoot(root);
  }, [root]);

  // No project open → no pipeline to report on → render nothing, so the header stays calm.
  if (root === null) return null;
  return <PipelineHealthIndicator health={health} />;
}
