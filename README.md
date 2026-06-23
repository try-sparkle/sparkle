# Sparkle

**An operations dashboard for AI coding agents.** Sparkle wraps Claude Code in a
visual interface that hides the terminal, filesystem, and git — and surfaces only what
matters: **what's being built, what needs a decision, and what just shipped.**

It's built for people who want to ship software without living in a terminal. Agents
run; you watch progress, approve the risky steps, and see what shipped.

This repository is the **open-source client** — the macOS desktop app and the shared UI
/ logic packages. (A mobile app is planned.)

## How it works
The desktop app runs **your own `claude` (Claude Code) binary locally**, in a
pseudo-terminal, under your own login — Sparkle is the UI on top and **never reads or
stores your auth token**. The genuine Claude Code binary authenticates itself, exactly
as it would in any terminal or IDE. So if you have Claude Code installed and logged in,
Sparkle drives it for you and turns its output into a clean dashboard (live agent cards,
approval prompts, an activity stream).

## Layout
| Path | What |
|------|------|
| `apps/desktop` | macOS app — Tauri v2 (Rust) + React + TypeScript + Vite |
| `packages/ui` | `@sparkle/ui` — design tokens (brand palette, type) |
| `packages/core` | `@sparkle/core` — shared agent-event risk model + output classifier |

## Quickstart
Prerequisites: **Node 22+**, **pnpm 10+**, **Rust** (stable) + the
[Tauri prerequisites](https://tauri.app/start/prerequisites/), and
[Claude Code](https://docs.claude.com/en/docs/claude-code) installed & logged in.

```bash
pnpm install
pnpm tauri:dev      # run the desktop app in dev
pnpm build:desktop  # typecheck + build the frontend
```

## Project status
Early. The local-agent dashboard works; an optional cloud/orchestration backend (for
always-on and multi-device, not in this repo) is configurable via the app's backend URL.

## Contributing
PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License
[MIT](./LICENSE).
