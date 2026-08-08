// THE SYSTEMIC GUARD for the relay's PTY writes, and it is a TYPE, not a heuristic.
//
// The framing in `relayGate` is only as good as the discipline of the call sites that use it, and
// before `FramedPtyText` that discipline was pure convention: nothing stopped a `socket.on(...)`
// handler added next quarter from calling `writePtyChained(id, payload.text)` with the raw remote
// string and silently reintroducing the hole. That is not hypothetical — roborev 54397 reopened
// 2197's paste-marker bug exactly that way, by adding a caller that did not know about the guard.
//
// A source-scanning grep was tried first and rejected: it matched the word `writePtyChained` inside
// a COMMENT, and its "is this argument safe" predicate accepted `i.text` (the raw socket payload)
// because it could only reason about variable names. A brand cannot be fooled by either.
//
// THE ASSERTIONS BELOW ARE CHECKED BY `tsc`, NOT BY VITEST. `apps/desktop/tsconfig.json` has
// `include: ["src"]`, so this file is typechecked — and a `@ts-expect-error` that does NOT error is
// itself a compile error. So if the brand ever stops rejecting raw strings, `pnpm -r typecheck`
// goes red here. The runtime `it()` blocks exist to pin the framing's observable bytes.

import { describe, expect, it } from "vitest";
import { frameRelaySubmit, frameSubmit, type FramedPtyText } from "./relayGate";
import { PASTE_START, PASTE_END } from "../pasteMarkers";

/** Stands in for `relayClient`'s `writeFramedToPty` — the only PTY write on the relay path. */
function acceptsOnlyFramed(text: FramedPtyText): string {
  return text;
}

describe("FramedPtyText brand (compile-time guard)", () => {
  it("rejects every UNFRAMED shape a future call site might reach for", () => {
    // @ts-expect-error a raw remote payload field is not framed
    acceptsOnlyFramed("rm -rf ~");
    // @ts-expect-error a CR-terminated but unframed string (the pre-fix shape) is not framed
    acceptsOnlyFramed("rm -rf ~\r");
    // @ts-expect-error frameSubmit is the LOCAL keystroke form — deliberately not relay-framed
    acceptsOnlyFramed(frameSubmit("y"));
    // @ts-expect-error hand-rolling the wrapper does not mint the brand; go through relayGate
    acceptsOnlyFramed(`${PASTE_START}rm -rf ~${PASTE_END}\r`);
    expect(true).toBe(true); // the real assertions above are enforced by tsc
  });

  it("accepts the framer's output", () => {
    expect(acceptsOnlyFramed(frameRelaySubmit("ls"))).toBe(`${PASTE_START}ls${PASTE_END}\r`);
  });

  it("is erased at runtime — a framed value is an ordinary string", () => {
    expect(typeof frameRelaySubmit("ls")).toBe("string");
  });
});
