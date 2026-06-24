import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

// NOTE: no React.StrictMode — its double-invoke of effects would spawn each agent's PTY
// twice (one would leak). Each AgentPane owns a single live PTY.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
