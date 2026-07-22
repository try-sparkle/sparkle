// apps/desktop/src/components/SelectionPopup.tsx
// Floating actions for highlighted terminal text (spec: 2026-06-24-terminal-selection-popup).
// The selection is already copied by Terminal.tsx; this card confirms that and offers ten
// actions. Rendered through a portal (like Tooltip.tsx) so it can't be clipped by the terminal's
// overflow:hidden, and positioned with viewport-clamped fixed coords.
import { useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  FiTool,
  FiCornerUpRight,
  FiPlay,
  FiSearch,
  FiBookmark,
  FiCheckSquare,
  FiCheck,
} from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { popupPosition } from "./selectionPopupPosition";
import {
  fixInAgent,
  sendToAgent,
  runAsCommand,
  searchWeb,
  saveNote,
  createTaskFromText,
} from "./selectionActions";
import { useProjectStore } from "../stores/projectStore";

const WIDTH = 300;

type Action = { icon: ReactNode; label: string; run: () => void; primary?: boolean };

export function SelectionPopup({
  x,
  y,
  text,
  agentId,
  projectId,
  projectRootPath,
  onClose,
}: {
  x: number;
  y: number;
  text: string;
  agentId: string;
  projectId: string;
  projectRootPath: string;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x + 8, top: y + 8 });
  const [toast, setToast] = useState<string | null>(null);

  // Stable ref to onClose so the dismiss effect runs once (avoids listener churn on parent re-renders).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Track mount state so in-flight async actions and pending timers can bail after unmount.
  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Measure the rendered card and clamp it into the viewport.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 360;
    setPos(popupPosition({ x, y }, { w: WIDTH, h }, { w: window.innerWidth, h: window.innerHeight }));
  }, [x, y, toast]);

  // Dismiss on Escape, outside-click, or scroll. Uses onCloseRef so this effect runs once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onDocDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onCloseRef.current();
    };
    // Dismiss when the USER scrolls away — but NOT on the terminal's own programmatic auto-scroll
    // as output streams in. xterm's `.xterm-viewport` fires a capture-phase `scroll` on every line
    // of output, so a plain window scroll listener would destroy the popup the instant it opened
    // over a busy terminal (the "the menu never appears" bug). A `wheel` event only fires on real
    // user scroll input, cleanly distinguishing the two. Ignore wheels inside the card itself.
    const onWheel = (e: WheelEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    // Capture phase so a click anywhere closes before it does anything else.
    document.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("wheel", onWheel, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocDown, true);
      window.removeEventListener("wheel", onWheel, true);
    };
    // Intentionally empty: everything this effect touches is read through refs, so there is nothing
    // to re-subscribe on. (Previously carried an exhaustive-deps suppression; the rule does not fire
    // here — refs are not dependencies — so the directive was inert and is gone.)
  }, []);

  // Run an action; show a toast then close, or close immediately. The success toast comes from
  // the `done` arg OR from a string the action returns (e.g. the new bead id) — so the action
  // never has to call setToast/onClose itself (which would race the auto-close). Errors toast too.
  const act = useCallback((fn: () => void | Promise<void | string>, done?: string) => {
    void (async () => {
      try {
        const result = await fn();
        if (!mountedRef.current) return;
        const msg = done ?? (typeof result === "string" ? result : undefined);
        if (msg) {
          setToast(msg);
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => { if (mountedRef.current) onCloseRef.current(); }, 1100);
        } else {
          onCloseRef.current();
        }
      } catch (e) {
        if (!mountedRef.current) return;
        setToast(e instanceof Error ? e.message : String(e));
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => { if (mountedRef.current) onCloseRef.current(); }, 1600);
      }
    })();
  }, []);

  // Some actions require a registered project in the store (Run as cmd). Panes that don't map to a
  // real project (e.g. SparkleAgentPane) pass an unregistered projectId; hide those actions rather
  // than silently no-op.
  const projectExists = useProjectStore((s) => s.projects.some((p) => p.id === projectId));

  const aiActions: Action[] = [
    { icon: <FiTool size={15} />, label: "Fix it", primary: true, run: () => act(() => fixInAgent(agentId, text)) },
  ];
  const doActions: Action[] = [
    { icon: <FiCornerUpRight size={15} />, label: "Send to agent", run: () => act(() => sendToAgent(agentId, text)) },
    ...(projectExists ? [
      { icon: <FiPlay size={15} />, label: "Run as cmd", run: () => act(() => runAsCommand(projectId, text)) },
    ] : []),
    { icon: <FiSearch size={15} />, label: "Search web", run: () => act(() => searchWeb(text)) },
    { icon: <FiBookmark size={15} />, label: "Save note", run: () => act(() => saveNote(projectRootPath, text, new Date().toISOString()), "Saved to NOTES.md") },
    { icon: <FiCheckSquare size={15} />, label: "New task", run: () => act(async () => `Created ${await createTaskFromText(projectRootPath, text)}`) },
  ];

  return createPortal(
    <div
      ref={cardRef}
      // Stop mousedown from bubbling to the terminal (which would clear the selection / re-open).
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        width: WIDTH,
        background: C.deepForest,
        border: `1px solid ${C.forest}`,
        borderRadius: 10,
        boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
        fontFamily: '"IBM Plex Sans", sans-serif',
        color: C.cream,
        padding: "10px 4px 8px",
        animation: "sparkle-tooltip-in 90ms ease-out",
      }}
    >
      <div style={{ color: C.teal, fontSize: 11.5, fontWeight: FONT_WEIGHT.semibold, margin: "2px 12px", display: "flex", alignItems: "center", gap: 4 }}>
        <FiCheck size={13} /> Copied to clipboard
      </div>
      <div
        style={{
          fontFamily: '"Source Code Pro", monospace',
          fontSize: 11,
          color: C.muted,
          background: C.forest,
          border: `1px solid ${C.forest}`,
          borderRadius: 5,
          padding: "5px 8px",
          margin: "8px 10px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {text.split("\n")[0]}
      </div>

      {toast ? (
        <div style={{ padding: "8px 12px", fontSize: 12, color: C.cream }}>{toast}</div>
      ) : (
        <>
          <Label>Work with AI</Label>
          <Grid actions={aiActions} />
          <Label>Do something</Label>
          <Grid actions={doActions} />
        </>
      )}
    </div>,
    document.body,
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        color: C.muted,
        margin: "11px 12px 6px",
      }}
    >
      {children}
    </div>
  );
}

function Grid({ actions }: { actions: Action[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: "0 8px" }}>
      {actions.map((a) => (
        <button
          key={a.label}
          onClick={a.run}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 9px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            fontSize: 12,
            fontFamily: "inherit",
            // Primary action sits on the constant blue teal fill — keep its text light in both
            // themes (C.cream flips to navy in light). Non-primary is transparent/forest, where
            // the themed ink is correct.
            color: a.primary ? ON_BRAND_FILL : C.cream,
            background: a.primary ? C.teal : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!a.primary) (e.currentTarget as HTMLButtonElement).style.background = C.forest;
          }}
          onMouseLeave={(e) => {
            if (!a.primary) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          <span style={{ width: 15, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{a.icon}</span>
          {a.label}
        </button>
      ))}
    </div>
  );
}
