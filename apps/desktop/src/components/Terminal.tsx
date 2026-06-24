import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { C, CHAT_USER_BUBBLE } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";
import { spawnPty, writePty, killPty, resizePty, onPtyOutput, onPtyExit } from "../pty";
import { StatusEngine } from "../engine/statusEngine";

/**
 * One xterm.js terminal bound to one agent's PTY (spec §3). Spawns the command on
 * mount, streams pty:output into the terminal AND the statusEngine, forwards
 * keystrokes back to the PTY, and tears the PTY down on unmount. Mouse-select + Cmd+C
 * copy are built into xterm.
 */
export function Terminal({
  agentId,
  command,
  args,
  cwd,
  active,
  onStatus,
  onReady,
  onExit,
}: {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  active: boolean;
  onStatus: (s: AgentTabStatus) => void;
  onReady?: () => void;
  onExit?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const engine = new StatusEngine({ agentId, onStatus });

    const term = new XTerm({
      // System monospaces (Menlo/SF Mono) carry full box-drawing glyphs as a fallback;
      // the Google-Fonts subset of Source Code Pro drops U+2500-block glyphs.
      fontFamily: '"Source Code Pro", "SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 13,
      // Must be 1.0 so box-drawing verticals (│ ╭ ╰) connect across rows with no gap.
      lineHeight: 1.0,
      // Draw box-drawing / block glyphs as exact-cell vectors (renderer-level), so they
      // align regardless of the font — fixes misaligned TUI borders (e.g. Claude's box).
      customGlyphs: true,
      cursorBlink: true,
      scrollback: 8000,
      theme: {
        background: C.forest,
        foreground: C.cream,
        cursor: C.accent,
        selectionBackground: CHAT_USER_BUBBLE,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // WebGL renderer enables customGlyphs (the default DOM renderer does not), giving
    // crisp, exactly-aligned box-drawing. Fall back silently if WebGL is unavailable.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* no WebGL — keep the default renderer (TUI borders may be less crisp) */
    }
    try {
      fit.fit();
    } catch {
      /* container not laid out yet; the ResizeObserver will fit shortly */
    }
    termRef.current = term;
    fitRef.current = fit;

    // Forward keystrokes typed directly in the terminal to the PTY.
    term.onData((d) => {
      void writePty(agentId, d);
    });

    void (async () => {
      const offOut = await onPtyOutput((e) => {
        if (e.id !== agentId) return;
        term.write(e.chunk);
        engine.ingest(e.chunk);
      });
      const offExit = await onPtyExit((e) => {
        if (e.id !== agentId) return;
        engine.exit();
        onExit?.();
      });
      if (disposed) {
        offOut();
        offExit();
        return;
      }
      unlistens.push(offOut, offExit);
      await spawnPty({ id: agentId, command, args, cwd, cols: term.cols, rows: term.rows });
      if (!disposed) onReady?.();
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void resizePty(agentId, term.cols, term.rows);
      } catch {
        /* ignore transient fit errors while hidden */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      for (const off of unlistens) off();
      void killPty(agentId);
      engine.dispose();
      term.dispose();
    };
    // agentId is stable for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Re-fit + focus when this tab becomes the active one (was display:none).
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        term.focus();
        void resizePty(agentId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
  }, [active, agentId]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />;
}
