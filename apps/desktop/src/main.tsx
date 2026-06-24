import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initLogger } from "./logger";
import { resolveThemeFromStorage } from "./theme/theme";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

// Set <html data-theme> synchronously, before first paint, from the persisted preference —
// otherwise a user who chose Light would see a flash of the default dark theme on launch.
// resolveThemeFromStorage parses the same zustand `sparkle-ui` envelope the store hydrates.
document.documentElement.dataset.theme = resolveThemeFromStorage(localStorage.getItem("sparkle-ui"));

// Stand up unified logging first so console.* calls and errors during render are captured.
initLogger();

// NOTE: no React.StrictMode — its double-invoke of effects would spawn each agent's PTY
// twice (one would leak). Each AgentPane owns a single live PTY.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
