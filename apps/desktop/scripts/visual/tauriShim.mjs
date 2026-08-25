// THE ONE Tauri IPC shim. Two callers, deliberately one source (bead sparkle-bg6868).
//
// The renderer reads `window.__TAURI_INTERNALS__` for every backend call; outside a Tauri webview
// it is absent and those calls THROW. That is why a plain browser pointed at this app's dev server
// can only ever render the auth gate — `trialApi.fetchTrial()` is `invoke("trial_status")`, its
// rejection sets `trialStore.error`, and `AuthGate` paints WelcomeScreen with "We couldn't load
// your free-trial status". The founder hit exactly that in every agent preview card.
//
// WHO INSTALLS IT, and why the two paths must not diverge:
//   • the visual-regression harness, over CDP (`scripts/visual/capture.mjs` INIT_SCRIPTS →
//     Page.addScriptToEvaluateOnNewDocument), where `serve.mjs` re-exports this constant;
//   • the agent preview server, as an inline <script> injected into index.html by the
//     `sparkle-preview-tauri-shim` vite plugin in `apps/desktop/vite.config.ts`, which is created
//     ONLY for `command === "serve" && mode === "preview"`.
// A second, subtly different shim would be a worse outcome than the bug it fixed, so this file
// exists to make "reuse" the cheap option. `previewTauriShimGate.test.ts` asserts the plugin serves
// THIS string, byte for byte.
//
// SECURITY. This fakes the answer to an entitlement check, so it must be unreachable in a release
// build. Both installers are structurally dev-only: the harness is a script that only ever runs
// against `vite` dev-serve, and the vite plugin is never constructed under `vite build` (the
// command that produces the shipped bundle). See the plugin's comment in vite.config.ts.

/**
 * The Tauri IPC shim. The renderer reads `window.__TAURI_INTERNALS__` for every backend call;
 * outside a Tauri webview it is absent and those calls THROW, which is what pins the app on a
 * blank screen in a plain browser. Resolving them to null instead lets the tree mount — the
 * fixtures (src/dev/visualFixtures.ts) supply the data the backend would have.
 *
 * Installed before any app module runs — over CDP as an init script by the visual harness, or as a
 * head-prepended inline <script> by the preview server's vite plugin. Both orderings are what make
 * the very first `invoke()` in the app find a bridge already in place.
 */
export const TAURI_SHIM = `
  (() => {
    // NEVER clobber a REAL bridge. Inside a Tauri webview \`__TAURI_INTERNALS__\` is already there
    // and replacing it would sever the app from its own backend. Neither installer runs there today
    // (see the header), so this is belt-and-braces — but it is what makes the shim safe to install
    // from anywhere, which is the property that stops the next caller from writing its own.
    if (window.__TAURI_INTERNALS__) return;
    let seq = 0;
    // Commands whose NULL answer would visibly change the layout. Everything else resolves to null,
    // which the app already treats as "no data" — that is the intended empty-workspace behaviour.
    //
    // probe_connectivity is the one that bites. connectivity.ts falls back to navigator.onLine only
    // when invoke THROWS; a resolved null is a falsy verdict, so the whole workspace renders under
    // the offline banner — a full-width strip that pushes every surface down and would score as a
    // layout-wide difference on every capture. Answering it truthfully (the harness does have a
    // network) is more faithful than clamping the store afterwards.
    //
    // history_prompts_in_range is the thread scrubber rail's dots (bead sparkle-7m719). A null here
    // is not merely "no data": the rail is a fixed-width gutter that still draws its track, its
    // handle and its scope dropdown, so an unanswered query captures an EMPTY rail — which is both
    // a visible layout difference and a picture of the exact failure the spec warns against ("the
    // founder will select 1w, see nothing, and reasonably conclude it is broken"). The shape is the
    // Rust PromptMarker from src-tauri/src/history.rs, pinned by
    // apps/desktop/shared/history-range-wire.json.
    //
    // Timestamps are offsets from the harness's FROZEN_CLOCK (FIXTURE_NOW, below), for the same
    // reason every other fixture time is: a wall-clock offset would render a different rail on
    // every run and score as a diff against the design rather than the design.
    const FIXTURE_NOW = 1785258000000;
    const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const PROMPTS = [
      [9 * DAY, "Set up the release pipeline so the DMG is notarized on my own Mac"],
      [6 * DAY, "Why did the concierge column stop remembering my thread after a restart?"],
      [3 * DAY, "Search public data sources to find me 20 people that are most like Zoe"],
      [30 * HOUR, "Make the search sit up next to the Sparkle.ai wordmark"],
      [26 * HOUR, "What happened to the retention work I asked about last week?"],
      [8 * HOUR, "Show me every agent that is blocked on me right now"],
      [7 * HOUR + 50 * MIN, "…and which of those are waiting on a review rather than a merge"],
      [7 * HOUR + 44 * MIN, "Park the ones that are only waiting on CI"],
      [3 * HOUR, "The vertical bar on the chat. I had asked for that multiple times"],
      [40 * MIN, "It is a vertical slider bar that makes it easy to scroll up and down the chat"],
      [12 * MIN, "Show me the rail with a week of history in it"],
    ].map(([ago, text], i) => ({
      id: "visual-prompt-" + (i + 1),
      createdAt: FIXTURE_NOW - ago,
      textPrefix: text,
    }));
    const ANSWERS = {
      probe_connectivity: true,
      notify_frontend_shown: null,
      history_prompts_in_range: PROMPTS,
      // The backlog page the rail asks for when it is dragged past the live window. An ARRAY, not
      // null: the caller maps over it, and null would be a different failure from "nothing older".
      history_entries_in_range: [],
    };
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => ++seq,
      unregisterCallback: () => {},
      invoke: (cmd) =>
        Promise.resolve(Object.prototype.hasOwnProperty.call(ANSWERS, cmd) ? ANSWERS[cmd] : null),
      convertFileSrc: (p) => p,
    };
  })();
`;
