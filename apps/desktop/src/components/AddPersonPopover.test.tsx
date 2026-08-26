// @vitest-environment jsdom
//
// The add-a-person panel. Every assertion here is on a SIDE EFFECT — the request that went out, the
// row that got painted, the verdict a cable predicate reaches about the DOM this component built —
// never on a precondition that was already true before the file existed. Three of them are shaped
// specifically against the vacuous forms this repo keeps producing:
//
//   • THE TWO CABLE TESTS ASK THE REAL PREDICATES, not the attributes. `unbindsOnPointerDown` and
//     `dismissibleSurfaceOpen` are what the shipping app runs, so deleting `data-circuit` or
//     `data-dismissible-open` from the panel turns each of them red. Asserting
//     `el.hasAttribute("data-circuit")` instead would pin the marker and prove nothing about what
//     it is for — and it is only load-bearing because the panel is a `role="group"`; the moment
//     someone "improves" the root to `role="dialog"`, `DISMISSIBLE_SELECTOR` matches on the role
//     alone and the second test can no longer fail. That is why the component says not to.
//   • THE PRIVACY PAIR IS TESTED IN BOTH DIRECTIONS with the SAME person. A test that only asserted
//     the absence would pass against a panel that lists nobody at all; one that only asserted the
//     exact match would pass against a panel that lists everyone. Only the pair pins the asymmetry
//     §5 actually requires.
//   • THE PROJECTION TEST feeds the directory a row POLLUTED with the fields §5 forbids and asserts
//     none of them reach the DOM. Asserting "the row shows the username" would go green against a
//     row that also painted the person's repo underneath it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PARTIAL mock (spreads the real module) so the error CLASSES stay real — see SettingsChatPane's
// test for why an exhaustive factory makes `instanceof` branches unreachable while looking green.
vi.mock("../services/socialApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/socialApi")>()),
  getDirectory: vi.fn(),
  getUser: vi.fn(),
  postConnection: vi.fn(),
}));

import {
  getDirectory,
  getUser,
  postConnection,
  SocialApiError,
  type PublicProfile,
  type UserLookup,
} from "../services/socialApi";
import {
  ADD_LISTED_LABEL,
  ADD_PERSON_EMPTY_TESTID,
  ADD_PERSON_EXACT_TESTID,
  ADD_PERSON_INPUT_TESTID,
  ADD_PERSON_POPOVER_TESTID,
  ADD_PERSON_ROW_TESTID,
  AddPersonPopover,
  SEND_REQUEST_LABEL,
  collapsesToExact,
  filterDirectory,
  needsExactLookup,
} from "./AddPersonPopover";
import {
  CABLE_REST,
  dismissibleSurfaceOpen,
  unbindsOnKey,
  unbindsOnPointerDown,
  type CableState,
} from "../engine/cable";

const mockDirectory = vi.mocked(getDirectory);
const mockGetUser = vi.mocked(getUser);
const mockPost = vi.mocked(postConnection);

const pub = (username: string, extra: Partial<PublicProfile> = {}): PublicProfile => ({
  socialId: `s-${username}`,
  username,
  displayName: null,
  online: false,
  ...extra,
});

/** A cable that is actually PATCHED. `CABLE_REST` would make both predicates answer false on the
 *  `wired === "off"` term alone, so every cable assertion below would pass against a panel with no
 *  markers at all — the vacuous shape these two tests exist to avoid. */
const WIRED: CableState = { ...CABLE_REST, wired: "left", agentId: "agent-1" };

/** The panel, rendered and settled — the directory read has landed by the time this returns. */
async function openPanel(onClose = vi.fn()) {
  render(<AddPersonPopover anchor={null} onClose={onClose} />);
  const panel = await screen.findByTestId(ADD_PERSON_POPOVER_TESTID);
  await waitFor(() => expect(mockDirectory).toHaveBeenCalled());
  return { panel, onClose };
}

const type = (value: string) =>
  fireEvent.change(screen.getByTestId(ADD_PERSON_INPUT_TESTID), { target: { value } });

beforeEach(() => {
  mockDirectory.mockReset();
  mockGetUser.mockReset();
  mockPost.mockReset();
  mockDirectory.mockResolvedValue({ users: [], nextCursor: null });
  // 404 is the deliberate no-existence-oracle answer, and it is the DEFAULT here so a test that
  // means "nobody by that name" does not have to remember to say so.
  mockGetUser.mockRejectedValue(new SocialApiError(404, null));
  mockPost.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("filterDirectory", () => {
  const users = [pub("ada"), pub("grace", { displayName: "Grace Hopper" }), pub("linus")];

  it("lists everyone when nothing is typed", () => {
    expect(filterDirectory(users, "").map((u) => u.username)).toEqual(["ada", "grace", "linus"]);
    expect(filterDirectory(users, "   ").map((u) => u.username)).toEqual(["ada", "grace", "linus"]);
  });

  it("matches a substring of the handle, case-insensitively", () => {
    expect(filterDirectory(users, "AD").map((u) => u.username)).toEqual(["ada"]);
    expect(filterDirectory(users, "nu").map((u) => u.username)).toEqual(["linus"]);
  });

  it("also matches the DISPLAY name, so a remembered person is findable by their real name", () => {
    // The point of the test: `grace` does not contain "hopper", so a username-only filter is green
    // on every other case here and red only on this one.
    expect(filterDirectory(users, "hopper").map((u) => u.username)).toEqual(["grace"]);
  });

  it("returns nobody rather than everybody when nothing matches", () => {
    expect(filterDirectory(users, "zzz")).toEqual([]);
  });
});

describe("needsExactLookup — the bound on the existence oracle", () => {
  const listed = [pub("ada")];

  it("refuses an empty or malformed string, so a prefix never costs a lookup", () => {
    expect(needsExactLookup("", listed)).toBe(false);
    expect(needsExactLookup("a", listed)).toBe(false); // under USERNAME_MIN_LENGTH
    expect(needsExactLookup("has spaces", listed)).toBe(false);
    expect(needsExactLookup("bad__name", listed)).toBe(false); // consecutive underscores
  });

  it("refuses a name the directory already answered with — including in another case", () => {
    expect(needsExactLookup("ada", listed)).toBe(false);
    expect(needsExactLookup("ADA", listed)).toBe(false);
  });

  it("asks about a well-formed name the directory did NOT list", () => {
    expect(needsExactLookup("grace", listed)).toBe(true);
  });
});

describe("collapsesToExact", () => {
  const lookup: UserLookup = { ...pub("grace"), relationship: "stranger" };

  it("collapses on a resolved lookup for the name currently typed", () => {
    expect(collapsesToExact("grace", [pub("ada")], lookup)).toBe(true);
  });

  it("does NOT collapse on a STALE reply for a name the user has moved on from", () => {
    // Replies do not arrive in request order. Keyed on the reply alone this would confirm the
    // existence of `grace` while the field says `graceland` — a false statement about a person.
    expect(collapsesToExact("graceland", [], lookup)).toBe(false);
  });

  it("does NOT collapse when the person is already listed — they are public, not a request", () => {
    expect(collapsesToExact("grace", [pub("grace")], lookup)).toBe(false);
  });
});

describe("AddPersonPopover — one control, both jobs", () => {
  it("has exactly ONE input: it filters the list AND is the manual type-in", async () => {
    mockDirectory.mockResolvedValue({ users: [pub("ada"), pub("linus")], nextCursor: null });
    const { panel } = await openPanel();
    await waitFor(() => expect(screen.getAllByTestId(ADD_PERSON_ROW_TESTID)).toHaveLength(2));

    // ONE, not two. Two controls for one intent is the shape the spec rules out, and a second box
    // would show up here as a second textbox.
    expect(panel.querySelectorAll("input")).toHaveLength(1);

    type("lin");
    const rows = screen.getAllByTestId(ADD_PERSON_ROW_TESTID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-username")).toBe("linus");
  });

  it("adds a listed person by sending a connection request for THAT username", async () => {
    mockDirectory.mockResolvedValue({ users: [pub("ada"), pub("linus")], nextCursor: null });
    await openPanel();
    await waitFor(() => expect(screen.getAllByTestId(ADD_PERSON_ROW_TESTID)).toHaveLength(2));

    fireEvent.click(screen.getByLabelText(`${ADD_LISTED_LABEL} — linus`));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("linus"));
    // The username, not the socialId: `POST /social/connections` takes a handle (§6.6), and the
    // server resolves it internally precisely so a client never holds the partition key.
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe("AddPersonPopover — the §5 privacy boundary", () => {
  // ONE person, used by BOTH tests below. `mallory` is known to the server and NOT public: the
  // directory never returns her, the exact endpoint does.
  const MALLORY = "mallory";
  const seedNonPublic = () => {
    mockDirectory.mockResolvedValue({ users: [pub("ada")], nextCursor: null });
    mockGetUser.mockImplementation(async (username: string) =>
      username === MALLORY
        ? ({ ...pub(MALLORY), relationship: "stranger" } as UserLookup)
        : Promise.reject(new SocialApiError(404, null)),
    );
  };

  it("NEVER LISTS a non-public user — a substring of her name matches nobody", async () => {
    seedNonPublic();
    await openPanel();
    type("mall");
    // A substring is not an exact name, so nothing is even ASKED about her…
    await waitFor(() => expect(screen.getByTestId(ADD_PERSON_EMPTY_TESTID)).toBeTruthy());
    expect(screen.queryByTestId(ADD_PERSON_EXACT_TESTID)).toBeNull();
    expect(screen.queryByTestId(ADD_PERSON_ROW_TESTID)).toBeNull();
    expect(screen.getByTestId(ADD_PERSON_POPOVER_TESTID).textContent).not.toContain(MALLORY);
  });

  it("…but CONFIRMS the same user on an exact-string match, as one 'Send connection request' row", async () => {
    seedNonPublic();
    await openPanel();
    type(MALLORY);

    const row = await screen.findByTestId(ADD_PERSON_EXACT_TESTID, undefined, { timeout: 2000 });
    expect(row.getAttribute("data-username")).toBe(MALLORY);
    // COLLAPSED TO ONE. `ada` is still in the directory and still matches nothing typed, so a panel
    // that merely appended the exact match would show two rows here.
    expect(screen.queryAllByTestId(ADD_PERSON_ROW_TESTID)).toHaveLength(0);
    expect(row.textContent).toContain(MALLORY);
    expect(screen.getByLabelText(`${SEND_REQUEST_LABEL} — ${MALLORY}`)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(`${SEND_REQUEST_LABEL} — ${MALLORY}`));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(MALLORY));
  });

  it("paints NOTHING about a stranger beyond the sealed four fields", async () => {
    // Fields §5 forbids at every visibility level. They are attached to the wire row on purpose:
    // `socialApi`'s JSON read is an unchecked cast, so a server that started emitting one of these
    // would hand the row straight to this component. Nothing here may paint it.
    const FORBIDDEN = {
      clerkUserId: "user_31337",
      email: "mallory@example.com",
      repo: "github.com/acme/secret-repo",
      projectName: "Project Nimbus",
      agentName: "refactor-auth",
      goal: "land the retry PR",
      branch: "feat/secret-branch",
      lastSeenAt: "2026-08-25T09:00:00.000Z",
      installId: "install-abc",
    };
    mockDirectory.mockResolvedValue({
      users: [{ ...pub("stranger", { displayName: "A Stranger" }), ...FORBIDDEN } as PublicProfile],
      nextCursor: null,
    });
    const { panel } = await openPanel();
    await waitFor(() => expect(screen.getByTestId(ADD_PERSON_ROW_TESTID)).toBeTruthy());

    // The four fields DO reach the screen — otherwise "nothing leaked" would be satisfied by a row
    // that painted nothing at all.
    expect(panel.textContent).toContain("A Stranger");
    expect(panel.textContent).toContain("stranger");

    // …and nothing else does. `outerHTML`, not `textContent`: a leak into a `title`, an
    // `aria-label` or a `data-` attribute is still a leak, and is exactly where one would hide.
    const html = panel.outerHTML;
    for (const value of Object.values(FORBIDDEN)) {
      expect(html, `the row leaked ${value}`).not.toContain(value);
    }
  });
});

describe("AddPersonPopover — the two non-negotiable attributes, asserted through the predicates", () => {
  it("a click INSIDE the panel does not drop the cable (data-circuit)", async () => {
    mockDirectory.mockResolvedValue({ users: [pub("ada")], nextCursor: null });
    const { panel } = await openPanel();
    await waitFor(() => expect(screen.getByTestId(ADD_PERSON_ROW_TESTID)).toBeTruthy());

    // The panel is portalled to `document.body`, so it is a DOM SIBLING of the app: every
    // ancestry-found branch of CIRCUIT_SELECTOR puts it outside the circuit. `[data-circuit]` is
    // the only thing that can put it back in — roborev 54821.
    expect(panel.parentElement).toBe(document.body);

    // The DEEPEST thing a user actually presses, not the root: `closest` walks up, so asserting on
    // the root would pass even if the marker sat somewhere a real press could never reach.
    const target = screen.getByTestId(ADD_PERSON_INPUT_TESTID);
    expect(unbindsOnPointerDown(WIRED, target)).toBe(false);
    expect(unbindsOnPointerDown(WIRED, screen.getByTestId(ADD_PERSON_ROW_TESTID))).toBe(false);

    // The control: a press on the shell outside the panel still unbinds, so the assertion above is
    // about this panel and not about a predicate that answers false for everything.
    expect(unbindsOnPointerDown(WIRED, document.createElement("div"))).toBe(true);
  });

  it("Escape closes the panel and LEAVES THE CABLE PATCHED (data-dismissible-open)", async () => {
    const onClose = vi.fn();
    await openPanel(onClose);

    // While the panel is up it OWNS Escape, so `unbindsOnKey` must yield. Without the marker
    // `dismissibleSurfaceOpen` finds nothing (the root is a `group`, not a `dialog`) and one press
    // would close the panel AND unmount the concierge.
    const dismissibleOpen = dismissibleSurfaceOpen(document);
    expect(dismissibleOpen).toBe(true);
    expect(unbindsOnKey(WIRED, "Escape", { dismissibleOpen })).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops claiming Escape once it is gone, so the cable can be unbound again", async () => {
    await openPanel();
    expect(dismissibleSurfaceOpen(document)).toBe(true);
    cleanup();
    // The other half of the pair: a marker that outlived its surface is the leaked-node shape that
    // killed ESC-to-unmount app-wide (bead sparkle-thm9o).
    expect(dismissibleSurfaceOpen(document)).toBe(false);
    expect(unbindsOnKey(WIRED, "Escape", { dismissibleOpen: false })).toBe(true);
  });
});

describe("AddPersonPopover — house rules", () => {
  it("renders no emoji: icons are react-icons/fi", async () => {
    mockDirectory.mockResolvedValue({ users: [pub("ada")], nextCursor: null });
    const { panel } = await openPanel();
    await waitFor(() => expect(screen.getByTestId(ADD_PERSON_ROW_TESTID)).toBeTruthy());
    expect(/\p{Extended_Pictographic}/u.test(panel.textContent ?? "")).toBe(false);
    expect(panel.querySelector("svg")).toBeTruthy();
  });
});
