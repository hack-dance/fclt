import { basename, dirname, join, resolve } from "node:path";
import {
  ensureSnippetFile,
  findSnippet,
  listSnippets,
  syncAll,
  validateSnippetMarkerName,
} from "./snippets";

const EDITOR_SPLIT_RE = /\s+/;

function printSnippetsHelp() {
  console.log(`facult snippets — sync reusable blocks across config files

Usage:
  facult snippets list [--json]
  facult snippets show <name> [--json]
  facult snippets create <name>
  facult snippets edit <name>
  facult snippets sync [--dry-run] [file...]

Notes:
  - <name> is the snippet marker name (e.g. codingstyle, global/codingstyle, myproject/context)
  - Unscoped names (e.g. codingstyle) resolve to project snippet first (if in a git repo), then global.
`);
}

function isSafePathString(p: string): boolean {
  return !p.includes("\0");
}

async function detectProjectForCwd(): Promise<string | null> {
  const cwd = process.cwd();
  let dir = resolve(cwd);
  for (let i = 0; i < 50; i += 1) {
    const git = join(dir, ".git");
    try {
      const st = await Bun.file(git).stat();
      if (st.isDirectory() || st.isFile()) {
        return basename(dir);
      }
    } catch {
      // ignore
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function openEditorBestEffort(path: string) {
  const editor = process.env.EDITOR?.trim();
  if (!editor) {
    return;
  }
  // Best-effort: split on whitespace. This won't handle complex quoting, but avoids
  // shelling out unnecessarily.
  const parts = editor.split(EDITOR_SPLIT_RE).filter(Boolean);
  const cmd = [...parts, path];
  try {
    Bun.spawnSync({
      cmd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    // ignore editor failures; user can open the file manually.
  }
}

function parseSubcommandArgs(
  args: string[],
  allowedLongFlags: string[]
): { positionals: string[]; flags: Set<string>; error?: string } {
  const allowed = new Set(allowedLongFlags);
  const flags = new Set<string>();
  const positionals: string[] = [];
  let parseOptions = true;

  for (const arg of args) {
    if (!arg) {
      continue;
    }
    if (parseOptions && arg === "--") {
      parseOptions = false;
      continue;
    }
    if (parseOptions && arg.startsWith("--")) {
      if (!allowed.has(arg)) {
        return { positionals, flags, error: `Unknown option: ${arg}` };
      }
      flags.add(arg);
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

export async function snippetsCommand(argv: string[]) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printSnippetsHelp();
    return;
  }

  if (sub === "list") {
    const json = rest.includes("--json");
    const snippets = await listSnippets();
    if (json) {
      console.log(JSON.stringify(snippets, null, 2));
      return;
    }
    if (!snippets.length) {
      console.log("(no snippets found)");
      return;
    }
    for (const s of snippets) {
      console.log(s.marker);
    }
    return;
  }

  if (sub === "show") {
    const parsed = parseSubcommandArgs(rest, ["--json"]);
    if (parsed.error) {
      console.error(parsed.error);
      process.exitCode = 2;
      return;
    }
    const json = parsed.flags.has("--json");
    const name = parsed.positionals[0];
    if (!name) {
      console.error("snippets show requires a name");
      process.exitCode = 2;
      return;
    }
    if (parsed.positionals.length > 1) {
      console.error("snippets show accepts a single name");
      process.exitCode = 2;
      return;
    }
    const err = validateSnippetMarkerName(name);
    if (err) {
      console.error(`Invalid snippet name "${name}": ${err}`);
      process.exitCode = 2;
      return;
    }

    const project = await detectProjectForCwd();
    const snippet = await findSnippet({ marker: name, project });
    if (!snippet) {
      console.error(`Snippet not found: ${name}`);
      process.exitCode = 1;
      return;
    }

    if (json) {
      console.log(JSON.stringify(snippet, null, 2));
      return;
    }
    console.log(snippet.content);
    return;
  }

  if (sub === "create") {
    const parsed = parseSubcommandArgs(rest, []);
    if (parsed.error) {
      console.error(parsed.error);
      process.exitCode = 2;
      return;
    }
    const name = parsed.positionals[0];
    if (!name) {
      console.error("snippets create requires a name");
      process.exitCode = 2;
      return;
    }
    if (parsed.positionals.length > 1) {
      console.error("snippets create accepts a single name");
      process.exitCode = 2;
      return;
    }
    const err = validateSnippetMarkerName(name);
    if (err) {
      console.error(`Invalid snippet name "${name}": ${err}`);
      process.exitCode = 2;
      return;
    }

    const { path, created } = await ensureSnippetFile({ marker: name });
    console.log(`${created ? "Created" : "Exists"}: ${path}`);
    openEditorBestEffort(path);
    return;
  }

  if (sub === "edit") {
    const parsed = parseSubcommandArgs(rest, []);
    if (parsed.error) {
      console.error(parsed.error);
      process.exitCode = 2;
      return;
    }
    const name = parsed.positionals[0];
    if (!name) {
      console.error("snippets edit requires a name");
      process.exitCode = 2;
      return;
    }
    if (parsed.positionals.length > 1) {
      console.error("snippets edit accepts a single name");
      process.exitCode = 2;
      return;
    }
    const err = validateSnippetMarkerName(name);
    if (err) {
      console.error(`Invalid snippet name "${name}": ${err}`);
      process.exitCode = 2;
      return;
    }

    const project = await detectProjectForCwd();
    const snippet = await findSnippet({ marker: name, project });
    if (!snippet) {
      console.error(`Snippet not found: ${name}`);
      process.exitCode = 1;
      return;
    }
    if (!isSafePathString(snippet.path)) {
      console.error(`Ignored unsafe path: ${snippet.path}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Editing: ${snippet.path}`);
    openEditorBestEffort(snippet.path);
    return;
  }

  if (sub === "sync") {
    const parsed = parseSubcommandArgs(rest, ["--dry-run"]);
    if (parsed.error) {
      console.error(parsed.error);
      process.exitCode = 2;
      return;
    }
    const dryRun = parsed.flags.has("--dry-run");
    const files = parsed.positionals;

    const results = await syncAll({
      dryRun,
      files: files.length ? files : undefined,
    });

    let updatedFiles = 0;
    for (const r of results) {
      if (r.errors.length) {
        console.log(`${r.filePath}: error`);
        for (const e of r.errors) {
          console.log(`  - ${e}`);
        }
        continue;
      }
      if (!r.changed) {
        continue;
      }
      updatedFiles += 1;
      console.log(`${dryRun ? "Would update" : "Updated"} ${r.filePath}:`);
      for (const c of r.changes) {
        if (c.status === "updated") {
          const lines =
            typeof c.lines === "number" ? ` (${c.lines} lines)` : "";
          console.log(`  ${c.marker} — updated${lines}`);
        } else if (c.status === "not-found") {
          console.log(`  ${c.marker} — not found (skipped)`);
        }
      }
    }

    const suffix = dryRun ? "would be updated" : "updated";
    console.log(`${updatedFiles} files ${suffix}`);
    return;
  }

  console.error(`Unknown snippets command: ${sub}`);
  printSnippetsHelp();
  process.exitCode = 2;
}
