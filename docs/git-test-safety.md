# Git test safety

Git-writing tests must use a dedicated temporary repository. The shared fixture helper clears
repository-local Git environment variables, isolates HOME and global configuration, and sets a
repository discovery ceiling. Bun's test preload also clears hook-provided Git context, so focused,
full, pre-commit, and CI-safe test commands share the same boundary.

Use the normal commands from the agent guide:

```bash
./scripts/test-safe.sh src/autosync.test.ts src/util/git-environment.test.ts
./scripts/test-safe.sh
./scripts/test-safe.sh --ci
```

Use the direct shell wrapper for focused tests too. Raw `bun test` or `bun run test` can inspect
ambient repository state before the JavaScript sanitizer or preload runs, so neither is the
supported Git-safe entrypoint.

Do not reproduce a suspected escape in a caller repository or shared worktree. Build a disposable
repository with a linked worktree and record the caller snapshot before the test instead.

## If a fixture escape is suspected

1. Stop the test process and avoid additional Git-writing commands in the affected checkout.
2. Capture `git status --porcelain=v2 --branch`, `git worktree list --porcelain`, current HEAD and
   refs, reflogs, config origins, index checksum, and tracked-file checksums.
3. Preserve the affected repository and worktree metadata in a copy before attempting repair.
4. Compare the captured state with the known pre-test snapshot and identify fixture commits or
   config changes without moving refs or rewriting files.
5. Escalate recovery to the repository owner with the evidence and use explicit, bounded ref/config
   operations only after the intended branch tip and worktree identity are known.

Do not use `git reset --hard`, checkout-based cleanup, broad config rewrites, or automatic worktree
pruning as fixture recovery. Those commands can destroy the evidence and unrelated user work.
