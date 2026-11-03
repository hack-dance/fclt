import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
}
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}
async function entries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory();
  } catch {
    return false;
  }
}
async function config(path: string, warnings: string[]): Promise<ObjectValue> {
  try {
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
async function accountHomes(home: string, harness: Harness): Promise<string[]> {
  const found = new Set<string>();
  for (const name of await entries(home)) {
    if (name.startsWith(`.${harness}`) && (await exists(join(home, name)))) {
      found.add(join(home, name));
    }
  }
  const accounts = join(home, ".local", "share", "agent-accounts");
  for (const name of await entries(accounts)) {
    const path = join(accounts, name, harness);
    if (await exists(path)) {
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
      identity = await realpath(root);
    } catch {
      return;
    }
    if (visited.has(identity)) {
      return;
    }
    visited.add(identity);
    const path = join(root, "SKILL.md");
    if (await Bun.file(path).exists()) {
      try {
        const text = (await Bun.file(path).text()).replaceAll("\r\n", "\n");
        const end = text.indexOf("\n---", 4);
        const metadata =
          text.startsWith("---\n") && end >= 0
            ? object(parseYaml(text.slice(4, end)))
            : {};
        if (typeof metadata.description !== "string") {
          args.warnings.push(`Skill lacks name/description: ${path}`);
          return;
        }
        const name =
          typeof metadata.name === "string" ? metadata.name : basename(root);
        const item = candidate({ ...args, name, kind: "skill", path });
        item.identity = join(identity, "SKILL.md");
        const description =
          args.harness === "claude"
            ? `${metadata.description}${typeof metadata.when_to_use === "string" ? ` ${metadata.when_to_use}` : ""}`.slice(
                0,
                1536
              )
            : metadata.description;
        item.listing = `${name}: ${description}\n`;
        item.alwaysTokens = estimate(item.listing);
        item.deferredTokens = estimate(text);
        if (
          metadata["disable-model-invocation"] === true &&
          args.harness === "claude"
        ) {
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
    for (const name of await entries(root)) {
      if (name === "node_modules" || name === ".git") {
        continue;
      }
      if (await exists(join(root, name))) {
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
async function session(args: {
  harness: Harness;
  account: string;
  home: string;
  cwd: string;
  contextTokens: number;
}): Promise<HarnessSessionInventory> {
  const { harness, account, home, cwd } = args;
  const warnings: string[] = [];
  const resources: Candidate[] = [];
  const native = `.${harness}`;
  const accountConfigPath = join(
    account,
    harness === "codex" ? "config.toml" : "settings.json"
  );
  const accountConfig = await config(accountConfigPath, warnings);
  const addSkills = async (
    root: string,
    layer: Layer,
    rank: number,
    canonical = false
  ) => {
    resources.push(
      ...(await skills({
        root,
        layer,
        rank,
        harness,
        account,
        canonical,
        warnings,
      }))
    );
  };
  const addConfig = async (
    path: string,
    layer: Layer,
    rank: number,
    canonical = false
  ) => {
    const parsed =
      path === accountConfigPath ? accountConfig : await config(path, warnings);
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
  await addSkills(join(account, "skills"), "account", 10);
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
    const userPath = (await Bun.file(internalPath).exists())
      ? internalPath
      : account === join(home, ".claude")
        ? join(home, ".claude.json")
        : `${account}.json`;
    const userConfig = await addConfig(userPath, "account", 11);
    const local = object(object(userConfig.projects)[cwd]);
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
  const ancestors: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (
      (await Bun.file(join(dir, ".git")).exists()) ||
      (await exists(join(dir, ".git"))) ||
      dirname(dir) === dir
    ) {
      break;
    }
  }
  for (const [index, dir] of ancestors.entries()) {
    const rank = 100 + index * 10;
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
          parsed: await config(path, warnings),
          path,
          layer: "project",
          rank: rank + (file.includes("local") ? 1 : 0),
        });
      }
    }
  }
  for (const dir of ancestors) {
    const instructionPath = join(dir, "AGENTS.md");
    if (!(await Bun.file(instructionPath).exists())) {
      continue;
    }
    const text = await Bun.file(instructionPath).text();
    for (const match of text.matchAll(/\]\(([^)\n]+\/SKILL\.md)\)/g)) {
      const target = match[1];
      if (!target || target.includes("://")) {
        continue;
      }
      const path = resolve(
        dir,
        target.startsWith("~/") ? join(home, target.slice(2)) : target
      );
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
      });
      for (const item of referenced) {
        item.use = "unknown";
        item.reason = `Referenced by ${instructionPath}; instruction references are not a native skill catalog`;
      }
      resources.push(...referenced);
    }
  }
  await addSkills(join(cwd, ".ai", "skills"), "project", 0, true);
  await addConfig(join(cwd, ".ai", "mcp", "servers.json"), "project", 0, true);
  await plugins({
    harness,
    account,
    settingSources,
    resources,
    warnings,
    addSkills,
    addConfig,
  });
  if (harness === "codex") {
    const skillSettings = object(accountConfig.skills);
    for (const rule of Array.isArray(skillSettings.config)
      ? skillSettings.config
      : []) {
      const entry = object(rule);
      if (entry.enabled !== false || typeof entry.path !== "string") {
        continue;
      }
      for (const item of resources) {
        if (
          item.kind === "skill" &&
          (dirname(item.definedAt) === resolve(account, entry.path) ||
            item.definedAt === resolve(account, entry.path))
        ) {
          item.use = "disabled";
          item.reason = "Disabled by skills.config";
        }
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
    for (const source of settingSources) {
      const overrides = object(source.parsed.skillOverrides);
      const disabledMcp = source.parsed.disabledMcpjsonServers;
      for (const item of resources) {
        if (item.kind === "skill" && item.use === "effective") {
          const mode = overrides[item.name];
          if (mode === "off") {
            item.use = "disabled";
            item.reason = "Disabled by skillOverrides";
          }
          if (mode === "name-only") {
            item.alwaysTokens = estimate(`${item.name}\n`);
          }
          if (mode === "user-invocable-only") {
            item.alwaysTokens = 0;
          }
        }
        if (
          item.kind === "mcp" &&
          basename(item.definedAt) === ".mcp.json" &&
          Array.isArray(disabledMcp) &&
          disabledMcp.includes(item.name)
        ) {
          item.use = "disabled";
          item.reason = "Disabled by disabledMcpjsonServers";
        }
      }
    }
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
  const configuredBudget = object(accountConfig.skills).max_context_tokens;
  const skillBudgetTokens =
    harness === "codex"
      ? typeof configuredBudget === "number" && configuredBudget >= 0
        ? configuredBudget
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
    "Skill budgets are modeled caps, not a reconstruction of the harness prompt or its overflow ordering. Context size is an input assumption; chars/4 is not a tokenizer."
  );
  return {
    harness,
    account,
    resources: resources.map(
      ({ rank: _rank, listing: _listing, identity: _identity, ...item }) => item
    ),
    tokens: {
      method:
        "estimate: ceil(chars/4); skill name + description; Claude description capped at 1536 chars; Codex 2%/10000 default cap, Claude ~1% cap",
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
      if (item !== winner && item.use === "effective") {
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
  const enabled = new Map<
    string,
    { enabled: boolean; path: string; layer: Layer; rank: number }
  >();
  for (const source of args.settingSources) {
    const values =
      args.harness === "claude"
        ? object(source.parsed.enabledPlugins)
        : object(source.parsed.plugins);
    for (const [name, value] of Object.entries(values)) {
      enabled.set(name, {
        enabled: value === true || object(value).enabled === true,
        path: source.path,
        layer: source.layer,
        rank: source.rank,
      });
    }
  }
  const registryPath = join(args.account, "plugins", "installed_plugins.json");
  const registry = object((await config(registryPath, args.warnings)).plugins);
  for (const name of new Set([...Object.keys(registry), ...enabled.keys()])) {
    const setting = enabled.get(name);
    const item = candidate({
      name,
      kind: "plugin",
      layer: setting?.layer ?? "account",
      path: setting?.path ?? registryPath,
      harness: args.harness,
      account: args.account,
      rank: setting?.rank ?? 10,
    });
    item.use = setting
      ? setting.enabled
        ? "effective"
        : "disabled"
      : "unknown";
    item.reason = setting
      ? "Plugin enablement from native configuration"
      : "Installed plugin; enablement not established";
    args.resources.push(item);
    if (item.use !== "effective") {
      continue;
    }
    let installations: unknown[] = Array.isArray(registry[name])
      ? registry[name]
      : [];
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
        installations = (await entries(root)).map((version) => ({
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
    const cache = `${await realpath(join(args.account, "plugins", "cache")).catch(() => resolve(args.account, "plugins", "cache"))}${sep}`;
    let actual: string;
    try {
      actual = await realpath(path);
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
      child.name = `${name.split("@")[0]}:${child.name}`;
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
  const sessions: HarnessSessionInventory[] = [];
  for (const harness of options.harnesses ??
    (["codex", "claude"] as Harness[])) {
    for (const account of options.homes?.length
      ? options.homes.map((path) => resolve(path))
      : await accountHomes(home, harness)) {
      sessions.push(
        await session({ harness, account, home, cwd, contextTokens })
      );
    }
  }
  return { version: 1, reportOnly: true, cwd, sessions };
}
export async function harnessInventoryCommand(argv: string[]): Promise<void> {
  const harnesses: Harness[] = [];
  const homes: string[] = [];
  let contextTokens: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
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
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
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
