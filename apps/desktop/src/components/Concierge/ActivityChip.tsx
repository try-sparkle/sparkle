// ActivityChip — a whole stretch of the agent's tool machinery, collapsed to ONE expandable line.
//
// THIS IS THE COMPONENT THAT MAKES THE MOUNTED PANE A TERMINAL SUBSTITUTE RATHER THAN A TERMINAL
// SUMMARY. The founder's ask was *"everything that's happening in the terminal I'm seeing in the
// concierge"* — so the machinery cannot simply be dropped, or the pane is a lossy digest and the
// terminal stays necessary. It also cannot be shown verbatim: raw tool traffic is ~89% of the
// transcript, it is laid out for ~100 columns against a ~380px pane, and it is exactly the noise
// that makes the raw log unliveable.
//
// So it is COMPRESSED, not deleted: verb + count + target on one line, with the calls one click
// away. You can see that work happened and what kind, without reading it.
import { useState } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";

import type { ActivityEntry } from "../../services/agentTranscript";
import { termMuted } from "../terminalChrome";
import type { ResolvedTheme } from "../../theme/theme";
import { FONT_MONO, TYPE } from "../../theme/scale";

export const ACTIVITY_CHIP_TESTID = "mounted-activity-chip";
export const ACTIVITY_CHIP_ITEMS_TESTID = "mounted-activity-items";

/** Elapsed time across the folded run, rendered the way a terminal reports it: whole seconds under a
 *  minute, `m s` above. Returns "" when the two stamps are unusable or the run was instant — an
 *  elapsed of `0s` is chrome that tells the reader nothing. */
export function elapsedLabel(start: string, end: string): string {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return "";
  const secs = Math.round((b - a) / 1000);
  if (secs <= 0) return "";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function ActivityChip({ entry, mode }: { entry: ActivityEntry; mode: ResolvedTheme }) {
  const [open, setOpen] = useState(false);
  const muted = termMuted(mode);
  const elapsed = elapsedLabel(entry.timestamp, entry.endTimestamp);

  return (
    <div style={{ alignSelf: "stretch" }}>
      <button
        type="button"
        data-testid={ACTIVITY_CHIP_TESTID}
        data-open={open ? "yes" : "no"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          // A chip is a control, not a card. No background, no border: it sits in the flow of the
          // conversation as a dim line, so a stretch of tool work reads as a beat between turns
          // rather than a box competing with the prose on either side of it.
          background: "none",
          border: "none",
          padding: "2px 0",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          fontFamily: FONT_MONO,
          fontSize: TYPE.micro,
          color: muted,
        }}
      >
        {open ? <FiChevronDown size={11} /> : <FiChevronRight size={11} />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.summary}
        </span>
        {elapsed !== "" && <span style={{ flexShrink: 0 }}>{elapsed}</span>}
      </button>
      {open && (
        <div
          data-testid={ACTIVITY_CHIP_ITEMS_TESTID}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "4px 0 6px 17px",
            fontFamily: FONT_MONO,
            fontSize: TYPE.micro,
            color: muted,
          }}
        >
          {entry.items.map((it, i) => (
            // Index-keyed deliberately: the items of one folded run are a fixed, immutable list read
            // from disk in order — they are never inserted into, reordered or filtered, so index IS
            // a stable identity here and the tool calls carry no id of their own.
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <div style={{ wordBreak: "break-all" }}>
                <span style={{ opacity: 0.7 }}>{it.verb} </span>
                {it.target}
              </div>
              {it.detail !== "" && (
                <div style={{ opacity: 0.7, paddingLeft: 10, wordBreak: "break-all" }}>→ {it.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
