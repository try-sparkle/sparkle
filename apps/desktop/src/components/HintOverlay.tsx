import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C, ON_GOLD_FILL } from "../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import { focusQuietly } from "../services/programmaticFocus";
import { useHintMode } from "../keyboardHints/useHintMode";
import {
  AGENT_HINT,
  PROJECT_TAB_HINT,
  RECENT_HINT,
  RECENT_SWITCH_HINT,
  RECENT_TRIGGER_HINT,
  ATTACH_TRIGGER_HINT,
  HINT_JUMP_ATTR,
  PAIR_PREFIX,
  assignLabels,
  attachActionLabel,
  isPairLabel,
} from "../keyboardHints/hintTargets";

// A single placed chiclet: the label, the screen rect of the control it sits on, and whether its
// badge hangs off the control's TOP edge rather than being vertically centred on it.
type Chiclet = { label: string; rect: DOMRect; el: HTMLElement; anchorTop: boolean };

// A scoped sub-layer of the overlay: while one is open, ONLY its own targets are badged.
//
// "attach" is the paperclip's two actions. The scope is not a nicety — "s" (Screenshot) is also
// CHROME_HINTS.screenshot, the agent-pane composer's button, and both can be on screen together.
//
// It is state rather than something inferred from the DOM (the way the Recent dropdown's scope is),
// because the attach group ALSO expands on plain hover: inferring it would let a mouse pointer left
// resting over the paperclip blank every other badge in the app.
type HintLayer = null | "attach";

// True for elements that are actually on screen and clickable: laid out (offsetParent), non-zero
// size, and at least partially within the viewport. Filters out display:none / collapsed / mode-
// gated controls (e.g. Think behind a flag, the account badge when there are no accounts).
function isVisible(el: HTMLElement): boolean {
  // A disabled control can't be clicked, so don't offer a (dead) chiclet for it.
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return false;
  const cs = getComputedStyle(el);
  // NOT PAINTED → NOT OFFERED. `offsetParent === null` catches `display: none` and nothing else:
  // a `visibility: hidden` element keeps its layout box, so it has an offsetParent and a plausible
  // on-screen rect, and every check below passes. That is the repo's OWN way of saying "covered"
  // (`paneVisibilityStyle`, and the Build column under a pair's Plan board), so without this the
  // overlay drew a chiclet floating over an opaque surface for a control nobody could see — and
  // since the key handler takes the FIRST match in DOM order, the covered copy of a duplicated
  // control won the mnemonic outright. A hidden element cannot be clicked, exactly like the
  // disabled one on the line above.
  if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
  // AND THE ONE A DESCENDANT CANNOT UNDO. `visibility` is inherited, so a control inside a covered
  // column that re-declares `visibility: visible` (the status-filter Reset link does exactly that,
  // conditionally) computes visible and slips past the line above. `inert` is not overridable from
  // inside, which is why the covered column carries both — so honour it here as well.
  if (el.closest("[inert]") !== null) return false;
  if (el.offsetParent === null && cs.position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (!(r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth)) {
    return false;
  }
  return !isClippedByAncestor(el, r);
}

// getBoundingClientRect reports an element's UNCLIPPED layout box, so a row scrolled out of an
// overflow container still reports a plausible on-screen rect. Without this check the Recent
// dropdown (maxHeight + overflowY:auto) hands out badges for rows nobody can see, and they get
// drawn below the popover over unrelated page content. Walk the ancestor chain and reject the
// element if the point we anchor its badge to falls outside any clipping ancestor's box.
function isClippedByAncestor(el: HTMLElement, r: DOMRect): boolean {
  const anchorX = r.left;
  const anchorY = r.top + r.height / 2;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    // Test THIS ancestor's own clip box before considering whether to stop — a container can be
    // both `position: fixed` and a scroller, and it still clips its own overflowing children.
    if (CLIPS.test(s.overflowX) || CLIPS.test(s.overflowY)) {
      const pr = p.getBoundingClientRect();
      // A zero-size ancestor isn't laid out, so there's nothing meaningful to clip against.
      if (pr.width > 0 || pr.height > 0) {
        if (anchorY < pr.top || anchorY > pr.bottom || anchorX < pr.left || anchorX > pr.right) {
          return true;
        }
      }
    }
    // A `fixed` element is positioned against the viewport, so nothing ABOVE it can clip it.
    if (s.position === "fixed") return false;
  }
  return false;
}

const CLIPS = /^(auto|scroll|hidden|clip)$/;

// Badge box metrics. These are the single source of truth: the style block below reads them, and
// BADGE_H is DERIVED from them, so restyling the chiclet can't silently un-center it.
const BADGE_LINE_H = TYPE.small; // font line-height, px — the scale's `small` step
const BADGE_PAD_Y = 2; // vertical padding, px
const BADGE_PAD_X = 5; // horizontal padding, px
const BADGE_BORDER = 1; // border width, px
const BADGE_H = BADGE_LINE_H + 2 * BADGE_PAD_Y + 2 * BADGE_BORDER;

// Normalize a KeyboardEvent.key to a label character: letters lowercased, digits and "." as-is.
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : "";
}

/** Where focus should go when a chain opened by `trigger` is left — i.e. what held it beforehand,
 *  UNLESS that is somewhere inside the surface the chain itself owns.
 *
 *  Handing focus back INTO that surface would re-fire the disclosure's own focus handler and
 *  re-expand what leaving had just collapsed — stranding the group open with its badges scoped away
 *  and no keyboard way out, which is the bug the collapse was written to fix.
 *
 *  This is not an exotic entry state, it is the STEADY one: AttachControl.close deliberately skips
 *  its focus handback when the paperclip is what holds focus, which after any completed chain it
 *  always is. So the second chain of a session starts with the trigger already focused. Tabbing to
 *  the paperclip before opening hint mode arrives the same way.
 *
 *  Containment, not identity, is the test — a hidden action button inside the collapsed group is
 *  just as wrong a target, and is harmless today only by the accident that `display: none` makes
 *  focus() a no-op. The trigger's PARENT is that surface: AttachControl wraps the clip and its two
 *  actions in one group element. */
function returnTargetFor(trigger: HTMLElement): HTMLElement | null {
  const prev = document.activeElement as HTMLElement | null;
  if (!prev || prev === trigger) return null;
  if (trigger.parentElement?.contains(prev)) return null;
  return prev;
}

/** Put focus back on the element a chain took it from, if that is still a real place to put it.
 *
 *  `document.body` is what `activeElement` reads as when nothing is focused, and it is not itself
 *  focusable — so it means "there was nothing to go back to", not "go back to the body". Treating it
 *  as a restore target is a silent no-op, which is worse than skipping: it looks like a handback.
 *
 *  Quiet, because putting focus back where it already was is not the user choosing a surface. A
 *  plain focus() here would have the compose box claim dictation on the way past. */
function restoreFocus(back: HTMLElement | null): void {
  if (!back || back === document.body || !back.isConnected) return;
  if (document.activeElement === back) return;
  focusQuietly(back);
}

/** Hand the selected control its own activation, once the overlay has torn down.
 *
 *  Deferred a tick so React has removed the overlay first — a synchronous click could re-enter
 *  layout while we're mid-update.
 *
 *  MARKED while it fires. A hint jump means "take me to this thing", and a handler may reasonably do
 *  something different for it than for a real click — the Build column's agent rows skip folding
 *  their worker subtree, and the presence slider TOGGLES instead of meaning the segment that was
 *  tagged. The attribute is the explicit signal for that. Sniffing `event.detail === 0` was tried
 *  instead and is wrong: detail describes the DISPATCH MECHANISM, so AT activations (VoiceOver /
 *  Switch Control AXPress) look identical to this and would silently get the jump behaviour too.
 *
 *  A TEXT FIELD IS FOCUSED, NOT CLICKED. `click()` on a textarea does not move the caret into it, so
 *  the compose box's hint would appear to do nothing at all. Focus, with the caret at the END of
 *  whatever is already in the box — the hint means "let me keep writing", not "let me start over".
 *  Detected by tag name rather than an opt-in attribute: this is a property OF the element, and an
 *  attribute is a second source of truth that can disagree with it. */
function fireActivation(el: HTMLElement): void {
  setTimeout(() => {
    el.setAttribute(HINT_JUMP_ATTR, "");
    try {
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const field = el as HTMLTextAreaElement | HTMLInputElement;
        field.focus();
        const end = field.value.length;
        try {
          field.setSelectionRange(end, end);
        } catch {
          // Not every input type supports a selection (email, number, …). Focus is the ask; the
          // caret placement is the nicety, and losing it must not lose the focus.
        }
      } else {
        el.click();
      }
    } finally {
      el.removeAttribute(HINT_JUMP_ATTR);
    }
  }, 0);
}

// Top-to-bottom, then left-to-right — the reading order used to number positional hints.
function byVisualOrder(a: HTMLElement, b: HTMLElement): number {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return ra.top - rb.top || ra.left - rb.left;
}

// Label a set of already-ordered elements and turn them into placed chiclets, dropping any that
// couldn't be assigned a label (e.g. a 27th recent row, or an unknown chrome id).
function place(els: HTMLElement[]): Chiclet[] {
  return assignLabels(els.map((el) => ({ hintId: el.dataset.hint ?? "", el })))
    .filter((t): t is typeof t & { label: string } => t.label !== null)
    .map((t) => ({
      label: t.label,
      el: t.el,
      rect: t.el.getBoundingClientRect(),
      anchorTop: t.el.dataset.hintAnchor === "top",
    }));
}

// Scan the DOM for tagged controls and assign each a label. Agents (data-hint="agent") are numbered
// top-to-bottom (then left-to-right); chrome controls keep their fixed mnemonic. Returns the placed
// chiclets in render order.
//
// `layer` is the scoped sub-layer that is open, if any (see HintLayer).
function collectChiclets(layer: HintLayer): Chiclet[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-hint]"),
  ).filter(isVisible);

  // The paperclip's chain. Selecting "k" expanded the group; these two actions are now the whole
  // layer, and everything else is deliberately unbadged (see HintLayer for why "s" requires that).
  const attachActions = nodes
    .filter((el) => attachActionLabel(el.dataset.hint ?? "") !== null)
    .sort(byVisualOrder);
  if (layer === "attach") return place(attachActions);

  // Recent-dropdown mode: when its rows are on screen, this is a focused "pick a project" moment.
  // Show ONLY the row badges (lettered a–z top to bottom) and suppress chrome/agents, so the whole
  // alphabet is collision-free and the eye goes straight to the list being chosen from.
  const recentItems = nodes
    .filter((el) => el.dataset.hint === RECENT_HINT)
    .sort(byVisualOrder);
  if (recentItems.length > 0) {
    // Every row before any Switch button: assignLabels walks one shared counter, so the rows claim
    // a.. in list order and the switches continue from there (13 rows → switches start at "n").
    const switches = nodes
      .filter((el) => el.dataset.hint === RECENT_SWITCH_HINT)
      .sort(byVisualOrder);
    return place([...recentItems, ...switches]);
  }

  const agents = nodes
    .filter((el) => el.dataset.hint === AGENT_HINT)
    .sort(byVisualOrder);
  // Project tabs read left to right along one row, which byVisualOrder gives us for free (equal
  // tops → compare lefts).
  const tabs = nodes
    .filter((el) => el.dataset.hint === PROJECT_TAB_HINT)
    .sort(byVisualOrder);
  // A Switch button only exists inside a Recent row, so if we got here there are none — but filter
  // it out anyway so it can never leak into the chrome bucket and resolve to a null label.
  //
  // The attach ACTIONS are filtered out too, and that one is load-bearing: the group they live in
  // expands on hover, so they are in the DOM and visible whenever the pointer rests on the
  // paperclip. Letting them through here would put a second "s" on screen beside the agent-pane
  // composer's screenshot button, and one of the two would be unreachable.
  const chrome = nodes.filter(
    (el) =>
      el.dataset.hint !== AGENT_HINT &&
      el.dataset.hint !== PROJECT_TAB_HINT &&
      el.dataset.hint !== RECENT_HINT &&
      el.dataset.hint !== RECENT_SWITCH_HINT &&
      attachActionLabel(el.dataset.hint ?? "") === null,
  );

  // Tabs first, then agents, then chrome: tabs claim the head of the shared overflow pool in
  // left-to-right order, agents take 1..9 in visual order and resume the pool after the tabs, and
  // chrome keeps its fixed keys. (assignLabels counts the tabs up front, so this order is for
  // readable, stable placement rather than something the labels depend on.)
  return place([...tabs, ...agents, ...chrome]);
}

// The keyboard-hint overlay. Mounted once at the app root; renders nothing until a clean ⌘ tap opens
// it (see useHintMode). When open it draws a gold chiclet over each tagged control and activates the
// matching control on a label keypress by firing that element's existing click handler.
export function HintOverlay() {
  const [chiclets, setChiclets] = useState<Chiclet[]>([]);
  // Is the PAIR_PREFIX layer open? While it is, only two-character labels are live and each shows
  // just its second character. Mirrored into a ref for the same reason the chiclets are.
  const [prefix, setPrefix] = useState(false);
  const prefixRef = useRef(false);
  // The open scoped sub-layer. Ref only — nothing renders from it directly; it feeds the next
  // collect, and a re-collect is what actually repaints.
  const layerRef = useRef<HintLayer>(null);
  // The trigger that opened the current chain, so leaving can hand focus back out of it, and what
  // held focus BEFORE the chain took it — almost always the compose box, since "/" is a hint whose
  // whole job is putting the caret there.
  const chainTriggerRef = useRef<HTMLElement | null>(null);
  const chainReturnRef = useRef<HTMLElement | null>(null);
  // Mirrors `active` for the deferred chain callbacks, which resolve two frames later and must not
  // commit into an overlay that has been dismissed in the meantime.
  const activeRef = useRef(false);

  // The keydown listener below reads the CURRENT chiclets through this ref rather than closing over
  // the `chiclets` state. Those are not equivalent, and the difference was a dropped keystroke.
  //
  // Binding the listener from an effect that depends on `chiclets` means the handler that is live
  // at any instant is the one from the last COMMITTED effect pass. React runs passive effects after
  // paint, so between "the new badges are on screen" and "the listener that knows about them is
  // bound" there is a real window. A key pressed in that window resolves against the stale array,
  // finds no match, and is swallowed by the printable-key guard — silently, since an unmatched
  // label is a deliberate no-op.
  //
  // That window is exactly where this feature asks the user to type. Opening the Recent dropdown
  // with "r" keeps hint mode active precisely so a project can be picked in the same breath, so the
  // fastest users — the ones the chaining flow is for — are the likeliest to lose the second key.
  // It surfaced as a CI flake (HintOverlay.test.tsx, "an a–z letter selects that project"): under
  // coverage instrumentation the effect flush shifts far enough to lose the race almost every run,
  // which is the same defect the product has, just made reproducible.
  //
  // A ref updated in the same tick as the state has no such window: the handler always sees the
  // latest placements. It also stops the listener being torn down and rebound on every re-collect.
  const chicletsRef = useRef<Chiclet[]>([]);
  const applyPrefix = useCallback((on: boolean) => {
    prefixRef.current = on;
    setPrefix(on);
  }, []);
  const applyChiclets = useCallback(
    (next: Chiclet[]) => {
      chicletsRef.current = next;
      setChiclets(next);
      // Never leave the pair layer open over nothing. A re-collect (a resize, a chain) can remove
      // the last pair label, and a layer with no live targets is a state the user can only feel as
      // "my keys stopped doing anything".
      if (prefixRef.current && !next.some((c) => isPairLabel(c.label))) applyPrefix(false);
    },
    [applyPrefix],
  );

  const refresh = useCallback(
    () => applyChiclets(collectChiclets(layerRef.current)),
    [applyChiclets],
  );

  // LEAVING A CHAIN HAS TO CLOSE WHAT IT OPENED. A chain trigger is a disclosure, and the one we
  // have — the concierge paperclip — latches open on `pinned`, whose only release paths run through
  // focus leaving the group. A synthetic click() focuses nothing (WKWebView does not focus a button
  // on click at all without Full Keyboard Access), so a chain entered and then abandoned left the
  // group expanded in the compose row with no badges on it and no keyboard way to collapse it.
  //
  // So the chain drives that group through its OWN machinery rather than around it: entering
  // focuses the trigger (which is what opens it), leaving blurs it (which is what closes it). No
  // new listener, no second source of truth for "is this thing open", and the keyboard path now
  // looks to the component exactly like the tab-in/tab-out it was already built to handle.
  // GIVING THE FOCUS BACK IS PART OF LEAVING. Entering took it from wherever the user was, and
  // releasing it with a bare blur() drops it on <body> — so "/" a draft, tap Control, k, Escape and
  // the caret is out of the box with nowhere to type. Restoring the previous element IS also the
  // collapse: focus landing outside the group is what its focusout handler reads. Quietly, via
  // focusQuietly, because putting focus back where it already was is not the user choosing a
  // surface — a plain focus() here would have the compose box claim dictation on the way past.
  const leaveChain = useCallback(() => {
    const trigger = chainTriggerRef.current;
    const back = chainReturnRef.current;
    chainTriggerRef.current = null;
    chainReturnRef.current = null;
    layerRef.current = null;
    if (!trigger) return;
    // BLUR UNCONDITIONALLY, THEN restore. Letting the restore stand in for the blur looks tempting
    // — focus landing outside the group is what collapses it either way — but it fails silently in
    // the case that matters most: when nothing was focused before the chain, there is no restore
    // target, so nothing moves and the group stays open. Two focus events, in the order that says
    // what happened: let go, then put it back.
    trigger.blur();
    // `back` is null when the previous holder was inside the group itself (returnTargetFor), and
    // that does NOT mean "nowhere to go" — it means the TRIGGER is where they were. A keyboard user
    // who tabbed to the paperclip, or anyone starting their second chain (the clip still holds
    // focus after a completed one), would otherwise be left on <body> with their tab position gone.
    // Handing it back is safe because restoreFocus goes through focusQuietly: AttachControl reads a
    // programmatic focus as ours and does not re-pin the group this same call just collapsed.
    restoreFocus(back ?? trigger);
  }, []);

  // Escape unwinds one layer at a time and only dismisses once there is nothing left to unwind.
  // useHintMode owns the dismissal and asks us first — see its header for why this is delegated
  // rather than intercepted.
  const onEscape = useCallback(() => {
    if (prefixRef.current) {
      applyPrefix(false);
      return true;
    }
    if (layerRef.current) {
      leaveChain();
      applyChiclets(collectChiclets(null));
      return true;
    }
    return false;
  }, [applyPrefix, applyChiclets, leaveChain]);

  const { active, close } = useHintMode(onEscape);

  // Compute placements as soon as we open (and on resize while open). Scroll dismisses instead of
  // re-placing (handled in useHintMode), so positions never go stale under the chiclets.
  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active) {
      // Closing drops every layer with it: reopening always starts at the top level, so a chain
      // abandoned by clicking away can't be waiting the next time the overlay opens. Dismissing the
      // whole overlay collapses an open chain for the same reason Escape does — a second trigger
      // tap must not leave a disclosure hanging open behind it.
      leaveChain();
      applyPrefix(false);
      applyChiclets([]);
      return;
    }
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [active, refresh, applyChiclets, applyPrefix, leaveChain]);

  // Label-key selection. Capture phase so we intercept the key before xterm/inputs consume it.
  useEffect(() => {
    if (!active) return;

    // What selecting a chiclet DOES. Three shapes: a chaining trigger re-collects into a sub-layer
    // and stays open, and everything else closes the overlay and hands the control its own
    // activation (a click, or a focus for a text field — see fireActivation).
    const activate = (el: HTMLElement) => {
      // Opening the Recent-projects dropdown by keyboard is a "chain straight into picking a
      // project" moment: keep hint mode ACTIVE instead of closing, so the dropdown's a–z row
      // badges appear at once and the user can pick without tapping the trigger again. Click to
      // open the dropdown, then re-collect after a double rAF — that gives React time to mount the
      // rows, so collectChiclets finds the recent-item rows and switches to its dropdown mode.
      // A programmatic el.click() dispatches a "click", not a "mousedown", so useHintMode's
      // mousedown-closes-overlay listener never fires — the overlay correctly stays open. (Every
      // OTHER control, including the dropdown's own recent-item rows, falls through to close+click.)
      if (el.dataset.hint === RECENT_TRIGGER_HINT) {
        el.click();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            // Two frames is long enough for the overlay to have been dismissed underneath us (a
            // second trigger tap, a mousedown, a scroll). Committing into a closed overlay would
            // resurrect state the close path just cleared.
            if (!activeRef.current) return;
            const next = collectChiclets(null);
            // Dropdown opened with rows → show their a–z badges and stay open to chain a pick.
            // Opened empty (no recent projects) → there's nothing to pick, so close instead of
            // stranding the user on a "stuck open" chrome overlay still showing the r badge.
            if (next.some((c) => c.el.dataset.hint === RECENT_HINT)) applyChiclets(next);
            else close();
          }),
        );
        return;
      }
      // The paperclip is the same shape: its click only EXPANDS the group holding the two things it
      // can do, so closing here would leave the user staring at an open menu with no badges on it.
      // Unlike the Recent dropdown the sub-layer is recorded (layerRef) rather than re-derived, so a
      // later resize re-collects the chain instead of falling back to the top level.
      if (el.dataset.hint === ATTACH_TRIGGER_HINT) {
        // FOCUS, then click. The group opens on focus anywhere inside it, and driving it that way
        // is what gives leaveChain something to undo — see its header. The click stays because it
        // is the trigger's documented contract; the focus is what makes the state releasable.
        chainReturnRef.current = returnTargetFor(el);
        el.focus();
        chainTriggerRef.current = el;
        el.click();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            // Dismissed while we waited — leaveChain has already run, so re-setting layerRef here
            // would leave the overlay reopening into a chain whose group is long collapsed: an
            // active overlay showing no badges at all, whose first Escape gets swallowed unwinding
            // the phantom layer instead of dismissing.
            if (!activeRef.current) return;
            const next = collectChiclets("attach");
            if (next.length > 0) {
              layerRef.current = "attach";
              applyChiclets(next);
            } else {
              // The group didn't expand (or its actions aren't reachable). Same call the Recent
              // trigger makes: close rather than strand the user on a layer with nothing in it.
              close();
            }
          }),
        );
        return;
      }
      // CHOOSING a chain member is not abandoning the chain, so hand the trigger over rather than
      // blurring it: the member's own handler closes the group and decides where focus goes (see
      // AttachControl.close, which rehomes focus only when it is about to destroy the element
      // holding it). Blurring first would collapse the group out from under the click we are about
      // to fire and take that decision away from it.
      //
      // The focus the chain TOOK still has to go back, though — AttachControl.close deliberately
      // skips its own handback when the paperclip is what holds focus, which after a keyboard chain
      // it always is, so choosing Screenshot would otherwise leave the caret out of the draft.
      // Queued after fireActivation's own tick so the handler has had its say first.
      const back = chainReturnRef.current;
      chainTriggerRef.current = null;
      chainReturnRef.current = null;
      close();
      fireActivation(el);
      if (back) setTimeout(() => restoreFocus(back), 0);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Nothing to select and nothing rendered (see the chiclets.length guard below) — don't
      // swallow keys, or an invisible-but-active overlay would silently eat keystrokes.
      const current = chicletsRef.current;
      if (current.length === 0) return;
      if (e.key === "Escape" || e.key === "Meta" || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = normalizeKey(e.key);
      // Non-printable keys (arrows, Tab, …) pass through so the user can still navigate/escape.
      if (!key) return;
      // Printable keys are swallowed while the overlay is open — it's a modal-feeling layer, so a
      // stray non-hint key must NOT leak into the focused terminal/composer underneath.
      e.preventDefault();
      e.stopPropagation();

      // THE PAIR LAYER. Inside it every live label is PAIR_PREFIX + this key; outside it, the prefix
      // can only mean "open the layer", because it is never a label in its own right (hintTargets).
      // Guarded on there being something behind it: opening an empty layer would look like the key
      // had killed the overlay.
      if (prefixRef.current) {
        const pair = current.find((c) => c.label === PAIR_PREFIX + key);
        if (!pair) return; // unassigned second key: no-op, stay in the layer
        applyPrefix(false);
        activate(pair.el);
        return;
      }
      if (key === PAIR_PREFIX) {
        if (current.some((c) => isPairLabel(c.label))) applyPrefix(true);
        return;
      }

      const hit = current.find((c) => c.label === key);
      if (!hit) return; // unassigned key: no-op, stay open
      activate(hit.el);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // `chiclets` is deliberately NOT a dependency: the handler reads chicletsRef, so rebinding on
    // every re-collect would buy nothing and reintroduce the stale-listener window described above.
  }, [active, close, applyChiclets, applyPrefix]);

  // Inside the pair layer only the two-character labels are live, and each shows just its SECOND
  // character — the prefix is already spent, so repeating it on every badge would be noise the user
  // has to read past. Outside it every badge shows, pairs included, so the layer is discoverable
  // rather than something you have to be told about.
  const visible = prefix ? chiclets.filter((c) => isPairLabel(c.label)) : chiclets;

  if (!active || visible.length === 0) return null;

  return createPortal(
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000, // above every modal/menu/tooltip
        pointerEvents: "none",
      }}
    >
      {visible.map((c, i) => (
        <div
          key={`${c.label}-${i}`}
          style={{
            position: "fixed",
            // Left edge of the control, vertically CENTERED on it. Anchoring to the top-left corner
            // (the Vimium convention) makes a badge straddle the boundary between two list rows, so
            // in a dense list it reads as belonging to the row above — the "letters don't track the
            // options" complaint. Centering ties each badge unambiguously to one row.
            //
            // `data-hint-anchor="top"` opts out, and the reason above is exactly why it has to be an
            // opt-in: on a TALL target — the compose box, ten lines of it — there is no adjacent row
            // to be confused with, and centring drops the badge halfway down an empty left edge
            // where it reads as belonging to nothing.
            top: c.anchorTop
              ? Math.max(2, c.rect.top + 2)
              : Math.max(2, c.rect.top + c.rect.height / 2 - BADGE_H / 2),
            left: Math.max(2, c.rect.left - 6),
            // The themed opaque-accent PAIR (fill + the ink that sits on it): a bright blue under
            // near-black in dark, a deep blue under white ink in light. These badges float over
            // whatever is on screen, including the light terminal plane, which is why the pair has
            // to be themed rather than a constant.
            background: C.goldFill,
            color: ON_GOLD_FILL,
            // NOT the shared `FONT.mono`, which is still the old `"Source Code Pro"` webfont —
            // packages/ui has not been migrated and two out-of-scope callers still read it.
            font: `700 ${BADGE_LINE_H}px/1 ${FONT_MONO}`,
            // 0.5px, NOT the label's 0.1em. This is not the label register: the chiclet is 700
            // weight at `TYPE.small`, where the treatment is `WEIGHT.med` at `TYPE.micro`, so
            // inheriting the label tracking is not automatic. It is also not free — React appends
            // `px` to a NUMBER, so `0.1em` here would be 1.2px at this size, a 2.4x increase on the
            // densest element the app draws, and CSS emits tracking AFTER the last character, so a
            // one-character badge would sit off-centre inside `BADGE_PAD_X`'s symmetric padding —
            // breaking the invariant stated above (roborev 54788).
            letterSpacing: 0.5,
            padding: `${BADGE_PAD_Y}px ${BADGE_PAD_X}px`,
            borderRadius: RADIUS.input,
            border: `${BADGE_BORDER}px solid ${ON_GOLD_FILL}`,
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
            textTransform: "uppercase",
          }}
        >
          {prefix ? c.label.slice(1) : c.label}
        </div>
      ))}
    </div>,
    document.body,
  );
}
