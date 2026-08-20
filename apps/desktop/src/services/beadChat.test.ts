// The bead card's Chat dispatch. Every row here asserts a SIDE EFFECT of the call — what landed in
// `composeHandoffStore` — because the only thing this module does is write there. Asserting that
// the function exists, or that it returned undefined, would pass against an empty body.
//
// The literal is asserted against `insertMention`'s OWN output, not against a hand-typed string:
// the whole contract of this module is that its text is indistinguishable from what the founder
// would have got by picking the bead out of the mention picker. A copy of the expected spelling
// here would go on passing after a change to `beadMentionLabel` that broke exactly that.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchBeadChat, beadChatDraft } from "./beadChat";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import {
  MENTION_SIGIL,
  beadMentionId,
  beadMentionLabel,
  insertMention,
  mentionsIn,
  MAX_BEAD_MENTION_LABEL,
} from "../components/Concierge/mentions";
import type { MentionAgent } from "../components/Concierge/mentions";
import type { Bead } from "./beads";
import { log } from "../logger";

/** The roster row a bead becomes — the same shape the picker's roster carries. `projectId`/
 *  `projectName` are empty because a bead has no project NAME in the roster (that is exactly why
 *  `withMentionLabels` disambiguates a bead by its id rather than by a project suffix), and
 *  `canAcceptInput` is false because a bead is a REFERENT, never a destination. */
function beadRow(b: Bead): MentionAgent {
  return {
    id: beadMentionId(b.id),
    name: beadMentionLabel(b.title, b.id),
    projectId: "",
    projectName: "",
    band: "done",
    canAcceptInput: false,
    kind: "bead",
  };
}

const store = () => useComposeHandoffStore.getState();

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Chat button on every bead card",
    description: "",
    status: "open",
    type: "task",
    priority: 0,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const B = bead({ id: "sparkle-1cpomd" });

beforeEach(() => useComposeHandoffStore.setState({ handoff: null }));

describe("dispatchBeadChat — what actually lands in the composer handoff", () => {
  it("writes the RE: draft, the sparkle route and the bead-chat origin", () => {
    dispatchBeadChat(B, "proj-1");
    const h = store().take();
    expect(h).not.toBeNull();
    expect(h!.text).toBe("RE: @Chat button on every bead card ");
    expect(h!.origin).toBe("bead-chat");
    expect(h!.projectId).toBe("proj-1");
    expect(h!.attachments).toEqual([]);
    // The founder pressed Chat, next to a Build It he did NOT press. Without this the concierge's
    // auto-router can aim the draft at whatever build agent is on screen — captureSends.ts:197-199.
    expect(h!.route).toBe("sparkle");
  });

  // ══ THE TRAILING SPACE ════════════════════════════════════════════════════════════════════════
  // Its own row, because it is invisible in the assertion above and every other row would still
  // pass without it. It terminates the mention (so the next keystroke cannot extend the label into
  // something matching no referent, silently dropping the aim) and puts the caret where the next
  // word goes.
  it("ends in a SPACE, so the mention is terminated and the caret is past it", () => {
    dispatchBeadChat(B, "p");
    const text = store().take()!.text;
    expect(text.endsWith(" ")).toBe(true);
    expect(text).not.toBe(text.trimEnd());
  });

  // ══ THE POINT OF THE WHOLE MODULE ═════════════════════════════════════════════════════════════
  // The pill is drawn because the mention is RECORDED FROM THE TEXT. So the literal must be byte
  // for byte what `insertMention` writes — derived here from `insertMention` itself rather than
  // retyped, so a change to either side fails this row instead of drifting past it.
  it("emits the SAME literal insertMention would have written from the picker", () => {
    // What the founder gets by typing "@" into an empty box and picking this bead.
    const picked = insertMention("", 0, 0, beadRow(B)).text;
    dispatchBeadChat(B, "p");
    expect(store().take()!.text).toBe(`RE: ${picked}`);
  });

  // …AND THAT LITERAL RESOLVES. The row above pins the spelling; this one proves the spelling is
  // one the mention scanner actually matches — a mention nothing records draws no pill, which is
  // the failure the founder would see.
  it("the draft resolves to a recorded BEAD mention against the roster", () => {
    const roster = [beadRow(B)];
    dispatchBeadChat(B, "p");
    const found = mentionsIn(store().take()!.text, roster);
    expect(found).toHaveLength(1);
    expect(found[0]!.agentId).toBe(beadMentionId(B.id));
  });

  // NEVER a markdown link. A sent USER bubble does not render markdown, so `[@Title](…)` would show
  // the founder raw brackets — and it would match no roster entry, so no pill either.
  it("is a bare mention literal, not a markdown link", () => {
    dispatchBeadChat(B, "p");
    const text = store().take()!.text;
    expect(text).not.toContain("](");
    expect(text.startsWith(`RE: ${MENTION_SIGIL}`)).toBe(true);
  });

  // The label is `beadMentionLabel`'s, so a sentence-length title is TRUNCATED rather than pasting
  // a paragraph into the composer for a one-word reference.
  it("truncates a long title through beadMentionLabel rather than pasting it whole", () => {
    const long = bead({ id: "sparkle-long", title: "x".repeat(200) });
    dispatchBeadChat(long, "p");
    const text = store().take()!.text;
    expect(text.length).toBeLessThan(long.title.length);
    expect(text).toBe(`RE: ${MENTION_SIGIL}${beadMentionLabel(long.title, long.id)} `);
    expect(text).toContain("…");
    expect(MAX_BEAD_MENTION_LABEL).toBeLessThan(long.title.length);
  });

  // A bead whose title normalises to nothing still gets an address — the id. Otherwise the draft
  // would read "RE: @ " and match nothing.
  it("falls back to the id when a title normalises away", () => {
    const blank = bead({ id: "sparkle-blank", title: "   " });
    dispatchBeadChat(blank, "p");
    expect(store().take()!.text).toBe(`RE: ${MENTION_SIGIL}sparkle-blank `);
  });

  it("beadChatDraft is the same string the dispatch writes", () => {
    dispatchBeadChat(B, "p");
    expect(store().take()!.text).toBe(beadChatDraft(B));
  });

  // Diagnostic, and the reason a future re-homing of the compose box fails loudly: the store's
  // header states that every producer logs its handoff.
  it("logs the handoff by bead ID, never by title", () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});
    dispatchBeadChat(B, "proj-1");
    expect(spy).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(spy.mock.calls[0]);
    expect(serialized).toContain("sparkle-1cpomd");
    expect(serialized).not.toContain(B.title);
    spy.mockRestore();
  });
});
