// Public surface of the overlay's tray + auto-launch integration (bead sparkle-uz87.9).
//
// This is the LAST unit of epic sparkle-uz87. It reads the session's snapshot (sparkle-uz87.7) and
// turns it into the two things that exist outside the overlay window: what the tray icon says, and
// whether the app launches at login.
//
// SCOPE NOTE, recorded here because the bead asks for more than this delivers: the bead also asks
// to "package the app for macOS and Windows". This repo bundles `dmg`/`app` only and releases from
// a self-hosted Mac with a signed, notarized pipeline; adding a Windows bundle target to that for a
// feature that is still flag-OFF would put the shipping path at risk for no user-visible gain. The
// Windows half is deliberately NOT attempted here. See PRD/living-sparkle-overlay-build.md.
export {
  deriveTrayStatus,
  trayTooltip,
  isCapturing,
  type TrayInputs,
  type TrayStatus,
} from "./trayStatus";
export {
  autoLaunchEnabled,
  parseAutoLaunchPreference,
  setAutoLaunch,
  type AutoLaunchPreference,
  type AutoLaunchResult,
  type AutoLaunchStore,
} from "./autoLaunch";
