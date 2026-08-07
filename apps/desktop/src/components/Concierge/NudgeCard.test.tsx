// @vitest-environment jsdom
//
// The nudge card's contract, as of the founder's 2026-07-30 spec:
//
//     [red circle] BLOCKED: [@Agent name as clickable pill] in [project-name] [x]
//
// ONE red treatment (the gold "wants you eventually" accent is gone with the tier that justified
// it), ONE line, and each fact stated ONCE — the card it replaced said the band, the project and
// the agent on line one and then repeated all three as prose on line two.
//
// What these cases are really guarding is the SUBTRACTION. It is easy to add a line back: a badge
// "for scanability", a chip "so the project stands out", a Show me "because the pill isn't obvious".
// Each is individually defensible and together they rebuild exactly what the founder asked to have
// removed, so the absences below are asserted as positively as the presences.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C } from "../../theme/colors";
import {
  NUDGE_CARD_TESTID,
  NUDGE_DISMISS_ACTION,
  NUDGE_LEAD_TESTID,
  NUDGE_MUTE_ACTION,
  NudgeCard,
  nudgeAccent,
  resolvedAccent,
} from "./NudgeCard";
import { AgentPillProvider } from "./AgentPill";
import type { ConciergeNudge } from "./types";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

/** jsdom serializes inline colors as rgb(...) — compare in that form. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
}

const nudge: ConciergeNudge = {
  id: "a-og",
  kind: "nudge",
  band: "needs_you",
  projectName: "drodio-website",
  agentName: "OG Image Pipeline",
  text: "OG Image Pipeline hit a build warning that needs your call — look, or let it ride?",
  actions: [],
};

const approvalNudge: ConciergeNudge = {
  ...nudge,
  id: "a-mirror",
  projectName: "sparkle-mobile",
  agentName: "Live Remote Mirror",
  actions: [{ id: "approve", label: "Approve", kind: "primary" }],
};

/** The card in the context a real column gives it, so its `AgentPill` resolves to a live agent
 *  instead of falling through to the unwired form. `onOpenAgent` is present but should never be
 *  reached: the card overrides it (see AgentPill.onOpen), which one case below pins. */
const renderCard = (
  n: ConciergeNudge,
  handlers: { onNudgeClick?: () => void; onNudgeAction?: () => void } = {},
  contextOpen = vi.fn((): RevealOutcome => "revealed"),
) => {
  const onNudgeClick = handlers.onNudgeClick ?? vi.fn();
  const onNudgeAction = handlers.onNudgeAction ?? vi.fn();
  render(
    <AgentPillProvider
      value={{
        agents: [
          {
            id: n.id,
            name: n.agentName,
            projectId: "p1",
            projectName: n.projectName,
            band: n.band,
            canAcceptInput: true,
          },
        ],
        onOpenAgent: contextOpen,
      }}
    >
      <NudgeCard nudge={n} onNudgeClick={onNudgeClick} onNudgeAction={onNudgeAction} />
    </AgentPillProvider>,
  );
  return { onNudgeClick, onNudgeAction, contextOpen };
};

const card = () => screen.getByTestId(NUDGE_CARD_TESTID);

describe("nudgeAccent — one red, no gold", () => {
  it("is brand sienna, and never amber", () => {
    // The amber accent belonged to the "wants you eventually" tier (`blocked`). That tier merged
    // into Needs-you, so a second alarm color on these cards would be a distinction the user can't
    // act on differently — both mean "go look".
    expect(nudgeAccent()).toBe(C.sienna);
    expect(nudgeAccent()).not.toBe(C.amber);
  });
});

describe("NudgeCard — the red box treatment survives the rewrite", () => {
  it("keeps the sienna fill, the uniform border and the band attribute", () => {
    renderCard(nudge);
    // The band reads from the card's border tint — literal brand sienna, never amber (the gold tier
    // is gone). There is deliberately NO left-edge stripe either (founder 2026-07-24), so assert the
    // POSITIVE shape: a uniform 1px border on all four edges. A bare `not.toBe("3px")` passed for a
    // 2px stripe, a 4px stripe, or any re-added asymmetric borderLeft — this cannot.
    expect(card().getAttribute("data-band")).toBe("needs_you");
    expect(card().style.border).toContain(rgb(C.sienna));
    expect(card().style.border).not.toContain(rgb(C.amber));
    expect(card().style.borderLeftWidth).toBe("1px");
    expect(card().style.borderLeftColor).toBe(card().style.borderTopColor);
    expect(card().style.borderLeftStyle).toBe(card().style.borderTopStyle);
  });

  it("names its agent in a machine-readable attribute, not only in its prose", () => {
    // What lets every OTHER suite assert which agent a card is about without matching copy that is
    // expected to keep changing. See NUDGE_CARD_TESTID.
    renderCard(nudge);
    expect(card().getAttribute("data-agent-id")).toBe("a-og");
  });
});

describe("NudgeCard — one line, each fact once", () => {
  it("leads with BLOCKED: and states the project once, as words", () => {
    renderCard(nudge);
    const blocked = screen.getByText("BLOCKED:");
    // The THEMED ink, not the literal accent: raw sienna is under the AA floor as text on the
    // concierge column. The fill/ink split the old badge carried is preserved on the lead word.
    expect(blocked.style.color).toBe(C.dangerInk);
    expect(blocked.style.color).not.toBe(rgb(C.sienna));
    expect(screen.getByText("in drodio-website")).toBeTruthy();
  });

  it("does NOT repeat the alert as a prose sentence under itself", () => {
    // The exact duplication the founder reported: line one said it in chrome, line two said it
    // again in words. `text` still rides on the nudge (the push channel and the roster line read
    // the same vocabulary) — the card simply must not draw it.
    renderCard(nudge);
    expect(screen.queryByText(nudge.text)).toBeNull();
    expect(card().textContent).not.toContain(" — ");
  });

  it("does not draw a 'Needs you' badge or a bordered project chip", () => {
    // Both were line one of the old card. Asserted as absences because re-adding either is the
    // easiest way for the three-line layout to come back one element at a time.
    renderCard(nudge);
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.queryByText("drodio-website")).toBeNull(); // the bare chip; "in <project>" remains
  });

  it("wraps rather than truncating, so a long name is never clipped into uselessness", () => {
    // The founder's one qualification on the one-line target. A pill elided to "Cockpit Col…" stops
    // identifying the agent, which is the only thing the card exists to say.
    renderCard(nudge);
    expect(card().style.flexWrap).toBe("wrap");
    expect(card().style.textOverflow).not.toBe("ellipsis");
    expect(card().style.whiteSpace).not.toBe("nowrap");
  });
});

describe("NudgeCard — the agent is a real, live pill", () => {
  it("renders the agent as the app's AgentPill, not as plain text", () => {
    renderCard(nudge);
    const pill = screen.getByTestId("concierge-agent-pill");
    expect(pill.getAttribute("data-agent-id")).toBe("a-og");
    expect(pill.textContent).toContain("OG Image Pipeline");
  });

  it("clicking the pill reveals through the CARD's path, not the context's weaker opener", () => {
    // Load-bearing, not a detail. The context's opener is `openProjectTab`, which cannot un-hide a
    // worker's row; the card's `onNudgeClick` → `revealAgent` can. Since the card now usually names
    // a worker, routing the pill through the context would land the reader on a screen where the
    // agent they clicked is not drawn (roborev 53679/53734).
    const { onNudgeClick, contextOpen } = renderCard(nudge);
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
    expect(onNudgeClick).toHaveBeenCalledWith(nudge);
    expect(contextOpen).not.toHaveBeenCalled();
  });

  it("has no separate 'Show me' button — the pill IS the navigation", () => {
    renderCard(nudge);
    expect(screen.queryByText("Show me")).toBeNull();
  });

  it("adds NO live region of its own — the column owns the only one", () => {
    // `AgentPill` normally mounts a permanent `role="status"` so a failed reveal can be announced.
    // That is right for a pill in a reply; it is wrong here, because a nudge card is on screen for
    // as long as its agent is red, so every card would park a second competing polite region in a
    // column that is documented to own exactly one — and a fleet with four asks would park four.
    // The card supplies its own reveal, which reports through that one announcer, so there is
    // nothing left for the pill to say. See AgentPill's `ownsOutcome`.
    renderCard(nudge);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.queryByTestId("concierge-agent-pill-live")).toBeNull();
  });
});

describe("NudgeCard — the two alarm controls", () => {
  it("[x] fires the dismiss action and does not also count as a card click", () => {
    const { onNudgeClick, onNudgeAction } = renderCard(nudge);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(onNudgeAction).toHaveBeenCalledTimes(1);
    expect(onNudgeAction).toHaveBeenCalledWith(nudge, NUDGE_DISMISS_ACTION);
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  it("keeps Mute reachable — rendered, labelled, and firing the mute action", () => {
    // NOT a styling preference. `setInterruptPreference` has exactly one call site in the app, so a
    // card that stopped offering Mute would have deleted the do-not-interrupt feature rather than
    // moved it. It is in the DOM (so it is tab- and screen-reader-reachable) and merely painted on
    // hover; this asserts the part that must not depend on a pointer.
    const { onNudgeClick, onNudgeAction } = renderCard(nudge);
    fireEvent.click(screen.getByLabelText("Mute alerts about OG Image Pipeline"));
    expect(onNudgeAction).toHaveBeenCalledWith(nudge, NUDGE_MUTE_ACTION);
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  it("both controls carry the agent's name, so a thread of cards is unambiguous by voice", () => {
    renderCard(nudge);
    expect(screen.getByLabelText("Dismiss this alert about OG Image Pipeline")).toBeTruthy();
    expect(screen.getByLabelText("Mute alerts about OG Image Pipeline")).toBeTruthy();
  });

  it("does not pin Mute's opacity inline, which would make its CSS reveal unreachable", () => {
    // THE BUG THIS EXISTS FOR (roborev 55986, High). The quiet control's resting state was an
    // INLINE `opacity: 0` while its reveal was a stylesheet rule — and an inline style beats any
    // selector, so `.nudge-card:hover .nudge-card-quiet { opacity: 1 }` could never win. Mute was in
    // the DOM, focusable, clickable, and permanently invisible. Every behavioural assertion above
    // stayed green, because `getByLabelText` and `fireEvent.click` do not look at paint.
    //
    // Asserted as the MECHANISM rather than as a computed value: jsdom does not load index.css, so
    // there is no rendered opacity to read here. What can be checked — and what actually broke — is
    // that the component leaves the property to the cascade and tags the element for the rule.
    renderCard(nudge);
    const mute = screen.getByTestId("concierge-nudge-mute");
    expect(mute.style.opacity).toBe("");
    expect(mute.className).toContain("nudge-card-quiet");
    // …and the [x], which rests VISIBLE, must not carry the class that hides it.
    expect(screen.getByTestId("concierge-nudge-dismiss").className).not.toContain(
      "nudge-card-quiet",
    );
  });

  it("lets Enter reach a focused control instead of the card swallowing it", () => {
    // THE OTHER KEYBOARD BUG (roborev 55986, Medium). The card's `onKeyDown` had no target guard, so
    // a keydown on a nested button bubbled up and `preventDefault()` cancelled the button's own
    // activation — Enter/Space activation IS the keydown default action for a <button>. A keyboard
    // user who tabbed to Mute and pressed Enter was navigated to the agent instead. Sharpest on the
    // icon controls, which the `:focus-within` reveal lights up for exactly that user.
    //
    // `fireEvent` returns false when the handler called `preventDefault()`, which is the precise
    // thing that used to destroy the activation — so this asserts the mechanism, not a proxy. jsdom
    // does not synthesize the Enter→click itself, so the browser's half is what `true` stands for.
    const { onNudgeClick } = renderCard(nudge);
    for (const id of ["concierge-nudge-mute", "concierge-nudge-dismiss"]) {
      expect(fireEvent.keyDown(screen.getByTestId(id), { key: "Enter" })).toBe(true);
    }
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  it("still takes Enter on the CARD itself — the guard did not disable the card's own gesture", () => {
    const { onNudgeClick } = renderCard(nudge);
    fireEvent.keyDown(card(), { key: "Enter" });
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
  });
});

describe("NudgeCard — Approve is not collapsed into an icon", () => {
  it("renders Approve as a labelled button when the agent is on an approval prompt", () => {
    // One-tap relay into a live terminal, with no other entry point in the app. An icon would make
    // an irreversible action ambiguous, which is why it did not follow Show me and Mute off the line.
    const { onNudgeAction, onNudgeClick } = renderCard(approvalNudge);
    fireEvent.click(screen.getByText("Approve"));
    expect(onNudgeAction).toHaveBeenCalledWith(approvalNudge, "approve");
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  it("an ordinary blocked card carries no labelled buttons at all", () => {
    renderCard(nudge);
    expect(screen.queryByText("Approve")).toBeNull();
  });
});

describe("NudgeCard — the card is still one big click target", () => {
  it("clicking the body fires onNudgeClick", () => {
    const { onNudgeClick, onNudgeAction } = renderCard(nudge);
    fireEvent.click(screen.getByText("in drodio-website"));
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
    expect(onNudgeClick).toHaveBeenCalledWith(nudge);
    expect(onNudgeAction).not.toHaveBeenCalled();
  });

  it("Enter on the focused card acts like a card click (it's a div, not a <button>)", () => {
    const { onNudgeClick } = renderCard(approvalNudge);
    fireEvent.keyDown(card(), { key: "Enter" });
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
  });

  it("labels itself for assistive tech in the same words it shows", () => {
    renderCard(nudge);
    expect(card().getAttribute("aria-label")).toBe("BLOCKED: OG Image Pipeline in drodio-website");
  });
});

// ══ THE RESOLVED TREATMENT ═══════════════════════════════════════════════════════════════════════
//
// THE REPORT (founder, 2026-08-06, bead `sparkle-9adzg`, with a screenshot). A red
// "BLOCKED: @<agent> in <project>" card sat in the thread describing an agent that had already
// unblocked — the cause was a transient `API Error: Unable to connect to API (ENOTFOUND)` that
// self-healed within minutes. His words: "The blocked card should go away or show as resolved and be
// grayed out if it's no longer blocked in the concierge chat thread." Asked which of the two, he
// chose to KEEP it: a card that deletes itself takes the record of what happened with it.
//
// THESE CASES COME IN PAIRS, AND THE SECOND OF EACH PAIR IS THE IMPORTANT ONE. Sparkle's standing
// rule is that nothing which needs the founder may be hidden, so the risk this feature introduces is
// not a lingering red — it is a LIVE blocker quietly rendered as finished. Every assertion that a
// resolved card went grey is therefore matched by one that a live card did NOT, on the same
// property. A one-sided suite here would go green on a component that greyed out everything.
const resolvedNudge: ConciergeNudge = {
  ...nudge,
  // 40 seconds — the founder's own "cleared in 40 seconds" case, the one that must not read like a
  // three-hour stall.
  resolved: { raisedAt: 1_000_000, resolvedAt: 1_040_000 },
};

describe("resolvedAccent — unmistakably not the alarm", () => {
  it("is the muted ink, and is not the red a live card wears", () => {
    // Not a washed-out sienna: a faded red still reads as red at a glance, which would leave a
    // finished episode competing for attention with a live one.
    expect(resolvedAccent()).toBe(C.muted);
    expect(resolvedAccent()).not.toBe(nudgeAccent());
  });
});

describe("NudgeCard — a resolved episode is history, not an alarm", () => {
  it("leads with RESOLVED and how long the block lasted, in the app's elapsed vocabulary", () => {
    renderCard(resolvedNudge);
    // "40s" and not "40 seconds" / "0.7m": `engine/elapsed.formatElapsed` is the ONE spelling the
    // Build column's rows a few hundred pixels away already use.
    expect(screen.getByTestId(NUDGE_LEAD_TESTID).textContent).toBe("RESOLVED after 40s:");
    // And the word it replaced is GONE — a card that said both would assert the stale fact anyway.
    expect(screen.queryByText("BLOCKED:")).toBeNull();
  });

  it("spells a long block differently from a short one", () => {
    // The whole point of carrying the duration: a card that cleared in 40s must not read like one
    // that was stuck for three hours. Same component, same slot, two clearly different sentences.
    const THREE_H_TWELVE_M = (3 * 60 + 12) * 60 * 1000;
    renderCard({
      ...nudge,
      resolved: { raisedAt: 0, resolvedAt: THREE_H_TWELVE_M },
    });
    expect(screen.getByTestId(NUDGE_LEAD_TESTID).textContent).toBe("RESOLVED after 3.2h:");
  });

  it("reads 0s rather than a negative duration when the clock steps backwards", () => {
    // The two instants are OBSERVATIONS taken at different times, so an NTP correction between them
    // can invert them. "RESOLVED after -4s:" is the kind of thing that ships.
    renderCard({ ...nudge, resolved: { raisedAt: 5_000, resolvedAt: 1_000 } });
    expect(screen.getByTestId(NUDGE_LEAD_TESTID).textContent).toBe("RESOLVED after 0s:");
  });

  it("goes grey and loses the glow — while a live card keeps both", () => {
    renderCard(resolvedNudge);
    expect(card().getAttribute("data-resolved")).toBe("true");
    expect(screen.getByTestId(NUDGE_LEAD_TESTID).style.color).toBe(resolvedAccent());
    expect(screen.getByTestId(NUDGE_LEAD_TESTID).style.color).not.toBe(C.dangerInk);
    // The glow IS the alarm. `none`, not a grey glow — a grey glow still lifts the card off the
    // thread exactly as far as a red one does.
    expect(card().style.boxShadow).toBe("none");
    expect(card().style.border).not.toContain(rgb(C.sienna));

    // THE OTHER DIRECTION, on the same three properties. Without this the suite would pass against
    // a component that painted EVERY card grey.
    cleanup();
    renderCard(nudge);
    expect(card().getAttribute("data-resolved")).toBeNull();
    expect(screen.getByTestId(NUDGE_LEAD_TESTID).style.color).toBe(C.dangerInk);
    expect(card().style.boxShadow).not.toBe("none");
    // The RAW hex here, not `rgb(…)`: jsdom's `box-shadow` parser stores the declaration verbatim
    // (custom colour functions and all), while its `border` parser normalises the same hex to
    // `rgb(…)`. Two properties, two serializations, one stylesheet — assert what each actually says.
    expect(card().style.boxShadow).toContain(C.sienna);
    expect(card().style.border).toContain(rgb(C.sienna));
  });

  it("draws its dot as a hollow ring, where a live card draws a filled disc", () => {
    // The redundant signal, for a reader who cannot separate muted grey from sienna at a glance —
    // or who has the two cards in different themes.
    const dotOf = () => card().querySelector("span[aria-hidden]") as HTMLElement;
    renderCard(resolvedNudge);
    expect(dotOf().style.background).toBe("transparent");
    expect(dotOf().style.borderStyle).toBe("solid");

    cleanup();
    renderCard(nudge);
    expect(dotOf().style.background).toBe(rgb(C.sienna));
    expect(dotOf().style.borderStyle).toBe("");
  });

  it("drops the action buttons — while an identical LIVE card keeps them", () => {
    // Approve on a finished episode relays an approval into a terminal that is not waiting for one,
    // or approves whatever that agent is sitting on NOW. `approvalNudge` is the card that carries an
    // Approve, so resolving it is the exact A/B.
    renderCard({ ...approvalNudge, resolved: resolvedNudge.resolved });
    expect(screen.queryByText("Approve")).toBeNull();

    cleanup();
    renderCard(approvalNudge);
    expect(screen.getByText("Approve")).toBeTruthy();
  });

  it("keeps [x] and mute reachable, so history can be cleared and an agent silenced", () => {
    // [x] on a resolved card means "take this out of my history" rather than the per-episode
    // acknowledgement it performs on a live one — the host branches on `resolved`. Mute stays
    // because it is a durable preference about the AGENT, and this card is the feature's only entry
    // point; a thread of resolved cards is precisely how you notice one agent keeps interrupting.
    const { onNudgeAction } = renderCard(resolvedNudge);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(onNudgeAction).toHaveBeenCalledWith(resolvedNudge, NUDGE_DISMISS_ACTION);
    fireEvent.click(screen.getByTestId("concierge-nudge-mute"));
    expect(onNudgeAction).toHaveBeenCalledWith(resolvedNudge, NUDGE_MUTE_ACTION);
  });

  it("tells assistive tech it is resolved, in the same words it shows", () => {
    // A screen-reader user gets the stale-fact bug in its purest form otherwise: the visual card
    // greys out and the label still says BLOCKED.
    renderCard(resolvedNudge);
    expect(card().getAttribute("aria-label")).toBe(
      "RESOLVED after 40s: OG Image Pipeline in drodio-website",
    );
  });
});
