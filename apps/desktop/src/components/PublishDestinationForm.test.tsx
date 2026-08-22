// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  PublishDestinationForm,
  destinationIdProblem,
  destinationUrlProblem,
} from "./PublishDestinationForm";

// What is worth pinning here is not that the form renders — it is that a value the backend will
// refuse NEVER REACHES THE CALLER. The caller writes config.toml, so a form that hands over a bad
// id produces a destination that exists in config and can never hold a keychain token: valid on
// screen, permanently broken in use, and only discoverable when a publish fails.
//
// So every assertion below is about the SIDE EFFECT — `onSubmit` called, or `onSubmit` not called —
// and never about the presence of an error message alone. A message is easy to render beside a
// write that happened anyway.

const GOOD = { id: "drodio", name: "drodio.com", url: "https://drodio.com/api/mcp" };

function fill(values: Partial<typeof GOOD>) {
  const merged = { ...GOOD, ...values };
  fireEvent.change(screen.getByTestId("publish-form-id"), { target: { value: merged.id } });
  fireEvent.change(screen.getByTestId("publish-form-name"), { target: { value: merged.name } });
  fireEvent.change(screen.getByTestId("publish-form-url"), { target: { value: merged.url } });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /add destination/i }));
}

describe("PublishDestinationForm", () => {
  it("hands the caller exactly what was typed, trimmed", () => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    fill({ id: "  drodio  ", name: " drodio.com ", url: "  https://drodio.com/api/mcp  " });
    submit();

    // The exact draft, not "was called": the caller turns these three values into three dotted
    // config paths, so a stray space in the id becomes a keychain key that never matches.
    expect(onSubmit).toHaveBeenCalledWith(GOOD);
  });

  // ── THE ID RULE, mirrored from Rust's `destination_id_is_valid` ──────────────────────────────
  // The id is interpolated into a keychain account key (`publish-<id>-token`), which is why the
  // rule is a whitelist. Each case below is a value that config.toml would happily hold and every
  // keychain call would then refuse.

  it.each([
    ["", "empty"],
    ["Drodio", "uppercase"],
    ["drodio.com", "a dot"],
    ["drodio com", "a space"],
    ["drodio_com", "an underscore"],
    ["drodio/../other", "path traversal"],
    ["a".repeat(65), "over 64 characters"],
  ])("refuses the id %j (%s) and writes nothing", (id) => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    fill({ id });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-form-id-problem")).toBeTruthy();
  });

  it("accepts every character the Rust rule allows, so the mirror is not stricter than it", () => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    // Lowercase, digits, dashes, and exactly 64 characters — the boundary, which an off-by-one
    // bound (`< 64`) would reject and which the backend accepts.
    const id = `${"a1-".repeat(21)}z`;
    expect(id).toHaveLength(64);
    fill({ id });
    submit();

    expect(onSubmit).toHaveBeenCalledWith({ ...GOOD, id });
  });

  it("refuses an id that is already configured, rather than overwriting that destination", () => {
    // A silent overwrite is the dangerous shape: `publish.destinations` is a map, so re-using an id
    // replaces the name and URL while the OLD destination's keychain token stays under that key —
    // the new URL would be sent the previous destination's bearer.
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} takenIds={["drodio", "linkedin"]} />);

    fill({ id: "linkedin" });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-form-id-problem").textContent).toContain("already configured");
  });

  // ── THE URL CHECKS ──────────────────────────────────────────────────────────────────────────
  // Deliberately light: `publish_url.rs::validate_destination_url` is the authority and re-runs at
  // call time. These pin the four the form does check, and the last test pins that the form SAYS it
  // is not the authority.

  it.each([
    ["", "empty"],
    ["not a url", "unparseable"],
    ["http://drodio.com/api/mcp", "plain http to a remote host"],
    ["file://localhost/etc/passwd", "a non-http scheme, even on loopback"],
    ["https://user:secret@drodio.com/api/mcp", "userinfo"],
    ["https://:secret@drodio.com/api/mcp", "userinfo with an empty username"],
  ])("refuses the URL %j (%s) and writes nothing", (url) => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    fill({ url });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-form-url-problem")).toBeTruthy();
  });

  it("explains that userinfo is a credential on disk, not merely a formatting complaint", () => {
    // The wording is the load-bearing part: a user told "invalid URL" moves the credential
    // somewhere else in config.toml. Told WHY, they take it out.
    expect(destinationUrlProblem("https://user:secret@drodio.com/api/mcp")).toContain("plaintext");
  });

  it.each([
    "http://localhost:3000/api/mcp",
    "http://LocalHost:3000/api/mcp",
    "http://127.0.0.1:3000/api/mcp",
    // 127.0.0.0/8 in its entirety — the obvious `=== "127.0.0.1"` spelling fails this one.
    "http://127.0.0.2:3000/api/mcp",
    // `URL.hostname` returns an IPv6 literal WITH its brackets, so a compare against "::1" that
    // does not strip them never matches and this loopback URL is wrongly refused.
    "http://[::1]:3000/api/mcp",
  ])("allows plain http on the loopback address %j", (url) => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    fill({ url });
    submit();

    expect(onSubmit).toHaveBeenCalledWith({ ...GOOD, url });
  });

  it("does not extend the loopback exemption to a host that merely looks like localhost", () => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    fill({ url: "http://localhost.evil.example.com/api/mcp" });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says on screen that the probe, not the form, is the authority", () => {
    render(<PublishDestinationForm onSubmit={vi.fn()} />);
    expect(screen.getByText(/quick checks only/i)).toBeTruthy();
    expect(screen.getByText(/capability probe/i)).toBeTruthy();
  });

  it("refuses a blank name and writes nothing", () => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} />);

    fill({ name: "   " });
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows no problem before the first submit attempt", () => {
    // Validating on every keystroke would tell the user their id is empty before they have typed
    // its first character.
    render(<PublishDestinationForm onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("publish-form-id-problem")).toBeNull();
    expect(screen.queryByTestId("publish-form-url-problem")).toBeNull();
  });

  it("submits nothing at all while the caller's write is in flight", () => {
    // One gesture, one write. Without this a double click writes the same destination twice.
    //
    // Submitted through the FORM rather than by clicking the button, deliberately: a `disabled`
    // attribute is not the guard, it is the paint. Enter in a text field, or a click that races the
    // re-render, submits a form whose button is disabled — so the check has to live in the handler,
    // and this is the event that proves it does.
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} busy />);

    fill({});
    fireEvent.submit(screen.getByRole("form", { name: /add publish destination/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prefills from `initial`, so the same form can edit an existing destination", () => {
    const onSubmit = vi.fn();
    render(<PublishDestinationForm onSubmit={onSubmit} initial={GOOD} submitLabel="Add destination" />);

    submit();

    expect(onSubmit).toHaveBeenCalledWith(GOOD);
  });
});

// The two rules as pure functions, so their boundaries are pinned without a render. These are the
// values a future edit is most likely to get wrong by one.
describe("destinationIdProblem", () => {
  it("accepts a plain id and rejects nothing it should not", () => {
    expect(destinationIdProblem("drodio")).toBeNull();
    expect(destinationIdProblem("x")).toBeNull();
    expect(destinationIdProblem("a".repeat(64))).toBeNull();
  });

  it("rejects one character past the limit", () => {
    expect(destinationIdProblem("a".repeat(65))).not.toBeNull();
  });
});
