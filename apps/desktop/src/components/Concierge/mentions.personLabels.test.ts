// TWO PEOPLE WITH THE SAME DISPLAY NAME MUST STILL BE ADDRESSABLE (roborev 82277).
//
// `personName()` is `displayName || username`, and only the SECOND is unique — the registry enforces
// a unique username, nothing enforces a unique display name. A person carries no `projectName`, so
// the agent disambiguator rendered two people called "Dan" as the IDENTICAL string `Dan ()`.
// `findMentionSpans` claims the first equal-length label in `longestLabelFirst` order and discards
// the overlapping second, so `@Dan` resolved to whichever `peopleList` sorted first — a rank that
// FLIPS when one goes offline, since it sorts on availability before name. The founder would have
// DM'd the wrong human, and the receipt would read `Sent to Dan.` either way.
//
// So these rows assert the END STATE — which socialId a given address resolves to — and not merely
// that the label strings differ. A pair of distinct-but-wrong labels would satisfy a string check
// while still aiming at one person.
import { describe, expect, it } from "vitest";

import {
  MAX_PERSON_MENTION_NAME,
  SPARKLE_MENTION_AGENT,
  SPARKLE_MENTION_ID,
  findMentionSpans,
  insertMention,
  isCompletedMention,
  isComposingMention,
  mentionQuery,
  withMentionLabels,
} from "./mentions";
import type { MentionAgent } from "./mentions";
import { personAgentId } from "../../engine/social";
import { roster } from "../../stores/socialStore";
import type { Person } from "../../stores/socialStore";

function person(socialId: string, username: string, displayName: string | null): Person {
  return {
    socialId,
    username,
    displayName,
    availability: "available",
    relationship: "connected",
  };
}

/** Two humans who chose the same display name — the whole point of the file. */
const DAN_A = person("soc-a", "dan", "Dan");
const DAN_B = person("soc-b", "dan2", "Dan");

const labelled = (people: Person[]): MentionAgent[] =>
  withMentionLabels(roster(Object.fromEntries(people.map((p) => [p.socialId, p]))));

describe("two people sharing a display name", () => {
  it("get DISTINCT labels, each carrying the username that is actually unique", () => {
    const rows = labelled([DAN_A, DAN_B]);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toEqual(expect.arrayContaining(["Dan (dan)", "Dan (dan2)"]));
    // THE BUG, stated as its own assertion so a regression names itself rather than showing up as a
    // confusing resolution failure three rows down.
    expect(labels).not.toContain("Dan ()");
  });

  // THE ROW THAT WOULD HAVE CAUGHT THE DEFECT. Distinct label STRINGS are not the deliverable —
  // addressing the right human is. Each address must resolve to its OWN socialId.
  it("each address resolves to its own person", () => {
    const rows = labelled([DAN_A, DAN_B]);
    const a = findMentionSpans("@Dan (dan) hi", rows)[0];
    const b = findMentionSpans("@Dan (dan2) hi", rows)[0];
    expect(a?.agentId).toBe(personAgentId("soc-a"));
    expect(b?.agentId).toBe(personAgentId("soc-b"));
    // …and they are genuinely different, which a pair of identical labels could never satisfy.
    expect(a?.agentId).not.toBe(b?.agentId);
  });

  // ORDERING MUST NOT DECIDE IT. `peopleList` sorts on availability BEFORE name, so the pre-fix
  // winner flipped when one person went offline. Feeding the same pair in the opposite availability
  // order must not change which address reaches whom.
  it("does not change who @Dan (dan) reaches when availability flips", () => {
    const flipped = labelled([{ ...DAN_A, availability: "offline" }, DAN_B]);
    const a = findMentionSpans("@Dan (dan) hi", flipped)[0];
    expect(a?.agentId).toBe(personAgentId("soc-a"));
  });
});

describe("a person whose display name is unique", () => {
  // THE OTHER DIRECTION. Labelling EVERY person would pass every row above while making the founder
  // type `@Ada (ada)` for the ordinary case — so the bare address has to survive.
  it("keeps the bare address, with no parenthetical", () => {
    const rows = labelled([person("soc-ada", "ada", "Ada"), DAN_B]);
    const ada = rows.find((r) => r.id === personAgentId("soc-ada"));
    expect(ada?.label).toBeUndefined();
    expect(findMentionSpans("@Ada hi", rows)[0]?.agentId).toBe(personAgentId("soc-ada"));
  });

  // A person with NO display name is addressed by username, which is already unique — so even a
  // collision-shaped roster leaves it bare.
  it("falls back to the username when no display name is set", () => {
    const rows = labelled([person("soc-x", "xavier", null)]);
    expect(rows[0]?.name).toBe("xavier");
    expect(rows[0]?.label).toBeUndefined();
  });
});

describe("an agent with a blank projectName", () => {
  // The empty-paren half of the same finding: `Name ()` is not a disambiguator. Two such rows are
  // still identical, so the label did nothing but make the ambiguity LOOK resolved.
  it("is left unlabelled rather than given an empty parenthetical", () => {
    const bare = (id: string): MentionAgent => ({
      id,
      name: "Twin",
      projectId: "",
      projectName: "",
      band: "running",
      canAcceptInput: true,
    });
    const rows = withMentionLabels([bare("ag1"), bare("ag2")]);
    expect(rows.map((r) => r.label)).toEqual([undefined, undefined]);
  });
});

// ══ THE ADDRESS HAS TO SURVIVE THE COMPOSER, NOT ONLY `findMentionSpans` (roborev 82346) ═════════
//
// Every row above feeds a PREPARED string straight to the resolver, so all of them passed over a
// label the composer could not actually carry. The disambiguated label is the ONLY label in this
// module built by concatenation, so it is the only one that can smuggle a second sigil into an
// address — and `mentionQuery` walks LEFT to the first `@` whose predecessor is not a NAME_CHAR,
// which `(` is not. These rows drive that scan.
describe("a disambiguated person address, as the composer actually sees it", () => {
  const rows = labelled([DAN_A, DAN_B]);
  const label = rows.find((r) => r.id === personAgentId("soc-b"))?.label;

  it("carries no sigil inside the address", () => {
    // Stated on its own so a regression names the cause rather than surfacing three rows down as a
    // paused countdown nobody can explain.
    expect(label).toBe("Dan (dan2)");
    expect(label?.slice(1)).not.toContain("@");
  });

  it("anchors the query on the LEADING sigil, not one inside the label", () => {
    const draft = `@${label} `;
    const q = mentionQuery(draft, draft.length);
    expect(q?.anchor).toBe(0);
    expect(q?.query).toBe(`${label} `);
  });

  it("reads as COMPLETED, so the countdown resumes and the picker stays shut", () => {
    const draft = `@${label} `;
    const q = mentionQuery(draft, draft.length);
    expect(isCompletedMention(q?.query ?? "", rows)).toBe(true);
    expect(isComposingMention(q, rows)).toBe(false);
  });

  it("is not rewritten by a re-insert at the query's own anchor", () => {
    // The end state of the bug: with the query anchored inside the label, Enter chose a row instead
    // of sending and `insertMention` rebuilt the draft from offset 5, yielding `@Dan (@Dan (@dan2) `.
    const draft = `@${label} `;
    const q = mentionQuery(draft, draft.length);
    const b = rows.find((r) => r.id === personAgentId("soc-b"))!;
    const again = insertMention(draft, q?.anchor ?? 0, draft.length, b);
    expect(again.text).toBe(draft);
    expect(findMentionSpans(again.text, rows)[0]?.agentId).toBe(personAgentId("soc-b"));
  });
});

// ══ A DISPLAY NAME IS PEER-CONTROLLED TEXT, AND IT LANDS IN AN ADDRESS (roborev 82360) ═══════════
//
// The block above closed this class in the JOINER — the ` (@handle)` suffix `withMentionLabels`
// builds. It stayed open in the OPERAND: `personName()` returns `displayName` verbatim and `labelOf`
// makes that string the address, so a peer who calls themselves `Dan @ Acme` reproduced the identical
// three-step failure with no concatenation involved at all — and on the BARE, uncollided row, which
// every test above leaves unlabelled precisely because it is supposed to be the safe case.
//
// The fixture above cannot see it: its display names are the sigil-free literal "Dan", so it pins
// only the half `USERNAME_FORMAT_RE` already made safe. These rows use a hostile display name, and
// they drive the composer rather than `findMentionSpans` — a prepared string proves nothing here,
// because the whole defect is about which offset the composer's own backward scan picks.
describe("a display name carrying a sigil", () => {
  const HOSTILE = person("soc-h", "danacme", "Dan @ Acme");

  it("does not reach the address — the roster normalises it at the seam", () => {
    const rows = labelled([HOSTILE]);
    expect(rows[0]?.name).toBe("Dan Acme");
    expect(rows[0]?.name).not.toContain("@");
  });

  it("leaves the query anchored on the LEADING sigil, so the countdown resumes", () => {
    const rows = labelled([HOSTILE]);
    const draft = `@${rows[0]?.name} `;
    const q = mentionQuery(draft, draft.length);
    expect(q?.anchor).toBe(0);
    expect(isCompletedMention(q?.query ?? "", rows)).toBe(true);
    expect(isComposingMention(q, rows)).toBe(false);
  });

  it("is not rewritten by a re-insert at the query's own anchor", () => {
    const rows = labelled([HOSTILE]);
    const draft = `@${rows[0]?.name} `;
    const q = mentionQuery(draft, draft.length);
    const again = insertMention(draft, q?.anchor ?? 0, draft.length, rows[0]!);
    expect(again.text).toBe(draft);
    expect(findMentionSpans(again.text, rows)[0]?.agentId).toBe(personAgentId("soc-h"));
  });

  it("still addresses the right person, rather than merely being sanitised", () => {
    const rows = labelled([HOSTILE, person("soc-other", "other", "Other")]);
    const h = rows.find((r) => r.id === personAgentId("soc-h"));
    expect(findMentionSpans(`@${h?.name} hi`, rows)[0]?.agentId).toBe(personAgentId("soc-h"));
  });

  // A NAME THAT NORMALISES TO NOTHING still has to be addressable, or stripping the sigil would
  // simply move the failure: an empty address matches nothing and the person drops off the roster.
  it("falls back to the username when the name is nothing but sigils and space", () => {
    const rows = labelled([person("soc-blank", "blankly", " @@  @ ")]);
    expect(rows[0]?.name).toBe("blankly");
  });
});

describe("a display name longer than the composer can query", () => {
  // `mentionQuery` gives up past MAX_MENTION_QUERY, so an unbounded name stops resolving ENTIRELY —
  // the same ceiling `MAX_BEAD_MENTION_LABEL` exists to enforce for the other free-form roster kind.
  const LONG = person("soc-l", "verbose", "Danielle ".repeat(12).trim());

  it("is truncated to the ceiling, so the address still matches", () => {
    const rows = labelled([LONG]);
    const name = rows[0]?.name ?? "";
    expect(name.length).toBeLessThanOrEqual(MAX_PERSON_MENTION_NAME);
    const draft = `@${name} `;
    expect(mentionQuery(draft, draft.length)?.anchor).toBe(0);
    expect(findMentionSpans(`@${name} hi`, rows)[0]?.agentId).toBe(personAgentId("soc-l"));
  });

  it("keeps the DISAMBIGUATED address inside the ceiling too — the suffix is budgeted, not added", () => {
    // The collision case is where being addressable matters most, because the bare name there
    // resolves to nobody. Appending ` (username)` on top of an already-maximal name is how a
    // disambiguated address grows past the ceiling and falls out of the picker's reach.
    const twin = person("soc-l2", "verbose2", "Danielle ".repeat(12).trim());
    const rows = labelled([LONG, twin]);
    for (const r of rows) {
      const label = r.label ?? r.name;
      expect(label.length).toBeLessThanOrEqual(MAX_PERSON_MENTION_NAME);
      const draft = `@${label} `;
      expect(mentionQuery(draft, draft.length)?.anchor).toBe(0);
      expect(findMentionSpans(`@${label} hi`, rows)[0]?.agentId).toBe(r.id);
    }
  });
});

// ══ AN ADDRESS IS ONLY AN ADDRESS IF IT NAMES ONE PERSON (roborev 82366) ═════════════════════════
//
// THE THIRD SIGHTING OF ONE CLASS, which is why the fix is at the roster and not at the next
// character. The two rounds before it each removed something a display name may CONTAIN — the sigil
// in the joiner, then the sigil and the length in the operand — and both are denylists over
// peer-controlled text, correct only for the cases their author thought of. `display_name` is
// free-form to 40 characters with nothing checking it on the write path, so the round after this one
// would have been the parentheses, and the round after that whatever spells an address next.
//
// The forgery: `withMentionLabels` counts collisions on `a.name` and never on the FINAL addresses,
// so an impostor whose display name IS somebody else's assigned label has a unique name, draws no
// suffix, and lands a byte-identical address. Every row in the blocks above asserts on ONE person's
// address in isolation — sigil-free, inside the ceiling, resolving to itself — and not one of them
// asserts the property that makes an address an address: that the SET is distinct.
describe("an impostor whose display name spells someone else's address", () => {
  const DAN_A2 = person("soc-a2", "dana", "Dan");
  const DAN_B2 = person("soc-b2", "danb", "Dan");
  // Unique NAME — so the collision count above sees nothing — but the same final ADDRESS as DAN_A2.
  const IMPOSTOR = person("soc-evil", "evil", "Dan (dana)");

  const addr = (a: MentionAgent): string => a.label ?? a.name;

  it("cannot take an address that already belongs to somebody", () => {
    const rows = labelled([DAN_A2, DAN_B2, IMPOSTOR]);
    expect(new Set(rows.map((r) => addr(r).toLowerCase())).size).toBe(rows.length);
  });

  // THE ROW THAT MATTERS. Distinct STRINGS are not the deliverable — reaching the human the founder
  // picked is. With two rows sharing a literal, `findMentionSpans` keeps roster order (a stable sort
  // on label LENGTH) and `peopleList` sorts on availability, so the winner flips when one goes
  // offline and the receipt reads `Sent to Dan.` either way.
  it("leaves every address resolving to the person it names", () => {
    const rows = labelled([DAN_A2, DAN_B2, IMPOSTOR]);
    for (const r of rows) {
      expect(findMentionSpans(`@${addr(r)} hi`, rows)[0]?.agentId).toBe(r.id);
    }
  });

  it("does not change who the real address reaches when availability flips", () => {
    const flipped = labelled([{ ...DAN_A2, availability: "offline" }, DAN_B2, IMPOSTOR]);
    const a = flipped.find((r) => r.id === personAgentId("soc-a2"));
    expect(findMentionSpans(`@${addr(a!)} hi`, flipped)[0]?.agentId).toBe(personAgentId("soc-a2"));
  });

  // ONLY THE COLLIDING ROWS MOVE. Rewriting every person to their username would satisfy every row
  // above while making the founder type `@ada` for the ordinary case — the same over-correction the
  // bare-address block guards against one layer down.
  it("leaves an uninvolved person's address alone", () => {
    const rows = labelled([DAN_A2, DAN_B2, IMPOSTOR, person("soc-ada2", "ada", "Ada")]);
    const ada = rows.find((r) => r.id === personAgentId("soc-ada2"));
    expect(ada?.label).toBeUndefined();
    expect(ada?.name).toBe("Ada");
  });
});

// ══ THE PASS HAS TO VERIFY THE SET IT PRODUCES, NOT THE ONE IT WAS GIVEN (roborev 82369) ═════════
//
// ROUND FOUR of the same class, and the one that lands on the FIX rather than on the name: a
// single-shot pass counted addresses BEFORE rewriting, so it could move a victim onto a string
// another row already held — the same wrong-human DM, one hop along, done to somebody who cannot see
// or prevent it. The block above could not catch it because its rewrite targets (`dana`, `evil`)
// collide with nothing, so its distinctness assertion passes on a set made distinct in ONE hop.
//
// These rows drive a SECOND hop. Both halves of the fix are pinned separately, because either alone
// still leaves a reachable collision: reserved handles (a display name that plainly spells another
// person's username is in collision before any rewrite) and the fixed point (recount after a hop,
// because the addresses have moved and the old counts no longer describe the roster).
describe("an attacker who spells a username the victim is about to be moved onto", () => {
  const DAN_A3 = person("soc-a3", "dana", "Dan");
  const DAN_B3 = person("soc-b3", "danb", "Dan");
  // Forges DAN_A3's disambiguated label, which forces DAN_A3 down onto its username `dana`…
  const FORGER = person("soc-f3", "evil", "Dan (dana)");
  // …and this one is already sitting on `dana`, with a UNIQUE name, so a single-shot pass never
  // looks at it and DAN_A3 lands on top of it.
  const SQUATTER = person("soc-s3", "x", "dana");

  const addr = (a: MentionAgent): string => a.label ?? a.name;
  const all = [DAN_A3, DAN_B3, FORGER, SQUATTER];

  it("still ends with every address naming exactly one person", () => {
    const rows = labelled(all);
    expect(new Set(rows.map((r) => addr(r).toLowerCase())).size).toBe(rows.length);
  });

  // THE ROW THAT MATTERS — distinct strings are not the deliverable, reaching the right human is.
  it("leaves `@dana` reaching the person whose username it is", () => {
    const rows = labelled(all);
    expect(findMentionSpans("@dana hi", rows)[0]?.agentId).toBe(personAgentId("soc-a3"));
  });

  it("moves the squatter off it rather than the victim", () => {
    const rows = labelled(all);
    const squatter = rows.find((r) => r.id === personAgentId("soc-s3"));
    expect(addr(squatter!).toLowerCase()).toBe("x");
  });

  it("keeps every address resolving to the row it names", () => {
    const rows = labelled(all);
    for (const r of rows) {
      expect(findMentionSpans(`@${addr(r)} hi`, rows)[0]?.agentId).toBe(r.id);
    }
  });

  it("does not change who @dana reaches when availability flips", () => {
    const flipped = labelled([{ ...DAN_A3, availability: "offline" }, DAN_B3, FORGER, SQUATTER]);
    expect(findMentionSpans("@dana hi", flipped)[0]?.agentId).toBe(personAgentId("soc-a3"));
  });
});

// ══ THE RESERVED-HANDLE HALF, ISOLATED — because the fixed point alone HIDES it ══════════════════
//
// Found by mutation rather than by reading: with the four-row fixture above, deleting the
// reserved-handle test changes NOTHING, because the victim is dragged onto `dana` by the forgery and
// the second hop then cleans up after it. So that block pins the fixed point twice over and the
// reserved half not at all — a guard green for a reason that has nothing to do with it.
//
// This roster forces NOBODY to move. The squatter simply takes another person's USERNAME as their
// display name, and no collision on `a.name` ever occurs, so a pass that only reacts to duplicate
// final addresses never looks at either row. `@ada` then reaches the squatter — and `ada` is not
// their name in any sense; it is the registry key of the person the founder meant.
describe("a squatter sitting on someone else's username with nothing forcing a move", () => {
  const ADA = person("soc-ada3", "ada", "Ada Lovelace");
  const SQUATTER2 = person("soc-sq", "zzz", "ada");

  const addr = (a: MentionAgent): string => a.label ?? a.name;

  it("does not let them keep it", () => {
    const rows = labelled([ADA, SQUATTER2]);
    const sq = rows.find((r) => r.id === personAgentId("soc-sq"));
    expect(addr(sq!).toLowerCase()).not.toBe("ada");
    expect(addr(sq!).toLowerCase()).toBe("zzz");
  });

  // THE SIDE EFFECT, not the label. `@ada` must not deliver a private message to the squatter.
  // It is allowed to reach nobody — Ada's own address is `Ada Lovelace` and the picker still offers
  // her on that prefix — because reaching nobody is recoverable and reaching an impostor is not.
  it("leaves `@ada` unable to deliver to them", () => {
    const rows = labelled([ADA, SQUATTER2]);
    expect(findMentionSpans("@ada hi", rows)[0]?.agentId).not.toBe(personAgentId("soc-sq"));
  });

  // AND THE OTHER DIRECTION: a person sitting on their OWN username is not squatting, so nothing
  // moves. Without this, "rewrite anyone whose address is a reserved handle" would pass every row
  // above while renaming the ordinary case for no reason.
  it("leaves a person whose display name IS their own username alone", () => {
    const rows = labelled([person("soc-self", "mila", "mila")]);
    expect(rows[0]?.label).toBeUndefined();
    expect(rows[0]?.name).toBe("mila");
  });
});

// ══ THE SECOND HOP (roborev 82369) ═════════════════════════════════════════════════════════════
// The review argued that `withUniquePersonAddresses` counts addresses ONCE, before the rewrite, and
// never checks the set it produces — so the username it falls back to could itself be occupied and
// the pass would return claiming an invariant it had not established. It named a precise four-person
// roster for it, reproduced here EXACTLY rather than paraphrased, because a paraphrase of an attack
// is not the attack.
//
// The rows below pass against the shipped implementation, which carries RESERVED HANDLES (a
// candidate address spelling another person's username is in collision BEFORE any rewrite) and a
// two-phase allocation: occupancy is seeded from the rows that are NOT moving, so a target about to
// be VACATED does not read as taken, and each assignment claims its string so two movers cannot pick
// the same one. (An earlier draft looped to a fixed point instead; mutation showed no roster reaches
// a second hop, so the loop was deleted rather than kept as a branch that cannot fail — see
// `withUniquePersonAddresses`.) These rows are kept because the finding is exactly right about what
// breaks if either remedy is removed.
describe("the four-person roster from roborev 82369", () => {
  // Dan A and Dan B collide on the display name `Dan`, so both take a suffix.
  const DAN_A = person("soc-dan-a", "dana", "Dan");
  const DAN_B = person("soc-dan-b", "danb", "Dan");
  // Forges Dan A's SUFFIXED label, which forces Dan A off it.
  const IMPOSTOR_1 = person("soc-evil", "evil", "Dan (dana)");
  // The second hop: a UNIQUE display name that plainly spells Dan A's username, so it draws no
  // suffix and a single-shot pass would never look at it again — while Dan A is being moved onto
  // exactly that string.
  const IMPOSTOR_2 = person("soc-x", "x", "dana");

  const rows = () => labelled([DAN_A, DAN_B, IMPOSTOR_1, IMPOSTOR_2]);
  const addr = (r: MentionAgent) => (r.label ?? r.name).toLowerCase();

  it("leaves every final address distinct, after the rewrite rather than before it", () => {
    const final = rows().map(addr);
    expect(new Set(final).size).toBe(final.length);
  });

  // THE ROW THAT MATTERS. Distinctness alone can be satisfied by moving the VICTIM somewhere else;
  // what the attack is for is capturing `@dana`, and the person who must own it is Dan A.
  it("keeps @dana pointing at Dan A, not at the impostor who spelled it", () => {
    const r = rows();
    const hit = findMentionSpans("@dana hi", r)[0];
    expect(hit?.agentId).toBe(personAgentId("soc-dan-a"));
    expect(hit?.agentId).not.toBe(personAgentId("soc-x"));
  });

  // …and the impostor is still addressable, on the one key it genuinely owns. A pass that achieved
  // distinctness by dropping a row would satisfy both rows above.
  it("moves the impostor onto its own handle rather than dropping it", () => {
    const x = rows().find((r) => r.id === personAgentId("soc-x"));
    expect(addr(x!)).toBe("x");
  });
});

// ══ THE ROSTER HOLDS MORE THAN PEOPLE, AND `@Sparkle` IS THE ONE ADDRESS THAT MUST NOT MOVE ══════
// (roborev 82370 — round FIVE, and the one that found the previous fix had made things WORSE.)
//
// Every block above goes through `labelled()`, which is `withMentionLabels(roster(people))` and
// contains people EXCLUSIVELY — so nothing above could see a cross-kind collision at all. But
// `mentionRoster` puts people, agents, beads AND the concierge in one roster, and the concierge is
// deliberately exempt from suffixing, so its address is the bare `Sparkle`.
//
// What made this a live defect rather than a documented edge: reserved handles turned the rewrite
// into a PEER-CONTROLLED trigger. Before them a person only moved when their address was already
// shared, which needed a forged label; after them a peer forces their own rewrite just by setting
// `display_name` to any other connection's username — so they choose the moment they land on a
// string of their own picking. With an unchecked target, a peer whose username is `sparkle` lands on
// the concierge's address, and this module's header calls that the one unrecoverable direction: the
// way OUT of a mount must not be shadowed by the thing being mounted to. `@Sparkle` is what the
// founder types and what `dictatedSparkleAddress` produces from speech.
describe("a roster that also holds the concierge and a build agent", () => {
  const addr = (r: MentionAgent) => (r.label ?? r.name).toLowerCase();
  const agentRow = (id: string, name: string): MentionAgent => ({
    id,
    name,
    projectId: "p",
    projectName: "Proj",
    band: "running",
    canAcceptInput: true,
  });
  const mixed = (people: Person[], others: MentionAgent[]): MentionAgent[] =>
    withMentionLabels([
      ...roster(Object.fromEntries(people.map((p) => [p.socialId, p]))),
      ...others,
      SPARKLE_MENTION_AGENT,
    ]);

  it("never lets a peer be rewritten onto the concierge's address", () => {
    // Username `sparkle`, and a display name that squats on somebody else's username so the rewrite
    // is FORCED — the peer-controlled trigger, aimed at `@Sparkle`.
    const victimHandle = person("soc-vh", "otherguy", "Someone");
    const attacker = person("soc-atk", "sparkle", "otherguy");
    const rows = mixed([victimHandle, attacker], []);
    const sparkleRow = rows.find((r) => r.id === SPARKLE_MENTION_ID);
    expect(addr(sparkleRow!)).toBe("sparkle");
    const atk = rows.find((r) => r.id === personAgentId("soc-atk"));
    expect(addr(atk!)).not.toBe("sparkle");
  });

  // THE SIDE EFFECT, which is the whole point: `@Sparkle` must still reach the concierge.
  it("leaves `@Sparkle` reaching the concierge", () => {
    const rows = mixed(
      [person("soc-vh2", "otherguy", "Someone"), person("soc-atk2", "sparkle", "otherguy")],
      [],
    );
    expect(findMentionSpans("@Sparkle hi", rows)[0]?.agentId).toBe(SPARKLE_MENTION_ID);
  });

  it("does not move a person onto a BUILD AGENT's address either", () => {
    // The same construction against an ordinary agent name: a person whose username is `kraken`,
    // forced to rewrite, must not land on the agent addressed as `kraken`.
    const rows = mixed(
      [person("soc-vh3", "otherguy", "Someone"), person("soc-k", "kraken", "otherguy")],
      [agentRow("agent-1", "kraken")],
    );
    const k = rows.find((r) => r.id === personAgentId("soc-k"));
    // Not the agent's address…
    expect(addr(k!)).not.toBe("kraken");
    // …and NOT still sitting on the username they squatted on, which is the half a weaker
    // assertion misses: with no second candidate the mover simply fails to move and keeps the
    // squat, so `@otherguy` still reaches the wrong human.
    expect(addr(k!)).not.toBe("otherguy");
    // The id-tailed form is what they land on, and they stay addressable.
    expect(addr(k!)).toBe("kraken (soc-k)");
    expect(new Set(rows.map(addr)).size).toBe(rows.length);
  });

  // AND THE ORDINARY CASE IS UNTOUCHED — a person whose username is free still gets it, or the
  // guard would be trading one broken address for another.
  it("still gives a forced-to-move person their own free username", () => {
    const rows = mixed(
      [person("soc-vh4", "otherguy", "Someone"), person("soc-free", "freename", "otherguy")],
      [],
    );
    const f = rows.find((r) => r.id === personAgentId("soc-free"));
    expect(addr(f!)).toBe("freename");
  });

  // ══ THE CONCIERGE'S ADDRESS IS PROTECTED TWICE, AND THE TWO RULES ARE DIFFERENT ════════════════
  // Mutation is what separated them: deleting one changed nothing while the other stood, so a single
  // test made both look load-bearing when only one was. They are:
  //
  //   • `occupied` — a person being rewritten may not LAND on `Sparkle`. Covered by the two rows
  //     above, which drive a forced move at it.
  //   • `reserved` — a person may not HOLD `Sparkle` in the first place. Nothing above reaches this:
  //     it needs a peer whose display name simply IS `Sparkle`, with no collision forcing anything.
  //
  // Both are asserted with the concierge row ABSENT, because `withMentionLabels` is EXPORTED and this
  // is a property of its contract, not of the one caller that happens to append that row. A future
  // caller assembling a roster without it must not be the thing that reopens `@Sparkle`.
  it("will not let a peer HOLD `Sparkle`, even with no collision forcing a move", () => {
    const addr2 = (r: MentionAgent) => (r.label ?? r.name).toLowerCase();
    const rows = withMentionLabels(
      roster({ "soc-imp": { ...person("soc-imp", "impostor", "Sparkle") } }),
    );
    const imp = rows.find((r) => r.id === personAgentId("soc-imp"));
    expect(addr2(imp!)).not.toBe("sparkle");
    // …and they are still addressable, on the key that is genuinely theirs.
    expect(addr2(imp!)).toBe("impostor");
  });

  it("will not let a peer be rewritten ONTO `Sparkle` with the concierge row absent", () => {
    const addr2 = (r: MentionAgent) => (r.label ?? r.name).toLowerCase();
    const rows = withMentionLabels(
      roster(
        Object.fromEntries(
          [person("soc-vh5", "otherguy", "Someone"), person("soc-s5", "sparkle", "otherguy")].map(
            (x) => [x.socialId, x],
          ),
        ),
      ),
    );
    const s5 = rows.find((r) => r.id === personAgentId("soc-s5"));
    expect(addr2(s5!)).not.toBe("sparkle");
  });
});
