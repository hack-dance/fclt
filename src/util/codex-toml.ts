const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const DOUBLE_QUOTED_KEY_RE = /^"([^"]+)"(.*)$/;
const SINGLE_QUOTED_KEY_RE = /^'([^']+)'(.*)$/;

const SECRETY_STRING_RE =
  /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)/i;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseCodexMcpServerNameFromSection(section: string): string | null {
  const prefix = "mcp_servers.";
  if (!section.startsWith(prefix)) {
    return null;
  }
  const rest = section.slice(prefix.length).trim();
  if (!rest) {
    return null;
  }

  // Quoted key: mcp_servers."Sequential_Thinking"
  if (rest.startsWith('"')) {
    const m = DOUBLE_QUOTED_KEY_RE.exec(rest);
    if (!m) {
      return null;
    }
    return m[1] || null;
  }

  // Single-quoted keys are unusual in TOML, but handle best-effort.
  if (rest.startsWith("'")) {
    const m = SINGLE_QUOTED_KEY_RE.exec(rest);
    if (!m) {
      return null;
    }
    return m[1] || null;
  }

  // Unquoted: mcp_servers.github.env -> github
  const first = rest.split(".")[0];
  return first || null;
}

export function extractCodexTomlMcpServerBlocks(
  text: string
): Record<string, string> {
  const lines = normalizeNewlines(text).split("\n");
  const out = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      const section = m[1] ?? "";
      const server = parseCodexMcpServerNameFromSection(section);
      if (server) {
        current = server;
        const arr = out.get(server) ?? [];
        arr.push(line);
        out.set(server, arr);
      } else {
        current = null;
      }
      continue;
    }

    if (current) {
      const arr = out.get(current) ?? [];
      arr.push(line);
      out.set(current, arr);
    }
  }

  const obj: Record<string, string> = {};
  for (const [name, lines] of out.entries()) {
    obj[name] = `${lines.join("\n")}\n`;
  }
  return obj;
}

export function extractCodexTomlMcpServerNames(text: string): string[] {
  return Object.keys(extractCodexTomlMcpServerBlocks(text)).sort();
}

export function sanitizeCodexTomlMcpText(text: string): string {
  const normalized = normalizeNewlines(text);

  // 1) Redact obvious token formats.
  let out = normalized.replace(SECRETY_STRING_RE, "<redacted>");

  // 2) Redact TOML assignments for secret-ish keys: FOO_TOKEN = "..."
  out = out.replace(
    /^(\s*[A-Za-z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)[A-Za-z0-9_]*\s*=\s*).+$/gim,
    '$1"<redacted>"'
  );

  // 3) Redact inline env assignments embedded in strings: API_KEY="..."
  out = out.replace(
    /\b([A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)[A-Z0-9_]*)="[^"]*"/gi,
    '$1="<redacted>"'
  );

  // 4) As a last pass, redact any remaining long quoted values for secret-ish keys
  // inside nested tables (best-effort).
  out = out.replace(
    /^(\s*[A-Za-z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|BEARER)[A-Za-z0-9_]*\s*=\s*)'.*'$/gim,
    "$1'<redacted>'"
  );

  return out;
}

export function sanitizeCodexTomlForAudit(value: unknown): unknown {
  // Keep this file focused; callers can use sanitizeCodexTomlMcpText() on strings.
  if (typeof value === "string") {
    // Avoid leaking token-like substrings when embedding in other payloads.
    const redacted = value.replace(SECRETY_STRING_RE, "<redacted>");
    if (SECRET_KEY_RE.test(value)) {
      return "<redacted>";
    }
    return redacted;
  }
  return value;
}
