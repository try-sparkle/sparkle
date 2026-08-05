// The window-local record of what the SERVER last said about each cloud session.
//
// Everything here is about ONE property: a reading is a snapshot of a machine this desktop does not
// own, so it must expire. `engine/goalContinuation` refuses a cloud agent it has no CURRENT reading
// for, which means a reader that forgot to expire would not fail loudly — it would quietly authorise
// resuming a sandbox nobody has looked at in hours. So the expiry is asserted directly, not through
// a consumer.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_SESSION_REFRESH_MS,
  CLOUD_SESSION_STATUS_MAX_AGE_MS,
  cloudSessionObservedAt,
  cloudSessionStatusOf,
  noteCloudSessionStatus,
  refreshCloudSessionStatuses,
  resetCloudSessionStatusesForTests,
} from "./sessionStatus";

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetCloudSessionStatusesForTests();
});

describe("readings", () => {
  it("reads back what the server said", () => {
    noteCloudSessionStatus("s1", "active", T0);
    expect(cloudSessionStatusOf("s1", T0 + 1_000)).toBe("active");
    expect(cloudSessionObservedAt("s1")).toBe(T0);
  });

  it("is undefined for a session nobody listed", () => {
    expect(cloudSessionStatusOf("never-seen", T0)).toBeUndefined();
  });

  it("EXPIRES — a stale reading is not a weaker reading, it is none", () => {
    noteCloudSessionStatus("s1", "active", T0);
    // One tick inside the window still answers…
    expect(cloudSessionStatusOf("s1", T0 + CLOUD_SESSION_STATUS_MAX_AGE_MS - 1)).toBe("active");
    // …and at the boundary it stops. This is the assertion standing between the goal sweep and a
    // resume aimed at a sandbox that hibernated an hour ago.
    expect(cloudSessionStatusOf("s1", T0 + CLOUD_SESSION_STATUS_MAX_AGE_MS)).toBeUndefined();
  });

  it("a fresh reading revives an expired one", () => {
    noteCloudSessionStatus("s1", "active", T0);
    const late = T0 + CLOUD_SESSION_STATUS_MAX_AGE_MS + 1;
    expect(cloudSessionStatusOf("s1", late)).toBeUndefined();
    noteCloudSessionStatus("s1", "paused", late);
    expect(cloudSessionStatusOf("s1", late + 1)).toBe("paused");
  });

  it("ignores a malformed row rather than recording an empty status", () => {
    noteCloudSessionStatus("", "active", T0);
    noteCloudSessionStatus("s2", "", T0);
    expect(cloudSessionStatusOf("", T0)).toBeUndefined();
    expect(cloudSessionStatusOf("s2", T0)).toBeUndefined();
  });
});

describe("refreshCloudSessionStatuses", () => {
  const api = (sessions: Array<{ id: string; status: string }>) => ({
    listSessions: vi.fn(async () => sessions),
  });

  it("records every lifecycle the listing returned", async () => {
    const deps = { api: api([
      { id: "a", status: "active" },
      { id: "b", status: "paused" },
      { id: "c", status: "complete" },
    ]), now: T0 };
    expect(await refreshCloudSessionStatuses("proj", deps)).toBe(3);
    expect(cloudSessionStatusOf("a", T0)).toBe("active");
    expect(cloudSessionStatusOf("b", T0)).toBe("paused");
    // TERMINAL ONES TOO. `reconcileCloudSessions` filters these out because it is deciding which
    // tabs to create; here a `complete` reading is precisely what stops a resume aimed at a
    // finished sandbox, so dropping it would leave that agent reading `unknown` forever.
    expect(cloudSessionStatusOf("c", T0)).toBe("complete");
  });

  it("THROTTLES — a 15s sweep may call it every pass without listing every pass", async () => {
    const deps = { api: api([{ id: "a", status: "active" }]), now: T0 };
    await refreshCloudSessionStatuses("proj", deps);
    expect(deps.api.listSessions).toHaveBeenCalledTimes(1);

    // One tick short of the interval: no second request.
    await refreshCloudSessionStatuses("proj", { ...deps, now: T0 + CLOUD_SESSION_REFRESH_MS - 1 });
    expect(deps.api.listSessions).toHaveBeenCalledTimes(1);

    await refreshCloudSessionStatuses("proj", { ...deps, now: T0 + CLOUD_SESSION_REFRESH_MS });
    expect(deps.api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("throttles PER PROJECT — one busy project must not starve another", async () => {
    const one = { api: api([{ id: "a", status: "active" }]), now: T0 };
    const two = { api: api([{ id: "b", status: "active" }]), now: T0 };
    await refreshCloudSessionStatuses("p1", one);
    await refreshCloudSessionStatuses("p2", two);
    expect(two.api.listSessions).toHaveBeenCalledTimes(1);
    expect(cloudSessionStatusOf("b", T0)).toBe("active");
  });

  it("swallows a failed listing, leaving the old readings to age out on their own", async () => {
    noteCloudSessionStatus("a", "active", T0);
    const deps = {
      api: { listSessions: vi.fn(async () => Promise.reject(new Error("offline"))) },
      now: T0 + CLOUD_SESSION_REFRESH_MS,
    };
    // Resolves, never rejects — a background refresher that threw would take the goal sweep down.
    await expect(refreshCloudSessionStatuses("proj", deps)).resolves.toBe(0);
    // The previous reading is untouched: a failed request is not evidence about the sandbox.
    expect(cloudSessionStatusOf("a", T0 + 1_000)).toBe("active");
  });

  it("stamps the throttle BEFORE awaiting, so overlapping sweeps do not each list", async () => {
    // The sweep runs every 15s and does not await this call. Stamping after the response would let
    // three passes each open their own request against the same project.
    let release!: (v: Array<{ id: string; status: string }>) => void;
    const listSessions = vi.fn(
      () => new Promise<Array<{ id: string; status: string }>>((r) => (release = r)),
    );
    const deps = { api: { listSessions }, now: T0 };
    const first = refreshCloudSessionStatuses("proj", deps);
    const second = refreshCloudSessionStatuses("proj", { ...deps, now: T0 + 1_000 });
    expect(await second).toBe(0);
    expect(listSessions).toHaveBeenCalledTimes(1);
    release([{ id: "a", status: "active" }]);
    expect(await first).toBe(1);
  });
});

describe("out-of-order listings — the NEWEST issue time wins, not the last write", () => {
  // Two producers list independently (the sweep's throttled refresh and `reattach` at project open)
  // and HTTP responses are unordered, so a listing ISSUED first can SETTLE second carrying an older
  // world. Under last-write-wins that stale `active` overwrote a fresh `paused`, and
  // `engine/goalContinuation` reads this map before deciding whether to resume — so the app could
  // wake and bill a sandbox the server had already parked (roborev / knightwatch probe).
  it("refuses a reading issued BEFORE the one already recorded", () => {
    noteCloudSessionStatus("a1", "paused", 2_000); // the fresher listing settled first
    noteCloudSessionStatus("a1", "active", 1_000); // the older one lands late

    expect(cloudSessionStatusOf("a1", 2_000)).toBe("paused");
  });

  it("accepts a genuinely NEWER reading", () => {
    noteCloudSessionStatus("a1", "paused", 1_000);
    noteCloudSessionStatus("a1", "active", 2_000);

    expect(cloudSessionStatusOf("a1", 2_000)).toBe("active");
  });

  it("lets a same-instant reading through — one issue time is one world", () => {
    noteCloudSessionStatus("a1", "paused", 1_000);
    noteCloudSessionStatus("a1", "waiting", 1_000);

    expect(cloudSessionStatusOf("a1", 1_000)).toBe("waiting");
  });
});

describe("a backward clock step must not freeze the map", () => {
  // The ordering guard needs an upper bound or it cannot self-heal. A reading stamped ahead of the
  // wall clock — an NTP correction or the user changing the time — would otherwise refuse EVERY
  // later listing for the whole skew window, while the frozen reading never aged out (its age is
  // negative, so the expiry check cannot fire). The goal-continuation gate reads this map before
  // deciding to resume, so a frozen `active` keeps billing a sandbox the server has since parked.
  it("does not serve a FUTURE-dated reading — it is not usable evidence", () => {
    noteCloudSessionStatus("a1", "active", 10_000);

    // The clock stepped back; the reading is now in the future.
    expect(cloudSessionStatusOf("a1", 5_000)).toBeUndefined();
  });

  it("EVICTS the impossible reading, so the next listing is not refused as 'older'", () => {
    noteCloudSessionStatus("a1", "active", 10_000);

    // The clock stepped back. Reading the impossible value is what THROWS IT AWAY — that is the
    // whole self-heal, and it has to be here rather than in the writer: only a reader holds a
    // wall-clock `now`, so only a reader can tell "ahead of the clock" from "issued a while ago".
    expect(cloudSessionStatusOf("a1", 5_000)).toBeUndefined();
    expect(cloudSessionObservedAt("a1")).toBeUndefined();

    // …so the very next sweep records normally instead of losing to a `prev` from the future.
    noteCloudSessionStatus("a1", "paused", 5_100);
    expect(cloudSessionStatusOf("a1", 5_200)).toBe("paused");
  });

  it("still refuses a merely-newer reading inside the plausible window", () => {
    // The ordinary out-of-order case must keep working — the heal is for broken clocks only.
    noteCloudSessionStatus("a1", "paused", 2_000);
    noteCloudSessionStatus("a1", "active", 1_000);

    expect(cloudSessionStatusOf("a1", 2_000)).toBe("paused");
  });

  it("un-throttles the REFRESH too — the other half of the same freeze", async () => {
    // The throttle stamp is future-dated by exactly the same step, and `deps.now - last` is then
    // negative, which is trivially under the interval — so without this rule every refresh returns
    // 0 without listing for the whole skew window. Paired with the read-side eviction that is the
    // worst of both: an empty map and no producer allowed to refill it (roborev 58586).
    const api = { listSessions: vi.fn(async () => [{ id: "a1", status: "active" }]) };
    expect(await refreshCloudSessionStatuses("proj", { api, now: T0 })).toBe(1);

    // The clock steps back ten refresh intervals. One sweep, in the order the sweep runs them: the
    // read evicts the now-impossible reading…
    const stepped = T0 - 10 * CLOUD_SESSION_REFRESH_MS;
    expect(cloudSessionStatusOf("a1", stepped)).toBeUndefined();

    // …and the refresh must LIST rather than sit out on a future-dated throttle stamp, which is
    // what actually puts a usable reading back. Both halves, or neither works.
    expect(await refreshCloudSessionStatuses("proj", { api, now: stepped })).toBe(1);
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(cloudSessionStatusOf("a1", stepped)).toBe("active");
  });

  it("refuses a stale listing NO MATTER HOW LATE it settles", () => {
    // A request that hangs longer than MAX_AGE still describes an OLDER world when it lands. A
    // size-based escape hatch in the writer ("a `prev` this far ahead must be a stepped clock")
    // cannot tell that case from a stepped clock, so it hands the race back to the stale response
    // — the exact overwrite this guard exists to prevent (roborev 58583).
    const late = 2_000 + CLOUD_SESSION_STATUS_MAX_AGE_MS;
    noteCloudSessionStatus("a1", "paused", late); // the sweep's listing, issued later, settles first
    noteCloudSessionStatus("a1", "active", 2_000); // the hung one lands three minutes late

    expect(cloudSessionObservedAt("a1")).toBe(late);
    expect(cloudSessionStatusOf("a1", late)).toBe("paused");
  });
});
