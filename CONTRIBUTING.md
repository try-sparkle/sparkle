# Contributing to Sparkle

Thanks for your interest! Sparkle is MIT-licensed and contributions are welcome.

## Dev setup
Prerequisites: Node 22+, pnpm 10+, Rust (stable) + [Tauri prerequisites](https://tauri.app/start/prerequisites/), and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed & logged in.

```bash
pnpm install
pnpm tauri:dev        # run the desktop app
pnpm build:desktop    # frontend typecheck + build
cd apps/desktop/src-tauri && cargo check   # Rust side
```

## Layout
- `apps/desktop` — Tauri v2 (Rust backend) + React/TS/Vite frontend.
- `packages/ui` (`@sparkle/ui`) — design tokens. **Never hardcode colors**; use the tokens.
- `packages/core` (`@sparkle/core`) — shared risk model + the PTY output classifier.

## Workflow
1. Branch off `main` (`feat/...`, `fix/...`).
2. Keep changes focused; match the surrounding style.
3. Verify: `pnpm build:desktop` (and `cargo check` if you touched Rust) must pass.
4. Open a PR against `main` with a clear description.

## Reporting issues
Use GitHub Issues. For security-sensitive reports, please disclose privately rather than
opening a public issue.

By contributing, you agree your contributions are licensed under the project's MIT license.
