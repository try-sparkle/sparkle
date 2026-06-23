# @sparkle/desktop

The Sparkle macOS desktop app — a **Tauri v2** shell (Rust) with a **React + TypeScript
+ Vite** frontend. It runs your own local `claude` (Claude Code) binary in a
pseudo-terminal and renders its output as an operations dashboard (agent cards, approval
prompts, activity stream). Sparkle never reads or stores your auth token — the genuine
binary authenticates itself.

## Commands
```bash
pnpm --filter @sparkle/desktop dev          # vite dev server (frontend only)
pnpm --filter @sparkle/desktop build        # typecheck + vite build
pnpm --filter @sparkle/desktop tauri dev    # full Tauri app
cd src-tauri && cargo check                 # Rust side
```

## Structure
- `src/` — React frontend: `components/` (AgentCard, ApprovalCard, ChatPanel,
  ExpertModeDrawer, Dashboard), `stores/` (Zustand), `agentRunner.ts` (PTY → classifier),
  `pty.ts` (Tauri bridge), `preflight.ts` (detects local `claude`).
- `src-tauri/` — Rust: `pty.rs` (local PTY host), `preflight.rs` (`claude` detection),
  `socket.rs` (optional backend relay), Tauri config + icons.

## Notes
- Colors come from `@sparkle/ui` tokens — never hardcode them.
- Cloud/backend features connect to a configurable orchestration URL (default
  `localhost:3001`); the backend is not part of this repo.
- Release builds are code-signed with an Apple Developer ID. The committed
  `signingIdentity` is a placeholder (`-`, ad-hoc) — set your own in
  `src-tauri/tauri.conf.json` to ship notarized builds.
