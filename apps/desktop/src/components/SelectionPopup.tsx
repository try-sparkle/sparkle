// apps/desktop/src/components/SelectionPopup.tsx
// Floating actions for highlighted terminal text (spec: 2026-06-24-terminal-selection-popup).
// The selection is already copied by Terminal.tsx; this card confirms that and offers ten
// actions. Rendered through a portal (like Tooltip.tsx) so it can't be clipped by the terminal's
// overflow:hidden, and positioned with viewport-clamped fixed coords.
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { C, FONT_WEIGHT } from "../theme/colors";
import { popupPosition } from "./selectionPopupPosition";
import {
  brainstormWith,
  explain,
  askWith,
  fixInAgent,
  sendToAgent,
  runAsCommand,
  searchWeb,
  saveNote,
  createTaskFromText,
} from "./selectionActions";
import { useProjectStore } from "../stores/projectStore";

const WIDTH = 300;

type Action = { icon: string; label: string; run: () => void; primary?: boolean };

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
  const [mode, setMode] = useState<"menu" | "ask">("menu");
  const [question, setQuestion] = useState("");
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
  }, [x, y, mode, toast]);

  // Dismiss on Escape, outside-click, or scroll. Uses onCloseRef so this effect runs once.
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // In ask sub-mode, Escape returns to the menu instead of closing the popup entirely.
        if (modeRef.current === "ask") setMode("menu");
        else onCloseRef.current();
      }
    };
    const onDocDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onScroll = () => onCloseRef.current();
    window.addEventListener("keydown", onKey);
    // Capture phase so a click anywhere closes before it does anything else.
    document.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally empty; reads via refs

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

  // Some actions require a registered project in the store (Brainstorm, Explain, Ask, Run as cmd).
  // Panes that don't map to a real project (e.g. SparkleAgentPane) pass an unregistered projectId;
  // hide those actions rather than silently no-op.
  const projectExists = useProjectStore((s) => s.projects.some((p) => p.id === projectId));

  const aiActions: Action[] = [
    ...(projectExists ? [
      { icon: "✦", label: "Brainstorm", primary: true, run: () => act(() => brainstormWith(projectId, text)) },
      { icon: "💡", label: "Explain", run: () => act(() => explain(projectId, text)) },
      { icon: "💬", label: "Ask…", run: () => setMode("ask") },
    ] : []),
    { icon: "🔧", label: "Fix it", run: () => act(() => fixInAgent(agentId, text)) },
  ];
  const doActions: Action[] = [
    { icon: "➦", label: "Send to agent", run: () => act(() => sendToAgent(agentId, text)) },
    ...(projectExists ? [
      { icon: "▶", label: "Run as cmd", run: () => act(() => runAsCommand(projectId, text)) },
    ] : []),
    { icon: "🔎", label: "Search web", run: () => act(() => searchWeb(text)) },
    { icon: "🔖", label: "Save note", run: () => act(() => saveNote(projectRootPath, text, new Date().toISOString()), "Saved to NOTES.md") },
    { icon: "☑", label: "New task", run: () => act(async () => `Created ${await createTaskFromText(projectRootPath, text)}`) },
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
      <div style={{ color: C.teal, fontSize: 11.5, fontWeight: FONT_WEIGHT.semibold, margin: "2px 12px" }}>
        ✓ Copied to clipboard
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
      ) : mode === "ask" ? (
        <div style={{ padding: "4px 10px 8px" }}>
          <Label>Ask about this</Label>
          <input
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && question.trim()) act(() => askWith(projectId, question.trim(), text));
            }}
            placeholder="Ask a question…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: C.forest,
              color: C.cream,
              border: `1px solid ${C.teal}`,
              borderRadius: 6,
              padding: "7px 9px",
              fontSize: 12,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 6 }}>
            Opens a brainstorm thread with your question + the selected text.
          </div>
        </div>
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
            color: C.cream,
            background: a.primary ? C.teal : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!a.primary) (e.currentTarget as HTMLButtonElement).style.background = C.forest;
          }}
          onMouseLeave={(e) => {
            if (!a.primary) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          <span style={{ width: 15, textAlign: "center" }}>{a.icon}</span>
          {a.label}
        </button>
      ))}
    </div>
  );
}
