import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { extractServersObject } from "./mcp-config";
import { parseJsonLenient } from "./util/json";

export type Harness = "codex" | "claude";
type Layer = "project" | "global" | "account";
type ObjectValue = Record<string, unknown>;
export interface HarnessResource {
  name: string;
  kind: "skill" | "mcp" | "plugin" | "app";
  layer: Layer;
  definedAt: string;
  harness: Harness;
  account: string;
  use: "effective" | "shadowed" | "disabled" | "canonical-only" | "unknown";
  reason: string;
  duplicates: string[];
  alwaysTokens: number | null;
  deferredTokens: number | null;
}
interface Candidate extends HarnessResource {
  rank: number;
  listing?: string;
  identity?: string;
  manualOnly?: boolean;
  pluginName?: string;
}
export interface HarnessSessionInventory {
  harness: Harness;
  account: string;
  resources: HarnessResource[];
  tokens: {
    method: string;
    contextTokens: number;
    skillBudgetTokens: number;
    skillListingBeforeBudget: number;
    skillListing: number;
    mcpNamesAndInstructions: number;
    alwaysMeasured: number;
    deferredMeasured: number;
    unmeasuredMcpServers: number;
    completeness: "partial";
  };
  warnings: string[];
}
interface Options {
  cwd?: string;
  homeDir?: string;
  harnesses?: Harness[];
  homes?: string[];
  contextTokens?: number;
  includeLn?: boolean;
}
interface ReadPolicy {
  includeLn: boolean;
  skippedLn: boolean;
  isolatedRoots: Set<string>;
}
const PATH_COMPONENTS = /[\\/]+/;
async function readable(
  path: string,
  policy: ReadPolicy,
  depth = 0,
  accountHome = false
): Promise<boolean> {
  if (policy.includeLn) {
    return true;
  }
  if (accountHome) {
    registerIsolatedHome(path, policy);
  }
  if (isLnHome(path, policy)) {
    policy.skippedLn = true;
    return false;
  }
  if (depth > 16) {
    return false;
  }
  // Resolve links one component at a time so a non-isolated alias cannot enter
  // an isolated home before the boundary check.
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep);
  let prefix = root;
  for (const [index, part] of parts.entries()) {
    prefix = join(prefix, part);
    if (isLnHome(prefix, policy)) {
      policy.skippedLn = true;
      return false;
    }
    try {
      const target = await fs.readlink(prefix);
      return readable(
        resolve(dirname(prefix), target, ...parts.slice(index + 1)),
        policy,
        depth + 1,
        accountHome
      );
    } catch (error) {
      if (object(error).code === "ENOENT" || object(error).code === "ENOTDIR") {
        return true;
      }
      if (object(error).code !== "EINVAL") {
        return false;
      }
    }
  }
  return true;
}
async function fileExists(path: string, policy: ReadPolicy): Promise<boolean> {
  return (await readable(path, policy)) && (await Bun.file(path).exists());
}
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}
async function entries(path: string, policy: ReadPolicy): Promise<string[]> {
  try {
    return (await readable(path, policy))
      ? (await fs.readdir(path)).sort()
      : [];
  } catch {
    return [];
  }
}
async function exists(
  path: string,
  policy: ReadPolicy,
  accountHome = false
): Promise<boolean> {
  try {
    return (
      (await readable(path, policy, 0, accountHome)) &&
      (await Bun.file(path).stat()).isDirectory()
    );
  } catch {
    return false;
  }
}
async function config(
  path: string,
  warnings: string[],
  policy: ReadPolicy
): Promise<ObjectValue> {
  try {
    if (!(await readable(path, policy))) {
      return {};
    }
    const text = await Bun.file(path).text();
    return object(
      path.endsWith(".toml") ? Bun.TOML.parse(text) : parseJsonLenient(text)
    );
  } catch (error) {
    if (object(error).code !== "ENOENT") {
      warnings.push(`Could not parse configuration: ${path}`);
    }
    return {};
  }
}
async function accountHomes(
  home: string,
  harness: Harness,
  policy: ReadPolicy
): Promise<string[]> {
  const found = new Set<string>();
  for (const name of await entries(home, policy)) {
    if (
      name.startsWith(`.${harness}`) &&
      (name.endsWith("-ln") || (await exists(join(home, name), policy, true)))
    ) {
      found.add(join(home, name));
    }
  }
  const accounts = join(home, ".local", "share", "agent-accounts");
  for (const name of await entries(accounts, policy)) {
    const path = join(accounts, name, harness);
    if (!policy.includeLn && name.endsWith("-ln")) {
      found.add(path);
    } else if (await exists(path, policy, true)) {
      found.add(path);
    }
  }
  const environmentHome =
    harness === "codex"
      ? process.env.CODEX_HOME
      : process.env.CLAUDE_CONFIG_DIR;
  // An injected fixture HOME must never escape into the process's real account.
  if (home === homedir() && environmentHome) {
    found.add(resolve(environmentHome));
  }
  return found.size ? [...found].sort() : [join(home, `.${harness}`)];
}
function candidate(args: {
  name: string;
  kind: HarnessResource["kind"];
  layer: Layer;
  path: string;
  harness: Harness;
  account: string;
  rank: number;
  canonical?: boolean;
}): Candidate {
  return {
    name: args.name,
    kind: args.kind,
    layer: args.layer,
    definedAt: args.path,
    harness: args.harness,
    account: args.account,
    rank: args.rank,
    use: args.canonical ? "canonical-only" : "effective",
    reason: args.canonical
      ? "Canonical source; not a native loading location"
      : "Native configuration candidate; runtime trust/auth not probed",
    duplicates: [],
    alwaysTokens: null,
    deferredTokens: null,
  };
}
async function skills(args: {
  root: string;
  layer: Layer;
  rank: number;
  harness: Harness;
  account: string;
  canonical?: boolean;
  warnings: string[];
  policy: ReadPolicy;
}): Promise<Candidate[]> {
  const result: Candidate[] = [];
  const visited = new Set<string>();
  async function walk(root: string, depth: number): Promise<void> {
    if (depth > 8) {
      args.warnings.push(`Skill traversal depth limit: ${root}`);
      return;
    }
    let identity: string;
    try {
      if (!(await readable(root, args.policy))) {
        return;
      }
      identity = await fs.realpath(root);
    } catch {
      return;
    }
    if (visited.has(identity)) {
      return;
    }
    visited.add(identity);
    const path = join(root, "SKILL.md");
    if (await fileExists(path, args.policy)) {
      try {
        const text = (await Bun.file(path).text()).replaceAll("\r\n", "\n");
        const end = text.indexOf("\n---", 4);
        const metadata =
          text.startsWith("---\n") && end >= 0
            ? object(parseYaml(text.slice(4, end)))
            : {};
        if (
          args.harness === "codex" &&
          (typeof metadata.description !== "string" ||
            typeof metadata.name !== "string")
        ) {
          args.warnings.push(`Skill lacks name/description: ${path}`);
          return;
        }
        const body =
          text.startsWith("---\n") && end >= 0
            ? text.slice(text.indexOf("\n", end + 1) + 1)
            : text;
        const summary =
          typeof metadata.description === "string"
            ? metadata.description
            : (body
                .split("\n")
                .find((line) => line.trim())
                ?.trim() ?? "");
        const name =
          typeof metadata.name === "string" ? metadata.name : basename(root);
        const item = candidate({ ...args, name, kind: "skill", path });
        item.identity = join(identity, "SKILL.md");
        const description =
          args.harness === "claude"
            ? `${summary}${typeof metadata.when_to_use === "string" ? ` ${metadata.when_to_use}` : ""}`.slice(
                0,
                1536
              )
            : summary;
        item.listing = `${name}: ${description}${args.harness === "codex" ? ` (${path})` : ""}\n`;
        item.alwaysTokens = estimate(item.listing);
        item.deferredTokens = estimate(text);
        if (
          metadata["disable-model-invocation"] === true &&
          args.harness === "claude"
        ) {
          item.manualOnly = true;
          item.listing = "";
          item.alwaysTokens = 0;
          item.reason = "Manual-only skill; excluded from automatic listing";
        }
        result.push(item);
      } catch {
        args.warnings.push(`Could not read skill metadata: ${path}`);
      }
      return;
    }
    for (const name of await entries(root, args.policy)) {
      if (name === "node_modules" || name === ".git") {
        continue;
      }
      if (await exists(join(root, name), args.policy)) {
        await walk(join(root, name), depth + 1);
      }
    }
  }
  await walk(args.root, 0);
  return result;
}
function servers(args: {
  parsed: ObjectValue;
  path: string;
  harness: Harness;
  account: string;
  layer: Layer;
  rank: number;
  canonical?: boolean;
}): Candidate[] {
  const definitions =
    args.harness === "codex" && args.path.endsWith(".toml")
      ? object(args.parsed.mcp_servers)
      : (extractServersObject(args.parsed) ?? {});
  return Object.entries(definitions).map(([name, value]) => {
    const definition = object(value);
    const item = candidate({ ...args, name, kind: "mcp" });
    if (definition.enabled === false || definition.disabled === true) {
      item.use = "disabled";
      item.reason = "Disabled in configuration";
    }
    // Only count inline offline metadata. Never return commands, env, URLs or schema contents.
    const tools = Array.isArray(definition.tools) ? definition.tools : null;
    const instructions =
      typeof definition.instructions === "string"
        ? definition.instructions
        : "";
    if (tools) {
      item.alwaysTokens = estimate(
        tools.map((tool) => String(object(tool).name ?? "")).join("\n") +
          instructions
      );
      item.deferredTokens = estimate(JSON.stringify(tools));
    }
    return item;
  });
}
function registerIsolatedHome(path: string, policy: ReadPolicy): void {
  if (
    !policy.includeLn &&
    (basename(path).endsWith("-ln") || basename(dirname(path)).endsWith("-ln"))
  ) {
    policy.isolatedRoots.add(resolve(path));
  }
}
function isLnHome(path: string, policy: ReadPolicy): boolean {
  const absolute = resolve(path);
  const parts = absolute.split(PATH_COMPONENTS);
  return (
    [...policy.isolatedRoots].some(
      (root) => absolute === root || absolute.startsWith(`${root}${sep}`)
    ) ||
    parts.some(
      (part, index) =>
        part.endsWith("-ln") &&
        (part.startsWith(".codex") ||
          part.startsWith(".claude") ||
          parts[index - 1] === "agent-accounts")
    )
  );
}
function applyClaudeSettings(args: {
  resources: Candidate[];
  sources: { parsed: ObjectValue; rank: number }[];
}): void {
  const sources = [...args.sources].sort((a, b) => a.rank - b.rank);
  const overrides = Object.assign(
    {},
    ...sources.map((source) => object(source.parsed.skillOverrides))
  ) as ObjectValue;
  const lists = (key: string) =>
    sources.flatMap((source) =>
      Array.isArray(source.parsed[key]) ? (source.parsed[key] as unknown[]) : []
    );
  const disabled = lists("disabledMcpServers");
  const disabledProject = lists("disabledMcpjsonServers");
  const approved = lists("enabledMcpjsonServers");
  const enableAll = sources.reduce(
    (value, source) =>
      typeof source.parsed.enableAllProjectMcpServers === "boolean"
        ? source.parsed.enableAllProjectMcpServers
        : value,
    false
  );
  for (const item of args.resources) {
    if (item.use === "canonical-only") {
      continue;
    }
    if (item.kind === "skill" && !item.pluginName && item.use === "effective") {
      const mode = overrides[item.name];
      if (mode === "off") {
        item.use = "disabled";
        item.reason = "Disabled by skillOverrides";
      }
      if (mode === "name-only" && !item.manualOnly) {
        item.alwaysTokens = estimate(`${item.name}\n`);
      }
      if (mode === "user-invocable-only" || item.manualOnly) {
        item.alwaysTokens = 0;
      }
    }
    if (item.kind !== "mcp") {
      continue;
    }
    if (disabled.includes(item.name)) {
      item.use = "disabled";
      item.reason = "Disabled by per-project MCP toggle";
      continue;
    }
    if (basename(item.definedAt) !== ".mcp.json" || item.pluginName) {
      continue;
    }
    if (disabledProject.includes(item.name)) {
      item.use = "disabled";
      item.reason = "Disabled by disabledMcpjsonServers";
    } else if (
      item.use === "effective" &&
      !enableAll &&
      !approved.includes(item.name)
    ) {
      item.use = "unknown";
      item.reason = "Project MCP server pending approval";
    }
  }
}
async function session(args: {
  harness: Harness;
  account: string;
  home: string;
  cwd: string;
  contextTokens: number;
  policy: ReadPolicy;
}): Promise<HarnessSessionInventory> {
  const { harness, account, home, cwd } = args;
  const warnings: string[] = [];
  const resources: Candidate[] = [];
  const native = `.${harness}`;
  const accountConfigPath = join(
    account,
    harness === "codex" ? "config.toml" : "settings.json"
  );
  const accountConfig = await config(accountConfigPath, warnings, args.policy);
  const addSkills = async (
    root: string,
    layer: Layer,
    rank: number,
    canonical = false
  ) => {
    const discovered = await skills({
      root,
      layer,
      rank,
      harness,
      account,
      canonical,
      warnings,
      policy: args.policy,
    });
    if (
      harness === "codex" &&
      !canonical &&
      (root === join(account, "skills") ||
        root.endsWith(join(".codex", "skills")))
    ) {
      for (const item of discovered) {
        item.use = "unknown";
        item.reason =
          "Legacy Codex skill location; loading depends on harness version";
      }
    }
    resources.push(...discovered);
  };
  const addConfig = async (
    path: string,
    layer: Layer,
    rank: number,
    canonical = false
  ) => {
    const parsed =
      path === accountConfigPath
        ? accountConfig
        : await config(path, warnings, args.policy);
    resources.push(
      ...servers({ parsed, path, harness, account, layer, rank, canonical })
    );
    return parsed;
  };
  await addSkills(join(home, ".ai", "skills"), "global", 0, true);
  await addConfig(join(home, ".ai", "mcp", "servers.json"), "global", 0, true);
  await addConfig(
    join(home, ".ai", "mcp", "servers.local.json"),
    "global",
    1,
    true
  );
  await addSkills(
    join(account, "skills"),
    "account",
    harness === "claude" ? 100_000 : 10
  );
  if (harness === "codex") {
    await addSkills(join(home, ".agents", "skills"), "global", 20);
  }
  await addConfig(accountConfigPath, "account", 10);
  const settingSources: {
    parsed: ObjectValue;
    path: string;
    layer: Layer;
    rank: number;
  }[] = [
    {
      parsed: accountConfig,
      path: accountConfigPath,
      layer: "account",
      rank: 10,
    },
  ];
  if (harness === "claude") {
    // Claude's user MCP config is a sibling of the config directory, including custom homes.
    const internalPath = join(account, ".claude.json");
    const userPath = (await fileExists(internalPath, args.policy))
      ? internalPath
      : account === join(home, ".claude")
        ? join(home, ".claude.json")
        : `${account}.json`;
    const userConfig = await addConfig(userPath, "account", 11);
    const local = object(object(userConfig.projects)[cwd]);
    settingSources.push({
      parsed: local,
      path: userPath,
      layer: "project",
      rank: 10_000,
    });
    resources.push(
      ...servers({
        parsed: local,
        path: userPath,
        harness,
        account,
        layer: "project",
        rank: 10_000,
      })
    );
  }
  let ancestors: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (
      (await fileExists(join(dir, ".git"), args.policy)) ||
      (await exists(join(dir, ".git"), args.policy))
    ) {
      break;
    }
    if (dirname(dir) === dir) {
      ancestors = [cwd];
      break;
    }
  }
  for (const [index, dir] of ancestors.entries()) {
    const rank = 100 + index * 10;
    if (dir === home || join(dir, native) === account) {
      continue;
    }
    await addSkills(join(dir, native, "skills"), "project", rank);
    if (harness === "codex") {
      await addSkills(join(dir, ".agents", "skills"), "project", rank + 1);
      const path = join(dir, native, "config.toml");
      settingSources.push({
        parsed: await addConfig(path, "project", rank),
        path,
        layer: "project",
        rank,
      });
    } else {
      await addConfig(join(dir, ".mcp.json"), "project", rank);
      for (const file of ["settings.json", "settings.local.json"]) {
        const path = join(dir, native, file);
        settingSources.push({
          parsed: await config(path, warnings, args.policy),
          path,
          layer: "project",
          rank: rank + (file.includes("local") ? 1 : 0),
        });
      }
    }
  }
  for (const dir of ancestors) {
    const instructionPath = join(dir, "AGENTS.md");
    if (!(await fileExists(instructionPath, args.policy))) {
      continue;
    }
    let text: string;
    try {
      text = await Bun.file(instructionPath).text();
    } catch {
      warnings.push(`Could not read instructions: ${instructionPath}`);
      continue;
    }
    for (const match of text.matchAll(/\]\(([^)\n]+\/SKILL\.md)\)/g)) {
      const target = match[1];
      if (!target || target.includes("://")) {
        continue;
      }
      const path = resolve(
        dir,
        target.startsWith("~/") ? join(home, target.slice(2)) : target
      );
      if (!(await fileExists(path, args.policy))) {
        warnings.push(`Missing referenced skill: ${path}`);
        continue;
      }
      if (resources.some((item) => item.definedAt === path)) {
        continue;
      }
      const referenced = await skills({
        root: dirname(path),
        layer: "project",
        rank: 0,
        harness,
        account,
        warnings,
        policy: args.policy,
      });
      for (const item of referenced) {
        item.use = "unknown";
        item.reason = `Referenced by ${instructionPath}; instruction references are not a native skill catalog`;
      }
      resources.push(...referenced);
    }
  }
  if (cwd !== home) {
    await addSkills(join(cwd, ".ai", "skills"), "project", 0, true);
    await addConfig(
      join(cwd, ".ai", "mcp", "servers.json"),
      "project",
      0,
      true
    );
  }
  await plugins({
    harness,
    account,
    settingSources,
    resources,
    warnings,
    addSkills,
    addConfig,
    cwd,
    policy: args.policy,
  });
  if (harness === "codex") {
    const rules = settingSources.flatMap((source) => {
      const value = object(source.parsed.skills).config;
      return (Array.isArray(value) ? value : []).map((rule) => ({
        entry: object(rule),
        base: dirname(source.path),
      }));
    });
    for (const item of resources.filter(
      (resource) =>
        resource.kind === "skill" && resource.use !== "canonical-only"
    )) {
      let enabled: boolean | undefined;
      for (const { entry, base } of rules) {
        if (
          typeof entry.enabled !== "boolean" ||
          (typeof entry.name === "string") === (typeof entry.path === "string")
        ) {
          continue;
        }
        const selector =
          typeof entry.path === "string"
            ? resolve(
                base,
                entry.path.startsWith("~/")
                  ? join(home, entry.path.slice(2))
                  : entry.path
              )
            : undefined;
        if (
          entry.name === item.name ||
          selector === item.definedAt ||
          selector === dirname(item.definedAt)
        ) {
          enabled = entry.enabled;
        }
      }
      if (enabled === false) {
        item.use = "disabled";
        item.reason = "Disabled by last matching skills.config entry";
      }
    }
    for (const [name, value] of Object.entries(object(accountConfig.apps))) {
      const item = candidate({
        name,
        kind: "app",
        layer: "account",
        path: accountConfigPath,
        harness,
        account,
        rank: 10,
      });
      item.use = object(value).enabled === false ? "disabled" : "unknown";
      item.reason = "Offline app declaration; remote tool catalog not measured";
      resources.push(item);
    }
    if (object(accountConfig.features).apps === true) {
      const item = candidate({
        name: "apps",
        kind: "app",
        layer: "account",
        path: accountConfigPath,
        harness,
        account,
        rank: 10,
      });
      item.use = "unknown";
      item.reason = "Apps enabled; remote app catalog not measured offline";
      resources.push(item);
    }
  }
  if (harness === "claude") {
    applyClaudeSettings({ resources, sources: settingSources });
  }
  if (
    harness === "claude" &&
    resources.some((item) => item.kind === "mcp" && item.pluginName)
  ) {
    warnings.push(
      "Plugin/connector MCP endpoint deduplication is not resolved offline; counts can include duplicate endpoints."
    );
  }
  resolveCandidates(resources);
  const seenSkills = new Set<string>();
  const active = resources.filter((item) => {
    if (item.use !== "effective") {
      return false;
    }
    if (item.kind !== "skill" || !item.identity) {
      return true;
    }
    if (seenSkills.has(item.identity)) {
      return false;
    }
    seenSkills.add(item.identity);
    return true;
  });
  const skillListingBeforeBudget = active
    .filter((item) => item.kind === "skill")
    .reduce((sum, item) => sum + (item.alwaysTokens ?? 0), 0);
  const configuredBudget = settingSources.reduce<unknown>(
    (value, source) => object(source.parsed.skills).max_context_tokens ?? value,
    undefined
  );
  const skillBudgetTokens =
    harness === "codex"
      ? typeof configuredBudget === "number" && configuredBudget >= 0
        ? Math.min(10_000, Math.floor(configuredBudget))
        : Math.min(10_000, Math.floor(args.contextTokens * 0.02))
      : Math.floor(args.contextTokens * 0.01);
  const skillListing = Math.min(skillListingBeforeBudget, skillBudgetTokens);
  const mcpNamesAndInstructions = active
    .filter((item) => item.kind === "mcp")
    .reduce((sum, item) => sum + (item.alwaysTokens ?? 0), 0);
  const unmeasuredMcpServers = active.filter(
    (item) => item.kind === "mcp" && item.alwaysTokens === null
  ).length;
  warnings.push(
    "Offline candidates only: runtime trust, session overrides, remote apps/connectors and MCP catalogs are not probed. Native tools and instruction documents are outside these totals."
  );
  warnings.push(
    "Codex admin skills under /etc/codex/skills, managed enterprise skills/settings, and external session configuration are not inspected."
  );
  warnings.push(
    "Skill budgets are modeled caps, not a reconstruction of the harness prompt or its overflow ordering. Context size is an input assumption; chars/4 is not a tokenizer."
  );
  return {
    harness,
    account,
    resources: resources.map(
      ({
        rank: _rank,
        listing: _listing,
        identity: _identity,
        manualOnly: _manualOnly,
        pluginName: _pluginName,
        ...item
      }) => item
    ),
    tokens: {
      method:
        "estimate: ceil(chars/4); skill name + description (+ path for Codex); Claude description capped at 1536 chars; Codex modeled 2%/10000 cap, Claude ~1% cap",
      contextTokens: args.contextTokens,
      skillBudgetTokens,
      skillListingBeforeBudget,
      skillListing,
      mcpNamesAndInstructions,
      alwaysMeasured: skillListing + mcpNamesAndInstructions,
      deferredMeasured: active.reduce(
        (sum, item) => sum + (item.deferredTokens ?? 0),
        0
      ),
      unmeasuredMcpServers,
      completeness: "partial",
    },
    warnings,
  };
}
function resolveCandidates(resources: Candidate[]): void {
  const groups = new Map<string, Candidate[]>();
  for (const item of resources) {
    const key = `${item.kind}:${item.name}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const native = group
      .filter((item) => item.use !== "canonical-only")
      .sort((a, b) => b.rank - a.rank);
    const winner = native[0];
    for (const item of group) {
      item.duplicates = group
        .filter((other) => other !== item)
        .map((other) => other.definedAt);
      if (
        item.use === "canonical-only" &&
        group.some(
          (other) =>
            other !== item && other.identity && other.identity === item.identity
        )
      ) {
        item.reason =
          "Canonical source also visible through a native skill path";
      }
      if (item.kind === "skill" && item.harness === "codex") {
        if (item.use === "effective") {
          item.reason =
            "Codex retains same-name skill candidates; no name-based shadowing assumed";
        }
        continue;
      }
      if (
        item !== winner &&
        (item.use === "effective" || item.use === "unknown")
      ) {
        item.use = "shadowed";
        item.reason = `Higher-precedence definition: ${winner?.definedAt}`;
      }
    }
  }
  resources.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name) ||
      b.rank - a.rank
  );
}
async function plugins(args: {
  harness: Harness;
  cwd: string;
  policy: ReadPolicy;
  account: string;
  settingSources: {
    parsed: ObjectValue;
    path: string;
    layer: Layer;
    rank: number;
  }[];
  resources: Candidate[];
  warnings: string[];
  addSkills: (
    root: string,
    layer: Layer,
    rank: number,
    canonical?: boolean
  ) => Promise<void>;
  addConfig: (
    path: string,
    layer: Layer,
    rank: number,
    canonical?: boolean
  ) => Promise<ObjectValue>;
}): Promise<void> {
  const declarations = new Map<string, Candidate[]>();
  for (const source of args.settingSources) {
    const values =
      args.harness === "claude"
        ? object(source.parsed.enabledPlugins)
        : object(source.parsed.plugins);
    for (const [name, value] of Object.entries(values)) {
      const item = candidate({
        name,
        kind: "plugin",
        layer: source.layer,
        path: source.path,
        harness: args.harness,
        account: args.account,
        rank: source.rank,
      });
      const enabled =
        typeof value === "boolean" ? value : object(value).enabled;
      item.use =
        enabled === true
          ? "effective"
          : enabled === false
            ? "disabled"
            : "unknown";
      item.reason = "Plugin declaration in native configuration";
      const group = declarations.get(name) ?? [];
      group.push(item);
      declarations.set(name, group);
      args.resources.push(item);
    }
  }
  const registryPath = join(args.account, "plugins", "installed_plugins.json");
  const registry = object(
    (await config(registryPath, args.warnings, args.policy)).plugins
  );
  for (const name of new Set([
    ...Object.keys(registry),
    ...declarations.keys(),
  ])) {
    const group = declarations.get(name) ?? [];
    const item =
      [...group].sort((a, b) => b.rank - a.rank)[0] ??
      candidate({
        name,
        kind: "plugin",
        layer: "account",
        path: registryPath,
        harness: args.harness,
        account: args.account,
        rank: 10,
      });
    if (!group.length) {
      item.use = "unknown";
      item.reason = "Installed plugin; enablement not established";
      args.resources.push(item);
    }
    if (item.use !== "effective") {
      continue;
    }
    let installations: unknown[] = Array.isArray(registry[name])
      ? registry[name]
      : [];
    if (args.harness === "claude") {
      installations = installations.filter((entry) => {
        const value = object(entry);
        return (
          value.scope === undefined ||
          value.scope === "user" ||
          ((value.scope === "project" || value.scope === "local") &&
            value.projectPath === args.cwd)
        );
      });
      const priority = (entry: unknown) =>
        object(entry).scope === "local"
          ? 3
          : object(entry).scope === "project"
            ? 2
            : 1;
      const highest = Math.max(...installations.map(priority));
      installations = installations.filter(
        (entry) => priority(entry) === highest
      );
    }
    if (args.harness === "codex" && installations.length === 0) {
      const [plugin, market, ...extra] = name.split("@");
      if (
        plugin &&
        market &&
        !extra.length &&
        ![plugin, market].some(
          (part) => part.includes("/") || part.includes("\\") || part === ".."
        )
      ) {
        const root = join(args.account, "plugins", "cache", market, plugin);
        installations = (await entries(root, args.policy)).map((version) => ({
          installPath: join(root, version),
        }));
      }
    }
    if (installations.length !== 1) {
      item.use = "unknown";
      item.reason = "Plugin installation cannot be uniquely resolved offline";
      continue;
    }
    const path = object(installations[0]).installPath;
    if (typeof path !== "string") {
      item.use = "unknown";
      continue;
    }
    // Only inspect an installed tree inside this account's plugin cache.
    if (
      !(await readable(join(args.account, "plugins", "cache"), args.policy))
    ) {
      item.use = "unknown";
      continue;
    }
    const cache = `${await fs.realpath(join(args.account, "plugins", "cache")).catch(() => resolve(args.account, "plugins", "cache"))}${sep}`;
    let actual: string;
    try {
      if (!(await readable(path, args.policy))) {
        item.use = "unknown";
        continue;
      }
      actual = await fs.realpath(path);
    } catch {
      item.use = "unknown";
      continue;
    }
    if (!actual.startsWith(cache)) {
      item.use = "unknown";
      item.reason = "Plugin path outside account cache; not inspected";
      continue;
    }
    const start = args.resources.length;
    await args.addSkills(join(actual, "skills"), item.layer, -10);
    await args.addConfig(join(actual, ".mcp.json"), item.layer, -10);
    for (const child of args.resources.slice(start)) {
      child.pluginName = name;
      child.name = `${args.harness === "claude" && child.kind === "mcp" ? "plugin:" : ""}${name.split("@")[0]}:${child.name}`;
      if (child.listing) {
        child.listing = `${name.split("@")[0]}:${child.listing}`;
        child.alwaysTokens = estimate(child.listing);
      }
      child.reason = `Provided by plugin ${name}; runtime loading not probed`;
    }
  }
}
export async function buildHarnessInventory(options: Options = {}) {
  const home = resolve(options.homeDir ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const contextTokens = options.contextTokens ?? 200_000;
  const policy: ReadPolicy = {
    includeLn: options.includeLn ?? false,
    skippedLn: false,
    isolatedRoots: new Set(),
  };
  const sessions: HarnessSessionInventory[] = [];
  const warnings: string[] = [];
  const harnesses = options.harnesses ?? (["codex", "claude"] as Harness[]);
  const explicitHomes = options.homes?.map((path) => resolve(path)) ?? [];
  const environmentHomes =
    home === homedir()
      ? [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR]
          .filter((path): path is string => !!path)
          .map((path) => resolve(path))
      : [];
  // Every boundary must exist before resource inspection begins, including homes
  // for the other harness and homes that appear later in an explicit list.
  const boundaries = new Set([...explicitHomes, ...environmentHomes]);
  for (const account of boundaries) {
    registerIsolatedHome(account, policy);
  }
  const accounts: { harness: Harness; account: string }[] = [];
  for (const harness of ["codex", "claude"] as Harness[]) {
    const discovered = explicitHomes.length
      ? explicitHomes
      : await accountHomes(home, harness, policy);
    for (const account of discovered) {
      boundaries.add(account);
      registerIsolatedHome(account, policy);
      if (harnesses.includes(harness)) {
        accounts.push({ harness, account });
      }
    }
  }
  // Preflight aliases as well as literal names; no session may run until this
  // pass has registered the targets of every candidate account alias.
  for (const account of boundaries) {
    await readable(account, policy, 0, true);
  }
  for (const { harness, account } of accounts) {
    if (!(await readable(account, policy, 0, true))) {
      continue;
    }
    sessions.push(
      await session({ harness, account, home, cwd, contextTokens, policy })
    );
  }
  if (policy.skippedLn) {
    warnings.push("skipped: ln-isolated");
  }
  return { version: 1, reportOnly: true, cwd, warnings, sessions };
}
export async function harnessInventoryCommand(argv: string[]): Promise<void> {
  const harnesses: Harness[] = [];
  const homes: string[] = [];
  let contextTokens: number | undefined;
  let json = false;
  let includeLn = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--include-ln") {
      includeLn = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--harness" && (value === "codex" || value === "claude")) {
      harnesses.push(value);
    } else if (arg === "--home") {
      homes.push(value);
    } else if (
      arg === "--context-tokens" &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) > 0
    ) {
      contextTokens = Number(value);
    } else {
      throw new Error(`Invalid inventory option: ${arg}`);
    }
    index++;
  }
  if (homes.length && new Set(harnesses).size !== 1) {
    throw new Error("--home requires exactly one harness");
  }
  const report = await buildHarnessInventory({
    harnesses: [...new Set(harnesses)],
    homes,
    contextTokens,
    includeLn,
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const warning of report.warnings) {
    console.log(`Note: ${warning}`);
  }
  for (const entry of report.sessions) {
    console.log(`\n${entry.harness} account ${entry.account}`);
    console.log("KIND\tNAME\tLAYER\tUSE\tALWAYS~\tDEFERRED~\tDEFINED AT");
    for (const item of entry.resources) {
      console.log(
        [
          item.kind,
          item.name,
          item.layer,
          item.use,
          item.alwaysTokens ?? "not measured",
          item.deferredTokens ?? "not measured",
          item.definedAt,
        ].join("\t")
      );
    }
    console.log(
      `Estimated measured tokens: always ${entry.tokens.alwaysMeasured}; deferred ${entry.tokens.deferredMeasured}; MCP servers not measured ${entry.tokens.unmeasuredMcpServers}`
    );
    console.log(entry.tokens.method);
    for (const warning of entry.warnings) {
      console.log(`Note: ${warning}`);
    }
  }
}
