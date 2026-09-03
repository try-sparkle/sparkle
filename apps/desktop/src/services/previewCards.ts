// previewCards — WHICH live previews the concierge is willing to put on screen, and how it gets a
// picture of one.
//
// ══ THE PROBLEM THIS SOLVES ═════════════════════════════════════════════════════════════════════
// The preview subsystem works. It is just invisible: an agent opens a dev server, its url is
// printed once into a terminal, the terminal keeps scrolling, and the one fact worth acting on —
// "there is something to LOOK at" — is gone within seconds. The founder, on the shape he wants
// instead: *"[dot color] [build agent name] has a preview for you to review: [preview card]"*,
// where clicking the card opens the localhost url and clicking the name opens that agent.
//
// ══ DETECTION RIDES THE LIFECYCLE, IT DOES NOT SCRAPE ═══════════════════════════════════════════
// Every fact this needs — the url, the port, the OWNING AGENT — is already held structurally by
// `preview:state` → `applyPreviewStatus` → `previewStore`. Scraping terminal output for a url is
// precisely where the url is missed today, so the fix cannot be a better scraper: it is to read the
// place that already knows.
//
// ══ A CARD, NOT A PANE, AND THAT IS THE LOAD-BEARING DESIGN POINT ═══════════════════════════════
// A preview PANE during planning is blocked three independent ways, and none of them is a bug to
// route around:
//   1. `WORK_MODES` is mutually exclusive (`engine/workMode`: plan | build | preview, one per
//      side), so "preview during plan" is UNREPRESENTABLE in the state model.
//   2. The concierge has NO WORKTREE, so it structurally cannot call `preview` at all
//      (`controlListener.handlePreview`'s `preview_unknown_caller` branch says exactly this).
//   3. `preview_open` needs a real dev server.
// A concierge ROW is not a work mode, so none of the three apply — the concierge only has to
// RENDER a url another agent already owns. `previewOpenOutcomeFor` clause 5 ("that pair is in build
// mode — never interrupt Plan") is therefore untouched by any of this, and must stay that way.
import { previewScreenshot } from "./conciergeTools/previewInspect";
// The same `load_attachment` command the composer's own image drops go through. NOT a second
// image-reading path: the CSP for this webview is `img-src 'self' data:`, so a file PATH cannot be
// rendered — only a data url can — and `load_attachment` is the one command that turns the first
// into the second, with its own containment check on the path it was handed.
import { loadAttachment } from "../components/composer/attachmentsApi";
import { isLoopbackPreviewUrl } from "./preview";
import { isSurfacingState, type PreviewEntry, type PreviewState } from "../stores/previewStore";

/** One card's worth of fact. Deliberately tiny: everything else a card draws (the agent's name, its
 *  status dot, whether it can be opened) is resolved from the live roster at render time, so a card
 *  cannot go stale in a way the rest of the column does not. */
export interface PreviewCardModel {
  agentId: string;
  /** ALREADY PROVEN LOOPBACK by {@link livePreviewCards}. A consumer may render it directly. */
  url: string;
  /**
   * When this preview last BECAME worth surfacing (`previewStore`'s `surfacedAt`), or when its
   * entry first appeared. The card re-captures its snapshot when this moves — see below for why
   * that is the only automatic refresh the store can honestly offer.
   */
  surfacedAt: number;
  /**
   * When this preview's ENTRY first appeared (`previewStore`'s `startedAt`), which is a different
   * instant from `surfacedAt` and is the one a thread artifact must anchor on (bead sparkle-75fbot,
   * roborev 77898).
   *
   * `surfacedAt` is stamped on the TRANSITION into a surfacing state, so for the ordinary
   * fresh-start lifecycle — entry created at T0, notice shown, `ready` at T1, card shown — it is T1,
   * later than T0 by the whole dev-server startup window: seconds for Vite, minutes for an install.
   * A notice carries T0 and a card carried T1, so the SAME preview reported two different arrival
   * instants depending on which projection the agent happened to be in. The anchor is captured once
   * per mount, so the first mount recorded T0 and any remount recomputed from T1 — and every message
   * that arrived in `(T0, T1]`, which is exactly the window in which someone chats to the agent
   * whose server is still building, flipped from below the card to above it. That is the same "the
   * card silently moved when I came back" symptom the stamp exists to remove.
   *
   * `startedAt` is preserved across every later transition (`setPreview` writes
   * `prev?.startedAt ?? Date.now()`), so it is stable for the life of the entry and both projections
   * can read the one clock. `surfacedAt` keeps the job it already had: driving snapshot recapture.
   */
  startedAt: number;
}

/**
 * The card a CONSUMER can actually paint: a {@link PreviewCardModel} whose agent the live roster
 * resolved. See {@link renderablePreviewCards} for why the name is part of the projection rather
 * than something the component looks up on its own.
 */
export interface NamedPreviewCardModel extends PreviewCardModel {
  /** The owning agent's name, as the roster spells it right now. */
  name: string;
}

/** The shape {@link renderablePreviewCards} needs from a project — structural on purpose, so this
 *  module does not drag the whole `Project` type (and its store) into a pure function. */
export interface PreviewCardRoster {
  readonly agents: readonly { readonly id: string; readonly name: string }[];
}

/**
 * The previews worth showing, newest surfacing first.
 *
 * TWO GATES, and both are narrowing:
 *
 *   • `isSurfacingState` — `ready`/`serving` only, the same set the auto-open predictor arms on.
 *     `listening` is deliberately excluded: a port is bound before the first compile finishes, so a
 *     card offered there sends the reader to the framework's own "compiling…" page. `stopped`,
 *     `failed` and `crashed` are excluded for the blunter reason — this is where the card RETIRES.
 *     A dead link is worse than no card, because it costs the reader a click to learn it is dead.
 *
 *   • `isLoopbackPreviewUrl` — the EXISTING check from `services/preview`, imported rather than
 *     re-implemented. A second copy of a security predicate is how the two drift, and this one is
 *     subtle enough to get wrong twice (it parses rather than string-matches, precisely so that
 *     `127.0.0.1.evil.com` and `evil.com/#127.0.0.1` cannot pass).
 *
 * A PURE FUNCTION over the store's map, so the whole "which cards exist" question is testable
 * without rendering anything — and so the retirement rule is one readable expression rather than a
 * lifecycle scattered across a component.
 */
export function livePreviewCards(byAgent: Record<string, PreviewEntry>): PreviewCardModel[] {
  const cards: { card: PreviewCardModel; at: number }[] = [];
  for (const [agentId, entry] of Object.entries(byAgent)) {
    if (!entry || !isSurfacingState(entry.status)) continue;
    if (!isLoopbackPreviewUrl(entry.url)) continue;
    // `entry.url` is a `string | null` and the guard above already refused null — but the compiler
    // cannot see through the helper, so this narrows explicitly rather than asserting.
    const url = entry.url;
    if (!url) continue;
    const at = entry.surfacedAt ?? entry.startedAt;
    // `at` orders the cards and drives snapshot recapture; `startedAt` is carried UNMODIFIED beside
    // it because an anchor needs one instant per agent that does not move — see the field docstring.
    cards.push({ card: { agentId, url, surfacedAt: at, startedAt: entry.startedAt }, at });
  }
  // NEWEST FIRST, because the newest preview is the one the reader has not seen yet. Ties fall back
  // to the agent id so the order is total and a re-render cannot shuffle two cards past each other.
  cards.sort((a, b) => b.at - a.at || a.card.agentId.localeCompare(b.card.agentId));
  return cards.map((c) => c.card);
}

/**
 * The previews worth showing that a reader can ACTUALLY SEE — {@link livePreviewCards} narrowed
 * once more by the live roster, with the owning agent's name resolved.
 *
 * ══ WHY THIS EXISTS RATHER THAN LIVING IN THE COMPONENT ═════════════════════════════════════════
 * "Is this preview on screen?" is asked in TWO places — the strip that paints the cards, and
 * `previewIdleGrace`, which stops a dev server nothing is showing. While the roster filter lived
 * only in the component, those two answers DISAGREED for exactly one case, and it was the case that
 * matters: a live loopback preview whose agent the roster cannot resolve (an orphan folded in by
 * `listPreviews()` after a window reload, a project removed, a server that outlived its agent). The
 * strip painted nothing for it, while the grace clock read it as visible and never armed — so that
 * server ran until the app quit. Two copies of a visibility rule is how a leak like that survives
 * both suites: each half is self-consistent.
 *
 * AN UNRESOLVABLE AGENT GETS NO CARD, and that is the founder-facing half of the same rule.
 * `AgentPill` degrades an id it cannot resolve to inert prose or a "…is closed" dead end, which is
 * right inside a transcript — a historical message must still render — and wrong here: this card's
 * whole proposition is "someone is showing you something RIGHT NOW".
 */
export function renderablePreviewCards(
  byAgent: Record<string, PreviewEntry>,
  projects: readonly PreviewCardRoster[],
): NamedPreviewCardModel[] {
  const named: NamedPreviewCardModel[] = [];
  for (const card of livePreviewCards(byAgent)) {
    for (const project of projects) {
      const agent = project.agents.find((a) => a.id === card.agentId);
      if (agent) {
        named.push({ ...card, name: agent.name });
        break;
      }
    }
  }
  return named;
}

/**
 * A picture of one agent's live preview, as a `data:` url ready for an `<img>`.
 *
 * TWO HOPS, and neither is new machinery. `previewScreenshot` (the existing `preview_inspect`
 * domain) drives a throwaway headless Chromium against the agent's own dev-server port and writes a
 * PNG to the capture dir — a PATH, never pixels, because the tool envelope that op normally answers
 * must not carry megabytes of base64. This webview cannot render a path (`img-src 'self' data:`),
 * so `load_attachment` reads that file back as a data url exactly as it does for a dropped image.
 *
 * RESOLVES `null` ON EVERY FAILURE, and that is deliberate rather than lazy. A card whose picture
 * did not arrive is still a useful card — it names the agent and it opens the url — whereas a
 * thrown error would take the whole strip down for a screenshot, which is the least important thing
 * on it. The refusals are ordinary states, not exceptions: `no-preview` (it stopped between the
 * store read and the capture), `preview-not-ready`, and `headless-browser-missing` (Playwright's
 * Chromium is not installed, which is a perfectly normal machine).
 */
/**
 * WHY THERE IS NO AUTOMATIC RE-CAPTURE ON HOT RELOAD, stated because it is the obvious next feature
 * and the reason it is missing is not laziness.
 *
 * THE REASON IS NOT A DEBOUNCE — THE ENGINE EMITS NOTHING TO DEBOUNCE. This header used to claim
 * that "a dev server re-emits `serving` on every hot reload" and that `previewStore.setPreview`
 * throws that repeat away. Both halves were false, and the false half had already been inherited
 * verbatim by a task brief as a settled premise, where it would have shipped a timer with no
 * signal to time off (bead `sparkle-l7cihu`). What `preview.rs`'s `supervise` (§6) actually does:
 *
 *   • the DISCOVERY block is guarded by `if bound.is_none()`, so it runs AT MOST ONCE, and the one
 *     transition inside it is to `listening`;
 *   • the HTTP probe runs every tick until the server answers or `READY_TIMEOUT` is spent, and
 *     `ready` goes out AT MOST ONCE, when it first answers (`ReadyWatch::tick`). The retry is bead
 *     `sparkle-dlrqb8.2`; before it, the probe sat inside the discovery block, so one failing probe
 *     was final and a server that bound its port before it could answer HTTP latched at `listening`
 *     forever — which is what kept the card unopenable for exactly the slow starts it exists for;
 *   • once `ready` has gone out (or the budget is spent) the loop body is only: check stop, check
 *     exited, sleep. The one reachable state change left is a terminal `finish(…)` — `crashed`, or
 *     `failed`. Giving up on the probe is NOT terminal: the server stays at `listening`, alive.
 *
 * So a healthy preview emits NOTHING AT ALL between reaching `ready` and dying. A hot reload is
 * invisible to Rust,
 * which never watches the served page; it only watches the process. There is no repeat event to
 * debounce off and none to stamp from. (`serving` is a red herring in particular: it has NO
 * production writer on either side of the wire — see the `PreviewState` note in `previewStore` —
 * so a fixture that hands `serving` in is not evidence that anything ever sends it.)
 *
 * That leaves TWO honest options, and picking between them is a product call rather than a
 * mechanical one: poll on a timer while a card is on screen (bounded, but captures nobody asked
 * for), or leave it manual.
 *
 * THE OPTION THAT IS NOT ON THAT LIST, named so it is not re-derived: "stamp a `lastEventAt` in
 * `applyPreviewStatus` even when the projection is unchanged" was the third entry here, and it is
 * STRUCTURALLY IMPOSSIBLE. A stamp needs an arriving event, and for a healthy server there is
 * none — the stamp would simply never move, so a re-capture built on it would be dead code that
 * looks correct. (`PreviewEntry.lastActivityAt` IS written through that bail and does exist — but
 * read its note: what moves it is a human's or an agent's gesture, plus the app's own re-reads, not
 * the dev server noticing a file change.)
 *
 * Today the card refreshes on the transitions the store CAN see — a preview reaching `ready` again
 * after a restart — plus the reader's own ⟳.
 */
export async function previewCardShot(agentId: string): Promise<string | null> {
  try {
    const shot = await previewScreenshot(agentId);
    if (!shot.ok) return null;
    const loaded = await loadAttachment(shot.data.path);
    return loaded.dataUrl ?? null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE OTHER HALF: A PREVIEW THAT IS NOT OPENABLE IS STILL WORTH SAYING OUT LOUD
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above answers ONE question — "which previews can the reader OPEN right now" — and it
// answers it narrowly on purpose. That narrowness left a founder-facing hole, because the states it
// excludes are not all the same kind of exclusion:
//
//   • `stopped` — RETIRED. Nothing to say; the card going away IS the message.
//   • `ready`/`serving` — the openable set. Handled above.
//   • `failed`/`crashed` — the reader is told NOTHING. An agent was asked for a preview, the dev
//     server refused to boot, and the concierge column is silent: no card, no pill, no error. The
//     one moment the founder most needs to know something happened is the one moment nothing
//     appears. And the explanation already exists end to end — `preview.rs` calls
//     `finish(…, PreviewState::Failed, …, Some(msg), …)` with messages that already carry a stderr
//     tail ("the dev server exited before it started listening. Last output: …"), `PreviewUpdate`
//     already carries `error`, and the store already holds it. Nothing rendered it.
//   • `installing`/`starting`/`listening` — the reader is told nothing for up to FIVE MINUTES.
//     `preview.rs` waits `INSTALL_WAIT_TIMEOUT` (300s) for the install to finish before it will
//     even try to spawn. A preview that was asked for and shows nothing for five minutes is
//     indistinguishable from one that was never asked for.
//
// ══ WHY A SEPARATE PROJECTION RATHER THAN WIDENING `livePreviewCards` ═══════════════════════════
// `livePreviewCards`/`renderablePreviewCards` are not just "the card list" — they are the app's
// definition of "a preview the human can OPEN", and `previewIdleGrace` reads that definition to
// decide which dev servers nothing is watching. Widening them here would silently change which
// servers get reclaimed, which is a lifecycle change wearing the costume of a UI change. So the
// noteworthy-but-not-openable states get their own projection and the openable definition is left
// exactly as it was.
//
// ══ A NOTICE IS A STATUS LINE, NOT AN INVITATION ════════════════════════════════════════════════
// "A dead link is worse than no card, because it costs the reader a click to learn it is dead" is
// the rule the exclusions above were written for, and it survives intact: a notice carries NO url
// to activate. The distinction is structural (nothing to click) rather than cosmetic (a greyed-out
// card), because a card that merely LOOKS inert still invites the click that teaches the reader it
// is dead.
//
// ══ RETIREMENT IS STILL DERIVED ═════════════════════════════════════════════════════════════════
// A pure function over the same `byAgent` map, exactly like `livePreviewCards`. No timer, no
// dismiss list, no sweep — a notice cannot outlive the entry it describes, because it IS that
// entry. See {@link pendingPreviewNotices} for the one honest caveat about how long a `failed`
// entry lives.

/**
 * The states a notice speaks for, as a TYPE rather than only as a set.
 *
 * Disjoint from `isSurfacingState` by construction (a preview is either openable or noteworthy,
 * never both) and deliberately excluding `stopped`, which is where the whole surface RETIRES rather
 * than something to announce.
 *
 * It is a type so that the consumer's wording table can be a total `Record` over it: adding a state
 * here without giving it a sentence is then a COMPILE error rather than a blank line in the
 * concierge column. `Extract` rather than a hand-written union, so a state renamed in the store's
 * `PreviewState` cannot silently survive here as a string literal that matches nothing.
 */
export type PreviewNoticeState = Exclude<PreviewState, "stopped">;

/**
 * EVERY non-`stopped` state, proven exhaustive BY THE COMPILER (roborev 65679, Medium).
 *
 * This was a `new Set<PreviewNoticeState>([...])`, which errors on an EXTRA literal but never on an
 * OMITTED one — so the docstring's promise ("adding a state without giving it a sentence is a
 * compile error") was exactly backwards for the change that matters. A `Record<PreviewNoticeState,
 * true>` is total: add a member to `PreviewState` and this object fails to compile until it is
 * listed here, and `PREVIEW_NOTICE_LEAD` fails until it is given a sentence.
 *
 * `Exclude` rather than a hand-written `Extract` list for the same reason: the union is DERIVED, so
 * a state added to the store is in it automatically instead of falling silently through both
 * projections.
 */
const NOTICE_STATE_TABLE: Record<PreviewNoticeState, true> = {
  installing: true,
  starting: true,
  listening: true,
  ready: true,
  serving: true,
  failed: true,
  crashed: true,
};

const NOTICE_STATES: ReadonlySet<PreviewState> = new Set(
  Object.keys(NOTICE_STATE_TABLE) as PreviewNoticeState[],
);

/** Does this state deserve a status line in the concierge column? A type guard, so the projection
 *  below narrows `PreviewState` down to the set the wording table actually covers. */
export function isPreviewNoticeState(state: PreviewState): state is PreviewNoticeState {
  return NOTICE_STATES.has(state);
}

/**
 * How much of `error` a notice will show.
 *
 * The Rust side's `stderr_tail` already clamps at `STDERR_TAIL` characters, but that is a clamp on
 * what the BACKEND is willing to carry, not on what a 320px-wide concierge column can hold. This is
 * the second, narrower clamp: enough to recognise the failure ("Error: Cannot find module 'vite'"),
 * far short of pushing the composer off screen. The full text stays reachable — it is on the
 * element's `title`, so a hover gives the untruncated string without a layout that grows.
 */
export const PREVIEW_NOTICE_DETAIL_MAX = 280;

/** Clamp to {@link PREVIEW_NOTICE_DETAIL_MAX}, keeping the TAIL rather than the head: the last line
 *  a dev server printed before it died is the one that says why. Returns null for text that is
 *  absent or only whitespace, so the caller never has to decide whether `""` means anything. */
export function clampNoticeDetail(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= PREVIEW_NOTICE_DETAIL_MAX) return trimmed;
  return `…${trimmed.slice(trimmed.length - PREVIEW_NOTICE_DETAIL_MAX)}`;
}

/** One status line's worth of fact. Note what is NOT here: no `url` to activate. See the header. */
export interface PreviewNoticeModel {
  agentId: string;
  /** The raw state, so the consumer can pick its own wording and its own ink without re-deriving
   *  "is this a failure" from a string it was handed. */
  status: PreviewNoticeState;
  /** True for `failed`/`crashed` — the states that are an OUTCOME rather than a stage. */
  failed: boolean;
  /** The error text, already clamped and trimmed, or null when the state carries none (which is the
   *  ordinary case for `installing`/`starting`/`listening`). */
  detail: string | null;
  /** The UNCLAMPED text, for a `title`/tooltip. Null exactly when `detail` is. */
  fullDetail: string | null;
  /** When this preview first appeared in the store, so the column can say how long a five-minute
   *  install has actually been going. */
  startedAt: number;
}

/** {@link PreviewNoticeModel} whose agent the live roster resolved — the notice twin of
 *  {@link NamedPreviewCardModel}, and it exists for the same reason. */
export interface NamedPreviewNoticeModel extends PreviewNoticeModel {
  name: string;
}

/**
 * The previews that are NOT openable but ARE worth saying out loud, newest first.
 *
 * A pure projection of the store, with no url in the output at all — see the header for why the
 * non-clickability is structural rather than styled.
 *
 * ══ HOW LONG A `failed` NOTICE LIVES, STATED RATHER THAN GUESSED ════════════════════════════════
 * Nothing sweeps `failed`/`crashed` entries out of `previewStore` today. `clearPreview` has exactly
 * one caller — `services/preview.stopPreviewForAgent`, the teardown path — so a failed notice stays
 * on screen until that agent's preview is stopped, until a later `preview:state` moves it to
 * another state, or until the window reloads (the store is in-memory by design, so a reload starts
 * empty). That is a real limitation and it is NOT fixed here: inventing a timer or a dismiss list
 * would break the "retirement is derived" property that makes this whole surface impossible to
 * leak. If the clutter turns out to matter, the honest fix is upstream — a sweep in the store or a
 * `stopped` event after a failure — not a clock in the projection.
 */
export function pendingPreviewNotices(byAgent: Record<string, PreviewEntry>): PreviewNoticeModel[] {
  const notices: PreviewNoticeModel[] = [];
  for (const [agentId, entry] of Object.entries(byAgent)) {
    if (!entry || !isPreviewNoticeState(entry.status)) continue;
    // THE TWO PROJECTIONS MUST PARTITION THE ENTRY SPACE, NOT JUST THE STATE MACHINE (roborev
    // 65679, Medium). `livePreviewCards` drops a `ready`/`serving` entry whose url is null or is
    // not loopback http — a Vite dev server on `server.https`, or a `serving` payload that arrived
    // with no url. Excluding those states here unconditionally left exactly the silence this whole
    // surface exists to end: a preview that is RUNNING, with no card and no notice and nothing at
    // all on screen. So a surfacing state falls through to a notice precisely when the card cannot
    // render it, and is skipped when the card can — which is what keeps the two disjoint.
    if (isSurfacingState(entry.status) && isLoopbackPreviewUrl(entry.url)) continue;
    const fullDetail = (entry.error ?? "").trim() || null;
    notices.push({
      agentId,
      status: entry.status,
      failed: entry.status === "failed" || entry.status === "crashed",
      detail: clampNoticeDetail(entry.error),
      fullDetail,
      startedAt: entry.startedAt,
    });
  }
  // NEWEST FIRST, and ties broken by agent id — the same total order `livePreviewCards` uses, so
  // two surfaces that sit next to each other cannot disagree about which preview is the recent one.
  notices.sort((a, b) => b.startedAt - a.startedAt || a.agentId.localeCompare(b.agentId));
  return notices;
}

/**
 * {@link pendingPreviewNotices} narrowed by the live roster, with the owning agent's name resolved.
 *
 * THE SAME UNRESOLVABLE-AGENT RULE AS `renderablePreviewCards`, and for the same reason: a notice
 * whose whole proposition is "SOMEONE is waiting on this / SOMEONE's server just died" is worthless
 * when the someone cannot be named or opened, and `AgentPill` would degrade it to the "…is closed"
 * dead end, which reads as a working pill.
 */
export function renderablePreviewNotices(
  byAgent: Record<string, PreviewEntry>,
  projects: readonly PreviewCardRoster[],
): NamedPreviewNoticeModel[] {
  const named: NamedPreviewNoticeModel[] = [];
  for (const notice of pendingPreviewNotices(byAgent)) {
    for (const project of projects) {
      const agent = project.agents.find((a) => a.id === notice.agentId);
      if (agent) {
        named.push({ ...notice, name: agent.name });
        break;
      }
    }
  }
  return named;
}
