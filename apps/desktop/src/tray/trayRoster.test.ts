import { describe, it, expect } from "vitest";
import { rankCmp, type TrayAgent } from "./trayRoster";

const a = (name: string, status: string): TrayAgent => ({
  id: name, name, kind: "build", status, status_color: "#000", status_label: "x", parent_id: null,
});

describe("rankCmp", () => {
  it("orders red (needs you) before working before dormant", () => {
    const sorted = [a("z", "working"), a("a", "stopped"), a("m", "waiting")].sort(rankCmp);
    expect(sorted.map((x) => x.status)).toEqual(["waiting", "working", "stopped"]);
  });
  it("breaks ties by name", () => {
    const sorted = [a("b", "idle"), a("a", "idle")].sort(rankCmp);
    expect(sorted.map((x) => x.name)).toEqual(["a", "b"]);
  });
  it("errored sorts before working (rank 0, same as waiting/approval)", () => {
    const sorted = [a("w", "working"), a("e", "errored")].sort(rankCmp);
    expect(sorted.map((x) => x.status)).toEqual(["errored", "working"]);
  });
});
