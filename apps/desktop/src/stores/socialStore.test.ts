import { describe, it, expect, beforeEach } from "vitest";

import { personAgentId } from "../engine/social";
import {
  useSocialStore,
  peopleList,
  personName,
  roster,
  totalUnread,
  type Person,
} from "./socialStore";

const person = (over: Partial<Person> & Pick<Person, "socialId" | "username">): Person => ({
  displayName: null,
  availability: "offline",
  relationship: "stranger",
  ...over,
});

const ada = person({ socialId: "s-ada", username: "ada", displayName: "Ada L" });
const bob = person({ socialId: "s-bob", username: "bob" });

beforeEach(() => {
  useSocialStore.getState().reset();
});

describe("socialStore — my profile", () => {
  it("starts with no social identity and the opt-in-off default", () => {
    const me = useSocialStore.getState().me;
    expect(me.username).toBeNull();
    // Nobody becomes discoverable by upgrading (§6.1).
    expect(me.visibility).toBe("unavailable");
  });

  it("patches without clobbering the fields it was not given", () => {
    useSocialStore.getState().setMyProfile({ username: "drodio", socialId: "s-me" });
    useSocialStore.getState().setMyProfile({ visibility: "public" });
    expect(useSocialStore.getState().me).toEqual({
      username: "drodio",
      displayName: null,
      visibility: "public",
      socialId: "s-me",
    });
  });
});

describe("socialStore — the roster of people", () => {
  it("setPeople REPLACES the roster, so someone the server stopped returning disappears", () => {
    useSocialStore.getState().setPeople([ada, bob]);
    useSocialStore.getState().setPeople([bob]);
    expect(Object.keys(useSocialStore.getState().people)).toEqual(["s-bob"]);
  });

  it("upsertPerson MERGES: a presence-only frame keeps the name it never mentioned", () => {
    useSocialStore.getState().upsertPerson(ada);
    // A `peer_presence` frame carries the availability and NOTHING else. Under a replace (or a
    // signature that demands a full Person) this cannot even be expressed — which is why the patch
    // below omits every other field.
    useSocialStore.getState().upsertPerson({ socialId: "s-ada", availability: "available" });
    const got = useSocialStore.getState().people["s-ada"]!;
    expect(got.availability).toBe("available");
    expect(got.displayName).toBe("Ada L");
    expect(got.username).toBe("ada");
    expect(got.relationship).toBe("stranger");
  });

  it("upsertPerson MERGES the other way too: a profile fetch does not blank the dot", () => {
    useSocialStore.getState().upsertPerson({ ...ada, availability: "available" });
    useSocialStore
      .getState()
      .upsertPerson({ socialId: "s-ada", displayName: "Ada Lovelace", relationship: "connected" });
    const got = useSocialStore.getState().people["s-ada"]!;
    expect(got.availability).toBe("available");
    expect(got.displayName).toBe("Ada Lovelace");
    expect(got.relationship).toBe("connected");
  });

  it("upsertPerson treats an explicit `undefined` as 'not mentioned', never as 'blank it'", () => {
    useSocialStore.getState().upsertPerson(ada);
    useSocialStore.getState().upsertPerson({ socialId: "s-ada", displayName: undefined });
    expect(useSocialStore.getState().people["s-ada"]!.displayName).toBe("Ada L");
  });

  it("upsertPerson creates NO row for an unknown id with no name — the same no-ghost rule", () => {
    useSocialStore.getState().upsertPerson({ socialId: "s-nobody", availability: "available" });
    expect(useSocialStore.getState().people).toEqual({});
  });

  it("upsertPerson DOES create a row when the patch names the person, filling fail-closed defaults", () => {
    useSocialStore.getState().upsertPerson({ socialId: "s-new", username: "cy" });
    expect(useSocialStore.getState().people["s-new"]).toEqual({
      socialId: "s-new",
      username: "cy",
      displayName: null,
      availability: "offline",
      relationship: "stranger",
    });
  });

  it("setPeople defaults a MISSING availability to offline — never 'reachable' on missing evidence", () => {
    // The API client's JSON read is an unchecked cast and the wire shape carries `online`, not
    // `availability`, so a row really can arrive without one. The type says otherwise; the store
    // does not get to believe it.
    const noAvailability = { socialId: "s-cy", username: "cy", displayName: null, relationship: "stranger" as const };
    useSocialStore.getState().setPeople([noAvailability]);
    expect(useSocialStore.getState().people["s-cy"]!.availability).toBe("offline");
  });

  it("setAvailability writes the peer's dot", () => {
    useSocialStore.getState().setPeople([ada]);
    useSocialStore.getState().setAvailability("s-ada", "available");
    expect(useSocialStore.getState().people["s-ada"]!.availability).toBe("available");
  });

  it("setAvailability for an UNKNOWN id creates no ghost row", () => {
    useSocialStore.getState().setAvailability("s-nobody", "available");
    expect(useSocialStore.getState().people).toEqual({});
  });

  it("setAvailability keeps the same object identity when nothing changed (no needless re-render)", () => {
    useSocialStore.getState().setPeople([ada]);
    const before = useSocialStore.getState().people;
    useSocialStore.getState().setAvailability("s-ada", "offline");
    expect(useSocialStore.getState().people).toBe(before);
  });

  it("removePerson drops the row AND its unread count", () => {
    useSocialStore.getState().setPeople([ada, bob]);
    useSocialStore.getState().bumpUnread("s-ada", 3);
    useSocialStore.getState().removePerson("s-ada");
    expect(useSocialStore.getState().people).toEqual({ "s-bob": bob });
    expect(useSocialStore.getState().unread).toEqual({});
  });
});

describe("socialStore — unread", () => {
  it("accumulates and clears per person, and totals across everyone", () => {
    useSocialStore.getState().bumpUnread("s-ada");
    useSocialStore.getState().bumpUnread("s-ada", 2);
    useSocialStore.getState().bumpUnread("s-bob");
    expect(totalUnread(useSocialStore.getState().unread)).toBe(4);
    useSocialStore.getState().clearUnread("s-ada");
    expect(useSocialStore.getState().unread).toEqual({ "s-bob": 1 });
    expect(totalUnread(useSocialStore.getState().unread)).toBe(1);
  });
});

describe("socialStore — connection requests", () => {
  it("sets each direction independently", () => {
    const req = { id: "c1", socialId: "s-ada", username: "ada", displayName: null };
    useSocialStore.getState().setRequests({ incoming: [req] });
    expect(useSocialStore.getState().incoming).toEqual([req]);
    expect(useSocialStore.getState().outgoing).toEqual([]);
    useSocialStore.getState().setRequests({ outgoing: [req] });
    // Setting outgoing must not wipe incoming — they arrive from one payload but change apart.
    expect(useSocialStore.getState().incoming).toEqual([req]);
  });
});

describe("socialStore — reset", () => {
  it("clears every account-scoped fact on sign-out", () => {
    useSocialStore.getState().setMyProfile({ username: "drodio", visibility: "public" });
    useSocialStore.getState().setPeople([ada]);
    useSocialStore.getState().bumpUnread("s-ada", 5);
    useSocialStore.getState().setRequests({ incoming: [{ id: "c1", socialId: "s-ada", username: "ada", displayName: null }] });
    useSocialStore.getState().reset();
    const s = useSocialStore.getState();
    expect(s.me.username).toBeNull();
    expect(s.me.visibility).toBe("unavailable");
    expect(s.people).toEqual({});
    expect(s.unread).toEqual({});
    expect(s.incoming).toEqual([]);
  });
});

describe("socialStore — selectors", () => {
  it("personName prefers a set display name and falls back to the username", () => {
    expect(personName(ada)).toBe("Ada L");
    expect(personName(bob)).toBe("bob");
    // Whitespace-only is not a name — same rule entitlement.authIdentity applies.
    expect(personName({ username: "cy", displayName: "   " })).toBe("cy");
  });

  it("peopleList puts reachable people first, then sorts by display name", () => {
    const zed = person({ socialId: "s-zed", username: "zed", availability: "available" });
    const amy = person({ socialId: "s-amy", username: "amy", availability: "offline" });
    const away = person({ socialId: "s-ida", username: "ida", availability: "away" });
    const list = peopleList({ "s-amy": amy, "s-zed": zed, "s-ida": away });
    expect(list.map((p) => p.username)).toEqual(["zed", "ida", "amy"]);
  });

  it("an UNRECOGNIZED availability ranks AS offline, proved by rank and not by alphabet", () => {
    // NAME-ADVERSARIAL on purpose. The bad row is called "aaa" so it sorts FIRST alphabetically:
    // if rank were being ignored it would lead the list, and if the fallback were a distinct
    // fourth tier it would trail "amy". Landing BETWEEN — after every available person, tied with
    // the offline group and ordered by name inside it — is a fact only the rank can produce.
    // (A bad row named "bad" would have passed under all three behaviours, which is exactly the
    // proved-by-alphabet trap.)
    const bad = { ...person({ socialId: "s-bad", username: "aaa" }), availability: undefined } as unknown as Person;
    const up = person({ socialId: "s-zed", username: "zed", availability: "available" });
    const off = person({ socialId: "s-amy", username: "amy", availability: "offline" });
    const list = peopleList({ "s-bad": bad, "s-amy": off, "s-zed": up });
    expect(list.map((p) => p.username)).toEqual(["zed", "aaa", "amy"]);
  });

  it("a NaN comparator would scramble rows nowhere near the bad one — the full order is asserted", () => {
    // The hazard is not the bad row's own position: a comparator returning NaN makes the WHOLE
    // sort implementation-defined. Two available people either side of it must stay in name order.
    const bad = { ...person({ socialId: "s-bad", username: "mid" }), availability: "busy" } as unknown as Person;
    const a = person({ socialId: "s-a", username: "ann", availability: "available" });
    const z = person({ socialId: "s-z", username: "zoe", availability: "available" });
    const list = peopleList({ "s-bad": bad, "s-z": z, "s-a": a });
    expect(list.map((p) => p.username)).toEqual(["ann", "zoe", "mid"]);
  });

  it("roster hands back the MentionAgent shape, addressed by the person: MOUNT id", () => {
    const got = roster({ "s-ada": { ...ada, availability: "available" } });
    expect(got).toEqual([
      {
        id: personAgentId("s-ada"),
        name: "Ada L",
        projectId: "",
        projectName: "",
        band: "running",
        canAcceptInput: true,
      },
    ]);
    // The id is the mount id, NOT the raw social id — every downstream mention consumer routes on it.
    expect(got[0]!.id).not.toBe("s-ada");
  });

  it("roster keeps an OFFLINE person addressable — availability is not a routing gate", () => {
    // persist-then-fan-out (§6): an offline peer's message is durably written and delivered on
    // reconnect, so hiding them from the picker would refuse a send that would have worked.
    const got = roster({ "s-bob": bob });
    expect(got).toHaveLength(1);
    expect(got[0]!.canAcceptInput).toBe(true);
  });
});
