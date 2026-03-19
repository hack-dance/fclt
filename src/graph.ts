const SNIPPET_MARKER_RE = /<!--\s*fclty:([A-Za-z0-9/_-]+)\s*-->/g;
const AI_REF_RE = /(?<![\w@])@ai\/([^\s"'`<>]+)/g;
const BUILTIN_REF_RE = /(?<![\w@])@builtin\/([^\s"'`<>]+)/g;
const PROJECT_REF_RE = /(?<![\w@])@project\/([^\s"'`<>]+)/g;
const SYMBOLIC_REF_RE = /\$\{(refs\.[^}]+)\}/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)}\]]+$/;

export type AssetSourceKind = "builtin" | "global" | "project";
export type AssetScope = "global" | "project";
export type GraphNodeKind =
  | "skill"
  | "mcp"
  | "agent"
  | "snippet"
  | "instruction"
  | "doc"
  | "tool-config"
  | "tool-rule"
  | "rendered-target";
export type GraphEdgeKind =
  | "snippet_marker"
  | "canonical_ref"
  | "project_ref"
  | "ref_symbol"
  | "render_source";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  name: string;
  sourceKind: AssetSourceKind;
  scope: AssetScope;
  path?: string;
  canonicalRef?: string;
  projectRoot?: string;
  projectSlug?: string;
  shadow?: boolean;
  meta?: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  locator: string;
}

export interface FacultGraph {
  version: number;
  generatedAt: string;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

export interface ExtractedReference {
  kind: "snippet_marker" | "canonical_ref" | "project_ref" | "ref_symbol";
  value: string;
}

function trimTrailingPunctuation(value: string): string {
  const match = TRAILING_PUNCTUATION_RE.exec(value);
  if (!match) {
    return value;
  }
  return value.slice(0, -match[0].length);
}

function pushAll(
  out: ExtractedReference[],
  regex: RegExp,
  kind: ExtractedReference["kind"],
  input: string,
  normalize?: (value: string) => string
) {
  regex.lastIndex = 0;
  for (let match = regex.exec(input); match; match = regex.exec(input)) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    out.push({
      kind,
      value: normalize ? normalize(raw) : raw,
    });
  }
}

export function extractExplicitReferences(input: string): ExtractedReference[] {
  const out: ExtractedReference[] = [];
  pushAll(out, SNIPPET_MARKER_RE, "snippet_marker", input);
  pushAll(out, AI_REF_RE, "canonical_ref", input, (value) => {
    return `@ai/${trimTrailingPunctuation(value)}`;
  });
  pushAll(out, BUILTIN_REF_RE, "canonical_ref", input, (value) => {
    return `@builtin/${trimTrailingPunctuation(value)}`;
  });
  pushAll(out, PROJECT_REF_RE, "project_ref", input, (value) => {
    return `@project/${trimTrailingPunctuation(value)}`;
  });
  pushAll(out, SYMBOLIC_REF_RE, "ref_symbol", input);
  return out;
}

export function makeGraphNodeId(args: {
  kind: GraphNodeKind;
  sourceKind: AssetSourceKind;
  scope: AssetScope;
  name: string;
}): string {
  return [args.kind, args.sourceKind, args.scope, args.name].join(":");
}

export function snippetMarkerToSnippetRef(marker: string): string {
  const trimmed = marker.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}
