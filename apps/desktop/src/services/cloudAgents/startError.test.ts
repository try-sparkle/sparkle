import { describe, it, expect } from "vitest";
import { classifyStartError, parseStartError } from "./startError";
import { CloudApiError } from "./api";

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
  it("classifies the feature-disabled error (CLOUD_AGENTS_ENABLED off)", () => {
    const g = classifyStartError({ status: 403, code: "cloud_agents_disabled" });
    expect(g.reason).toBe("feature_disabled");
    expect(g.deepLink).toBeUndefined();
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

  it("classifies not-entitled → no_paid_account", () => {
    const g = classifyStartError({ status: 403, code: "not_entitled" });
    expect(g.reason).toBe("no_paid_account");
    expect(g.deepLink).toBe("credits");
  });

  it("prefers the stable code over the status when both are present", () => {
    // 403 alone would read feature_disabled, but the code says it's really an auth problem.
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
    ).toBe("feature_disabled");
  });

  it("pins CODE_HINTS precedence: the first matching fragment (array order) wins", () => {
    // A code containing two fragments must resolve deterministically by CODE_HINTS order, so a
    // future reorder can't silently change the deep-link target.
    // "cloud_agents_disabled" precedes "claude_auth" → feature_disabled.
    expect(classifyStartError({ code: "cloud_agents_disabled_no_claude_auth" }).reason).toBe(
      "feature_disabled",
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
});
