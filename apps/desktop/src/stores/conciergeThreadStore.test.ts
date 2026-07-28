// C2 — the concierge's visible thread survives an app restart, and cannot blow the localStorage
// quota doing it (spec §3 subsystem C2).
//
// "Simulated reload" here means what it means for any persisted zustand store: the JSON that
// `partialize` produced is what a fresh page would read back, so a test that writes through the
// store and then re-reads localStorage is testing exactly the restart path. `persist` writes
// synchronously to localStorage, so no timers are involved.
import { describe, it, expect, afterEach } from "vitest";
import {
  useConciergeThreadStore,
  persistableThread,
  rehydrateThread,
  RESTORED_ID_PREFIX,
  CONCIERGE_THREAD_MAX,
  CONCIERGE_MSG_MAX_LEN,
  CONCIERGE_TRUNCATION_SUFFIX,
  boundLiveThumbnails,
  LIVE_THUMBNAIL_MESSAGES,
  LIVE_THUMBNAIL_MAX_CHARS,
} from "./conciergeThreadStore";
import type { ConciergeMessage } from "../components/Concierge/types";

const STORAGE_KEY = "sparkle-concierge-thread";

function you(id: string, text = `msg ${id}`): ConciergeMessage {
  return { id, kind: "you", text };
}
function sparkle(id: string, text = `reply ${id}`): ConciergeMessage {
  return { id, kind: "sparkle", text };
}

/** The text of a message that has one. `ConciergeMessage` is a union and the recap variant carries no
 *  `text`, so an assertion on a bubble's words has to narrow first. */
function textOf(m: ConciergeMessage | undefined): string | undefined {
  return m && "text" in m ? m.text : undefined;
}

/** What a fresh page load would rehydrate: the persisted payload, read back out of localStorage. */
function persisted(): ConciergeMessage[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as { state: { chat: ConciergeMessage[] } }).state.chat;
}

const setChat = (next: ConciergeMessage[]) => useConciergeThreadStore.getState().setChat(next);

describe("conciergeThreadStore", () => {
  afterEach(() => {
    localStorage.clear();
    useConciergeThreadStore.setState({ chat: [] });
  });

  it("rehydrates the conversation after a simulated reload", () => {
    setChat([you("1", "how are the agents"), sparkle("2", "all calm")]);
    // The whole point of the subsystem: a fresh webview reads this back instead of an empty column.
    expect(persisted()).toEqual([you("1", "how are the agents"), sparkle("2", "all calm")]);
  });

  it("keeps the thread OLDEST FIRST, the order the view model renders", () => {
    setChat([you("1"), sparkle("2"), you("3")]);
    expect(persisted().map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("is a drop-in for the useState setter: the updater form sees the previous thread", () => {
    setChat([you("1")]);
    useConciergeThreadStore.getState().setChat((prev) => [...prev, sparkle("2")]);
    expect(useConciergeThreadStore.getState().chat.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("clearChat empties both the live thread and the persisted copy", () => {
    setChat([you("1"), sparkle("2")]);
    useConciergeThreadStore.getState().clearChat();
    expect(useConciergeThreadStore.getState().chat).toEqual([]);
    expect(persisted()).toEqual([]);
  });

  describe("does not persist feed-derived messages", () => {
    // The view model is `[...chat, ...digests, ...nudges]` and only `chat` is conversation. Digests
    // and nudges never enter `chat` at all; `recap` and `batch` do, and are the ones that have to be
    // filtered here. A restored recap would announce that agents which may no longer exist wanted
    // something from you, over an away-duration measured in a session that has ended.
    const derived: ConciergeMessage[] = [
      {
        id: "d1",
        kind: "digest",
        band: "needs_you",
        // Required since main made every construction site declare what the count promises
        // (services/conciergeDigest DigestVariant). Irrelevant to this row — it asserts a digest
        // never reaches `chat` at all — but the type must still be satisfied honestly.
        variant: "rows",
        text: "3 need you",
        leadAgentId: "a1",
      },
      {
        id: "n1",
        kind: "nudge",
        band: "needs_you",
        projectName: "p",
        agentName: "a",
        text: "t",
        actions: [],
      },
      { id: "b1", kind: "batch", text: "All projects calm" },
      { id: "r1", kind: "recap", awayMs: 60_000, needsYou: [], finished: [], decisions: [] },
    ];

    for (const m of derived) {
      it(`drops kind "${m.kind}"`, () => {
        setChat([you("1"), m, sparkle("2")]);
        expect(persisted().map((x) => x.id)).toEqual(["1", "2"]);
      });
    }

    it("leaves them in LIVE state, so the session that produced them still renders them", () => {
      // Filtering in the reducer instead would make the card vanish out from under the user the
      // instant it was posted.
      setChat([you("1"), ...derived]);
      expect(useConciergeThreadStore.getState().chat.map((m) => m.id)).toEqual([
        "1",
        "d1",
        "n1",
        "b1",
        "r1",
      ]);
    });
  });

  describe("caps (localStorage is ~5MB)", () => {
    it("keeps only the newest CONCIERGE_THREAD_MAX messages, trimming from the front", () => {
      const many = Array.from({ length: CONCIERGE_THREAD_MAX + 25 }, (_, i) => you(String(i)));
      setChat(many);
      const out = persisted();
      expect(out).toHaveLength(CONCIERGE_THREAD_MAX);
      // Newest kept, oldest dropped: entry 25 is the first survivor of 225 messages capped at 200.
      expect(out[0]?.id).toBe("25");
      expect(out.at(-1)?.id).toBe(String(CONCIERGE_THREAD_MAX + 24));
    });

    it("truncates over-long text rather than dropping the bubble", () => {
      const long = "x".repeat(CONCIERGE_MSG_MAX_LEN + 500);
      setChat([you("1", long)]);
      const out = persisted();
      // Still one bubble — a message the user actually sent has to be there when they scroll back.
      expect(out).toHaveLength(1);
      expect(textOf(out[0])).toBe("x".repeat(CONCIERGE_MSG_MAX_LEN) + CONCIERGE_TRUNCATION_SUFFIX);
    });

    it("leaves text exactly at the cap untouched (no off-by-one truncation marker)", () => {
      const exact = "y".repeat(CONCIERGE_MSG_MAX_LEN);
      setChat([sparkle("1", exact)]);
      expect(textOf(persisted()[0])).toBe(exact);
    });

    it("caps the PERSISTED copy only — live state keeps every message untruncated", () => {
      const long = "z".repeat(CONCIERGE_MSG_MAX_LEN + 10);
      const many: ConciergeMessage[] = [
        ...Array.from({ length: CONCIERGE_THREAD_MAX + 5 }, (_, i) => you(String(i))),
        sparkle("long", long),
      ];
      setChat(many);
      const live = useConciergeThreadStore.getState().chat;
      expect(live).toHaveLength(CONCIERGE_THREAD_MAX + 6);
      expect(textOf(live.at(-1))).toBe(long);
    });

    it("bounds the serialized payload well under the quota even at both caps", () => {
      // The two caps have to bound SIZE, not just count — that is the whole reason the length cap
      // exists alongside the count cap. Worst case: a full thread of maximum-length messages.
      const worst = Array.from({ length: CONCIERGE_THREAD_MAX + 50 }, (_, i) =>
        you(String(i), "w".repeat(CONCIERGE_MSG_MAX_LEN * 2)),
      );
      setChat(worst);
      const raw = localStorage.getItem(STORAGE_KEY) ?? "";
      // 200 × ~4KB ≈ 800KB — comfortably inside a ~5MB budget shared with every other store.
      expect(raw.length).toBeLessThan(1_500_000);
    });

    // A sent message now carries the files that rode with it, so the bubble can show them (PRD §8).
    // `dataUrl` is base64 — one retina screenshot is routinely 1–4MB, i.e. the entire quota in a
    // single bubble, and it arrives through a field the TEXT cap above cannot see. When the persist
    // write throws, zustand stops persisting the whole store silently.
    it("strips an attachment's base64 on the way out, keeping the record that names it", () => {
      const big = `data:image/png;base64,${"A".repeat(200_000)}`;
      setChat([
        {
          id: "you-1",
          kind: "you",
          text: "look · 1 image",
          attachments: [
            { id: "s1", kind: "image", path: "/tmp/shot.png", name: "shot.png", dataUrl: big },
          ],
        },
      ]);
      const raw = localStorage.getItem(STORAGE_KEY) ?? "";
      expect(raw).not.toContain("base64");
      expect(raw.length).toBeLessThan(2_000);

      // The record itself survives, so a restored bubble still names what was sent (it renders as a
      // chip rather than a thumbnail — MessageAttachments falls back on a missing dataUrl).
      const out = persisted()[0];
      const atts = out?.kind === "you" ? out.attachments : undefined;
      expect(atts).toEqual([
        { id: "s1", kind: "image", path: "/tmp/shot.png", name: "shot.png" },
      ]);

      // LIVE state is untouched — the session that took the screenshot must keep showing it.
      const live = useConciergeThreadStore.getState().chat[0];
      expect(live?.kind === "you" ? live.attachments?.[0]?.dataUrl : undefined).toBe(big);
    });
  });

  // The second size axis, and a DIFFERENT one from the caps above (roborev 53760). `chat` is never
  // trimmed while the session runs — CONCIERGE_THREAD_MAX applies only in `partialize` — so once a
  // sent message carries its own attachments, every `you` bubble pins its base64 for the life of the
  // process. Before that it was released at send time, when the composer row unmounted.
  describe("live retention (memory, not localStorage)", () => {
    /** A `you` message carrying one image preview of `chars` base64 characters. */
    const withImage = (id: string, chars = 100): ConciergeMessage => ({
      id,
      kind: "you",
      text: `msg ${id}`,
      attachments: [
        {
          id: `a-${id}`,
          kind: "image",
          path: `/tmp/${id}.png`,
          name: `${id}.png`,
          dataUrl: `data:image/png;base64,${"A".repeat(chars)}`,
        },
      ],
    });
    const previewOf = (m: ConciergeMessage | undefined): string | undefined =>
      m?.kind === "you" ? m.attachments?.[0]?.dataUrl : undefined;

    it("keeps previews on the newest N bubbles and strips the rest", () => {
      const many = Array.from({ length: LIVE_THUMBNAIL_MESSAGES + 3 }, (_, i) =>
        withImage(String(i)),
      );
      setChat(many);
      const live = useConciergeThreadStore.getState().chat;
      // Oldest three lost their previews…
      expect(live.slice(0, 3).map(previewOf)).toEqual([undefined, undefined, undefined]);
      // …the newest N kept theirs, and the naming record survives either way.
      expect(live.slice(3).every((m) => previewOf(m) !== undefined)).toBe(true);
      const oldest = live[0];
      expect(oldest?.kind === "you" ? oldest.attachments?.[0]?.name : "").toBe("0.png");
    });

    it("strips an oversized preview even when it is the NEWEST message", () => {
      // A count cap alone is not enough: screenshots are downscaled in Rust, but a picked or dropped
      // image is not — attachments.rs emits a data_url for anything up to 40MB.
      setChat([withImage("huge", LIVE_THUMBNAIL_MAX_CHARS + 1)]);
      expect(previewOf(useConciergeThreadStore.getState().chat[0])).toBeUndefined();
    });

    it("does not let an already-stripped bubble consume the budget", () => {
      // Otherwise the cap would ratchet down one message at a time over a long session, and the
      // newest bubble would eventually lose its thumbnail too.
      const older = Array.from({ length: LIVE_THUMBNAIL_MESSAGES * 2 }, (_, i) =>
        withImage(`old${i}`),
      );
      setChat(older);
      // Write again, appending one more: the survivors must still be the newest N.
      useConciergeThreadStore.getState().setChat((prev) => [...prev, withImage("new")]);
      const live = useConciergeThreadStore.getState().chat;
      expect(live.filter((m) => previewOf(m) !== undefined)).toHaveLength(LIVE_THUMBNAIL_MESSAGES);
      expect(previewOf(live.at(-1))).toBeDefined();
    });

    it("returns the very same array when nothing needs stripping", () => {
      // Bubbles are memoized on identity: rebuilding the array on every write would re-render the
      // whole thread on each keystroke-driven update.
      const chat = [you("1"), sparkle("2"), withImage("3")];
      expect(boundLiveThumbnails(chat)).toBe(chat);
    });

    it("leaves untouched messages referentially identical when it does strip one", () => {
      const chat = Array.from({ length: LIVE_THUMBNAIL_MESSAGES + 1 }, (_, i) =>
        withImage(String(i)),
      );
      const out = boundLiveThumbnails(chat);
      expect(out).not.toBe(chat);
      expect(out[0]).not.toBe(chat[0]); // the one that lost its preview
      expect(out.slice(1).every((m, i) => m === chat[i + 1])).toBe(true);
    });
  });

  // The tests above exercise the pure reducers. This one exercises the WIRING: that `merge` is
  // actually hooked up, so a real page load gets collision-safe ids rather than the raw persisted
  // ones. `persist.rehydrate()` re-reads localStorage through the same path a fresh page does.
  it("a real rehydration runs the payload through merge, not straight into state", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { chat: [you("you-1"), sparkle("brain-1", "from last night")] }, version: 0 }),
    );
    await useConciergeThreadStore.persist.rehydrate();
    const chat = useConciergeThreadStore.getState().chat;
    expect(chat.map((m) => m.id)).toEqual([`${RESTORED_ID_PREFIX}0`, `${RESTORED_ID_PREFIX}1`]);
    // The words themselves are what the user came back for — only the ids are rewritten.
    expect(chat.map((m) => textOf(m))).toEqual(["msg you-1", "from last night"]);
  });

  describe("rehydrateThread — restored ids must not collide with a fresh session's", () => {
    it("reindexes every restored message into the restored: namespace", () => {
      const out = rehydrateThread([you("you-1"), sparkle("brain-1"), you("you-2")]);
      expect(out.map((m) => m.id)).toEqual([
        `${RESTORED_ID_PREFIX}0`,
        `${RESTORED_ID_PREFIX}1`,
        `${RESTORED_ID_PREFIX}2`,
      ]);
    });

    it("cannot collide with the ids ConciergeHost mints on a fresh page", () => {
      // `nextId` restarts at 0 every page load (`you-1`, `sparkle-1`, `err-1`, `recap-1`) and streamed
      // replies are keyed `brain-<rust turn id>`, whose sequence also restarts with the process. So a
      // brand-new turn regenerates exactly the ids a restored bubble is holding.
      const fresh = ["you-1", "sparkle-1", "err-1", "recap-1", "brain-1", "brain-2"];
      const restored = rehydrateThread([you("you-1"), sparkle("brain-1")]).map((m) => m.id);
      for (const id of restored) expect(fresh).not.toContain(id);
    });

    it("REGRESSION: a new turn's upsert must not overwrite a restored bubble", () => {
      // This is the concrete failure the reindex prevents. ConciergeHost's streaming upsert locates
      // its bubble with `prev.findIndex((m) => m.id === k)` where `k = "brain-" + turnId`. Without
      // the reindex, a restored `brain-1` IS that index, so the new reply lands on top of an old
      // message instead of being appended — and the thread silently loses a turn.
      const restoredThread = rehydrateThread([you("you-1"), sparkle("brain-1", "last session")]);
      const k = "brain-1"; // what key(id) yields for the first turn of the new session
      expect(restoredThread.findIndex((m) => m.id === k)).toBe(-1);
      // …so the host appends, and both turns survive.
      const afterUpsert = [...restoredThread, sparkle(k, "this session")];
      expect(afterUpsert).toHaveLength(3);
      expect(afterUpsert.map((m) => textOf(m))).toEqual([
        "msg you-1",
        "last session",
        "this session",
      ]);
    });

    it("is idempotent across stacked restarts (no duplicate ids after two rounds)", () => {
      // Prefixing the original id instead of reindexing would break here: session 1's `you-1` becomes
      // `restored:you-1`, session 2 mints a fresh `you-1`, and the next restore would produce two
      // messages both claiming `restored:you-1`.
      const first = rehydrateThread([you("you-1"), sparkle("brain-1")]);
      const second = rehydrateThread([...first, you("you-1"), sparkle("brain-1")]);
      expect(new Set(second.map((m) => m.id)).size).toBe(second.length);
    });

    it("clears redirectable on a restored receipt, but keeps the rest of it", () => {
      // Only the NEWEST routed message offers the one-tap redirect, and after a restart every restored
      // receipt is old — with `sentTextRef` empty, the button would be a dead affordance.
      const [out] = rehydrateThread([
        {
          id: "you-1",
          kind: "you",
          text: "ship it",
          receipt: { target: "agent", agentName: "CI Hardening", agentId: "a1", redirectable: true },
        },
      ]);
      expect(out).toMatchObject({
        kind: "you",
        text: "ship it",
        receipt: { target: "agent", agentName: "CI Hardening", agentId: "a1", redirectable: false },
      });
    });

    it("leaves a receipt that was never redirectable alone", () => {
      const [out] = rehydrateThread([
        { id: "you-1", kind: "you", text: "hi", receipt: { target: "sparkle" } },
      ]);
      expect(out).toMatchObject({ receipt: { target: "sparkle" } });
      expect(out && "receipt" in out ? out.receipt : undefined).not.toHaveProperty(
        "redirectable",
        true,
      );
    });

    it("survives an empty or absent persisted payload", () => {
      expect(rehydrateThread([])).toEqual([]);
    });
  });

  describe("persistableThread", () => {
    it("is a no-op for a short, conversation-only thread", () => {
      const chat = [you("1"), sparkle("2")];
      expect(persistableThread(chat)).toEqual(chat);
    });

    it("does not mutate its input", () => {
      const chat = [you("1", "a".repeat(CONCIERGE_MSG_MAX_LEN + 1))];
      const snapshot = JSON.parse(JSON.stringify(chat)) as ConciergeMessage[];
      persistableThread(chat);
      expect(chat).toEqual(snapshot);
    });

    it("preserves every non-text field of a clipped message", () => {
      const msg: ConciergeMessage = {
        id: "1",
        kind: "you",
        text: "q".repeat(CONCIERGE_MSG_MAX_LEN + 1),
        receipt: { target: "agent", agentName: "CI Hardening", agentId: "a1" },
      };
      const [out] = persistableThread([msg]);
      // A restored bubble that lost its routing receipt would silently drop "where this went".
      expect(out).toMatchObject({
        id: "1",
        kind: "you",
        receipt: { target: "agent", agentName: "CI Hardening", agentId: "a1" },
      });
    });
  });
});
