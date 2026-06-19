# fclt Documentation

These docs explain the product model behind `fclt`. The root [README](../README.md) is the quick start and command reference. The files here explain why the pieces exist and how they fit together.

Start here:

- [Concepts](./concepts.md): canonical roots, generated state, rendered outputs, scopes, and asset types.
- [Managed Mode](./managed-mode.md): when to let `fclt` write tool files, and how adoption works.
- [Project `.ai`](./project-ai.md): how repo-local capability works without leaking project review state into the repo.
- [Built-In Pack](./built-in-pack.md): the packaged operating-model layer for writeback and evolution.
- [Writeback And Evolution](./writeback-evolution.md): how real-work friction becomes reviewable capability changes.
- [Roadmap](./roadmap.md): current product gaps and non-goals.

## Documentation Policy

Public docs should use generic examples. Do not include personal account names, private customer names, local machine paths, secret values, or project-specific operating notes. Use placeholders such as `/path/to/repo`, `example.com`, and `~/.ai`.

Machine-local state and review artifacts can contain project metadata. `fclt` keeps those artifacts in machine-local Facult state and global `~/.ai/writebacks` / `~/.ai/evolution` review directories, not in repo-local project `.ai` directories.
