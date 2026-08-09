// The Permissions Policy the preview iframe delegates to the framed page: nothing.
//
// ── WHY THIS IS NOT `allow=""` ────────────────────────────────────────────────────────────────
//
// `allow=""` is an EMPTY container policy — it declares nothing. The inherited-policy algorithm
// only consults the container policy for features that APPEAR in it; a feature that is absent
// falls back to its own default allowlist. So an empty attribute is not "deny everything", it is
// "say nothing", and what happens next depends entirely on the feature's default:
//
//   default allowlist `self`  — camera, microphone, geolocation, clipboard-read, display-capture.
//     A CROSS-ORIGIN child is denied these already. This frame is cross-origin by construction
//     (`tauri://localhost` embedding `http://127.0.0.1:<port>`; `allow-same-origin` preserves the
//     frame's OWN origin rather than making it same-origin with us), so they were never reachable.
//     For this class the attribute changes nothing.
//
//   default allowlist `*`     — picture-in-picture, gamepad, sync-xhr, unload, and the ad-tech /
//     privacy set. These are INHERITED BY a cross-origin child by default. An empty attribute
//     leaves them exactly as they were: enabled. Only an explicit `<feature> 'none'` removes them.
//
// That distinction is the entire reason this file exists. FOUR earlier drafts of the rationale got
// it wrong in four different ways — first claiming the attribute was essential, then that it was
// harmless to delete, then that an empty value closed the `*` class, then misclassifying three
// features (`fullscreen` and `autoplay` are `self`-default, not `*`; `storage-access` is `*`, and
// sat in the block described as "already denied").
//
// So: TREAT THE CLASSIFICATION BELOW AS A READING OF THE SPEC, NOT A RESULT. It is the classes
// that keep being restated wrongly, never the deny list — every feature here is denied BY THIS
// LIST whichever class it is filed under, so a misclassification changes nothing observable, which
// is exactly why the errors survive review. Read that as "either class", NEVER as "with or without
// the attribute": deleting the `allow` attribute re-opens the whole `*` block. That is the
// "harmless to delete" error above — named by its words rather than by its position, because an
// ordinal into a prose list goes stale the moment the list is reordered or grows a fifth entry, and
// an earlier draft of this very sentence cited the wrong one ("an empty value closed the `*`
// class", which is a claim about `allow=""`, not about removing the attribute). If you are about to
// rely on a feature being in one class rather than the other, measure it first.
//
// ── WHY DENY THEM AT ALL ──────────────────────────────────────────────────────────────────────
//
// The framed page is authored by an AGENT and must be treated as hostile input. It is also a
// secure context in its own right (loopback origins are "potentially trustworthy"), so it is not
// disqualified from asking at the origin level. Denying by name is cheap and static; there is no
// handler to get wrong.
//
// ── MAINTENANCE ───────────────────────────────────────────────────────────────────────────────
//
// This list must GROW as the `*`-default set does, and it will drift — that is a real cost, taken
// deliberately over the alternative of leaving the class open. Unknown feature names in an `allow`
// attribute are ignored rather than fatal, so listing a feature an engine does not implement is
// safe, and listing one that arrives later is the only way to be ahead of it.
//
// The set below is CHROMIUM's `*`-default list, which is what a WebView2 (Windows) build faces.
// WebKit — what ships on macOS today — implements a narrower slice of Permissions Policy, so some
// of these are inert there. Inert is the right failure direction. NOT YET MEASURED in either
// engine: the probe that would settle it is in `docs/live-browser-preview.md`, and it must include
// a `*`-default feature (e.g. `document.pictureInPictureEnabled`) and name the engine it ran in,
// because a probe of only the `self`-default class can return exactly one answer and would be
// misread as confirming the whole table.
const DENIED_FEATURES = [
  // ── DEFAULT ALLOWLIST `*` — inherited by a cross-origin child, so `'none'` here is what
  //    actually removes them. This is the class an empty `allow` would have left OPEN.
  "picture-in-picture",
  "gamepad",
  "sync-xhr",
  "unload",
  "document-domain",
  "storage-access",
  // The ad-tech / privacy set.
  "browsing-topics",
  "attribution-reporting",
  "join-ad-interest-group",
  "run-ad-auction",
  "shared-storage",
  "shared-storage-select-url",
  "private-aggregation",

  // ── DEFAULT ALLOWLIST `self` — already denied to a cross-origin child. Named for depth: a
  //    refactor that makes the frame same-origin, or that starts granting `allow` for some other
  //    reason, flips these from deny to grant.
  "camera",
  "microphone",
  "geolocation",
  "clipboard-read",
  "clipboard-write",
  "display-capture",
  "fullscreen",
  "autoplay",
  "midi",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "payment",
  "screen-wake-lock",
  "idle-detection",
  "local-fonts",
  "window-management",
] as const;

/** `<feature> 'none'` for every feature above — the value of the iframe's `allow` attribute. */
export const PREVIEW_PERMISSIONS_POLICY = DENIED_FEATURES.map((f) => `${f} 'none'`).join("; ");
