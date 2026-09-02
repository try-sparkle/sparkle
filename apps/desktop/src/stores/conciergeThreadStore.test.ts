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
  LIVE_THUMBNAIL_TOTAL_CHARS,
  BRAIN_ID_PREFIX,
  endStreamsThrough,
} from "./conciergeThreadStore";
import {
  LINT_CHECK_MAX_LEN,
  LINT_DETAIL_MAX_LEN,
  MAX_LINT_MARKS,
} from "../components/Concierge/lintMarks";
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
    const back = persisted();
    // The whole point of the subsystem: a fresh webview reads this back instead of an empty column.
    // `arrivedAt` is stripped for the comparison because its value is the CLOCK's, not the fixture's
    // — it is asserted on its own terms immediately below.
    expect(back.map(({ arrivedAt: _arrivedAt, ...rest }) => rest)).toEqual([
      you("1", "how are the agents"),
      sparkle("2", "all calm"),
    ]);
    // …AND EVERY TURN COMES BACK WITH THE INSTANT IT ARRIVED (bead sparkle-75fbot). This is the one
    // test that reads the real localStorage payload rather than calling `persistableThread`
    // directly, so it is where "the stamp reaches disk" is actually pinned: a thread artifact
    // derives its position in the transcript from these, and without them a restored thread cannot
    // say when anything happened.
    expect(back.map((m) => typeof m.arrivedAt)).toEqual(["number", "number"]);
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
      // chip rather than a thumbnail — AttachmentStrip falls back on a missing dataUrl).
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

    // THE AGGREGATE AXIS (roborev 53786). The message cap and the per-attachment cap bound their
    // own axes and nothing bounds the sum: nothing limits attachments PER MESSAGE — the composer
    // and loadAttachmentPaths load every dropped path — so one drop of 20 photos used to pin
    // 20 × up to 4M chars, and six such bubbles multiplied it. Same unbounded retention this
    // function exists to close, reached sideways.
    describe("total character budget", () => {
      /** One `you` message carrying several previews, each `chars` base64 characters. */
      const withImages = (id: string, count: number, chars: number): ConciergeMessage => ({
        id,
        kind: "you",
        text: `msg ${id}`,
        attachments: Array.from({ length: count }, (_, i) => ({
          id: `a-${id}-${i}`,
          kind: "image" as const,
          path: `/tmp/${id}-${i}.png`,
          name: `${id}-${i}.png`,
          dataUrl: `data:image/png;base64,${"A".repeat(chars)}`,
        })),
      });
      const previewsOf = (m: ConciergeMessage | undefined): (string | undefined)[] =>
        m?.kind === "you" ? (m.attachments ?? []).map((a) => a.dataUrl) : [];

      /** A preview just inside the per-attachment cap, so only the AGGREGATE can reject it. */
      const NEAR_MAX = LIVE_THUMBNAIL_MAX_CHARS - 100;
      /** How many of those the total admits. The total is 3× the per-attachment cap, so three
       *  near-max previews fit and the fourth cannot — whether they sit in one bubble or six. */
      const FITS = 3;
      const kept = (previews: (string | undefined)[]) => previews.filter((p) => p !== undefined);

      it("keeps only SOME previews of a single multi-attachment message", () => {
        // The case the old caps missed entirely: one drop, five photos, one bubble. The message cap
        // sees a single message and the per-attachment cap sees five acceptable images.
        const out = boundLiveThumbnails([withImages("drop", 5, NEAR_MAX)]);
        const previews = previewsOf(out[0]);
        expect(kept(previews)).toHaveLength(FITS);
        // Array order within the message, so the tiles that keep their thumbnail are the leading
        // ones the reader sees first — not an arbitrary subset.
        expect(previews.slice(FITS)).toEqual([undefined, undefined]);
        // The retained previews really do fit the budget, which is the property being bought.
        expect(kept(previews).reduce((n, p) => n + p!.length, 0)).toBeLessThanOrEqual(
          LIVE_THUMBNAIL_TOTAL_CHARS,
        );
        // The naming record survives stripping, exactly as on the other axes.
        const stripped = out[0]?.kind === "you" ? out[0].attachments?.[4] : undefined;
        expect(stripped?.name).toBe("drop-4.png");
      });

      it("spends the budget ACROSS messages, newest first", () => {
        // Four bubbles, comfortably inside the message cap of 6, that together overrun the total.
        const chat = Array.from({ length: FITS + 1 }, (_, i) => withImages(`m${i}`, 1, NEAR_MAX));
        const out = boundLiveThumbnails(chat);
        expect(previewsOf(out[0])).toEqual([undefined]); // the oldest loses it…
        expect(out.slice(1).every((m) => previewsOf(m)[0] !== undefined)).toBe(true); // …newest keep
      });

      it("does not let OVERSIZED previews eat the aggregate on their way out", () => {
        // The per-attachment cap is the FAST REJECT: an oversized preview is stripped and costs the
        // total nothing, so the ordinary preview behind it still fits. If it decremented the budget
        // instead, a few 40 MB pastes would strip the whole thread behind them.
        //
        // THREE oversized bubbles, not one, and that is the whole point of the fixture: one would
        // leave 8.3M chars of budget even if it DID charge, so the ordinary preview would survive
        // either way and the test could not fail on the behaviour it names (roborev 53894). Three
        // at 4.19M each overrun the 12.58M total, so charging them strips the ordinary one.
        const huge = LIVE_THUMBNAIL_MAX_CHARS + 1;
        const out = boundLiveThumbnails([
          withImage("ordinary"), // oldest, so it is spent LAST
          withImages("huge1", 1, huge),
          withImages("huge2", 1, huge),
          withImages("huge3", 1, huge),
        ]);
        expect(previewsOf(out[1])).toEqual([undefined]);
        expect(previewsOf(out[2])).toEqual([undefined]);
        expect(previewsOf(out[3])).toEqual([undefined]);
        expect(previewOf(out[0])).toBeDefined();
      });

      it("an oversized attachment does not exhaust the budget for its own SIBLINGS", () => {
        // Same invariant one level down: the fast reject must not set `exhausted`, or a single
        // oversized image in a drop would cost every tile after it in the SAME bubble.
        const chat: ConciergeMessage[] = [
          {
            id: "mixed",
            kind: "you",
            text: "one bad apple",
            attachments: [
              {
                id: "a-huge",
                kind: "image",
                path: "/tmp/huge.png",
                name: "huge.png",
                dataUrl: `data:image/png;base64,${"A".repeat(LIVE_THUMBNAIL_MAX_CHARS + 1)}`,
              },
              {
                id: "a-ok",
                kind: "image",
                path: "/tmp/ok.png",
                name: "ok.png",
                dataUrl: `data:image/png;base64,${"A".repeat(100)}`,
              },
            ],
          },
        ];
        const previews = previewsOf(boundLiveThumbnails(chat)[0]);
        expect(previews[0]).toBeUndefined(); // the oversized one
        expect(previews[1]).toBeDefined(); // its sibling, unaffected
      });

      it("still returns the input array when everything fits", () => {
        const chat = [withImages("small", 5, 100)];
        expect(boundLiveThumbnails(chat)).toBe(chat);
      });
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

  // ══ LINT MARKS SURVIVE A RESTART — THE DECISION, PINNED (bead sparkle-kr2jz) ═══════════════════
  // This is the fork in the road the field had to be walked through deliberately, and these rows are
  // what stop it being re-decided by accident in either direction.
  //
  // KEPT, unlike `ConciergeFailureMessage` — the deliberate counter-example, held off PERSISTED_KINDS
  // entirely because "you've hit your session limit · resets 8:40am" is a claim about NOW that has
  // expired by the next launch. A lint mark is not that kind of claim: "this reply offered to act and
  // no action ran in it" is a closed observation about a turn that has ended, and the reply text it
  // annotates is persisted verbatim beside it. Dropping it would also undo the point, since what the
  // founder is trying to see is a PATTERN across turns.
  //
  // BOUNDED AND RE-VALIDATED on both boundaries, because "it survives" is the easy half — every
  // rebuild in this module is a spread, so the field would have come back whether or not anyone had
  // thought about it.
  describe("a reply's lint marks", () => {
    const marked = (lint: unknown): ConciergeMessage =>
      ({ id: "s1", kind: "sparkle", text: "Say go and I'll spawn it.", lint }) as ConciergeMessage;

    it("SURVIVES a simulated reload", () => {
      setChat([marked([{ check: "ask-without-action", severity: "block", detail: "offered to act" }])]);
      expect(persisted()[0]).toMatchObject({
        lint: [{ check: "ask-without-action", severity: "block", detail: "offered to act" }],
      });
      // …and comes back off the restore path still attached, which is the half that actually reaches
      // a renderer. `rehydrateThread` is what a fresh page runs on the payload above.
      expect(rehydrateThread(persisted())[0]).toMatchObject({
        id: `${RESTORED_ID_PREFIX}0`,
        lint: [{ check: "ask-without-action" }],
      });
    });

    it("leaves a CLEAN reply with no lint field — the positive control", () => {
      // Without this, the row above passes against a store that stamps every restored message with
      // an empty array, which would make a restored thread claim findings nothing produced.
      setChat([sparkle("s1", "Spawned it.")]);
      expect(persisted()[0]).not.toHaveProperty("lint");
      expect(rehydrateThread(persisted())[0]).toMatchObject({ lint: undefined });
    });

    it("caps a runaway array on the way to disk", () => {
      // `hedge-words` reports one violation PER WORD, so this is the realistic case. Unbounded, it is
      // the same quota failure stripDataUrls and the collapsed-payload budget exist to prevent,
      // reaching through a field the text cap cannot see.
      const many = Array.from({ length: 40 }, () => ({ check: "hedge-words", severity: "warn", detail: "d" }));
      const [out] = persistableThread([marked(many)]);
      expect((out as { lint?: unknown[] }).lint!.length).toBeLessThanOrEqual(MAX_LINT_MARKS);
    });

    // ══ THE WRITE-SIDE BOUND WAS A NO-OP (roborev 57878/57851, Medium) ═══════════════════════
    // `boundLintMarks` normalized the marks and then discarded the result unless the array LENGTH
    // changed — and clipping `detail`, clipping `check` and coercing `severity` all leave the length
    // alone. So the only thing it actually enforced on the way to disk was MAX_LINT_MARKS, and the
    // original over-long payload was persisted. The existing clip assertion in this file goes through
    // `rehydrateThread` (the RESTORE path, which always worked), so nothing covered the write side.
    it("clips an over-long detail ON THE WAY OUT, not only on the way back in", () => {
      const [out] = persistableThread([
        marked([{ check: "hedge-words", severity: "warn", detail: "z".repeat(9000) }]),
      ]);
      expect((out as { lint?: { detail: string }[] }).lint![0]!.detail).toHaveLength(
        LINT_DETAIL_MAX_LEN,
      );
    });

    it("coerces a NON-STRING severity on the way out — also a same-length change", () => {
      // Non-string specifically: `sanitize` deliberately passes an unknown STRING tier through, on
      // the stated grounds that a mark whose only consumer is a `data-` attribute must not be the
      // one place that hard-rejects a newly added severity. Only a wrong TYPE is coerced.
      const [out] = persistableThread([
        marked([{ check: "hedge-words", severity: 7, detail: "d" }]),
      ]);
      expect((out as { lint?: { severity: string }[] }).lint![0]!.severity).toBe("warn");
    });

    // roborev 57898: `check` was type-checked but never bounded, so a hand-edited localStorage
    // payload with a multi-megabyte check id survived every round trip — rehydrate re-validated it
    // and persistableThread wrote it straight back. The element-wise comparison made it subtler
    // still: the long value compared EQUAL to its unnormalized self, so the write path concluded
    // "nothing needed changing" for a payload nothing had bounded.
    it("clips an over-long CHECK id on the way out too", () => {
      const [out] = persistableThread([
        marked([{ check: "c".repeat(9000), severity: "warn", detail: "d" }]),
      ]);
      expect((out as { lint?: { check: string }[] }).lint![0]!.check).toHaveLength(
        LINT_CHECK_MAX_LEN,
      );
    });

    it("clips an over-long CHECK id on the way back in", () => {
      const restored = rehydrateThread([
        marked([{ check: "c".repeat(9000), severity: "warn", detail: "d" }]),
      ]);
      expect((restored[0] as { lint?: { check: string }[] }).lint![0]!.check).toHaveLength(
        LINT_CHECK_MAX_LEN,
      );
    });

    it("still preserves identity when nothing needed changing — the positive control", () => {
      // Without this, the two rows above would pass against a `boundLintMarks` that simply rebuilt
      // every message, which is the re-render cost the identity shortcut exists to avoid.
      const msg = marked([{ check: "hedge-words", severity: "warn", detail: "short" }]);
      expect(persistableThread([msg])[0]).toBe(msg);
    });

    it("throws away a hand-edited localStorage payload that is not marks at all", () => {
      // The restore path takes untrusted input: this JSON was written by whatever build ran last and
      // is editable by hand. A junk `lint` must not reach the renderer.
      expect(rehydrateThread([marked("not-an-array")])[0]).toMatchObject({ lint: undefined });
      expect(rehydrateThread([marked([null, 7, "x"])])[0]).toMatchObject({ lint: undefined });
      // …while a forged over-long detail is clipped rather than the whole record discarded.
      const forged = rehydrateThread([marked([{ check: "hedge-words", severity: "warn", detail: "z".repeat(9000) }])]);
      expect((forged[0] as { lint?: { detail: string }[] }).lint![0]!.detail).toHaveLength(LINT_DETAIL_MAX_LEN);
    });
  });
});

// ══ ABANDONED FRAGMENTS ARE DECLARED DEAD AT SEND TIME (roborev 62936) ═══════════════════════════
// `endStreamsThrough` is the only thing that ever marks the ordinary double-send's casualty. The
// backend kills the displaced child and its reader returns SILENTLY, so no `done` and no `error`
// arrive for that turn — there is no event to hang a marker on, and the deltas it already painted
// stay on screen forever. `conciergeHistoryCapture` waits for a bubble to stop growing before
// indexing it, so without this sweep the most common abandoned reply in the app is one the founder
// can scroll back to and never search for.
describe("endStreamsThrough", () => {
  const brain = (turn: number, text: string, extra: object = {}): ConciergeMessage =>
    ({ id: `${BRAIN_ID_PREFIX}${turn}`, kind: "sparkle", text, ...extra }) as ConciergeMessage;

  it("marks a streaming bubble at or below the floor", () => {
    const out = endStreamsThrough([brain(7, "I was say")], 7);
    expect((out[0] as { streamEnded?: true }).streamEnded).toBe(true);
  });

  it("leaves the turn ABOVE the floor alone — it is the one still talking", () => {
    // The whole point of a floor: the send that retires 7 is the same send that starts 8, and
    // sweeping 8 would mark the live reply final while its first chunk is all it has.
    const out = endStreamsThrough([brain(7, "old"), brain(8, "new")], 7);
    expect((out[0] as { streamEnded?: true }).streamEnded).toBe(true);
    expect((out[1] as { streamEnded?: true }).streamEnded).toBeUndefined();
  });

  it("never touches a bubble that SETTLED — it answered, which is the opposite claim", () => {
    const settled = brain(7, "done", { settled: true });
    expect(endStreamsThrough([settled], 7)[0]).toBe(settled);
  });

  it("ignores non-brain bubbles and non-numeric turn ids", () => {
    // A `postSparkle` notice is whole on arrival and was never on a numeric floor; sweeping by id
    // shape rather than by kind alone is what keeps this from stamping one.
    const notice = sparkle("sparkle-4", "Sent to Kraken Auth.");
    const odd = brain(0, "x");
    const weird = { id: `${BRAIN_ID_PREFIX}abc`, kind: "sparkle", text: "y" } as ConciergeMessage;
    const out = endStreamsThrough([notice, odd, weird], 99);
    expect(out[0]).toBe(notice);
    expect((out[1] as { streamEnded?: true }).streamEnded).toBe(true);
    expect(out[2]).toBe(weird);
  });

  it("keys on the PREFIX, not on 'six characters then digits'", () => {
    // The turn number is read as `id.slice(BRAIN_ID_PREFIX.length)`, so without the prefix test the
    // guard degrades into an offset coincidence: any sparkle id whose 7th character onward happens
    // to be digits would be swept out of a namespace this function knows nothing about. That is a
    // silent mis-sweep — the bubble is marked final and indexed early, with nothing to show for it
    // in a diff. `toast-99` is the shape: six characters, then digits, and not a brain bubble.
    const other = sparkle("toast-99", "not a brain reply");
    expect(endStreamsThrough([other], 99)[0]).toBe(other);
  });

  it("returns the SAME array when nothing qualifies, so it cannot force a re-render", () => {
    // Same discipline as `markSettled`: this runs on every send, and the common case is that
    // nothing is mid-stream. A fresh array each time would rebuild a transcript of memoised rows
    // for no reason.
    const chat = [you("you-1"), sparkle("sparkle-1")];
    expect(endStreamsThrough(chat, 99)).toBe(chat);
  });
});
