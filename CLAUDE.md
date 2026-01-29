---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

<!-- hack:agent-docs:start -->
## hack CLI (local dev + MCP)

Use `hack` as the single interface for local dev. It manages docker compose, TLS/DNS, and logs.

Concepts:
- Project: a repo with `.hack/` config + compose file.
- Service: a docker compose service (e.g. api, web, worker).
- Instance: a running project; branch instances are separate copies started with `--branch`.

When to use a branch instance:
- You need two versions running at once (PR review, experiments, migrations).
- You want to keep a stable environment while testing another branch.
- Use `--branch <name>` on `hack up/open/logs/down` to target it.

Standard workflow:
- If `.hack/` is missing: `hack init`
- Start services: `hack up --detach`
- Check status: `hack ps` or `hack projects status`
- Open app: `hack open` (use `--json` for machine parsing)
- Stop services: `hack down`

Logs and search:
- Tail compose logs: `hack logs --pretty` or `hack logs <service>`
- Snapshot for agents: `hack logs --json --no-follow`
- Loki history: `hack logs --loki --since 2h --pretty`
- Filter Loki services: `hack logs --loki --services api,web`
- Raw LogQL: `hack logs --loki --query '{project="<name>"}'`
- Force compose logs: `hack logs --compose`
- If Loki is unavailable, start global logs: `hack global up`

Run commands inside services:
- One-off: `hack run <service> <cmd...>` (uses `docker compose run --rm`)
- Example: `hack run api bun test`
- Use `--workdir <path>` to change working dir inside the container.
- Use `hack ps --json` to list services and status.

Project targeting:
- From repo root, commands use that project automatically.
- Else use `--project <name>` (registry) or `--path <repo-root>`.
- List projects: `hack projects --json`

Daemon (optional):
- Start for faster JSON status/ps: `hack daemon start`
- Check status: `hack daemon status`

Docker compose notes:
- Prefer `hack` commands; they include the right files/networks.
- Use `docker compose -f .hack/docker-compose.yml exec <service> <cmd>` only if you need exec into a running container.

Sessions (tmux-based):
- Interactive picker: `hack session` (fzf picker, works as switcher inside tmux)
- Start/attach: `hack session start <project>` (attaches if exists, switches if in tmux)
- Force new: `hack session start <project> --new --name agent-1`
- With infra: `hack session start <project> --up`
- List: `hack session list`
- Stop: `hack session stop <session>`
- Exec in session: `hack session exec <session> "<command>"`
- Setup tmux: `hack setup tmux` (installs tmux if missing)

Agent setup (CLI-first):
- Cursor rules: `hack setup cursor`
- Claude hooks: `hack setup claude`
- Codex skill: `hack setup codex`
- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)
- Init patterns: `hack agent patterns`
- MCP (no-shell only): `hack setup mcp`
<!-- hack:agent-docs:end -->

<!-- hack:tickets:start -->
## Tickets (git-backed)

This project uses `hack` tickets (extension: `dance.hack.tickets`).

Common commands:
- Create: `hack tickets create --title "..." --body-stdin [--depends-on "T-00001"] [--blocks "T-00002"]`
- List: `hack tickets list`
- Tui: `hack tickets tui`
- Show: `hack tickets show T-00001`
- Update: `hack tickets update T-00001 [--title "..."] [--body "..."] [--depends-on "..."] [--blocks "..."]`
- Status: `hack tickets status T-00001 in_progress`
- Sync: `hack tickets sync`

Recommended body template (Markdown):
```md
## Context
## Goals
## Notes
## Links
```

Tip: use `--body-stdin` for multi-line markdown.

Data lives in `.hack/tickets/` (gitignored on the main branch) and syncs to hidden ref `refs/hack/tickets` by default.
<!-- hack:tickets:end -->
