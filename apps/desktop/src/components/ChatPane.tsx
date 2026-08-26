import { memo, useCallback, useMemo, useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
// The design scale, not literals: `theme/scale.test.ts` is a RATCHET at ceiling 0 for
// off-scale `fontSize`/`borderRadius`, and `RADIUS.bubble` is named for this exact call site.
import { FONT_UI, RADIUS, SPACE, TYPE } from "../theme/scale";
import { paneVisibilityStyle } from "./paneVisibility";
import { Markdown } from "./Markdown";
import { useAutoFollow } from "../hooks/useAutoFollow";
import { socialIdFromPersonAgentId } from "../engine/social";
import {
  chatContentKey,
  chatRearmKey,
  sendableBody,
  type ChatMessage,
  type ChatSendExtras,
  type ChatThreadSource,
} from "../engine/chatThread";
import { personName, useSocialStore } from "../stores/socialStore";
import {
  CHAT_COMPOSER_PLACEHOLDER_UNWIRED,
  CHAT_EMPTY_BODY,
  CHAT_EMPTY_TITLE,
  CHAT_ERROR_TITLE,
  CHAT_LOADING,
  CHAT_NO_PERSON,
  CHAT_SEND_FAILED,
  CHAT_SEND_LABEL,
  CHAT_SENDING,
  CHAT_UNWIRED_BODY,
  CHAT_UNWIRED_TITLE,
  chatComposerPlaceholder,
  chatPaneLabel,
} from "./chatCopy";

/** A hook returning this pane's thread. See {@link ChatPaneProps.useThread}. */
export type UseChatThread = (socialId: string) => ChatThreadSource;

/**
 * THE DEFAULT SEAM — an honest no-transport thread.
 *
 * The server half of Social Coding (design stage S4: conversations, messages, HTTP send, socket
 * notify) is built in parallel with this pane, so on the day the pane lands there is nothing for it
 * to talk to. This is what it talks to instead, and the state it reports is `"unwired"` rather than
 * `"ready"` with an empty list — those are different facts and the pane paints them differently.
 * An empty `ready` thread claims "nobody has sent anything", which is a statement about the
 * conversation the app is in no position to make.
 *
 * ⚠️ A DEFAULTED SEAM THAT EVERY TEST INJECTS IS A LINE COVERED BY NOTHING (a measured failure mode
 * in this repo — see AGENTS.md, "a defaulted seam every test injects"): delete the default and the
 * suite stays green while the real app renders `undefined`. So `ChatPane.default.test.tsx` mounts
 * this pane with NO `useThread` prop and asserts what this function produces — the unwired notice
 * and a composer that refuses to send.
 *
 * It is a hook by shape and not by behaviour (it calls nothing), so the object is module-frozen
 * rather than rebuilt per render: a fresh identity here would change `contentKey` on every tick.
 */
const UNWIRED_THREAD: ChatThreadSource = Object.freeze({
  messages: Object.freeze([]) as readonly ChatMessage[],
  state: "unwired" as const,
  error: null,
  // Never throws, per `ChatSendResult`'s contract — a rejected promise crossing the submit handler
  // is how a user's words get lost instead of staying on screen.
  send: async () => ({ ok: false as const, reason: "no_transport" }),
});
export function useUnwiredChatThread(): ChatThreadSource {
  return UNWIRED_THREAD;
}

export interface ChatPaneProps {
  /** Is this pane the stage's active surface? Drives `paneVisibilityStyle` and nothing else — the
   *  pane stays MOUNTED when false. */
  visible: boolean;
  /**
   * The person mount id — `person:<social_id>`, from `engine/social.personAgentId`.
   *
   * A person is addressed through the SAME `agentId` plumbing a build agent is, and this pane takes
   * the same `{ visible, agentId }` props `SparkleAgentPane` does for that reason. It does NOT take
   * a bare `social_id`: every other surface in the mount path (`mountedThreadStore`, `draftKey`,
   * `routableMountedAgentId`) holds the prefixed form, and a pane that took the unprefixed one
   * would be the one place a caller has to remember to strip it.
   */
  agentId: string;
  /**
   * WHERE THE MESSAGES COME FROM AND WHERE THE SENDS GO — injected, defaulted, never imported.
   *
   * This pane must not reach for `services/socialApi`: that module and this one are being built at
   * the same time by different people, and a direct call would pin the pane to whatever signature
   * happened to exist on the day it was written. S4's real transport arrives as a different value
   * for this prop, with no change to any signature here.
   *
   * ⚠️ IT IS CALLED AS A HOOK, so it must be one: called unconditionally, same hook count every
   * render, stable identity across renders of a given pane. Passing a fresh inline closure per
   * render is safe only while the closure's own hook count is constant.
   */
  useThread?: UseChatThread;
}

/**
 * ══ THE PERSON CHAT PANE — a direct child of `terminal-stage` ═══════════════════════════════════
 *
 * Bead `sparkle-xnjil.10`. Design: `docs/superpowers/specs/2026-08-05-social-coding-design.md`
 * §9 row U5 and §10 "Key UI design calls".
 *
 * `position: absolute; inset: 0`, spread `paneVisibilityStyle(visible)` — `SparkleAgentPane`'s
 * shape exactly, because it solves the same problem: several panes stacked in one stage, one of
 * them painting.
 *
 * ── NOT `PaneHost`, AND THAT IS THE POINT OF THE WHOLE FILE ─────────────────────────────────────
 * `PaneHost` exists for ONE reason: to keep a PTY alive across re-parenting when a project moves
 * between pairs (`Workspace.paneMounting.test.tsx` is its guard, and it probes for the absence of a
 * teardown). A chat pane has no PTY to lose, no xterm, and no FitAddon that has to be measured in a
 * box that was never `display: none`. Routing it through the portal would buy nothing and would add
 * this pane to a mechanism whose every invariant is about a terminal.
 *
 * ── ONE SURFACE AT A TIME ───────────────────────────────────────────────────────────────────────
 * `Workspace.paneVisibleAgentId.right` MUST be null while a chat is active, or the selected agent's
 * pane paints underneath this one. That guard is in `Workspace.tsx`, alongside the identical ones
 * for `sparkleActive` / `researchActive` / `boardActive`, and `Workspace.chatPane.test.tsx` asserts
 * both directions of it.
 *
 * ── HIDDEN, NOT UNMOUNTED; AND THE INNER THREAD IS KEYED ON THE PERSON ──────────────────────────
 * The pane stays mounted and merely invisible, so a chat you flick away from and back to is the
 * same component instance. The INNER thread carries `key={socialId}`, so switching people swaps the
 * conversation — a half-typed message to one person can never surface in another's box — while the
 * pane around it is untouched.
 *
 * ══ IT HAS ITS OWN COMPOSER, AND THAT IS NOT A REGRESSION ══════════════════════════════════════
 *
 * READ THIS BEFORE REMOVING IT. `SparkleAgentPane`'s docstring says its composer was deleted
 * because "Improve Sparkle had two ways in while everything else had one", and this pane looks like
 * the same mistake being made again. It is the same RULE reaching the opposite outcome.
 *
 * The rule is ONE INPUT SURFACE PER PANE. `SparkleAgentPane` already had one — the terminal, which
 * is a row you type into — so its compose box was the second, and the founder had it removed on
 * sight: *"You added a secondary composed window to improve sparkle I don't need that."*
 *
 * THIS PANE HAS NO TERMINAL AND THEREFORE NO INPUT SURFACE AT ALL. Without a composer it is
 * read-only: a conversation you can watch and cannot answer. The founder asked for the opposite in
 * the sentence that specified this pane — *"I can optionally have the Concierge mounted to be
 * chatting with that user or I can just be chatting directly with that user in the terminal pane"*
 * — so the composer here IS the pane's one input surface, not a second one. Removing it does not
 * restore parity with `SparkleAgentPane`; it removes the only way to use the feature.
 *
 * ══ R3 IS ABSOLUTE: CHAT TEXT NEVER REACHES AN AGENT'S STDIN ═══════════════════════════════════
 *
 * Design §9, "Do NOT defer". Nothing in this file may route a peer's words — or the user's words to
 * a peer — into a PTY (`pty_write`), a prompt, or a concierge dispatch. The submit handler below
 * calls exactly one thing, the injected `send`, and `ChatPane.r3.test.tsx` proves it by asserting
 * both halves: the transport got the text, and no Tauri command was invoked at all.
 *
 * ── REGISTER ───────────────────────────────────────────────────────────────────────────────────
 * `Markdown` at its default `face="ui"`, and the pane's own type is `FONT_UI`. Deliberately NOT
 * `terminalChrome`'s `TERM_BODY_*`: that is the register in which a machine speaks, and every
 * person on the other end of this pane is a human.
 */
export function ChatPane({ visible, agentId, useThread = useUnwiredChatThread }: ChatPaneProps) {
  const socialId = socialIdFromPersonAgentId(agentId);
  // Read-only view of the sibling's roster: this pane never writes to `socialStore`.
  const person = useSocialStore((s) => (socialId ? s.people[socialId] : undefined));
  const name = person ? personName(person) : (socialId ?? "");

  return (
    <div
      data-testid="chat-pane"
      data-chat-social-id={socialId ?? ""}
      role="region"
      aria-label={chatPaneLabel(name)}
      style={{
        position: "absolute",
        inset: 0,
        // Hidden WITHOUT collapsing the box, exactly as every other pane in this stage does. There
        // is no terminal here to be mis-measured, but the stacking contract is shared: see
        // paneVisibility.ts.
        ...paneVisibilityStyle(visible),
        flexDirection: "column",
        background: C.forest,
        fontFamily: FONT_UI,
        color: C.cream,
      }}
    >
      {socialId === null ? (
        // NOT an empty render. A pane that paints nothing is indistinguishable from one that failed
        // to mount, and this branch is reachable only through a caller bug — so it should say so.
        <div data-testid="chat-no-person" style={EMPTY_WRAP}>
          <div style={EMPTY_TITLE}>{CHAT_NO_PERSON}</div>
        </div>
      ) : (
        // ── THE KEY IS THE WHOLE POINT ────────────────────────────────────────────────────────
        // Switching people REPLACES this subtree (its draft, its scroll position, its follow
        // state) while leaving the pane above it mounted. Without the key, React would reuse the
        // instance and Alice's half-typed message would appear in Bob's composer.
        <ChatThread key={socialId} socialId={socialId} name={name} useThread={useThread} />
      )}
    </div>
  );
}

const EMPTY_WRAP: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: SPACE.xl,
  textAlign: "center",
};
const EMPTY_TITLE: React.CSSProperties = { fontWeight: FONT_WEIGHT.semibold, fontSize: TYPE.body };
const EMPTY_BODY: React.CSSProperties = { color: C.muted, fontSize: TYPE.small, maxWidth: 380 };

/** One person's conversation. Mounted under `key={socialId}` — see {@link ChatPane}. */
function ChatThread({
  socialId,
  name,
  useThread,
}: {
  socialId: string;
  name: string;
  useThread: UseChatThread;
}) {
  const thread = useThread(socialId);
  const { messages, state } = thread;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const contentKey = useMemo(() => chatContentKey(messages), [messages]);
  const rearmKey = useMemo(() => chatRearmKey(messages), [messages]);
  const { scrollRef, onScroll } = useAutoFollow({
    contentKey,
    rearmKey,
    onReachTop: thread.onReachTop,
  });

  const canSend = state !== "unwired" && sendableBody(draft) !== null && !sending;

  const submit = useCallback(async () => {
    const body = sendableBody(draft);
    if (body === null || state === "unwired") return;
    // CLEAR OPTIMISTICALLY, so the box is ready for the next line the instant the key is pressed —
    // the transport owns the echo, and a failed send keeps the words in the thread (see
    // `ChatMessage.failed`) rather than in the box.
    setDraft("");
    setSending(true);
    try {
      // THE ONLY CALL THIS HANDLER MAKES. R3: no PTY, no prompt, no concierge dispatch. The two
      // optional fields are passed through as `undefined` deliberately — the signature carries
      // `mentions` and `attachments` from day one so the deferred features (bead
      // `sparkle-xnjil.17`) need no change here, and nothing produces them yet.
      const extras: ChatSendExtras = {};
      await thread.send(body, extras);
    } finally {
      setSending(false);
    }
  }, [draft, state, thread]);

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="chat-thread"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: SPACE.sm,
          padding: `${SPACE.lg}px ${SPACE.xl}px`,
        }}
      >
        {state === "loading" && messages.length === 0 && (
          <div data-testid="chat-loading" style={EMPTY_WRAP}>
            <div style={EMPTY_BODY}>{CHAT_LOADING}</div>
          </div>
        )}
        {state === "error" && (
          <div data-testid="chat-error" role="alert" style={EMPTY_WRAP}>
            <div style={EMPTY_TITLE}>{CHAT_ERROR_TITLE}</div>
            {thread.error ? <div style={EMPTY_BODY}>{thread.error}</div> : null}
          </div>
        )}
        {state === "unwired" && (
          <div data-testid="chat-unwired" style={EMPTY_WRAP}>
            <div style={EMPTY_TITLE}>{CHAT_UNWIRED_TITLE}</div>
            <div style={EMPTY_BODY}>{CHAT_UNWIRED_BODY}</div>
          </div>
        )}
        {state === "ready" && messages.length === 0 && (
          <div data-testid="chat-empty" style={EMPTY_WRAP}>
            <div style={EMPTY_TITLE}>{CHAT_EMPTY_TITLE}</div>
            <div style={EMPTY_BODY}>{CHAT_EMPTY_BODY}</div>
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} peerName={name} />
        ))}
      </div>

      {/* THE COMPOSER — this pane's ONE input surface. See the file docstring before removing it. */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "flex-end",
          gap: SPACE.sm,
          padding: `${SPACE.nav}px ${SPACE.md}px`,
          borderTop: `1px solid ${C.hairline}`,
          background: C.conciergeSurface,
        }}
      >
        <textarea
          data-testid="chat-composer"
          aria-label={
            state === "unwired" ? CHAT_COMPOSER_PLACEHOLDER_UNWIRED : chatComposerPlaceholder(name)
          }
          placeholder={
            state === "unwired" ? CHAT_COMPOSER_PLACEHOLDER_UNWIRED : chatComposerPlaceholder(name)
          }
          value={draft}
          disabled={state === "unwired"}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks a line — the shape every compose surface in this app
            // already uses, so a person does not have to learn a second one.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          style={{
            flex: 1,
            resize: "none",
            minHeight: 34,
            maxHeight: 160,
            padding: `${SPACE.sm}px ${SPACE.nav}px`,
            borderRadius: RADIUS.input,
            border: `1px solid ${C.inputEdge}`,
            background: C.inputSurface,
            color: C.cream,
            fontFamily: FONT_UI,
            fontSize: TYPE.body,
            lineHeight: 1.4,
          }}
        />
        <button
          type="button"
          data-testid="chat-send"
          disabled={!canSend}
          onClick={() => void submit()}
          style={{
            flex: "0 0 auto",
            border: "none",
            borderRadius: RADIUS.input,
            padding: `${SPACE.sm}px ${SPACE.lg}px`,
            background: canSend ? C.teal : C.pillFill,
            color: canSend ? ON_BRAND_FILL : C.muted,
            fontFamily: FONT_UI,
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPE.body,
            cursor: canSend ? "pointer" : "default",
          }}
        >
          {CHAT_SEND_LABEL}
        </button>
      </div>
    </>
  );
}

/**
 * One message. TWO-SIDED BUBBLES — the peer's words are prose in the UI face, flush left; yours are
 * a filled bubble flush right.
 *
 * `CHAT_USER_BUBBLE` is the fill, reused rather than re-picked: it is already what a message the
 * user wrote looks like everywhere else in this app, and a second blue would make "mine" mean two
 * things. And `terminalChrome`'s `TERM_BODY_*` is deliberately absent — that register says "a
 * machine is speaking", which is exactly wrong for the other end of this pane.
 */
const ChatBubble = memo(function ChatBubble({
  message,
  peerName,
}: {
  message: ChatMessage;
  peerName: string;
}) {
  const mine = message.mine;
  return (
    <div
      data-testid={`chat-msg-${message.id}`}
      data-mine={String(mine)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: mine ? "flex-end" : "flex-start",
        maxWidth: "100%",
      }}
    >
      {!mine && (
        <div style={{ fontSize: TYPE.small, color: C.muted, marginBottom: 2 }}>
          {message.author || peerName}
        </div>
      )}
      <div
        style={{
          maxWidth: "82%",
          padding: `${SPACE.sm}px ${SPACE.input}px`,
          borderRadius: RADIUS.bubble,
          background: mine ? CHAT_USER_BUBBLE : C.conciergeSurfaceLifted,
          color: C.cream,
          fontSize: TYPE.body,
          // A pending bubble is dimmed rather than removed or badged in place — the words stay
          // exactly where they will settle, so an ack changes nothing the reader is looking at.
          opacity: message.pending ? 0.7 : 1,
        }}
      >
        <Markdown text={message.body} />
      </div>
      {(message.pending || message.failed) && (
        <div
          data-testid={`chat-msg-state-${message.id}`}
          style={{ fontSize: TYPE.small, color: message.failed ? C.dangerInk : C.muted, marginTop: 2 }}
        >
          {message.failed ? CHAT_SEND_FAILED : CHAT_SENDING}
        </div>
      )}
    </div>
  );
});
