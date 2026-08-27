// THE COMPOSE WINDOW for pinging @improve / @sparkle and watching the reply come back.
//
// The founder's ask (bead sparkle-hdlhox): let him ping the two Sparkle-side agents HIMSELF, not
// only have them talk to each other. He types "@improve why is CI red?", presses Send, and sees:
//   • his own line, tagged with WHICH agent it went to (the target pill),
//   • a PENDING row ("Improve Sparkle is thinking…") — never a false "no response" blank,
//   • the agent's reply when it arrives.
//
// The parse (`mentionHandles`), the transport (`mentionChannel`) and the turn lifecycle
// (`useMentionChannel`) are all separate, pure-where-possible modules; this file is the presentation
// only. It reuses the app's mention vocabulary (`MentionPill`) and theme tokens (`theme/colors`) so
// it reads as one surface with the concierge, not a bolted-on panel.
import { useMemo, useState, type KeyboardEvent } from "react";
import { C } from "../../theme/colors";
import { RADIUS } from "../../theme/scale";
import { MentionPill } from "../Concierge/MentionPill";
import {
  candidateTargets,
  leadingHandleQuery,
  MENTION_SIGIL,
  type MentionTarget,
} from "./mentionHandles";
import {
  useMentionChannel,
  type MentionTurn,
  type SendRejection,
  type UseMentionChannelOptions,
} from "./useMentionChannel";

export interface MentionComposePanelProps extends UseMentionChannelOptions {
  /** Optional placeholder override; defaults to a line naming both handles. */
  placeholder?: string;
}

/** The at-a-glance hint under the box for why a send did not go out. */
function rejectionHint(reason: SendRejection, token?: string): string {
  switch (reason) {
    case "no-handle":
      return `Start with ${MENTION_SIGIL}improve or ${MENTION_SIGIL}sparkle to pick who answers.`;
    case "unknown-handle":
      return `${MENTION_SIGIL}${token ?? ""} isn't a handle — try ${MENTION_SIGIL}improve or ${MENTION_SIGIL}sparkle.`;
    case "empty":
      return "Type a message after the handle.";
  }
}

export function MentionComposePanel(props: MentionComposePanelProps) {
  const { placeholder, ...channelOpts } = props;
  const { turns, send } = useMentionChannel(channelOpts);
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  // The typeahead: open only while a leading `@…` is being typed (no space yet).
  const query = leadingHandleQuery(text);
  const candidates = useMemo(() => (query === null ? [] : candidateTargets(query)), [query]);
  const showPicker = query !== null && candidates.length > 0;

  const submit = (): void => {
    const outcome = send(text);
    if (outcome.ok) {
      setText("");
      setHint(null);
    } else {
      setHint(rejectionHint(outcome.reason, outcome.token));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  };

  const choose = (t: MentionTarget): void => {
    setText(`${MENTION_SIGIL}${t.token} `);
    setHint(null);
  };

  return (
    <section
      data-testid="mention-compose-panel"
      aria-label="Ping a Sparkle agent"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        background: C.conciergeSurface,
        color: C.cream,
        borderRadius: RADIUS.modal,
      }}
    >
      <div
        data-testid="mention-transcript"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {turns.length === 0 ? (
          <p data-testid="mention-empty" style={{ margin: 0, color: C.muted, fontSize: 13 }}>
            Ping {MENTION_SIGIL}improve or {MENTION_SIGIL}sparkle and their answer shows up here.
          </p>
        ) : (
          turns.map((t) => <TurnRow key={t.id} turn={t} />)
        )}
      </div>

      <div style={{ position: "relative" }}>
        {showPicker && (
          <ul
            data-testid="mention-picker"
            role="listbox"
            style={{
              listStyle: "none",
              margin: 0,
              marginBottom: 6,
              padding: 4,
              background: C.conciergeSurfaceLifted,
              border: `1px solid ${C.hairline}`,
              borderRadius: RADIUS.input,
            }}
          >
            {candidates.map((t) => (
              <li key={t.handle}>
                <button
                  type="button"
                  data-testid={`mention-candidate-${t.handle}`}
                  onMouseDown={(e) => {
                    // mousedown, not click: keep focus off the textarea's blur so the pick lands.
                    e.preventDefault();
                    choose(t);
                  }}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    width: "100%",
                    padding: "4px 6px",
                    background: "transparent",
                    border: "none",
                    color: C.cream,
                    cursor: "pointer",
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {MENTION_SIGIL}
                    {t.token}
                  </span>
                  <span style={{ color: C.muted, fontSize: 12 }}>{t.blurb}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          data-testid="mention-input"
          aria-label="Message to a Sparkle agent"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (hint) setHint(null);
          }}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={placeholder ?? `${MENTION_SIGIL}improve or ${MENTION_SIGIL}sparkle — ask them anything`}
          style={{
            width: "100%",
            resize: "vertical",
            padding: 8,
            background: C.inputSurface,
            color: C.cream,
            border: `1px solid ${C.inputEdge}`,
            borderRadius: RADIUS.input,
            font: "inherit",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
          <span data-testid="mention-hint" style={{ color: C.amberInk, fontSize: 12, minHeight: 16 }}>
            {hint ?? ""}
          </span>
          <button
            type="button"
            data-testid="mention-send"
            onClick={submit}
            style={{
              padding: "4px 14px",
              background: C.accentInk,
              color: C.conciergeSurface,
              border: "none",
              borderRadius: RADIUS.input,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}

/** One sent-and-answered exchange. Always shows WHICH agent it went to and its live status. */
function TurnRow({ turn }: { turn: MentionTurn }) {
  return (
    <div data-testid="mention-turn" data-target={turn.target.handle} data-status={turn.status}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <MentionPill agentId={`mention:${turn.target.handle}`} testId="mention-turn-pill">
          {MENTION_SIGIL}
          {turn.target.token}
        </MentionPill>
        <span style={{ color: C.cream, fontSize: 13 }}>{turn.body}</span>
      </div>
      <div style={{ marginTop: 4, marginLeft: 4 }}>
        {turn.status === "pending" && (
          <span data-testid="mention-pending" style={{ color: C.muted, fontSize: 12, fontStyle: "italic" }}>
            {turn.target.displayName} is thinking…
          </span>
        )}
        {turn.status === "arrived" && (
          <p
            data-testid="mention-reply"
            style={{
              margin: 0,
              padding: "6px 8px",
              background: C.conciergeSurfaceLifted,
              borderRadius: RADIUS.bubble,
              color: C.cream,
              fontSize: 13,
            }}
          >
            <span style={{ color: C.tealInk, fontWeight: 600, marginRight: 6 }}>
              {turn.target.displayName}
            </span>
            {turn.reply}
          </p>
        )}
        {turn.status === "error" && (
          <span data-testid="mention-error" style={{ color: C.dangerInk, fontSize: 12 }}>
            Couldn't reach {turn.target.displayName}: {turn.error}
          </span>
        )}
      </div>
    </div>
  );
}
