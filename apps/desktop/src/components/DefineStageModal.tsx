// Unit 4 of "Definable Done & Delivered" — the Define/Edit modal.
//
// A small chat-style modal that lets a project define what "Done"/"Delivered" mean for itself.
// It opens on a smart default (Yes/No); "No" (or "Edit the instructions") drops into a light
// Haiku-backed chat that turns free text into a strict `StageDefinition`, which is persisted to
// the project's `.sparkle/config.toml` via `writeStageDef`. For Delivered it first runs the
// Delivery Detector (`detectDelivery`) so the default proposal reflects how THIS project ships,
// and it stays honest when it can't tell. Spec:
//   docs/superpowers/specs/2026-07-02-definable-done-delivered-design.md  (UX → Define/Edit modal)
//
// Interfaces consumed (never reimplemented): stageDefs (read/write/isDefined), deliveryDetector
// (detectDelivery), config (getConfig), anthropic (structuredJson). This component only READS the
// world and writes stage definitions; Unit 5 wires the open trigger + passes props.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FiCheck } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE, ROW_ACTIVE_BUBBLE } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { ModalShell } from "./ModalShell";
import { getConfig } from "../services/config";
import {
  readStageDef,
  writeStageDef,
  isDefined,
  type StageKey,
  type StageDefinition,
  type StageCriterion,
  type DeliveryMethod,
} from "../services/stageDefs";
import { detectDelivery, type DeliveryProposal } from "../services/deliveryDetector";
import { structuredJson } from "../services/anthropic";

export interface DefineStageModalProps {
  /** Which board stage this modal defines. */
  stageKey: StageKey;
  /** The human project name, shown in the prompts (bolded). */
  projectName: string;
  /** Absolute repo path — passed to detectDelivery / writeStageDef / getConfig. */
  projectRoot: string;
  /** Close the modal (backdrop, Escape, the ✕, or a terminal "Close" button). */
  onClose: () => void;
}

/** Human-readable phrasing for a detected delivery method, used in the proposal line. */
const METHOD_LABEL: Record<DeliveryMethod, string> = {
  release_tag: "cutting a release",
  ci_deploy: "a CI deploy",
  merge_is_deploy: "auto-deploying on merge",
  package_publish: "publishing to a package registry",
  unknown: "an unrecognized method",
};

/** The default Done definition: merged into the remote main branch (one auto criterion). */
function doneDefault(): StageDefinition {
  return {
    description: "Merged into the remote main branch.",
    criteria: [{ text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" }],
  };
}

/** Build a Delivered definition from a detector proposal (learn-then-automate starts unlearned). */
function deliveredFromProposal(p: DeliveryProposal): StageDefinition {
  return {
    description: "Shipped to production.",
    criteria: p.criteria,
    detectedMethod: p.method,
    confidence: p.confidence,
    confidenceNote: p.note,
    learned: false,
  };
}

/** The Haiku contract: convert plain language → strict StageDefinition. Pins the exact JSON shape,
 *  the CLOSED AutoSignal set, the auto/manual rule, and (for delivered) the "don't invent a method"
 *  honesty rule. `structuredJson` appends its own firm JSON-only instruction on top of this. */
function systemPrompt(stageKey: StageKey): string {
  const stageLabel = stageKey === "done" ? "Done" : "Delivered";
  const lines = [
    `You convert a person's plain-language description of what "${stageLabel}" means for their`,
    `software project into a single strict JSON StageDefinition object. The board stage being`,
    `defined is "${stageKey}".`,
    ``,
    `Output EXACTLY this JSON shape (omit optional fields you don't set):`,
    `{`,
    `  "description": string,        // one short sentence paraphrasing what the stage means`,
    `  "criteria": [                 // one entry per distinct condition the user described`,
    `    { "text": string, "kind": "auto" | "manual", "signal"?: AutoSignal }`,
    `  ],`,
    `  "detectedMethod"?: "release_tag" | "ci_deploy" | "merge_is_deploy" | "package_publish" | "unknown",`,
    `  "confidence"?: "high" | "medium" | "low" | "none",`,
    `  "confidenceNote"?: string,`,
    `  "learned"?: boolean`,
    `}`,
    ``,
    `AutoSignal is a CLOSED set — the ONLY valid values are:`,
    `  "merged_to_main"  the work is merged into the remote main/default branch`,
    `  "pr_merged"       the pull request was merged`,
    `  "pushed"          the branch was pushed to the remote`,
    `  "in_release"      the merge commit is contained in a shipped/cut release`,
    ``,
    `Rules:`,
    `- "kind":"auto" means Sparkle can OBSERVE the criterion automatically; it REQUIRES a "signal"`,
    `  drawn from the closed set above and NOTHING outside it.`,
    `- Anything that cannot be mapped to one of those four signals MUST be "kind":"manual" with NO`,
    `  "signal" field (a human ticks it). Never invent a signal outside the closed set.`,
    `- Keep "criteria" to the few conditions the user actually described; do not pad.`,
  ];
  if (stageKey === "delivered") {
    lines.push(
      ``,
      `For the "delivered" stage ONLY:`,
      `- Set "detectedMethod"/"confidence"/"confidenceNote" ONLY if the user's description clearly`,
      `  justifies a specific production-ship method. If it is unclear, leave "detectedMethod" unset`,
      `  (or "unknown"), set "confidence" to "none", and prefer manual criteria.`,
      `- Do NOT invent a delivery method you cannot justify from what the user actually said.`,
    );
  }
  return lines.join("\n");
}

/** The closed AutoSignal set — anything else Haiku returns is not observable, so we demote it. */
const KNOWN_SIGNALS = new Set(["merged_to_main", "pr_merged", "pushed", "in_release"]);

/** Defensively normalize a Haiku-parsed definition: guarantee a criteria array, force auto criteria
 *  to carry a known signal (else demote to manual), and strip stray signals off manual criteria.
 *  Haiku is instructed to obey this, but we never trust it to. */
function normalizeParsed(parsed: StageDefinition): StageDefinition {
  const rawCriteria = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
  const criteria: StageCriterion[] = rawCriteria
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .map((c) => {
      const text = c.text.trim();
      if (c.kind === "auto" && c.signal && KNOWN_SIGNALS.has(c.signal)) {
        return { text, kind: "auto", signal: c.signal };
      }
      // Unknown/absent signal, or explicitly manual → a human ticks it.
      return { text, kind: "manual" };
    });
  const out: StageDefinition = { criteria };
  if (typeof parsed?.description === "string" && parsed.description.trim()) {
    out.description = parsed.description.trim();
  }
  if (parsed?.detectedMethod) out.detectedMethod = parsed.detectedMethod;
  if (parsed?.confidence) out.confidence = parsed.confidence;
  if (typeof parsed?.confidenceNote === "string") out.confidenceNote = parsed.confidenceNote;
  if (typeof parsed?.learned === "boolean") out.learned = parsed.learned;
  return out;
}

/** The Done saved-confirmation tail: the persisted description (with terminal punctuation ensured),
 *  or a graceful fallback when a definition was saved without one. Keeps the sentence well-formed
 *  whether the description came from the default, Haiku, or free text. */
function doneSummary(def: StageDefinition | undefined): string {
  const desc = def?.description?.trim();
  if (!desc) return "a custom definition (no description).";
  return /[.!?]$/.test(desc) ? desc : `${desc}.`;
}

interface Msg {
  role: "assistant" | "user";
  body: ReactNode;
}

type View = "loading" | "intro" | "chat" | "editOverview" | "saved";

export function DefineStageModal({ stageKey, projectName, projectRoot, onClose }: DefineStageModalProps) {
  const stageLabel = stageKey === "done" ? "Done" : "Delivered";

  const [view, setView] = useState<View>("loading");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [existing, setExisting] = useState<StageDefinition | undefined>(undefined);
  const [proposal, setProposal] = useState<DeliveryProposal | undefined>(undefined);
  const [introYesNo, setIntroYesNo] = useState(true);
  const [draft, setDraft] = useState<StageDefinition | undefined>(undefined);
  // The definition actually persisted — the "saved" confirmation reflects THIS, not the default.
  const [savedDef, setSavedDef] = useState<StageDefinition | undefined>(undefined);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The action to re-run when the error banner's "Retry" is clicked — a re-send of the last chat
  // turn OR a re-attempt of the last failed persist, whichever raised the error. Null clears Retry.
  const retryRef = useRef<(() => void) | null>(null);

  const push = (m: Msg) => setMessages((prev) => [...prev, m]);

  // ── Initialize: read the existing definition; for undefined Delivered, run the detector ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const eff = await getConfig(projectRoot);
        if (cancelled) return;
        const cur = readStageDef(eff.config, stageKey);
        if (isDefined(cur)) {
          setExisting(cur);
          setView("editOverview");
          return;
        }
        // Undefined → build the smart-default intro.
        if (stageKey === "done") {
          push({
            role: "assistant",
            body: (
              <>
                “Done” is typically defined as merging into the remote main branch. Is that how
                you’d like it to work in <strong>{projectName}</strong>?
              </>
            ),
          });
          setIntroYesNo(true);
          setView("intro");
          return;
        }
        // Delivered → detect how the project ships, then phrase the intro by confidence tier.
        let p: DeliveryProposal | undefined;
        try {
          p = await detectDelivery(projectRoot);
        } catch {
          p = undefined; // detection failed → fall through to the generic line
        }
        if (cancelled) return;
        setProposal(p);
        if (p && (p.confidence === "high" || p.confidence === "medium")) {
          push({
            role: "assistant",
            body: (
              <>
                It looks like <strong>{projectName}</strong> ships to production via{" "}
                <strong>{METHOD_LABEL[p.method]}</strong> — I’ll watch that and mark items Delivered
                automatically. Use that?
              </>
            ),
          });
          setIntroYesNo(true);
          setView("intro");
        } else if (p && p.confidence === "low") {
          push({
            role: "assistant",
            body: (
              <>
                My best guess is that <strong>{projectName}</strong> ships to production via{" "}
                <strong>{METHOD_LABEL[p.method]}</strong>, but I’m{" "}
                <strong>not confident (low confidence)</strong>: {p.note} Use that, or tell me how it
                really works?
              </>
            ),
          });
          setIntroYesNo(true);
          setView("intro");
        } else if (p && p.confidence === "none") {
          // Honest can't-detect: skip Yes/No, go straight to the chat.
          push({
            role: "assistant",
            body: (
              <>
                I couldn’t detect how {projectName} ships to production — tell me how it works, or
                I’ll keep Delivered as a manual check.
              </>
            ),
          });
          setIntroYesNo(false);
          setView("chat");
        } else {
          // Detector unavailable → generic line + Yes/No.
          push({
            role: "assistant",
            body: (
              <>
                “Delivered” is typically defined as shipping code to production. Is that how you’d
                like it to work in <strong>{projectName}</strong>?
              </>
            ),
          });
          setIntroYesNo(true);
          setView("intro");
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setView("intro");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, stageKey, projectName]);

  // ── Persist a definition, then show the stage-appropriate confirmation ──
  async function persist(def: StageDefinition) {
    setBusy(true);
    setError(undefined);
    try {
      await writeStageDef(projectRoot, stageKey, def);
      retryRef.current = null;
      setSavedDef(def);
      setView("saved");
    } catch (e) {
      // Wire Retry to re-attempt THIS save (the failure came from persist, not the chat).
      retryRef.current = () => void persist(def);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Intro "Yes": accept the default/detected definition.
  async function onYes() {
    if (stageKey === "done") {
      await persist(doneDefault());
      return;
    }
    // Delivered: accept the detected proposal (guaranteed present on any Yes/No delivered intro).
    if (proposal) await persist(deliveredFromProposal(proposal));
  }

  // Intro "No": reveal the chat box.
  function onNo() {
    push({
      role: "assistant",
      body: <>How do you want to define “{stageLabel}”?</>,
    });
    setView("chat");
  }

  // Edit mode "Edit the instructions": reveal the chat box (relearn on save).
  function onEditInstructions() {
    push({
      role: "assistant",
      body: <>How do you want to define “{stageLabel}”?</>,
    });
    setView("chat");
  }

  /** Reconcile a Haiku-parsed Delivered definition with the Delivery Detector. Editing relearns:
   *  we reset `learned=false` and re-run the detector so confidence resets; when the user's stated
   *  method agrees with the detector, we keep the detector's confidence + note. */
  async function finalizeDelivered(parsed: StageDefinition): Promise<StageDefinition> {
    const def: StageDefinition = { ...parsed, learned: false };
    let p = proposal;
    try {
      p = await detectDelivery(projectRoot);
      setProposal(p);
    } catch {
      // keep whatever we already had; a detector failure must not block saving.
    }
    if (p && def.detectedMethod && def.detectedMethod === p.method) {
      def.confidence = p.confidence;
      def.confidenceNote = p.note;
    }
    return def;
  }

  // The async Haiku turn, split from the transcript push so Retry can re-run it WITHOUT appending
  // a duplicate user bubble. Input is cleared only on success — an in-flight turn keeps its text so
  // the action row stays on "Send"/"Thinking…" (not the Save branch) and a failure leaves it to edit.
  async function runHaiku(trimmed: string) {
    setBusy(true);
    setError(undefined);
    try {
      const parsed = await structuredJson<StageDefinition>(systemPrompt(stageKey), trimmed);
      const normalized = normalizeParsed(parsed);
      const finalDef =
        stageKey === "delivered" ? await finalizeDelivered(normalized) : normalized;
      setDraft(finalDef);
      setInput("");
      retryRef.current = null;
      push({
        role: "assistant",
        body: <>Here’s how I’ll define “{stageLabel}”. Save it, or type a change and Send again.</>,
      });
    } catch (e) {
      // Wire Retry to re-run THIS turn (no re-push of the already-visible user message).
      retryRef.current = () => void runHaiku(trimmed);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Send a free-text turn to Haiku: push the user's message once, then run the turn.
  function sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    push({ role: "user", body: trimmed });
    void runHaiku(trimmed);
  }

  const canPickYesNo = view === "intro" && introYesNo && !busy && !error;

  return (
    <ModalShell width={480} onCancel={onClose}>
      <div style={header}>
        <div style={title}>Define “{stageLabel}”</div>
        <div style={subtitle}>{projectName}</div>
      </div>

      <div style={transcript} data-testid="define-transcript">
        {view === "loading" && <div style={assistantLine}>One sec — reading this project…</div>}

        {messages.map((m, i) => (
          <div key={i} style={m.role === "assistant" ? assistantLine : userLine}>
            {m.body}
          </div>
        ))}

        {/* Edit-mode overview: the current definition, then an "edit the instructions" entry. */}
        {view === "editOverview" && existing && (
          <>
            <div style={assistantLine}>
              Here’s how <strong>{projectName}</strong> currently defines “{stageLabel}”.
            </div>
            <DefinitionPreview def={existing} stageKey={stageKey} />
          </>
        )}

        {/* A parsed-but-unsaved draft awaiting the user's Save/amend. */}
        {view === "chat" && draft && <DefinitionPreview def={draft} stageKey={stageKey} />}

        {/* Saved confirmation copy. */}
        {view === "saved" && (
          <div style={confirmBlock}>
            {stageKey === "delivered" ? (
              <div style={confirmRow}>
                <FiCheck size={16} color={C.successInk} aria-hidden />
                <span>
                  Delivered will track your production ships. Sparkle will watch how {projectName}{" "}
                  ships and mark items Delivered automatically once it’s confident. It may take a
                  ship or two to lock onto your release pattern — and I’ll tell you right away if I
                  can’t detect it.
                </span>
              </div>
            ) : (
              <div style={confirmRow}>
                <FiCheck size={16} color={C.successInk} aria-hidden />
                <span>“Done” is set for {projectName} — {doneSummary(savedDef)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={errorBanner} role="alert">
          <span>{error}</span>
          <button
            type="button"
            style={ghostBtn}
            disabled={busy}
            onClick={() => {
              // Re-run whichever action failed (chat re-send or persist re-attempt).
              const again = retryRef.current;
              setError(undefined);
              again?.();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Action row ── */}
      <div style={actions}>
        {canPickYesNo && (
          <>
            <button type="button" style={primaryBtn} onClick={() => void onYes()}>
              Yes
            </button>
            <button type="button" style={ghostBtn} onClick={onNo}>
              No
            </button>
          </>
        )}

        {view === "editOverview" && (
          <>
            <button type="button" style={primaryBtn} onClick={onEditInstructions}>
              Edit the instructions
            </button>
            <button type="button" style={ghostBtn} onClick={onClose}>
              Close
            </button>
          </>
        )}

        {view === "chat" && (
          <form
            style={chatForm}
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat(input);
            }}
          >
            <input
              aria-label={`Describe what “${stageLabel}” means`}
              placeholder={`How do you want to define “${stageLabel}”?`}
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              style={chatInput}
              autoFocus
            />
            {/* Iterate vs. commit: an empty box with a draft in hand offers Save; typing new text
                switches back to Send so "type a change and Send again" actually re-invokes Haiku. */}
            {draft && !input.trim() ? (
              <button
                type="button"
                style={primaryBtn}
                disabled={busy}
                onClick={() => void persist(draft)}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            ) : (
              <button type="submit" style={primaryBtn} disabled={busy || !input.trim()}>
                {busy ? "Thinking…" : "Send"}
              </button>
            )}
          </form>
        )}

        {view === "saved" && (
          <button type="button" style={primaryBtn} onClick={onClose}>
            Close
          </button>
        )}

        {view === "loading" && <div style={{ height: 1 }} />}
      </div>
    </ModalShell>
  );
}

/** A compact, read-only view of a StageDefinition: description, criteria with auto/manual + signal
 *  badges, and (for delivered) the watched method + confidence + note. */
function DefinitionPreview({ def, stageKey }: { def: StageDefinition; stageKey: StageKey }) {
  return (
    <div style={previewCard} data-testid="definition-preview">
      {def.description && <div style={previewDesc}>{def.description}</div>}
      <ul style={critList}>
        {def.criteria.map((c, i) => (
          <li key={i} style={critItem}>
            <span style={critText}>{c.text}</span>
            <CriterionBadge c={c} />
          </li>
        ))}
      </ul>
      {stageKey === "delivered" && (def.detectedMethod || def.confidence) && (
        <div style={deliveredMeta}>
          {def.detectedMethod && (
            <span>
              Watching: <strong>{METHOD_LABEL[def.detectedMethod]}</strong>
            </span>
          )}
          {def.confidence && (
            <span style={{ marginLeft: 8 }}>
              confidence <strong>{def.confidence}</strong>
            </span>
          )}
          {def.confidenceNote && <div style={{ marginTop: 4 }}>{def.confidenceNote}</div>}
        </div>
      )}
    </div>
  );
}

function CriterionBadge({ c }: { c: StageCriterion }) {
  if (c.kind === "auto") {
    return (
      <span style={{ ...badge, color: C.successInk, borderColor: C.successInk }}>
        auto{c.signal ? ` · ${c.signal}` : ""}
      </span>
    );
  }
  return <span style={{ ...badge, color: C.muted, borderColor: C.muted }}>manual</span>;
}

// ── styles (inline CSSProperties, matching the app's convention) ────────────────────────────
const header: CSSProperties = { marginBottom: 14 };
const title: CSSProperties = { fontSize: 15, fontWeight: FONT_WEIGHT.semibold, color: C.cream };
const subtitle: CSSProperties = { fontSize: 12, color: C.muted, marginTop: 2 };

const transcript: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxHeight: "48vh",
  overflowY: "auto",
  marginBottom: 12,
};

const assistantLine: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: C.cream,
  background: "transparent",
  alignSelf: "stretch",
};

const userLine: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: C.cream,
  background: CHAT_USER_BUBBLE,
  borderRadius: 10,
  padding: "8px 11px",
  alignSelf: "flex-end",
  maxWidth: "85%",
};

const previewCard: CSSProperties = {
  border: `1px solid ${C.forest}`,
  borderRadius: 10,
  padding: "10px 12px",
  background: C.forest,
};

const previewDesc: CSSProperties = {
  fontSize: 13,
  color: C.cream,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 8,
};

const critList: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 };

const critItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12.5,
};

const critText: CSSProperties = { color: C.cream };

const badge: CSSProperties = {
  fontSize: 10.5,
  border: "1px solid",
  borderRadius: 6,
  padding: "1px 6px",
  whiteSpace: "nowrap",
  fontFamily: '"IBM Plex Mono", monospace',
};

const deliveredMeta: CSSProperties = {
  marginTop: 10,
  paddingTop: 8,
  borderTop: `1px solid ${C.deepForest}`,
  fontSize: 12,
  color: C.muted,
};

const confirmBlock: CSSProperties = { marginTop: 2 };
const confirmRow: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  fontSize: 13,
  lineHeight: 1.55,
  color: C.cream,
};

const errorBanner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  fontSize: 12.5,
  color: "#e5484d",
  border: "1px solid #e5484d",
  borderRadius: 8,
  padding: "8px 10px",
  marginBottom: 10,
};

const actions: CSSProperties = { display: "flex", gap: 8, alignItems: "center" };

const chatForm: CSSProperties = { display: "flex", gap: 8, width: "100%" };

const chatInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: C.deepForest,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "8px 11px",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const primaryBtn: CSSProperties = {
  background: ROW_ACTIVE_BUBBLE,
  color: C.cream,
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const ghostBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "8px 16px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

export default DefineStageModal;
