// The page `sent-card-shot.mjs` photographs. Mounts the REAL `ConciergeThread` with the app's own
// stylesheet in a real browser, so the black sent card can be judged as PAINT rather than as a
// declaration — which is the only form the founder's question takes ("show me both themes").
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
//
// THE FIXTURE IS A COMPARISON, not a single card. A picture of one black card cannot answer "is this
// distinguishable at a glance while scrolling" — that question is about the card NEXT TO its
// neighbours. So the thread below interleaves all four states the column can show:
//
//   1. an ordinary message the concierge answered   → the blue bubble, unchanged
//   2. a message forwarded to an agent              → the black card with `Sent to: ● @Agent`
//   3. a second forwarded one                       → so a RUN of them reads as a run
//   4. a refused send                               → blue, with its line still hanging below
//
// 4 is in the picture deliberately: it is the case that must NOT look like it left, and an eye
// comparing 2 against 4 is the check no assertion in the suite can make.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ConciergeThread } from "../../src/components/Concierge/ConciergeThread";
import { AgentPillProvider } from "../../src/components/Concierge/AgentPill";

const params = new URLSearchParams(location.search);
/** The concierge column width to model. `CONCIERGE_DEFAULT_WIDTH` is 360. */
const WIDTH = Number(params.get("w") ?? 380);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

const AGENT_ID = "cal";
const AGENT_NAME = "Drodio Admin Calendar";

const ROSTER = [
  {
    id: AGENT_ID,
    name: AGENT_NAME,
    projectId: "p1",
    projectName: "sparkle",
    band: "running",
    canAcceptInput: true,
  },
];

const MESSAGES = [
  {
    id: "m1",
    kind: "you",
    text: "How's the booking flow coming along?",
    receipt: { target: "sparkle" },
  },
  {
    id: "m2",
    kind: "sparkle",
    text: "Two fields still need validation. Want me to hand that to the calendar agent?",
  },
  {
    id: "m3",
    kind: "you",
    text:
      "And so that should be under email. And it should be HTTPS. It should be basically the same " +
      "way it works on the personalization. It should have your dash handle and Amber, and it " +
      "should also have a help me find my LinkedIn so they can click that.",
    receipt: { target: "agent", agentId: AGENT_ID, agentName: AGENT_NAME, redirectable: true },
  },
  {
    id: "m4",
    kind: "you",
    text:
      "So let's put all the fields into meeting type section in the admin, and then let's decide " +
      "if they're optional or required.",
    receipt: { target: "agent", agentId: AGENT_ID, agentName: AGENT_NAME, redirectable: true },
    // THE TWO THINGS INSIDE THE CARD THAT PAINT A GROUND OF THEIR OWN, and the reason this fixture
    // carries them. Without one of each, the probe photographs a card whose every pixel of text sits
    // directly on black — which is the easy case, and the one that was never broken.
    //
    // A non-image attachment renders AttachmentStrip's CHIP form (no thumbnail), which fills with
    // `--c-chat-bubble`; a collapsed paste renders TextPill's tile, which fills `--c-deep-forest`.
    // Both were themed while the ink on them was pinned dark, so light mode put #dce8fc on a #e8f0fd
    // chip — about 1.07:1, the label invisible inside its own tile — and no screenshot could show it
    // because no fixture message had either. `dataUrl` is deliberately absent: it is what makes this
    // the chip rather than a thumbnail, and AttachmentStrip's own comment calls the chip "the
    // designed steady state after a restart", so it is the common case and not an edge one.
    attachments: [{ id: "a1", kind: "file", path: "/tmp/booking-spec.pdf", name: "booking-spec.pdf" }],
    collapsed: [
      { id: "c1", text: "field,required\nemail,yes\nlinkedin,no\n".repeat(40), lineCount: 120 },
    ],
  },
  {
    id: "m5",
    kind: "you",
    text: "Also add the LinkedIn lookup to the same section.",
    // NEVER LEFT THE ROOM. Blue, and its line still hangs below — the contrast that makes the black
    // card mean something.
    receipt: { target: "agent", agentId: AGENT_ID, agentName: AGENT_NAME, refused: true },
  },
];

function Harness() {
  return (
    <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: () => "revealed" }}>
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
    </AgentPillProvider>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
// Nothing here is async, but the shot waits on this rather than on a selector so it cannot
// photograph a half-committed tree.
requestAnimationFrame(() => requestAnimationFrame(() => (window.__sentCardHarnessReady = true)));
