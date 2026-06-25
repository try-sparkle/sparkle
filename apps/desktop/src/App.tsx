import { useEffect } from "react";
import { Workspace } from "./components/Workspace";
import { useApplyTheme } from "./theme/theme";
import { resolveEnvChiefPat } from "./services/chief";
import { useSettingsStore } from "./stores/settingsStore";

export function App() {
  // Single writer of <html data-theme> for the whole app (owns the matchMedia subscription).
  useApplyTheme();

  // Seed the Chief PAT from the user's environment (.env.local) at launch so the Brainstorm
  // agent works without pasting a token. Resolved in Rust (never baked into the bundle); set
  // unconditionally — including "" — so a removed env token doesn't leave a stale value.
  useEffect(() => {
    void resolveEnvChiefPat().then((pat) =>
      useSettingsStore.getState().setRuntimeChiefPat(pat),
    );
  }, []);

  return <Workspace />;
}
