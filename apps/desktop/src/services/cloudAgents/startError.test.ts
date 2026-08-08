import { describe, it, expect } from "vitest";
import { classifyStartError, isTranscriptTooLarge, parseStartError } from "./startError";
import { CloudApiError, makeCloudApi } from "./api";
import { synthesizedErrorMessage } from "./synthesizedError";

describe("parseStartError", () => {
  it("reads a structured object", () => {
    expect(parseStartError({ status: 402, code: "insufficient_credits", message: "nope" })).toEqual({
      status: 402,
      code: "insufficient_credits",
      message: "nope",
    });
  });
  it("parses a JSON string body", () => {
    expect(parseStartError('{"status":403,"code":"cloud_agents_disabled"}')).toMatchObject({
      status: 403,
      code: "cloud_agents_disabled",
    });
  });
  it("falls back to message for an Error or plain string", () => {
    expect(parseStartError(new Error("boom")).message).toBe("boom");
    expect(parseStartError("just text").message).toBe("just text");
  });

  it("reads status + code off an Error SUBCLASS (CloudApiError), not just a plain object", () => {
    expect(parseStartError(new CloudApiError(500, "boom_code", "kaboom"))).toEqual({
      status: 500,
      code: "boom_code",
      message: "kaboom",
    });
  });

  it("trims an Error message and collapses interior whitespace/newlines", () => {
    expect(parseStartError(new Error("  sandbox provisioning failed  ")).message).toBe(
      "sandbox provisioning failed",
    );
    expect(parseStartError(new Error("sandbox failed\n   retrying")).message).toBe(
      "sandbox failed retrying",
    );
    expect(parseStartError({ status: 500, message: "  padded  " }).message).toBe("padded");
  });

  it("collapses a whitespace-only message to null (never an empty string)", () => {
    expect(parseStartError(new Error("   ")).message).toBeNull();
    expect(parseStartError({ status: 500, message: "\n\t " }).message).toBeNull();
    expect(parseStartError("   ").message).toBeNull();
  });

  it("still unwraps a JSON envelope carried in .message, unmangled", () => {
    const wrapped = new Error('  {"status":402,"code":"insufficient_credits","message":"a  b"}  ');
    expect(parseStartError(wrapped)).toMatchObject({
      status: 402,
      code: "insufficient_credits",
      // The nested message is read from the RAW envelope, so its own spacing survives the parse
      // (then gets normalized on its own pass).
      message: "a b",
    });
  });
});

describe("classifyStartError", () => {
  it("classifies the kill-switch refusal as an OUTAGE, not an account problem", () => {
    const g = classifyStartError({ status: 403, code: "cloud_agents_disabled" });
    expect(g.reason).toBe("service_unavailable");
    // No deep link, and here that is right: the switch is ours, so Settings holds no fix.
    expect(g.deepLink).toBeUndefined();
    // The copy must not blame the caller's account — that sentence was the original dead end.
    expect(g.message).not.toMatch(/your account/i);
    expect(g.message).toMatch(/temporarily unavailable/i);
  });

  it("classifies a missing-Claude-auth error → deep-link to cloudauth", () => {
    const g = classifyStartError({ status: 400, code: "no_claude_auth" });
    expect(g.reason).toBe("no_auth");
    expect(g.deepLink).toBe("cloudauth");
  });

  it("classifies out-of-credits (402) → deep-link to credits", () => {
    const g = classifyStartError({ status: 402 });
    expect(g.reason).toBe("insufficient_credits");
    expect(g.deepLink).toBe("credits");
  });

  it("classifies a 401 as signed_out with a sign-in affordance", () => {
    const g = classifyStartError({ status: 401 });
    expect(g.reason).toBe("signed_out");
    expect(g.needsSignIn).toBe(true);
  });

  // Cloud no longer requires a paid account, so there is no `no_paid_account` bucket. An OLDER
  // server can still send `not_entitled`, and "add credits" is both the right advice and the right
  // destination for anyone who receives it — a top-up is what clears `paid_at` on that server too.
  it("routes an older server's not_entitled to credits rather than a dead end", () => {
    const g = classifyStartError({ status: 403, code: "not_entitled" });
    expect(g.reason).toBe("insufficient_credits");
    expect(g.deepLink).toBe("credits");
  });

  // ── THE SYNTHESIZED FALLBACK IS NOT THE SERVER'S PROSE ───────────────────────────────────────
  it("does not render ensureOk's SYNTHESIZED message as if the server had written it", () => {
    // `ensureOk` does not leave `message` null when a body carries none — it synthesizes
    // `Request failed (<status>)` for an empty body, a non-JSON body, a proxy's HTML error page.
    // That is not equal to the code, so it passed the prose gate and rendered VERBATIM: the user
    // read "Request failed (403)" and never saw the status's own sentence. It shadowed 413 too.
    const g403 = classifyStartError(new CloudApiError(403, null, synthesizedErrorMessage(403)));
    expect(g403.message).not.toMatch(/request failed/i);
    const g413 = classifyStartError(new CloudApiError(413, null, synthesizedErrorMessage(413)));
    expect(g413.message).toMatch(/too large/i);
    const g500 = classifyStartError(new CloudApiError(500, null, synthesizedErrorMessage(500)));
    expect(g500.message).toBe("Couldn't start the cloud agent — try again.");
  });

  it("survives a REAL non-JSON error through makeCloudApi — the producer, not a hand-typed copy", () => {
    // The binding test. The suppression used to be a regex re-encoding `ensureOk`'s template
    // literal with nothing tying them together, so a reword there would silently stop the match
    // while every test stayed green (they all hand-typed the string they asserted).
    const api = makeCloudApi({
      baseUrl: "https://example.invalid",
      getToken: async () => "tok",
      fetch: (async () =>
        new Response("<html><body>Forbidden</body></html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        })) as typeof fetch,
    });
    return api.startSession({ projectId: "p", goal: "g", repoUrl: "r" } as never).then(
      () => {
        throw new Error("expected startSession to reject");
      },
      (err: unknown) => {
        expect((err as CloudApiError).message).toBe(synthesizedErrorMessage(403));
        expect(classifyStartError(err).message).not.toMatch(/request failed/i);
      },
    );
  });

  // ── "TRY AGAIN" IS A PROMISE ─────────────────────────────────────────────────────────────────
  it("never promises 'try again' for a body-less NON-RETRYABLE status", () => {
    // Suppressing the synthesized message makes the retry line reachable on body-less 4xx, and
    // `/sessions/start` emits several (404 not_found, 400 claude_auth_required, 409
    // session_id_taken) that fail identically every time.
    for (const status of [400, 404, 405, 409, 410, 451]) {
      const m = classifyStartError(new CloudApiError(status, null, synthesizedErrorMessage(status))).message;
      expect(m).not.toMatch(/try again/i);
      expect(m).toMatch(/refused that request/i);
      // …and it claims neither account scope nor permanence, neither of which a bare status proves.
      expect(m).not.toMatch(/your account|this account/i);
      expect(m).not.toMatch(/won't change|permanent/i);
    }
  });

  it("DOES still promise 'try again' where retrying can actually work", () => {
    // The positive half, so the rule above cannot pass by never offering retry at all. `status: 0`
    // is a network failure — this module treats a falsy status as "no status" everywhere else.
    for (const status of [500, 502, 503, 429, 408, 425]) {
      expect(
        classifyStartError(new CloudApiError(status, null, synthesizedErrorMessage(status))).message,
      ).toBe("Couldn't start the cloud agent — try again.");
    }
    expect(
      classifyStartError(new CloudApiError(0, null, synthesizedErrorMessage(0))).message,
    ).toBe("Couldn't start the cloud agent — try again.");
  });

  it("prefers the stable code over the status when both are present", () => {
    // 403 alone would read service_unavailable, but the code says it is really an auth problem.
    const g = classifyStartError({ status: 403, code: "missing_auth" });
    expect(g.reason).toBe("no_auth");
  });

  it("detects an offline transport failure (no HTTP status) across real runtime messages", () => {
    // The literal strings the actual webviews/runtimes emit when there's no connectivity.
    expect(classifyStartError(new Error("Failed to fetch")).reason).toBe("offline"); // Chromium
    expect(classifyStartError(new Error("Load failed")).reason).toBe("offline"); //     macOS WKWebView
    expect(classifyStartError(new Error("fetch failed")).reason).toBe("offline"); //    undici/Node
    expect(
      classifyStartError(new Error("NetworkError when attempting to fetch resource")).reason,
    ).toBe("offline"); // Firefox
    expect(classifyStartError("connection refused").reason).toBe("offline");
    // A wrapper that reports a network failure as status 0 is still "no status".
    expect(classifyStartError({ status: 0, message: "load failed" }).reason).toBe("offline");
  });

  it("does NOT let '…load failed' substrings trip the offline bucket (word-boundary anchor)", () => {
    // The `\bload failed\b` anchor exists so WKWebView's "Load failed" classifies as offline while
    // application-level failures that merely END in "load failed" do not. These carry NO status —
    // the same shape as a genuine transport failure — so the anchor is the ONLY thing keeping them
    // out of the "check your connection" path. Pin it.
    for (const msg of ["upload failed", "download failed", "payload failed", "Upload failed"]) {
      expect(classifyStartError(new Error(msg)).reason).toBe("generic");
      expect(classifyStartError({ message: msg }).reason).toBe("generic");
    }
    // …while the real WKWebView phrase still classifies as offline, in either casing.
    expect(classifyStartError(new Error("Load failed")).reason).toBe("offline");
    expect(classifyStartError(new Error("request load failed")).reason).toBe("offline");
  });

  it("does NOT treat a server response (real status) mentioning connect/timeout as offline", () => {
    // These carry a status → a real server-side failure, not a transport problem. They must stay
    // generic so the user isn't sent down the 'check your connection' path.
    expect(classifyStartError({ status: 500, message: "could not connect the repository" }).reason).toBe(
      "generic",
    );
    expect(classifyStartError({ status: 500, message: "sandbox provisioning timed out" }).reason).toBe(
      "generic",
    );
    expect(classifyStartError({ status: 504, message: "gateway timeout" }).reason).toBe("generic");
    // A CloudApiError (Error subclass) with a status must keep it — never decay to offline.
    expect(
      classifyStartError(new CloudApiError(500, null, "sandbox provisioning timed out")).reason,
    ).toBe("generic");
    // And a CloudApiError with a code still classifies by code.
    expect(
      classifyStartError(new CloudApiError(403, "cloud_agents_disabled", "off")).reason,
    ).toBe("service_unavailable");
  });

  it("pins CODE_HINTS precedence: the first matching fragment (array order) wins", () => {
    // A code containing two fragments must resolve deterministically by CODE_HINTS order, so a
    // future reorder can't silently change the deep-link target.
    // "cloud_agents_disabled" precedes "claude_auth" → service_unavailable.
    expect(classifyStartError({ code: "cloud_agents_disabled_no_claude_auth" }).reason).toBe(
      "service_unavailable",
    );
    // The genuinely ambiguous overlap: "insufficient_credits" (earlier) precedes "paid_account".
    expect(classifyStartError({ code: "billing.paid_account_insufficient_credits" }).reason).toBe(
      "insufficient_credits",
    );
  });

  it("does NOT misclassify a prose message that contains a snake_case fragment (code-only match)", () => {
    // A 500 whose human message happens to mention "payment_required" must stay generic — the
    // fragment match is against `code` only, not the free-text message.
    const g = classifyStartError({ status: 500, message: "internal: payment_required flag unset" });
    expect(g.reason).toBe("generic");
    // Same rule with no status at all: prose fragments never classify, only `code` does.
    expect(classifyStartError({ message: "no_claude_auth was mentioned in the log" }).reason).toBe(
      "generic",
    );
    expect(classifyStartError({ message: "cloud_agents_disabled?" }).reason).toBe("generic");
    // …and the same fragment IN THE CODE does classify — proving the split is code-vs-message.
    expect(classifyStartError({ code: "no_claude_auth" }).reason).toBe("no_auth");
  });

  it("falls back to the plain retry line when the message is only whitespace", () => {
    const g = classifyStartError({ status: 500, message: "   \n  " });
    expect(g.reason).toBe("generic");
    expect(g.message).toBe("Couldn't start the cloud agent — try again.");
  });

  it("surfaces a short server message verbatim for a generic failure", () => {
    const g = classifyStartError({ status: 500, message: "sandbox provisioning failed" });
    expect(g.reason).toBe("generic");
    expect(g.message).toBe("sandbox provisioning failed");
  });

  it("does not leak a huge/opaque body — falls back to a plain retry line", () => {
    const g = classifyStartError({ status: 500, message: "x".repeat(500) });
    expect(g.reason).toBe("generic");
    expect(g.message).toBe("Couldn't start the cloud agent — try again.");
  });

  it("never renders a bare MACHINE CODE as the user's error line", () => {
    // A route that answers `{ error: "<code>" }` and nothing else makes `ensureOk` fold that one
    // token into BOTH code and message, and the generic branch's "prefer the server's message" rule
    // would then print snake_case at the user. The live case: a 413 whose only body is
    // `transcript_too_large`, shown to someone who sent no transcript (roborev 57566).
    const g = classifyStartError(new CloudApiError(413, "transcript_too_large", "transcript_too_large"));
    expect(g.message).not.toMatch(/transcript_too_large/);
    expect(g.message).toBe("That request was too large for the cloud service.");

    // The rule is about the code/message COLLISION, not about 413 — any such body gets the written
    // sentence instead of the token.
    const h = classifyStartError({ status: 500, code: "sandbox_boot_failed", message: "sandbox_boot_failed" });
    expect(h.message).toBe("Couldn't start the cloud agent — try again.");
    // Casing differences are still the same token.
    expect(
      classifyStartError({ status: 500, code: "boot_failed", message: "BOOT_FAILED" }).message,
    ).toBe("Couldn't start the cloud agent — try again.");
  });

  it("still prefers a real PROSE message that merely accompanies a code", () => {
    // The suppression must not swallow genuine server prose — that would undo the whole point of
    // surfacing the server's own words on a generic failure.
    const g = classifyStartError({ status: 500, code: "boot_failed", message: "the sandbox never booted" });
    expect(g.message).toBe("the sandbox never booted");
  });

  it("gives a 413 its own line — 'try again' is wrong advice for a request that won't shrink", () => {
    expect(classifyStartError({ status: 413 }).message).toBe(
      "That request was too large for the cloud service.",
    );
    // Neutral about WHAT was too large: createCloudAgent sends no transcript, so naming the
    // conversation here would be a guess — and telling a user their conversation was too big when
    // none was sent is the exact defect this replaced.
    expect(classifyStartError({ status: 413 }).message).not.toMatch(/conversation|transcript/i);
  });
});

// ── the ONE trigger for the promotion transcript retry (bead sparkle-nit44) ─────────────────────
//
// This predicate is deliberately NOT a `StartErrorReason`: the only caller that can act on it is
// `promote.ts`, which is the only caller that ever SENDS a transcript. `createCloudAgent` never
// does, so a 413 there is an oversized something-else and must keep reading as `generic` rather
// than telling a user their conversation was too big when no conversation was sent.
describe("isTranscriptTooLarge", () => {
  it("fires on the route's own signal: 413 { error: 'transcript_too_large' }", () => {
    // What the desktop actually receives: `ensureOk` folds the body's `error` into `code`.
    expect(isTranscriptTooLarge(new CloudApiError(413, "transcript_too_large", "transcript_too_large"))).toBe(
      true,
    );
  });

  it("fires on a BARE 413 with no code of ours — Fastify's bodyLimit, and any proxy in front of it", () => {
    // The case that matters most, and the reason the trigger cannot be code-only: a body that dies
    // at the transport/bodyLimit boundary carries FST_ERR_CTP_BODY_TOO_LARGE (or nothing at all
    // from a proxy), never our code. A classifier keyed only on the code would go dark for exactly
    // the largest transcripts.
    expect(isTranscriptTooLarge(new CloudApiError(413, null, "Request failed (413)"))).toBe(true);
    expect(isTranscriptTooLarge({ status: 413 })).toBe(true);
    expect(isTranscriptTooLarge(new CloudApiError(413, "FST_ERR_CTP_BODY_TOO_LARGE", "too big"))).toBe(
      true,
    );
    expect(isTranscriptTooLarge('{"status":413}')).toBe(true);
  });

  it("fires on the code even when the status is NOT 413 (either half suffices)", () => {
    expect(isTranscriptTooLarge({ status: 400, code: "transcript_too_large" })).toBe(true);
    expect(isTranscriptTooLarge({ code: "transcript_too_large" })).toBe(true);
  });

  it("does NOT fire on any other start failure", () => {
    // Every other bucket the classifier knows about, plus the shapes that carry no status at all.
    expect(isTranscriptTooLarge(new CloudApiError(402, "insufficient_credits", "broke"))).toBe(false);
    expect(isTranscriptTooLarge(new CloudApiError(403, "cloud_agents_disabled", "off"))).toBe(false);
    expect(isTranscriptTooLarge(new CloudApiError(401, null, "signed out"))).toBe(false);
    expect(isTranscriptTooLarge(new CloudApiError(400, "bad_request", "bad_request"))).toBe(false);
    expect(isTranscriptTooLarge(new CloudApiError(500, null, "sandbox provisioning failed"))).toBe(
      false,
    );
    expect(isTranscriptTooLarge(new Error("Failed to fetch"))).toBe(false);
    expect(isTranscriptTooLarge(undefined)).toBe(false);
  });

  it("does NOT fire on prose that merely MENTIONS the code (code-only match, like CODE_HINTS)", () => {
    // Same split the rest of this module enforces: a free-text message never classifies. A 500 whose
    // body quotes the code must not make the promotion silently drop the user's conversation.
    expect(
      isTranscriptTooLarge({ status: 500, message: "internal: transcript_too_large check threw" }),
    ).toBe(false);
    expect(isTranscriptTooLarge("transcript_too_large happened once")).toBe(false);
  });
});
