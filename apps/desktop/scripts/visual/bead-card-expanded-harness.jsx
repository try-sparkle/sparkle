// The page `bead-card-expanded-shot.mjs` photographs. Mounts the REAL `ConciergeThread` with the
// app's own stylesheet in a real browser, so the founder's "show these bead cards as expanded by
// default" can be judged as PAINT rather than as a DOM assertion.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
//
// ── THE FIXTURE IS A COMPARISON, NOT ONE CARD ───────────────────────────────────────────────────
// A picture of a single expanded card cannot answer the question the founder actually has, which is
// whether a REPLY full of them still reads as a reply. So the thread below is deliberately the hard
// case rather than the flattering one:
//
//   1. prose, then a bead → the card has to sit inside a sentence without breaking it
//   2. FOUR beads in one message → his routine case, and the one that could swamp his own text
//   3. prose AFTER the cards → the thing that gets pushed off screen if the cards are too tall
//   4. a bead that does NOT resolve, and a backticked one → both must stay dead prose, so the
//      picture shows that expansion did not leak into what gets MATCHED
//
// 4 is in the shot deliberately: it is the case that must NOT become a card, and an eye comparing it
// against the cards above is the check no assertion in the suite makes about appearance.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ConciergeThread } from "../../src/components/Concierge/ConciergeThread";
import { BeadPillProvider } from "../../src/components/Concierge/BeadPill";
import { useBeadsStore } from "../../src/stores/beadsStore";

const params = new URLSearchParams(location.search);
/** The concierge column width to model. `CONCIERGE_DEFAULT_WIDTH` is 360. */
const WIDTH = Number(params.get("w") ?? 380);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

function bead(over) {
  return {
    title: "Never hide a row that needs action",
    description:
      'FOUNDER\'S RULE, verbatim: "We should never hide a row that needs action from me."\n\n' +
      "Stated about the recap card's \"+11 more\", but it is a PRODUCT PRINCIPLE and it applies to " +
      "every truncated, capped, collapsed or paged list in Sparkle.",
    status: "open",
    type: "task",
    priority: 0,
    labels: [],
    parent: null,
    ...over,
  };
}

// FOUR DISTINCT STATUSES AND PRIORITIES, because the card's status dot, its priority chip and its
// progress rail are the three things that carry colour — so a theme problem shows up in those or
// nowhere. One card in one state would photograph the easy case.
const BEADS = [
  // TYPE `task`, where the founder's screenshot shows a `bug`. "Build It" is offered for an epic or
  // a task and for nothing else (`useBeadBuildActions`) — and the screenshot's bead is a bug that
  // qualifies because it HAS CHILDREN, which needs a populated `beadsStore` this page has no reason
  // to seed. That rule is about the BEAD, not about expansion, so using a type that carries the
  // action is what keeps the photograph a picture of THIS change rather than of a fixture accident.
  bead({ id: "sparkle-qogah", status: "closed", priority: 0, type: "task", title: "Never hide a row that needs action: audit every capped, collapsed or paged list in Sparkle" }),
  bead({ id: "sparkle-aaa11", status: "in_progress", priority: 1, title: "Rotate the auth-failure retry to a healthy account" }),
  bead({ id: "sparkle-bbb22", status: "open", priority: 2, title: "Bead cards render expanded in the concierge" }),
  bead({ id: "sparkle-ccc33", status: "blocked", priority: 3, title: "Drain the orphaned roborev findings" }),
  // AN EPIC, so the card's **Open** group has something to draw. It is the only bead here that gets
  // it — the two destinations are epic-shaped, and the founder scoped it "if it is an epic" — so
  // this card is also the control that proves the four TASK cards above correctly do NOT get it.
  //
  // `type: "epic"` rather than giving it children, deliberately: `isEpicIndexed` accepts either, and
  // a declared epic keeps the fixture to one bead instead of two, with no child card appearing in
  // the thread that the photograph would then have to explain.
  //
  // `status: "in_progress"` is the founder's own case — *"instead of Build It, because it's already
  // building"*. A started epic has no Build It, so this card photographs the exact hole the Open
  // links were asked to fill.
  bead({
    id: "sparkle-ddd44",
    status: "in_progress",
    priority: 1,
    type: "epic",
    title: "EPIC: the concierge can open an epic where the founder wants it",
  }),
];

// THE BACKLOG THE EPIC GATE IS ANSWERED AGAINST. `useBeadBuildActions` reads `allBeads` from the
// beads STORE, not from the pill context above — so without this seed every bead resolves as "not
// an epic" and the Open group is invisible no matter what the fixture says. The store is a
// module-level singleton, so this runs once at import and needs no provider.
useBeadsStore.setState({
  byProject: { p1: { beads: BEADS, board: {}, loadedAt: 1 } },
});

// `rootPath` is supplied so the cards render their WRITE controls — the priority chip and "Build
// It". Without it the card is read-only, and the founder's screenshot has Build It in it.
const CTX = {
  beads: new Map(BEADS.map((b) => [b.id, { bead: b, projectId: "p1", rootPath: "/repo" }])),
  onViewOnBoard: () => true,
  // The new destination. Supplied here for the same reason `onViewOnBoard` is: its PRESENCE is what
  // switches the affordance on, so a harness that omitted it would photograph the feature turned
  // off and look like a passing shot.
  onViewInColumn: () => true,
};

const MESSAGES = [
  { id: "m1", kind: "you", text: "What still needs me?" },
  {
    id: "m2",
    kind: "sparkle",
    text: "One thing only you can settle: sparkle-qogah — it has been restarted once and still hasn't moved.",
  },
  {
    id: "m3",
    kind: "sparkle",
    text:
      "Here is the rest of the queue: sparkle-aaa11 and sparkle-bbb22 are moving, sparkle-ccc33 is " +
      "stuck behind a review.\n\nNone of those need you today — I am listing them so you can see the " +
      "shape of the week rather than because any of them is a decision.",
  },
  {
    id: "m4",
    kind: "sparkle",
    text:
      "And sparkle-ddd44 is an epic that is already building — so instead of Build It, its card " +
      "offers Open, with the two places an epic can be opened.",
  },
  {
    id: "m5",
    kind: "sparkle",
    text:
      "For contrast: sparkle-notreal is an id I made up and it must stay prose, and `sparkle-qogah` " +
      "in backticks must stay dead monospace — this change is about the DEFAULT OPEN STATE of a " +
      "card, never about what gets matched.",
  },
];

function Harness() {
  return (
    <BeadPillProvider value={CTX}>
      {/* The concierge column's content box, painted on the column's OWN plane — the card has to be
          judged against the surface it actually sits on, not against the page's default white. */}
      <div
        id="column"
        style={{
          width: `${WIDTH}px`,
          background: "var(--c-concierge-surface)",
          padding: "10px 0",
        }}
      >
        <ConciergeThread
          messages={MESSAGES}
          typing={false}
          turnFloor={-1}
          statuses={{}}
          onNudgeClick={() => {}}
          onNudgeAction={() => {}}
        />
      </div>
    </BeadPillProvider>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
// Nothing here is async, but the shot waits on this rather than on a selector so it cannot
// photograph a half-committed tree.
requestAnimationFrame(() => requestAnimationFrame(() => (window.__beadCardHarnessReady = true)));
