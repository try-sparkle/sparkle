// @vitest-environment jsdom
//
// The Chat block's header — "CHAT" · rule · count · [+].
//
// It reads as another rung of the same ladder the stage headers draw, and it is a SEPARATE
// component from `StageSectionHeader` for three reasons the spec states, of which one is testable
// here and is the one that would actually hurt a user: every stage header is wrapped in
// `<div aria-hidden>` (a tree may not own a heading), and an interactive control inside an
// aria-hidden subtree is unreachable to assistive tech. This header owns a button, so it must never
// acquire that wrapper — which is also why extending the stage header with an `action` prop was the
// wrong shape rather than merely a busier one.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `[+]` mounts `AddPersonPopover`, which reads the directory on open. Mocked at the module
// boundary so this file tests the WIRING and not the network.
vi.mock("../services/socialApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/socialApi")>()),
  getDirectory: vi.fn(async () => ({ users: [], nextCursor: null })),
  getUser: vi.fn(),
  postConnection: vi.fn(),
}));

import { ADD_PERSON_POPOVER_TESTID } from "./AddPersonPopover";
import { useSocialStore } from "../stores/socialStore";
import {
  ADD_PERSON_LABEL,
  CHAT_ADD_PERSON_TESTID,
  CHAT_HEADER_TESTID,
  ChatSectionHeader,
  OPEN_SOCIAL_SETTINGS_EVENT,
} from "./ChatSectionHeader";
import { FONT_MONO } from "../theme/scale";

beforeEach(() => useSocialStore.getState().reset());

afterEach(() => {
  cleanup();
  useSocialStore.getState().reset();
});

/** Give the signed-in user a social identity. Without one the `[+]` goes to Settings instead —
 *  see the component header, and the pair of tests below that pins both destinations. */
const withHandle = () =>
  useSocialStore.setState({ me: { ...useSocialStore.getState().me, username: "me" } });

const renderHeader = (count = 2, unread?: number) => {
  render(<ChatSectionHeader count={count} unread={unread} />);
  return screen.getByTestId(CHAT_HEADER_TESTID);
};

describe("ChatSectionHeader", () => {
  it("lays out label · rule · count · [+], in that order", () => {
    const header = renderHeader();
    const [label, rule, count, add] = Array.from(header.children) as (HTMLElement | undefined)[];
    expect(label?.textContent).toBe("Chat");
    expect(rule?.getAttribute("data-testid")).toBe("chat-header-rule");
    expect(count?.getAttribute("data-testid")).toBe("chat-header-count");
    expect(add?.getAttribute("data-testid")).toBe(CHAT_ADD_PERSON_TESTID);
    // The RULE takes the flex, so the label sizes to its own word and the tally sits right. Give
    // the LABEL the flex instead and the header is two loose spans with a stranded number.
    // (`1 1 0%` — jsdom expands the `flex: 1` shorthand; the load-bearing part is `flex-grow`.)
    expect(rule?.style.flexGrow).toBe("1");
    expect(label?.style.flexGrow).toBe("0");
  });

  it("wears the section-label treatment, so it reads as part of the same instrument", () => {
    // Mono is the characteristic mark — a tracked uppercase run in the UI face is just small shouty
    // body copy; the even advance width is what scores as "field name".
    expect(renderHeader().style.fontFamily).toBe(FONT_MONO);
  });

  it("paints the count, including zero", () => {
    expect(renderHeader(0).textContent).toContain("0");
    cleanup();
    expect(screen.queryByTestId(CHAT_HEADER_TESTID)).toBeNull();
    expect(renderHeader(7).querySelector('[data-testid="chat-header-count"]')?.textContent).toBe("7");
  });

  it("badges unread only when there is some", () => {
    renderHeader(2, 0);
    expect(screen.queryByTestId("chat-header-unread")).toBeNull();
    cleanup();
    renderHeader(2, 5);
    const badge = screen.getByTestId("chat-header-unread");
    expect(badge.textContent).toBe("5");
    // Words, not only the number: colour and position are not an accessible name.
    expect(badge.getAttribute("aria-label")).toBe("5 unread");
  });
});

describe("ChatSectionHeader — the [+]", () => {
  it("is a real, always-visible, named button", () => {
    renderHeader(0);
    const add = screen.getByTestId(CHAT_ADD_PERSON_TESTID);
    expect(add.tagName).toBe("BUTTON");
    // A hover-reveal here would be a `visibility:hidden` box — neither a hit-test target nor
    // sequentially focusable — on the ONE control that can add the first person.
    expect(add.style.visibility).not.toBe("hidden");
    expect(add.style.opacity).not.toBe("0");
    expect(screen.getByLabelText(ADD_PERSON_LABEL)).toBe(add);
    expect(add.getAttribute("title")).toBe(ADD_PERSON_LABEL);
  });

  it("with NO handle, dispatches the decoupling event and opens no panel", () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_SOCIAL_SETTINGS_EVENT, heard);
    try {
      renderHeader();
      fireEvent.click(screen.getByTestId(CHAT_ADD_PERSON_TESTID));
      expect(heard).toHaveBeenCalledTimes(1);
      expect(heard.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent);
      // A directory panel here would open onto a permanently empty list with no signpost out —
      // every `/social/*` path 404s for an account with no row. Settings is the only useful door.
      expect(screen.queryByTestId(ADD_PERSON_POPOVER_TESTID)).toBeNull();
    } finally {
      window.removeEventListener(OPEN_SOCIAL_SETTINGS_EVENT, heard);
    }
  });

  it("WITH a handle, opens the add-person panel instead — and does not open Settings", async () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_SOCIAL_SETTINGS_EVENT, heard);
    try {
      withHandle();
      renderHeader();
      fireEvent.click(screen.getByTestId(CHAT_ADD_PERSON_TESTID));
      expect(await screen.findByTestId(ADD_PERSON_POPOVER_TESTID)).toBeTruthy();
      // The OTHER half: sending the user to Settings as well would be two surfaces for one press.
      expect(heard).not.toHaveBeenCalled();
      expect(screen.getByTestId(CHAT_ADD_PERSON_TESTID).getAttribute("aria-expanded")).toBe("true");
    } finally {
      window.removeEventListener(OPEN_SOCIAL_SETTINGS_EVENT, heard);
    }
  });

  it("toggles: a second press on the [+] closes the panel it opened", async () => {
    withHandle();
    renderHeader();
    const add = screen.getByTestId(CHAT_ADD_PERSON_TESTID);
    fireEvent.click(add);
    await screen.findByTestId(ADD_PERSON_POPOVER_TESTID);
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByTestId(ADD_PERSON_POPOVER_TESTID)).toBeNull());
    expect(add.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders no emoji anywhere — house rule, icons are react-icons/fi", () => {
    const header = renderHeader();
    // A quick sweep of the pictographic ranges over everything the header paints as TEXT. The icon
    // is an <svg>, which contributes no text content, so a passing sweep also means the glyph did
    // not arrive as a character.
    expect(/\p{Extended_Pictographic}/u.test(header.textContent ?? "")).toBe(false);
    expect(header.querySelector("svg")).toBeTruthy();
  });
});
