import type {
  IndexSource,
  LoadManifestHints,
  RemoteIndexManifest,
  RemoteMcpItem,
  RemoteSkillItem,
} from "./remote-types";

const TRAILING_SLASH_RE = /\/+$/;
const LEADING_AT_RE = /^@/;
const GITHUB_SOURCE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/#?]+)(?:\/(.*))?)?/i;
const REPO_DOT_GIT_SUFFIX_RE = /\.git$/i;
const LEADING_SLASH_RE = /^\/+/;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILLS_SH_ENTRY_RE =
  /"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]+)"(?:,"description":"([^"]*)")?/g;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function trimTrailingSlash(v: string): string {
  return v.replace(TRAILING_SLASH_RE, "");
}

function buildUrl(base: string, path: string): string {
  const normalizedBase = trimTrailingSlash(base);
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function encodeRefPath(ref: string): string {
  return ref
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function normalizedItemRef(raw: string): string {
  return raw.trim().replace(LEADING_AT_RE, "");
}

function mcpNameFromRef(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  if (!parts.length) {
    return ref;
  }
  return parts.at(-1) ?? ref;
}

function schemaRequiredEnv(
  rawSchema: unknown
): Record<string, string> | undefined {
  if (!isPlainObject(rawSchema)) {
    return undefined;
  }
  const schema = rawSchema as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
  if (!required.length) {
    return undefined;
  }
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const name of uniqueSorted(required)) {
    const prop = properties[name];
    if (
      isPlainObject(prop) &&
      typeof (prop as Record<string, unknown>).default === "string"
    ) {
      const defaultValue = (prop as Record<string, unknown>).default as string;
      env[name] = defaultValue;
      continue;
    }
    env[name] = "<set-me>";
  }
  return Object.keys(env).length ? env : undefined;
}

function buildPlaceholderMcpDefinition(
  env?: Record<string, string>
): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    transport: "stdio",
    command: "<set-command>",
    args: ["<set-args>"],
  };
  if (env && Object.keys(env).length) {
    definition.env = env;
  }
  return definition;
}

function smitherySearchItemToRemoteItem(raw: unknown): RemoteMcpItem | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const qualifiedNameRaw =
    typeof obj.qualifiedName === "string" ? obj.qualifiedName : "";
  const id = normalizedItemRef(qualifiedNameRaw);
  if (!id) {
    return null;
  }
  const title =
    typeof obj.displayName === "string" ? obj.displayName : mcpNameFromRef(id);
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const sourceUrl = typeof obj.homepage === "string" ? obj.homepage : undefined;
  const tags = uniqueSorted(
    [
      "mcp",
      "smithery",
      obj.verified === true ? "verified" : "",
      obj.remote === true ? "remote-capable" : "",
    ].filter(Boolean)
  );
  return {
    id,
    type: "mcp",
    title,
    description,
    sourceUrl,
    tags,
    mcp: {
      name: mcpNameFromRef(id),
      definition: buildPlaceholderMcpDefinition(),
    },
  };
}

function smitheryDetailToRemoteItem(
  raw: unknown,
  itemIdHint?: string
): RemoteMcpItem | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const qualifiedNameRaw =
    typeof obj.qualifiedName === "string" ? obj.qualifiedName : "";
  const id = normalizedItemRef(qualifiedNameRaw || itemIdHint || "");
  if (!id) {
    return null;
  }

  const tags = uniqueSorted(
    [
      "mcp",
      "smithery",
      obj.remote === true ? "remote-capable" : "",
      Array.isArray(obj.tools) ? "has-tools" : "",
    ].filter(Boolean)
  );

  const connections = Array.isArray(obj.connections) ? obj.connections : [];
  let deploymentUrl =
    typeof obj.deploymentUrl === "string" ? obj.deploymentUrl.trim() : "";
  let envSchema: unknown;
  for (const conn of connections) {
    if (!isPlainObject(conn)) {
      continue;
    }
    const connType = typeof conn.type === "string" ? conn.type : "";
    const connDeploymentUrl =
      typeof conn.deploymentUrl === "string" ? conn.deploymentUrl : "";
    if (!deploymentUrl && connDeploymentUrl) {
      deploymentUrl = connDeploymentUrl;
    }
    if (!envSchema && connType === "http") {
      envSchema = conn.configSchema;
    }
  }
  const requiredEnv = schemaRequiredEnv(envSchema);

  let definition: Record<string, unknown> =
    buildPlaceholderMcpDefinition(requiredEnv);
  if (deploymentUrl) {
    const normalizedDeployment = trimTrailingSlash(deploymentUrl);
    const mcpUrl = normalizedDeployment.endsWith("/mcp")
      ? normalizedDeployment
      : `${normalizedDeployment}/mcp`;
    definition = {
      transport: "http",
      url: mcpUrl,
    };
    if (requiredEnv && Object.keys(requiredEnv).length) {
      definition.env = requiredEnv;
    }
  }

  const title =
    typeof obj.displayName === "string" ? obj.displayName : mcpNameFromRef(id);
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const sourceUrl = typeof obj.homepage === "string" ? obj.homepage : undefined;
  const version =
    typeof obj.version === "string"
      ? obj.version
      : typeof obj.updatedAt === "string"
        ? obj.updatedAt
        : undefined;

  return {
    id,
    type: "mcp",
    title,
    description,
    version,
    sourceUrl,
    tags,
    mcp: {
      name: mcpNameFromRef(id),
      definition,
    },
  };
}

async function loadSmitheryManifest(args: {
  source: IndexSource;
  fetchJson: (url: string) => Promise<unknown>;
  hints?: LoadManifestHints;
}): Promise<RemoteIndexManifest> {
  const baseManifest: RemoteIndexManifest = {
    name: args.source.name,
    url: args.source.url,
    items: [],
  };
  const itemId = args.hints?.itemId?.trim();
  if (itemId) {
    const detailUrl = buildUrl(
      args.source.url,
      `/servers/${encodeRefPath(normalizedItemRef(itemId))}`
    );
    const raw = await args.fetchJson(detailUrl);
    const item = smitheryDetailToRemoteItem(raw, itemId);
    if (!item) {
      return baseManifest;
    }
    return {
      ...baseManifest,
      items: [item],
    };
  }

  const q = args.hints?.query?.trim() ?? "";
  const searchUrl = new URL(buildUrl(args.source.url, "/servers"));
  searchUrl.searchParams.set("pageSize", "50");
  if (q) {
    searchUrl.searchParams.set("q", q);
  }

  const raw = await args.fetchJson(searchUrl.toString());
  if (!isPlainObject(raw)) {
    return baseManifest;
  }
  const obj = raw as Record<string, unknown>;
  const servers = Array.isArray(obj.servers) ? obj.servers : [];
  const items = servers
    .map(smitherySearchItemToRemoteItem)
    .filter((v): v is RemoteMcpItem => !!v);
  return {
    ...baseManifest,
    items,
  };
}

function glamaServerToRemoteItem(
  raw: unknown,
  itemIdHint?: string
): RemoteMcpItem | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const namespace =
    typeof obj.namespace === "string" ? obj.namespace.trim() : "";
  const slug = typeof obj.slug === "string" ? obj.slug.trim() : "";
  const fallbackId = typeof obj.id === "string" ? obj.id.trim() : "";
  const id =
    itemIdHint?.trim() ||
    (namespace && slug ? `${namespace}/${slug}` : fallbackId);
  if (!id) {
    return null;
  }

  const attributes = Array.isArray(obj.attributes)
    ? obj.attributes
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
  const tags = uniqueSorted(["mcp", "glama", ...attributes]);
  const requiredEnv = schemaRequiredEnv(obj.environmentVariablesJsonSchema);
  const definition = buildPlaceholderMcpDefinition(requiredEnv);
  const title = typeof obj.name === "string" ? obj.name : mcpNameFromRef(id);
  const description =
    typeof obj.description === "string" ? obj.description : undefined;

  let sourceUrl = typeof obj.url === "string" ? obj.url : undefined;
  if (!sourceUrl && isPlainObject(obj.repository)) {
    const repo = obj.repository as Record<string, unknown>;
    sourceUrl = typeof repo.url === "string" ? repo.url : undefined;
  }

  const version =
    typeof obj.version === "string"
      ? obj.version
      : typeof obj.updatedAt === "string"
        ? obj.updatedAt
        : undefined;

  return {
    id,
    type: "mcp",
    title,
    description,
    version,
    sourceUrl,
    tags,
    mcp: {
      name: mcpNameFromRef(id),
      definition,
    },
  };
}

async function loadGlamaManifest(args: {
  source: IndexSource;
  fetchJson: (url: string) => Promise<unknown>;
  hints?: LoadManifestHints;
}): Promise<RemoteIndexManifest> {
  const baseManifest: RemoteIndexManifest = {
    name: args.source.name,
    url: args.source.url,
    items: [],
  };
  const itemId = args.hints?.itemId?.trim();
  if (itemId) {
    const detailUrl = buildUrl(
      args.source.url,
      `/servers/${encodeRefPath(itemId)}`
    );
    const raw = await args.fetchJson(detailUrl);
    const item = glamaServerToRemoteItem(raw, itemId);
    if (!item) {
      return baseManifest;
    }
    return {
      ...baseManifest,
      items: [item],
    };
  }

  const q = args.hints?.query?.trim() ?? "";
  const searchUrl = new URL(buildUrl(args.source.url, "/servers"));
  searchUrl.searchParams.set("first", "50");
  if (q) {
    searchUrl.searchParams.set("search", q);
  }
  const raw = await args.fetchJson(searchUrl.toString());
  if (!isPlainObject(raw)) {
    return baseManifest;
  }
  const obj = raw as Record<string, unknown>;
  const servers = Array.isArray(obj.servers) ? obj.servers : [];
  const items = servers
    .map((server) => glamaServerToRemoteItem(server))
    .filter((v): v is RemoteMcpItem => !!v);
  return {
    ...baseManifest,
    items,
  };
}

interface SkillsShEntry {
  id: string;
  title: string;
  description?: string;
  sourceUrl?: string;
}

function decodeJsonStringLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function skillNameFromId(id: string): string {
  const base = id.split("/").filter(Boolean).at(-1) ?? id;
  return base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseSkillsShEntries(html: string): SkillsShEntry[] {
  const normalizedHtml = html.replaceAll('\\"', '"').replaceAll("\\/", "/");
  const out: SkillsShEntry[] = [];
  for (const match of normalizedHtml.matchAll(SKILLS_SH_ENTRY_RE)) {
    const rawSource = match[1] ?? "";
    const rawSkillId = match[2] ?? "";
    const rawName = match[3] ?? "";
    const rawDescription = match[4] ?? "";

    const sourceUrl = decodeJsonStringLiteral(rawSource).trim();
    const skillId = decodeJsonStringLiteral(rawSkillId).trim();
    const name = decodeJsonStringLiteral(rawName).trim();
    const description = decodeJsonStringLiteral(rawDescription).trim();

    const id = normalizedItemRef(skillId || sourceUrl);
    if (!id) {
      continue;
    }
    out.push({
      id,
      title: name || skillNameFromId(id),
      description: description || undefined,
      sourceUrl: sourceUrl || undefined,
    });
  }

  const dedup = new Map<string, SkillsShEntry>();
  for (const entry of out) {
    dedup.set(entry.id, entry);
  }
  return Array.from(dedup.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function githubSourceParts(sourceUrl: string): {
  owner: string;
  repo: string;
  branch?: string;
  pathPrefix?: string;
} | null {
  const m = sourceUrl.match(GITHUB_SOURCE_RE);
  if (!m) {
    return null;
  }
  const owner = m[1]?.trim();
  const repo = (m[2] ?? "").trim().replace(REPO_DOT_GIT_SUFFIX_RE, "");
  const branch = m[3]?.trim() || undefined;
  const pathPrefix = m[4]?.trim().replace(LEADING_SLASH_RE, "") || undefined;
  if (!(owner && repo)) {
    return null;
  }
  return { owner, repo, branch, pathPrefix };
}

function buildSkillsShRawCandidates(entry: SkillsShEntry): string[] {
  const urls: string[] = [];
  if (
    entry.sourceUrl &&
    entry.sourceUrl.includes("raw.githubusercontent.com") &&
    entry.sourceUrl.endsWith(".md")
  ) {
    urls.push(entry.sourceUrl);
  }

  if (entry.sourceUrl) {
    const gh = githubSourceParts(entry.sourceUrl);
    if (gh) {
      const path = gh.pathPrefix ? `${gh.pathPrefix}/SKILL.md` : "SKILL.md";
      if (gh.branch) {
        urls.push(
          `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${path}`
        );
      }
      urls.push(
        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/main/${path}`
      );
      urls.push(
        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/master/${path}`
      );
    }
  }

  const idMatch = entry.id.match(OWNER_REPO_RE);
  if (idMatch) {
    const [owner = "", repo = ""] = entry.id.split("/", 2);
    if (!(owner && repo)) {
      return uniqueSorted(urls);
    }
    urls.push(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`
    );
    urls.push(
      `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`
    );
  }

  return uniqueSorted(urls);
}

function skillItemFromEntry(args: {
  entry: SkillsShEntry;
  content?: string;
}): RemoteSkillItem {
  const skillName = skillNameFromId(args.entry.id) || "skill";
  const tags = uniqueSorted(["skill", "skills.sh"]);
  const content =
    args.content?.trim() ||
    `# ${args.entry.title || "{{name}}"}\n\n${
      args.entry.description ?? "Imported from skills.sh."
    }\n`;
  return {
    id: args.entry.id,
    type: "skill",
    title: args.entry.title,
    description: args.entry.description,
    sourceUrl: args.entry.sourceUrl,
    tags,
    skill: {
      name: skillName,
      files: {
        "SKILL.md": content,
      },
    },
  };
}

async function loadSkillsShManifest(args: {
  source: IndexSource;
  fetchText: (url: string) => Promise<string>;
  hints?: LoadManifestHints;
}): Promise<RemoteIndexManifest> {
  const baseManifest: RemoteIndexManifest = {
    name: args.source.name,
    url: args.source.url,
    items: [],
  };

  const itemId = args.hints?.itemId?.trim();
  const q = (itemId || args.hints?.query || "").trim();
  const searchUrl = new URL(buildUrl(args.source.url, "/"));
  if (q) {
    searchUrl.searchParams.set("q", q);
  }
  const html = await args.fetchText(searchUrl.toString());
  const entries = parseSkillsShEntries(html);

  if (itemId) {
    const targetId = normalizedItemRef(itemId);
    const matched =
      entries.find((entry) => entry.id === targetId) ??
      entries.find((entry) => entry.id.includes(targetId)) ??
      (() => {
        const fallback: SkillsShEntry = {
          id: targetId,
          title: skillNameFromId(targetId) || targetId,
          sourceUrl: targetId.match(OWNER_REPO_RE)
            ? `https://github.com/${targetId}`
            : undefined,
        };
        return fallback;
      })();

    let content: string | undefined;
    for (const candidate of buildSkillsShRawCandidates(matched)) {
      try {
        const txt = await args.fetchText(candidate);
        if (txt.trim()) {
          content = txt;
          break;
        }
      } catch {
        // Try next source candidate.
      }
    }

    return {
      ...baseManifest,
      items: [skillItemFromEntry({ entry: matched, content })],
    };
  }

  return {
    ...baseManifest,
    items: entries.map((entry) => skillItemFromEntry({ entry })),
  };
}

function clawhubVersionValue(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.version === "string" && raw.version.trim()) {
    return raw.version.trim();
  }
  const latest = raw.latestVersion;
  if (typeof latest === "string" && latest.trim()) {
    return latest.trim();
  }
  if (isPlainObject(latest)) {
    const latestObj = latest as Record<string, unknown>;
    if (typeof latestObj.version === "string" && latestObj.version.trim()) {
      return latestObj.version.trim();
    }
    if (typeof latestObj.id === "string" && latestObj.id.trim()) {
      return latestObj.id.trim();
    }
  }
  return undefined;
}

function clawhubEntryToRemoteSkillItem(
  raw: unknown,
  itemIdHint?: string
): RemoteSkillItem | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const slug = typeof obj.slug === "string" ? obj.slug.trim() : "";
  const id = normalizedItemRef(itemIdHint || slug);
  if (!id) {
    return null;
  }

  const title =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name
      : skillNameFromId(id);
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const sourceUrl =
    typeof obj.sourceUrl === "string"
      ? obj.sourceUrl
      : typeof obj.repositoryUrl === "string"
        ? obj.repositoryUrl
        : undefined;
  const categories = Array.isArray(obj.categories)
    ? obj.categories
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    : [];

  return {
    id,
    type: "skill",
    title,
    description,
    version: clawhubVersionValue(obj),
    sourceUrl,
    tags: uniqueSorted(["skill", "clawhub", ...categories]),
    skill: {
      name: skillNameFromId(id) || id,
      files: {
        "SKILL.md": "# {{name}}\n",
      },
    },
  };
}

function extractClawhubFilePaths(raw: unknown): string[] {
  if (!isPlainObject(raw)) {
    return [];
  }
  const obj = raw as Record<string, unknown>;
  const candidates: unknown[] = [];
  candidates.push(obj.files);
  candidates.push(obj.filePaths);
  candidates.push(obj.paths);

  const out: string[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const entry of candidate) {
      if (typeof entry === "string") {
        out.push(entry);
        continue;
      }
      if (isPlainObject(entry)) {
        const path =
          typeof entry.path === "string"
            ? entry.path
            : typeof entry.filePath === "string"
              ? entry.filePath
              : "";
        if (path) {
          out.push(path);
        }
      }
    }
  }

  return uniqueSorted(
    out
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => path.replace(LEADING_SLASH_RE, ""))
  );
}

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || relPath.includes("\0")) {
    return false;
  }
  const normalized = relPath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    return false;
  }
  if (parts.includes(".") || parts.includes("..")) {
    return false;
  }
  return true;
}

async function loadClawhubManifest(args: {
  source: IndexSource;
  fetchJson: (url: string) => Promise<unknown>;
  fetchText: (url: string) => Promise<string>;
  hints?: LoadManifestHints;
}): Promise<RemoteIndexManifest> {
  const baseManifest: RemoteIndexManifest = {
    name: args.source.name,
    url: args.source.url,
    items: [],
  };
  const itemId = args.hints?.itemId?.trim();
  if (itemId) {
    const detailUrl = buildUrl(
      args.source.url,
      `/skills/${encodeURIComponent(normalizedItemRef(itemId))}`
    );
    const detailRaw = await args.fetchJson(detailUrl);
    const detailItem = clawhubEntryToRemoteSkillItem(detailRaw, itemId);
    if (!detailItem) {
      return baseManifest;
    }

    const detailObj = isPlainObject(detailRaw)
      ? (detailRaw as Record<string, unknown>)
      : {};
    const version = detailItem.version;
    const fallbackPaths = ["SKILL.md"];
    let filePaths = fallbackPaths;
    if (version) {
      try {
        const versionUrl = buildUrl(
          args.source.url,
          `/skills/${encodeURIComponent(detailItem.id)}/versions/${encodeURIComponent(version)}`
        );
        const versionRaw = await args.fetchJson(versionUrl);
        const extracted = extractClawhubFilePaths(versionRaw);
        if (extracted.length) {
          filePaths = extracted;
        }
      } catch {
        // Keep fallback file list.
      }
    } else {
      const extracted = extractClawhubFilePaths(detailObj);
      if (extracted.length) {
        filePaths = extracted;
      }
    }

    const files: Record<string, string> = {};
    for (const path of filePaths) {
      if (!isSafeRelativePath(path)) {
        continue;
      }
      const fileUrl = new URL(
        buildUrl(
          args.source.url,
          `/skills/${encodeURIComponent(detailItem.id)}/file`
        )
      );
      fileUrl.searchParams.set("path", path);
      if (version) {
        fileUrl.searchParams.set("version", version);
      }
      try {
        const text = await args.fetchText(fileUrl.toString());
        if (text.trim()) {
          files[path] = text;
        }
      } catch {
        try {
          const raw = await args.fetchJson(fileUrl.toString());
          if (typeof raw === "string" && raw.trim()) {
            files[path] = raw;
            continue;
          }
          if (isPlainObject(raw)) {
            const obj = raw as Record<string, unknown>;
            const content =
              typeof obj.content === "string"
                ? obj.content
                : typeof obj.text === "string"
                  ? obj.text
                  : "";
            if (content.trim()) {
              files[path] = content;
            }
          }
        } catch {
          // Ignore missing file and continue.
        }
      }
    }

    if (!Object.keys(files).length) {
      files["SKILL.md"] = `# ${detailItem.title ?? "{{name}}"}\n`;
    }

    return {
      ...baseManifest,
      items: [
        {
          ...detailItem,
          skill: {
            name: detailItem.skill.name,
            files,
          },
        },
      ],
    };
  }

  const q = args.hints?.query?.trim() ?? "";
  const searchUrl = new URL(buildUrl(args.source.url, "/skills"));
  searchUrl.searchParams.set("limit", "50");
  if (q) {
    searchUrl.searchParams.set("query", q);
    searchUrl.searchParams.set("q", q);
  }
  const raw = await args.fetchJson(searchUrl.toString());
  const list = Array.isArray(raw)
    ? raw
    : isPlainObject(raw)
      ? Array.isArray((raw as Record<string, unknown>).items)
        ? ((raw as Record<string, unknown>).items as unknown[])
        : Array.isArray((raw as Record<string, unknown>).skills)
          ? ((raw as Record<string, unknown>).skills as unknown[])
          : []
      : [];

  const items = list
    .map((entry) => clawhubEntryToRemoteSkillItem(entry))
    .filter((v): v is RemoteSkillItem => !!v);
  return {
    ...baseManifest,
    items,
  };
}

export async function loadProviderManifest(args: {
  source: IndexSource;
  fetchJson: (url: string) => Promise<unknown>;
  fetchText: (url: string) => Promise<string>;
  hints?: LoadManifestHints;
}): Promise<RemoteIndexManifest> {
  if (args.source.kind === "smithery") {
    return await loadSmitheryManifest({
      source: args.source,
      fetchJson: args.fetchJson,
      hints: args.hints,
    });
  }
  if (args.source.kind === "glama") {
    return await loadGlamaManifest({
      source: args.source,
      fetchJson: args.fetchJson,
      hints: args.hints,
    });
  }
  if (args.source.kind === "skills-sh") {
    return await loadSkillsShManifest({
      source: args.source,
      fetchText: args.fetchText,
      hints: args.hints,
    });
  }
  if (args.source.kind === "clawhub") {
    return await loadClawhubManifest({
      source: args.source,
      fetchJson: args.fetchJson,
      fetchText: args.fetchText,
      hints: args.hints,
    });
  }

  throw new Error(`Unsupported provider source kind: ${args.source.kind}`);
}
