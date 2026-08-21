import { useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiCheckCircle, FiFilm, FiFolder, FiImage, FiTrash2 } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { PUBLISH_AFFORDANCES, type DestinationCapabilities, type PublishAffordance } from "../services/publishCapabilities";

// The configure pane's card for ONE publish destination (bead `sparkle-131ms.5`).
//
// Its whole job is to make the capability probe's answer LEGIBLE, and the two halves of that are
// asymmetric on purpose:
//
//   • INVALID — the missing required tools are named VERBATIM. "This destination isn't compatible"
//     is not actionable; `list_projects` is, because the person configuring it can go and add that
//     tool (or pick a destination that has it). Same for an argument-shape problem, which names the
//     tool AND the property.
//   • VALID — one control per affordance the destination actually earned, and NOTHING for the ones
//     it did not. A hidden affordance is the point of the optional half of the contract: a
//     destination with no `upload_image` must not show an image control that would fail on click.
//
// The controls are DISCLOSURES, not actions. A configure pane's real question is "why can I do
// this / why can't I", so each one reveals the tool(s) backing it. Composing and publishing happen
// in the concierge chat (bead `sparkle-131ms.6`), not here — a card full of buttons that pretend to
// post would be worse than no card.

/** How each affordance is presented, and which tools back it.
 *
 *  The KEYS are the closed set from `publishCapabilities.ts` (mirrored from Rust's `AFFORDANCES`,
 *  which pins the same list in a test). The labels and the backing-tool names are presentation and
 *  live here; the `Record<PublishAffordance, …>` type is what makes a new key a typecheck failure
 *  rather than a silently unrendered control. */
const AFFORDANCE_UI: Record<
  PublishAffordance,
  { label: string; blurb: string; tools: readonly string[]; Icon: typeof FiImage }
> = {
  "project-picker": {
    label: "Choose a project",
    blurb: "Every draft is filed under one of the destination's projects.",
    tools: ["list_projects"],
    Icon: FiFolder,
  },
  "image-attach": {
    label: "Attach an image",
    blurb: "Upload an image and put it in the post.",
    tools: ["upload_image"],
    Icon: FiImage,
  },
  "video-attach": {
    label: "Attach a video",
    blurb: "Both halves of the upload are needed — a token to stream against, and the call that binds the result to the post.",
    tools: ["create_video_upload_token", "attach_video"],
    Icon: FiFilm,
  },
  "take-down": {
    label: "Take a post back down",
    blurb: "Unpublish a post that is already live.",
    tools: ["unpublish_content"],
    Icon: FiTrash2,
  },
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  border: `1px solid ${C.hairline}`,
  borderRadius: RADIUS.modal,
  padding: 14,
  fontFamily: FONT_UI,
};

const verdictRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: TYPE.body,
  fontWeight: 600,
};

const toolName: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: TYPE.small,
};

const affordanceButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  border: `1px solid ${C.hairline}`,
  borderRadius: RADIUS.input,
  padding: "7px 10px",
  background: "transparent",
  color: C.cream,
  cursor: "pointer",
  fontSize: TYPE.body,
  textAlign: "left",
  fontFamily: FONT_UI,
};

export interface PublishDestinationCardProps {
  /** What the user calls this destination ("drodio.com"). */
  name: string;
  /** The probe's answer. Every field is required — see `publishCapabilities.ts` on why. */
  capabilities: DestinationCapabilities;
}

export function PublishDestinationCard({ name, capabilities }: PublishDestinationCardProps) {
  const [expanded, setExpanded] = useState<PublishAffordance | null>(null);

  return (
    <section style={card} aria-label={`Publish destination ${name}`} data-testid="publish-destination-card">
      <div style={{ fontSize: TYPE.body, fontWeight: 600, color: C.cream }}>{name}</div>

      {capabilities.valid ? (
        <div style={{ ...verdictRow, color: C.successInk }} data-testid="publish-destination-verdict">
          <FiCheckCircle size={14} aria-hidden />
          Ready to publish
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ ...verdictRow, color: C.dangerInk }} data-testid="publish-destination-verdict">
            <FiAlertTriangle size={14} aria-hidden />
            Sparkle can’t publish here
          </div>

          {capabilities.missingRequired.length > 0 && (
            <div data-testid="publish-missing-required">
              <div style={{ fontSize: TYPE.small, color: C.muted }}>
                {capabilities.missingRequired.length === 1
                  ? "It’s missing this tool:"
                  : "It’s missing these tools:"}
              </div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {/* Named verbatim. A count, or a paraphrase, costs the one detail that lets
                    someone fix it. */}
                {capabilities.missingRequired.map((tool) => (
                  <li key={tool} style={{ ...toolName, color: C.cream }} data-testid={`publish-missing-tool-${tool}`}>
                    {tool}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {capabilities.argShapeProblems.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="publish-arg-shape-problems">
              {capabilities.argShapeProblems.map((problem) => (
                <li key={problem} style={{ fontSize: TYPE.small, color: C.cream }}>
                  {problem}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* One control per AVAILABLE affordance, and nothing at all for the rest.
          The `valid &&` is NOT redundant with the host, which already empties `affordances` for an
          invalid destination. It is the same invariant enforced at the end that renders it: this
          card is the last thing between a broken destination and a button the user can press, and
          a payload that ever carried both would paint controls for calls that cannot succeed. The
          two ends agree today; only one of them is the one the user clicks. */}
      {capabilities.valid && capabilities.affordances.length > 0 && (
        <div
          role="group"
          aria-label="What this destination supports"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          {PUBLISH_AFFORDANCES.filter((a) => capabilities.affordances.includes(a)).map((a) => {
            const ui = AFFORDANCE_UI[a];
            const open = expanded === a;
            return (
              <div key={a}>
                <button
                  type="button"
                  style={affordanceButton}
                  aria-expanded={open}
                  data-testid={`publish-affordance-${a}`}
                  onClick={() => setExpanded(open ? null : a)}
                >
                  <ui.Icon size={14} aria-hidden />
                  {ui.label}
                </button>
                {open && (
                  <div style={{ padding: "6px 10px 0", fontSize: TYPE.small, color: C.muted }}>
                    {ui.blurb}{" "}
                    <span style={toolName}>{ui.tools.join(", ")}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
