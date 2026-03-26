# Contributing

This file covers contributor and release workflow details that do not need to live in the main README.

## Local Install Modes

For local CLI setup outside npm or Homebrew installs:

```bash
bun run install:status
bun run install:dev
bun run install:bin
```

Default install path is `~/.ai/.facult/bin/fclt`. You can pass a custom target dir via `--dir=/path`.

## Local Development

Typical contributor workflow:

```bash
bun run install:status
bun run install:dev
bun run install:bin
bun run build
bun run build:verify
bun run type-check
bun run test:ci
bun test
bun run check
bun run fix
```

Packaging and release dry runs:

```bash
bun run pack:dry-run
bun run release:dry-run
```

## CI And Release Automation

- CI workflow: `.github/workflows/ci.yml`
- Release workflow: `.github/workflows/release.yml`
- Semantic-release config: `.releaserc.json`

Release behavior:

1. Every push to `main` runs full checks.
2. `semantic-release` creates the version, tag, and GitHub release.
3. The release workflow builds platform binaries and uploads them to that release.
4. npm publish runs only after binary asset upload succeeds.
5. Published assets include platform binaries, `fclt-install.sh`, `facult-install.sh`, and `SHA256SUMS`.
6. When `HOMEBREW_TAP_TOKEN` is configured, the workflow also updates `hack-dance/homebrew-tap`.
7. The npm launcher resolves your platform, downloads the matching release binary, caches it locally, and runs it.

Current prebuilt binary targets:

- `darwin-x64`
- `darwin-arm64`
- `linux-x64`
- `windows-x64`

Self-update behavior:

1. npm or Bun global install updates through the package manager.
2. Direct binary installs replace the binary in place.
3. `fclt self-update` and `fclt update --self` use the appropriate path for the current install method.

Required secrets for publish:

- `NPM_TOKEN`
- `HOMEBREW_TAP_TOKEN`

Local semantic-release dry runs require Node `>=24.10`.

Recommended one-time bootstrap before first auto release:

```bash
git tag v0.0.0
git push origin v0.0.0
```

That makes the first semantic-release increment land at `0.0.1` for patch-level changes.
