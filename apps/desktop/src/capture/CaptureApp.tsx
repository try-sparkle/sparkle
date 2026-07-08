// The capture takeover (spec §3): rendered in the dedicated transparent `capture` window, so the
// full-viewport scrim IS the window dressing. A shot arrives over `capture://shot`, the user
// narrates (dictation) or types, picks a project, and routes it to Think / Plan / Build — which
// just broadcasts `capture://send` and hides; the owning project window does the work (Task 4).
import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT, THEME_HEX } from "../theme/colors";
import { LogoWaveform } from "../components/LogoWaveform";
import { useAmbientVoice } from "../useDictation";
import { useDictationStore } from "../stores/dictationStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { StatusDot } from "../components/StatusDot";
import { micHotPlaceholder, wakePlaceholder } from "../voice/dictationCopy";
import { useSettingsStore } from "../stores/settingsStore";
import { subscribeToCrossWindowSync } from "../services/crossWindowSync";
import { safeUnlisten } from "../services/safeUnlisten";
import { chooseLayout } from "./captureLayout";
import { readLastFocusedProject } from "./lastFocusedProject";
import { shouldConfirmDiscard } from "./discard";
import { onCaptureShot, emitCaptureSend, hideCaptureWindow } from "./captureEvents";
import type { CaptureSendMode, CaptureSendPayload, CaptureShot } from "./types";

// The takeover is a dark surface by design (approved mockup) regardless of the app theme, so the
// card uses the dark-theme literals rather than the var()-based tokens (main.tsx also pins
// data-theme=dark for this view so reused components like LogoWaveform stay legible on it).
const NAVY = THEME_HEX.dark.forest;
const NAVY_DEEP = THEME_HEX.dark.deepForest;
const CREAM = THEME_HEX.dark.cream;
const MUTED = THEME_HEX.dark.muted;

const MODES: Array<{ mode: CaptureSendMode; label: string }> = [
  { mode: "think", label: "Think" },
  { mode: "plan", label: "Plan" },
  { mode: "build", label: "Build" },
];

export function CaptureApp() {
  // The dictation pipeline's frontend half (dictation://* listeners + wake machine) is mounted
  // per-webview; this window renders its own React root, so it must mount its own controller —
  // exactly like App does. Focus gating in useDictation routes text to whichever window is key.
  useAmbientVoice();

  const [captures, setCaptures] = useState<CaptureShot[]>([]);
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [hoveredMode, setHoveredMode] = useState<CaptureSendMode | null>(null);
  const [buildMenuOpen, setBuildMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const projects = useProjectStore((s) => s.projects);
  // Live per-agent status → the color swatch next to each existing build agent in the Build menu.
  const runtimeStatus = useRuntimeStore((s) => s.status);

  // Keep the shared persisted stores (project list, mic mute) live: this webview exists from app
  // start, so without the sync a project created later would never appear in the switcher.
  useEffect(() => subscribeToCrossWindowSync(), []);

  // A new shot resets the whole session: v1 shows one shot (state stays an array — multi-shot
  // chaining is a planned follow-up) and re-resolves the default project to wherever the user
  // was last working at THIS capture, not at webview boot.
  useEffect(() => {
    const p = onCaptureShot((shot) => {
      setCaptures([shot]);
      // Unsent narration survives a re-capture: a stray hotkey press must not silently throw
      // away dictated text (the same principle as the discard confirm) — the user re-shooting
      // mid-narration almost always wants a better screenshot for the SAME thought.
      setText((v) => (shouldConfirmDiscard(v) ? v : ""));
      setConfirming(false);
      setImgDims(null);
      const st = useProjectStore.getState();
      const last = readLastFocusedProject();
      const valid = last && st.projects.some((pr) => pr.id === last) ? last : st.projects[0]?.id;
      setProjectId(valid ?? "");
      // Focus after the card mounts so typing (and the dictation caret) lands in the textarea.
      requestAnimationFrame(() => taRef.current?.focus());
    });
    return () => {
      void safeUnlisten(p);
    };
  }, []);

  const active = captures.length > 0;

  // The cross-window sync keeps `projects` live while the takeover is open, so the selection
  // must be reconciled against it: a project deleted in another window would otherwise send a
  // dangling id (with the <select> silently displaying a different option), and a first project
  // created after an empty-state shot would appear selected while projectId stayed "".
  useEffect(() => {
    if (!active) return;
    if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0]?.id ?? "");
  }, [active, projects, projectId]);

  // ---- Voice dictation wiring (mirrors ThinkPanel's composer) ----------------------
  const audioActive = useDictationStore((s) => active && s.status === "listening");
  const phase = useDictationStore((s) => s.phase);
  const liveActive = audioActive && phase === "active";
  const livePassive = audioActive && phase === "passive";
  const wakeWord = useSettingsStore((s) => s.wakeWord);
  const stopWord = useSettingsStore((s) => s.stopWord);
  const interim = useDictationStore((s) => (active ? s.interim : ""));

  useEffect(() => {
    if (!active) return;
    const append = (t: string) => {
      setText((v) => (v ? `${v} ${t}` : t));
      taRef.current?.focus();
    };
    useDictationStore.getState().registerInsert(append);
    return () => {
      const store = useDictationStore.getState();
      if (store.insertTarget === append) store.registerInsert(null);
    };
  }, [active]);

  const reset = () => {
    setCaptures([]);
    setText("");
    setConfirming(false);
    setImgDims(null);
    // The window hides before mouseleave can fire, so a lingering hover would restyle the
    // same button on the NEXT capture.
    setHoveredMode(null);
    setBuildMenuOpen(false);
  };
  const hideNow = () => {
    reset();
    void hideCaptureWindow();
  };
  const requestDiscard = () => {
    if (shouldConfirmDiscard(text)) setConfirming(true);
    else hideNow();
  };

  // Esc anywhere in the takeover asks to discard (textarea included — it has no Esc behavior
  // of its own). While the confirm strip is up, Esc backs out of the confirm instead.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Peel one layer at a time: an open Build menu (or the discard confirm) backs out first,
      // so Esc doesn't blow past a popover straight into a discard.
      if (buildMenuOpen) setBuildMenuOpen(false);
      else if (confirming) setConfirming(false);
      else requestDiscard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, confirming, buildMenuOpen, text]);

  const send = (mode: CaptureSendMode, buildOpts?: { forceNewAgent?: boolean; targetAgentId?: string }) => {
    // Belt-and-suspenders alongside the buttons' disabled attribute, so a future keyboard
    // shortcut (Cmd+Enter etc.) can never emit a payload with an empty projectId.
    if (!sendEnabled) return;
    const payload: CaptureSendPayload = {
      mode,
      projectId,
      text,
      attachments: captures.map((c) => ({ path: c.path, dataUrl: c.dataUrl })),
      // Build-only routing (see the Build menu below); omitted for think/plan so their payloads
      // stay byte-for-byte as before.
      ...(buildOpts?.forceNewAgent ? { forceNewAgent: true } : {}),
      ...(buildOpts?.targetAgentId ? { targetAgentId: buildOpts.targetAgentId } : {}),
    };
    void emitCaptureSend(payload);
    reset();
    void hideCaptureWindow();
  };

  // Existing build agents for the currently-selected project — the entries in the Build menu.
  const buildAgents = projects.find((p) => p.id === projectId)?.agents.filter((a) => a.kind === "build") ?? [];
  // Single enablement rule (plan Task 3 Step 5): a project + at least one shot; text may be
  // empty — an image alone is sendable.
  const sendEnabled = projectId !== "" && captures.length >= 1;

  // Window not showing a capture → paint nothing (the OS window is hidden anyway; rendering
  // nothing also keeps the transparent webview truly invisible if it's ever briefly on screen).
  const shot = captures[0];
  if (!shot) return null;

  // The fit box handed to chooseLayout is what's left for the IMAGE once the composer block
  // (+ the card's padding/gap) claims its side — fitting the image alone to the raw screen
  // would overflow the card for a full-screen landscape shot. `h > w` mirrors chooseLayout's
  // placement rule (portrait → composer right, else below).
  const COMPOSER_W = 420 + 16; // composer column width + flex gap
  const COMPOSER_H = 230 + 16; // approximate composer column height + flex gap
  const CARD_CHROME = 34; // 16px padding × 2 + 1px border × 2
  const layout = imgDims
    ? chooseLayout(
        imgDims.w,
        imgDims.h,
        window.innerWidth - CARD_CHROME - (imgDims.h > imgDims.w ? COMPOSER_W : 0),
        window.innerHeight - CARD_CHROME - (imgDims.h > imgDims.w ? 0 : COMPOSER_H),
      )
    : null;

  return (
    <div
      data-testid="capture-scrim"
      // A click on the shaded area (outside the card) ALWAYS closes immediately — no discard
      // confirm even when there's narration (the deliberate "click away to dismiss" gesture).
      // Guard on target === currentTarget so clicks bubbling up from the card/composer/buttons
      // don't close; only a click that actually landed on the scrim itself does.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) hideNow();
      }}
      style={{
        position: "fixed",
        inset: 0,
        // ~half as dark as the original 0.55 scrim (user found the takeover too dark).
        background: "rgba(20,22,30,0.28)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        data-testid="capture-card"
        style={{
          position: "relative",
          display: "flex",
          flexDirection: layout?.placement === "right" ? "row" : "column",
          alignItems: "center",
          gap: 16,
          padding: 16,
          background: NAVY,
          border: `1px solid ${NAVY_DEEP}`,
          borderRadius: 4,
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
          maxWidth: "92vw",
          maxHeight: "92vh",
        }}
      >
        {/* Corner cancel: closes immediately, no discard confirm (same path as a scrim click). */}
        <button
          data-testid="capture-cancel"
          onClick={hideNow}
          aria-label="Cancel capture"
          title="Cancel (discard capture)"
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            zIndex: 2,
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            color: MUTED,
            border: `1px solid ${NAVY_DEEP}`,
            borderRadius: 4,
            fontSize: 15,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ✕
        </button>

        <img
          src={shot.dataUrl}
          alt="Captured screenshot"
          onLoad={(e) =>
            setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          style={{
            display: "block",
            borderRadius: 4,
            // True-to-size once measured (chooseLayout shrinks past 80% of the screen, never
            // upscales); the vw/vh caps only bridge the single frame before onLoad fires.
            ...(layout && imgDims
              ? { width: Math.round(imgDims.w * layout.imgScale) }
              : { maxWidth: "70vw", maxHeight: "60vh" }),
          }}
        />

        {/* Composer block: logo + waveform + narration + project + the three sends */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 420, maxWidth: "88vw" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height: 28 }} />
            <div style={{ flex: 1 }}>
              <LogoWaveform />
            </div>
          </div>

          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={
              liveActive
                ? micHotPlaceholder(stopWord)
                : livePassive
                ? wakePlaceholder(wakeWord)
                : "Narrate what you captured, or type it here…"
            }
            style={{
              width: "100%",
              resize: "none",
              background: NAVY_DEEP,
              color: CREAM,
              border: `1px solid ${NAVY_DEEP}`,
              borderRadius: 4,
              padding: "8px 10px",
              fontSize: 13,
              lineHeight: 1.5,
              outline: "none",
              fontFamily: '"IBM Plex Sans", sans-serif',
            }}
          />
          {audioActive && interim && (
            <div
              style={{
                color: MUTED,
                fontStyle: "italic",
                fontSize: 13,
                lineHeight: 1.4,
                padding: "0 2px",
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              {interim}
            </div>
          )}

          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project"
            style={{
              width: "100%",
              background: NAVY_DEEP,
              color: projectId ? CREAM : MUTED,
              border: `1px solid ${NAVY_DEEP}`,
              borderRadius: 4,
              padding: "7px 8px",
              fontSize: 13,
              outline: "none",
            }}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {confirming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, color: CREAM, fontSize: 13 }}>Discard capture?</span>
              <button
                onClick={hideNow}
                style={{
                  background: C.sienna,
                  color: CREAM,
                  border: `1px solid ${C.sienna}`,
                  borderRadius: 4,
                  padding: "6px 14px",
                  fontSize: 13,
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor: "pointer",
                }}
              >
                Discard
              </button>
              <button
                onClick={() => setConfirming(false)}
                style={{
                  background: "transparent",
                  color: CREAM,
                  border: `1px solid ${MUTED}`,
                  borderRadius: 4,
                  padding: "6px 14px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Keep editing
              </button>
            </div>
          ) : (
            <div style={{ position: "relative", display: "flex", gap: 8 }}>
              {MODES.map(({ mode, label }) => {
                const primary = mode === "build";
                const hovered = hoveredMode === mode && sendEnabled;
                // Build no longer sends on click — it opens an options menu (New vs. an existing
                // build agent). Think/Plan keep sending immediately, exactly as before.
                const isBuild = mode === "build";
                return (
                  <button
                    key={mode}
                    onClick={() => (isBuild ? setBuildMenuOpen((o) => !o) : send(mode))}
                    disabled={!sendEnabled}
                    aria-expanded={isBuild ? buildMenuOpen : undefined}
                    onMouseEnter={() => setHoveredMode(mode)}
                    onMouseLeave={() => setHoveredMode((m) => (m === mode ? null : m))}
                    title={
                      sendEnabled
                        ? isBuild
                          ? "Choose a build agent"
                          : `Send to ${label}`
                        : "Pick a project first"
                    }
                    style={{
                      flex: 1,
                      background: primary
                        ? sendEnabled
                          ? hovered
                            ? "#4a80ff"
                            : C.teal
                          : NAVY_DEEP
                        : hovered
                        ? NAVY_DEEP
                        : "transparent",
                      color: sendEnabled ? CREAM : MUTED,
                      border: `1px solid ${primary && sendEnabled ? C.teal : NAVY_DEEP}`,
                      borderRadius: 4,
                      padding: "8px 0",
                      fontSize: 13,
                      fontWeight: FONT_WEIGHT.semibold,
                      cursor: sendEnabled ? "pointer" : "default",
                    }}
                  >
                    {isBuild ? `${label} ▾` : `${label} ❯`}
                  </button>
                );
              })}

              {buildMenuOpen && sendEnabled && (
                <>
                  {/* Outside-click catcher: a click anywhere else dismisses the menu without
                      closing the takeover. Fixed + full-viewport so it also covers the scrim. */}
                  <div
                    data-testid="build-menu-backdrop"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setBuildMenuOpen(false);
                    }}
                    style={{ position: "fixed", inset: 0, zIndex: 3 }}
                  />
                  <div
                    data-testid="build-menu"
                    role="menu"
                    style={{
                      position: "absolute",
                      right: 0,
                      bottom: "calc(100% + 6px)",
                      zIndex: 4,
                      minWidth: 200,
                      maxWidth: 320,
                      maxHeight: 260,
                      overflowY: "auto",
                      background: NAVY_DEEP,
                      border: `1px solid ${NAVY}`,
                      borderRadius: 6,
                      boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                      padding: 6,
                    }}
                  >
                    <button
                      data-testid="build-menu-new"
                      role="menuitem"
                      onClick={() => send("build", { forceNewAgent: true })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        textAlign: "left",
                        background: "transparent",
                        color: CREAM,
                        border: "none",
                        borderRadius: 4,
                        padding: "7px 8px",
                        fontSize: 13,
                        fontWeight: FONT_WEIGHT.semibold,
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ width: 9, textAlign: "center", flex: "0 0 auto" }}>+</span>
                      <span>New build agent</span>
                    </button>
                    {buildAgents.length > 0 && (
                      <div
                        style={{ height: 1, background: NAVY, margin: "5px 4px" }}
                        aria-hidden="true"
                      />
                    )}
                    {buildAgents.map((a) => {
                      const status = runtimeStatus[a.id] ?? "stopped";
                      const name = a.autoNameVariants?.title?.trim() || a.name;
                      return (
                        <button
                          key={a.id}
                          role="menuitem"
                          onClick={() => send("build", { targetAgentId: a.id })}
                          title={`Send to ${name}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            textAlign: "left",
                            background: "transparent",
                            color: CREAM,
                            border: "none",
                            borderRadius: 4,
                            padding: "7px 8px",
                            fontSize: 13,
                            cursor: "pointer",
                          }}
                        >
                          <StatusDot status={status} />
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
