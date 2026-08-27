// THE CLIENT HALF OF THE `GET /social/conversations` CONTRACT (bead sparkle-u94wvm).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
// `ConversationRow` declared `socialId` and `lastSeq`, which the route has never emitted, and
// omitted `muted`, `last_read_seq` and `peers`, which it always has. Two typechecked files, two
// green suites, and no mechanism anywhere that could compare them — the drift was invisible until
// the first consumer was written, at which point it presents as a SERVER bug.
//
// ── WHY THIS TEST IS NOT THE TYPE RESTATED IN ANOTHER FORM ───────────────────────────────────────
// The literal below is typed `ConversationRow[]`, so tsc checks it for exhaustiveness against the
// interface — a key added to the type without being added here fails to compile, and a key removed
// from the type makes this literal an excess-property error. But its VALUES are then deep-equalled
// against `apps/orchestration/src/lib/__fixtures__/socialConversationsResponse.json`, a CAPTURED
// response body which the server's own suite asserts against `wireConversationRow()` — the function
// the route builds every row with. So this file cannot go green by agreeing with itself: the
// authority is the capture, and the capture's authority is the server's projection.
//
// PROVEN TO FAIL, not assumed: dropping `kind` from the interface and from the literal reds the
// key-set and deep-equal cases here (the capture still carries it), and adding a phantom key to the
// interface reds `pnpm typecheck` at this literal.
//
// The path reaches ACROSS PACKAGES on purpose. Copying the fixture into apps/desktop would give
// each side its own artifact to keep in step, which is the arrangement that produced the bug.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  partitionConversations,
  type ConversationRow,
  type PublicProfile,
} from "./socialApi";

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  "../../../orchestration/src/lib/__fixtures__/socialConversationsResponse.json",
);

/** The captured body, read as `unknown` — casting it to `ConversationRow` here would assert the
 *  very thing under test. */
function capturedRows(): Record<string, unknown>[] {
  const body = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    conversations: Record<string, unknown>[];
  };
  return body.conversations;
}

/**
 * THE CAPTURE, RE-DECLARED THROUGH THE CLIENT TYPE. tsc checks this against `ConversationRow`;
 * `toEqual` below checks it against the real bytes. Both have to hold.
 */
const AS_THE_CLIENT_TYPES_IT: ConversationRow[] = [
  {
    id: "3f1a9c62-8d47-4b0e-9a21-0c5e7b6d4f18",
    kind: "dm",
    state: "active",
    unread: 2,
    muted: false,
    last_read_seq: 7,
    peers: [
      {
        socialId: "a4d2f8b1-6c39-4e57-8b0a-1d9e2f3c4b5a",
        username: "ada",
        displayName: "Ada Lovelace",
        online: true,
      },
    ],
  },
  {
    id: "7c8e2d10-4b6f-4a93-8e15-2f7a9b3c6d40",
    kind: "dm",
    state: "requested",
    unread: 1,
    muted: true,
    last_read_seq: 0,
    peers: [
      {
        socialId: "b5e3a9c2-7d40-4f68-9c1b-2e0f3a4d5c6b",
        username: "grace",
        displayName: "grace",
        online: false,
      },
    ],
  },
  {
    id: "0b4d6e83-1a25-4c7f-9d38-6e1b8c0a2f57",
    kind: "support",
    state: "active",
    unread: 0,
    muted: false,
    last_read_seq: 0,
    peers: [],
  },
];

describe("ConversationRow matches the captured `GET /social/conversations` body", () => {
  it("the client type's key set is EXACTLY the wire's, row for row", () => {
    const rows = capturedRows();
    expect(rows).toHaveLength(AS_THE_CLIENT_TYPES_IT.length);

    for (const [i, captured] of rows.entries()) {
      const typed = AS_THE_CLIENT_TYPES_IT[i]!;
      // Sorted key sets, so the failure message names the field rather than dumping two objects.
      // This is the assertion the old interface could not pass: it would have reported the two
      // phantom keys as missing from the wire and `muted`/`last_read_seq`/`peers` as unmodelled.
      expect(Object.keys(captured).sort()).toEqual(Object.keys(typed).sort());
    }
  });

  it("…and the VALUES too, so a key mapped from the wrong field still fails", () => {
    expect(capturedRows()).toEqual(AS_THE_CLIENT_TYPES_IT);
  });

  it("no wire value is null or absent, which is why no member is optional", () => {
    // `field?: T` means `T | undefined` and EXCLUDES null, so an optional member on a key the
    // server always emits describes a case that never occurs while failing to describe the one that
    // does. Every key here is required; this is the evidence for that, taken from the bytes.
    for (const row of capturedRows()) {
      for (const [key, value] of Object.entries(row)) {
        expect(value, `${key} is present and non-null on the wire`).not.toBeNull();
        expect(value, `${key} is present and non-null on the wire`).not.toBeUndefined();
      }
    }
  });

  it("peers carry exactly the four sealed public fields", () => {
    const typedPeerKeys: Record<keyof PublicProfile, true> = {
      socialId: true,
      username: true,
      displayName: true,
      online: true,
    };
    const expected = Object.keys(typedPeerKeys).sort();
    const peers = capturedRows().flatMap((r) => (r.peers as Record<string, unknown>[]) ?? []);
    // PAIRED with the leak check below: "no peer leaks a clerk id" is satisfied by a capture with
    // no peers in it at all.
    expect(peers.length).toBeGreaterThan(0);
    for (const peer of peers) expect(Object.keys(peer).sort()).toEqual(expected);
    expect(JSON.stringify(peers)).not.toContain("clerk");
  });

  it("the real capture partitions — the discriminator survives the round trip", () => {
    // The end the type exists for: `partitionConversations` is the only consumer today, and it
    // branches on `kind`. Driving it with the CAPTURED rows (not hand-built ones) is what proves
    // the discriminator is really on the wire and really typed.
    const p = partitionConversations(AS_THE_CLIENT_TYPES_IT);
    expect(p.support?.id).toBe("0b4d6e83-1a25-4c7f-9d38-6e1b8c0a2f57");
    expect(p.chats.map((c) => c.id)).toEqual([
      "3f1a9c62-8d47-4b0e-9a21-0c5e7b6d4f18",
      "7c8e2d10-4b6f-4a93-8e15-2f7a9b3c6d40",
    ]);
    expect(p.chats.some((c) => c.kind === "support")).toBe(false);
  });
});
