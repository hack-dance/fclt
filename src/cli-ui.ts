const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
const NEWLINE_SPLIT_RE = /\n+/;
const WHITESPACE_SPLIT_RE = /\s+/;
const DEFAULT_CONTENT_WIDTH = 92;
const MIN_CONTENT_WIDTH = 64;
const MAX_CONTENT_WIDTH = 108;
const TABLE_MIN_COLUMN_WIDTH = 12;
const TABLE_GAP = 2;

type Tone = "accent" | "muted" | "success" | "warn" | "danger";

export interface PageSection {
  title: string;
  lines: string[];
}

export interface RenderPageOptions {
  title: string;
  subtitle?: string;
  sections: PageSection[];
  footer?: string[];
}

export interface RenderTableOptions {
  headers: string[];
  rows: string[][];
}

export interface RenderCatalogItem {
  title: string;
  meta?: string;
  badges?: string[];
  description?: string;
  details?: string[];
}

function supportsColor(): boolean {
  return (
    process.stdout.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.CLICOLOR !== "0"
  );
}

function colorize(text: string, tone: Tone, bold = false): string {
  if (!supportsColor()) {
    return text;
  }

  const code =
    tone === "accent"
      ? "36"
      : tone === "muted"
        ? "2"
        : tone === "success"
          ? "32"
          : tone === "warn"
            ? "33"
            : "31";

  const prefix = bold ? `1;${code}` : code;
  return `\u001B[${prefix}m${text}\u001B[0m`;
}

function visibleWidth(value: string): number {
  return value.replace(ANSI_RE, "").length;
}

function containsAnsi(value: string): boolean {
  return value.replace(ANSI_RE, "") !== value;
}

function contentWidth(): number {
  const terminalWidth = process.stdout.columns ?? DEFAULT_CONTENT_WIDTH;
  return Math.max(
    MIN_CONTENT_WIDTH,
    Math.min(MAX_CONTENT_WIDTH, terminalWidth - 2)
  );
}

function padVisible(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function clampColumnWidths(headers: string[], rows: string[][]): number[] {
  const maxWidth = contentWidth();
  const widths = headers.map((header, index) =>
    Math.max(
      visibleWidth(header),
      ...rows.map((row) => visibleWidth(row[index] ?? ""))
    )
  );
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, headers.length - 1) * TABLE_GAP;

  if (totalWidth <= maxWidth || headers.length <= 1) {
    return widths;
  }

  const next = [...widths];
  const shrinkable = new Set(next.keys());

  while (
    next.reduce((sum, width) => sum + width, 0) +
      Math.max(0, headers.length - 1) * TABLE_GAP >
    maxWidth
  ) {
    let widestIndex = -1;
    let widestWidth = -1;

    for (const index of shrinkable) {
      if ((next[index] ?? 0) > widestWidth) {
        widestWidth = next[index] ?? 0;
        widestIndex = index;
      }
    }

    if (widestIndex < 0) {
      break;
    }

    const minWidth =
      widestIndex === 0 && headers.length === 2 ? 10 : TABLE_MIN_COLUMN_WIDTH;
    if ((next[widestIndex] ?? 0) <= minWidth) {
      shrinkable.delete(widestIndex);
      if (shrinkable.size === 0) {
        break;
      }
      continue;
    }

    next[widestIndex] = (next[widestIndex] ?? 0) - 1;
  }

  return next;
}

function wrapWord(word: string, width: number): string[] {
  if (width <= 0 || visibleWidth(word) <= width) {
    return [word];
  }

  const chunks: string[] = [];
  let chunk = "";
  for (const char of word) {
    if (visibleWidth(chunk + char) > width && chunk) {
      chunks.push(chunk);
      chunk = char;
      continue;
    }
    chunk += char;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}

function wrapPlainText(text: string, width: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [""];
  }

  if (width <= 0) {
    return [normalized];
  }

  const paragraphs = normalized.split(NEWLINE_SPLIT_RE);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(WHITESPACE_SPLIT_RE).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const segments = wrapWord(word, width);
      for (const segment of segments) {
        const candidate = line ? `${line} ${segment}` : segment;
        if (visibleWidth(candidate) > width && line) {
          lines.push(line);
          line = segment;
          continue;
        }
        line = candidate;
      }
    }

    if (line) {
      lines.push(line);
    }
  }

  return lines.length > 0 ? lines : [normalized];
}

function wrapPrefixedLine(
  prefix: string,
  text: string,
  width = contentWidth()
): string[] {
  if (containsAnsi(text)) {
    return [`${prefix}${text}`];
  }
  const bodyWidth = Math.max(12, width - visibleWidth(prefix));
  const wrapped = wrapPlainText(text, bodyWidth);
  return wrapped.map(
    (line, index) =>
      `${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`
  );
}

function renderSectionTitle(title: string): string[] {
  const dividerWidth = Math.max(8, Math.min(contentWidth(), title.length + 12));
  return [
    colorize(title, "accent", true),
    renderMuted("─".repeat(dividerWidth)),
  ];
}

export function renderCode(value: string): string {
  return colorize(value, "accent", true);
}

export function renderMuted(value: string): string {
  return colorize(value, "muted");
}

export function renderBadge(value: string, tone: Tone): string {
  return colorize(`[${value}]`, tone, true);
}

export function renderBullets(items: string[]): string[] {
  return items.flatMap((item) => wrapPrefixedLine("• ", item));
}

export function renderCatalog(items: RenderCatalogItem[]): string[] {
  const width = contentWidth();
  const lines: string[] = [];

  for (const [index, item] of items.entries()) {
    if (index > 0) {
      lines.push(renderMuted("─".repeat(Math.min(width, 32))));
    }

    const titleLine = colorize(item.title, "accent", true);
    if (item.meta) {
      const metaLine = renderMuted(item.meta);
      const combined = `${titleLine}  ${metaLine}`;
      if (visibleWidth(combined) <= width) {
        lines.push(combined);
      } else {
        lines.push(titleLine);
        lines.push(metaLine);
      }
    } else {
      lines.push(titleLine);
    }

    if (item.badges && item.badges.length > 0) {
      lines.push(item.badges.join(" "));
    }

    if (item.description) {
      lines.push(...wrapPlainText(item.description, width));
    }

    if (item.details) {
      for (const detail of item.details) {
        lines.push(...wrapPrefixedLine("  ", detail, width));
      }
    }
  }

  return lines;
}

export function renderKeyValue(
  rows: [label: string, value: string][]
): string[] {
  if (rows.length === 0) {
    return [];
  }

  const width = contentWidth();
  const labelWidth = Math.min(
    16,
    Math.max(...rows.map(([label]) => visibleWidth(label)), 0)
  );
  const valueWidth = Math.max(20, width - labelWidth - 3);
  const lines: string[] = [];

  for (const [label, value] of rows) {
    const wrapped = wrapPlainText(value, valueWidth);
    lines.push(
      `${padVisible(renderMuted(label), labelWidth)} ${wrapped[0] ?? ""}`
    );
    for (const line of wrapped.slice(1)) {
      lines.push(`${" ".repeat(labelWidth)} ${line}`);
    }
  }

  return lines;
}

export function renderTable(options: RenderTableOptions): string[] {
  if (options.headers.length === 0) {
    return [];
  }

  const widths = clampColumnWidths(options.headers, options.rows);
  const gap = " ".repeat(TABLE_GAP);
  const header = options.headers
    .map((value, index) => padVisible(value, widths[index] ?? 0))
    .join(gap);
  const divider = widths.map((width) => "─".repeat(width)).join(gap);
  const rows = options.rows.flatMap((row) => {
    const wrappedCells = row.map((value, index) =>
      wrapPlainText(value ?? "", widths[index] ?? TABLE_MIN_COLUMN_WIDTH)
    );
    const rowHeight = Math.max(...wrappedCells.map((cell) => cell.length), 1);

    return Array.from({ length: rowHeight }, (_, rowIndex) =>
      wrappedCells
        .map((cell, columnIndex) =>
          padVisible(cell[rowIndex] ?? "", widths[columnIndex] ?? 0)
        )
        .join(gap)
    );
  });

  return [colorize(header, "accent", true), renderMuted(divider), ...rows];
}

export function renderJsonBlock(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

export function renderPage(options: RenderPageOptions): string {
  const lines: string[] = [colorize(options.title, "accent", true)];

  if (options.subtitle) {
    lines.push(
      ...wrapPlainText(options.subtitle, contentWidth()).map((line) =>
        renderMuted(line)
      )
    );
  }

  for (const section of options.sections) {
    if (section.lines.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(...renderSectionTitle(section.title));
    lines.push(...section.lines);
  }

  if (options.footer && options.footer.length > 0) {
    lines.push("");
    lines.push(
      ...options.footer.flatMap((line) =>
        wrapPrefixedLine("› ", line).map((wrapped) => renderMuted(wrapped))
      )
    );
  }

  return lines.join("\n");
}
