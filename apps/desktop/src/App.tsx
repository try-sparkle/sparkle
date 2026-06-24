import { Workspace } from "./components/Workspace";
import { useApplyTheme } from "./theme/theme";

export function App() {
  // Single writer of <html data-theme> for the whole app (owns the matchMedia subscription).
  useApplyTheme();
  return <Workspace />;
}
