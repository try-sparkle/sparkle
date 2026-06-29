# Desktop auto-updater — signing key setup

The Sparkle desktop app uses the Tauri 2 updater plugin (Unit A of the auto-updater feature).
Updates are distributed as **public GitHub Releases** on `try-sparkle/sparkle` and verified with a
minisign keypair. This doc explains the keys and what the user/CI must do.

## What's committed vs. secret

- **Public key — committed.** It lives in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`. The app uses it to verify the signature on every downloaded update
  before installing (signature mismatch = fail closed, no install).
- **Private key + password — NOT committed.** They sign the update artifacts at release time and
  must only ever exist as CI secrets. `*.key` / `*.key.pub` are git-ignored (see
  `apps/desktop/.gitignore`) as a backstop.

## Where the generated private key lives right now

The keypair was generated with the Tauri CLI:

```sh
pnpm --filter @sparkle/desktop exec tauri signer generate -w "<scratchpad>/sparkle-updater.key"
```

It was generated in an ephemeral worker scratchpad and has since been **copied to a stable
location on this machine** (outside the repo, git-ignored by living outside it entirely):

- Private key: `~/.sparkle/updater/sparkle-updater.key`  (chmod 600)
- Public key:  `~/.sparkle/updater/sparkle-updater.key.pub`  (matches `plugins.updater.pubkey`)

The password chosen at generation time was **empty** (no password).

> This file is the ONLY copy of the private key. Add it to the CI secrets below (and/or a
> password manager) and keep `~/.sparkle/updater/` backed up. If it is lost, generate a new
> keypair and update the `pubkey` in `tauri.conf.json` — old installs will then only be able to
> update once they're on a build carrying the new public key.

## CI secrets the user must add

Add these to the GitHub Actions secrets for the repo that runs the release workflow (Unit B):

| Secret name | Value |
|-------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The **contents** of `sparkle-updater.key` (the whole file). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key password — **empty string** for the key generated above. |

The release build reads these env vars automatically and emits the signed update artifacts
(`*.app.tar.gz` + `*.app.tar.gz.sig`) because `bundle.createUpdaterArtifacts` is `true` in
`tauri.conf.json`.

## How a release flows (context; Unit B owns the pipeline)

1. CI builds the desktop app with `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` set → signed update
   artifacts + `latest.json`.
2. CI publishes a GitHub Release on `try-sparkle/sparkle` with those artifacts.
3. The app polls `https://github.com/try-sparkle/sparkle/releases/latest/download/latest.json`,
   verifies the signature against the committed public key, and installs per the user's
   "Automatically apply updates" setting.
