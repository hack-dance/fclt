import type {
  AssetScope,
  AssetSourceKind,
  FacultGraph,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
} from "./graph";
import { facultAiGraphPath } from "./paths";

type QueryableGraphKind =
  | GraphNodeKind
  | "skills"
  | "agents"
  | "snippets"
  | "instructions"
  | "docs"
  | "tool-configs"
  | "tool-rules"
  | "rendered-targets";

export interface GraphSelection {
  sourceKind?: AssetSourceKind;
  scope?: AssetScope;
}

export interface GraphRelation {
  edge: GraphEdge;
  node: GraphNode;
}

const KIND_ALIASES: Record<QueryableGraphKind, GraphNodeKind> = {
  skill: "skill",
  skills: "skill",
  agent: "agent",
  agents: "agent",
  snippet: "snippet",
  snippets: "snippet",
  instruction: "instruction",
  instructions: "instruction",
  mcp: "mcp",
  doc: "doc",
  docs: "doc",
  "tool-config": "tool-config",
  "tool-configs": "tool-config",
  "tool-rule": "tool-rule",
  "tool-rules": "tool-rule",
  "rendered-target": "rendered-target",
  "rendered-targets": "rendered-target",
};

function normalizeKindToken(token: string): GraphNodeKind | null {
  return KIND_ALIASES[token as QueryableGraphKind] ?? null;
}

function sourceRank(sourceKind: AssetSourceKind): number {
  switch (sourceKind) {
    case "project":
      return 0;
    case "global":
      return 1;
    case "builtin":
      return 2;
    default:
      return 99;
  }
}

function matchesSelection(
  node: GraphNode,
  selection?: GraphSelection & { kind?: GraphNodeKind }
): boolean {
  if (selection?.kind && node.kind !== selection.kind) {
    return false;
  }
  if (selection?.sourceKind && node.sourceKind !== selection.sourceKind) {
    return false;
  }
  if (selection?.scope && node.scope !== selection.scope) {
    return false;
  }
  return true;
}

export async function loadGraph(opts?: {
  rootDir?: string;
  homeDir?: string;
}): Promise<FacultGraph> {
  const homeDir = opts?.homeDir ?? process.env.HOME ?? "";
  const graphPath = facultAiGraphPath(homeDir, opts?.rootDir);
  const file = Bun.file(graphPath);
  if (!(await file.exists())) {
    throw new Error(`Graph not found at ${graphPath}. Run "fclt index".`);
  }
  return JSON.parse(await file.text()) as FacultGraph;
}

export function resolveGraphNode(
  graph: FacultGraph,
  query: string,
  selection?: GraphSelection
): GraphNode | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = Object.values(graph.nodes).filter((node) =>
    matchesSelection(node, selection)
  );

  const exactId = graph.nodes[trimmed];
  if (exactId && matchesSelection(exactId, selection)) {
    return exactId;
  }

  const canonical = candidates.find((node) => node.canonicalRef === trimmed);
  if (canonical) {
    return canonical;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const kindToken = trimmed.slice(0, colonIndex);
    const kind = normalizeKindToken(kindToken);
    if (kind) {
      const name = trimmed.slice(colonIndex + 1);
      const matches = candidates
        .filter((node) => node.kind === kind && node.name === name)
        .sort((a, b) => sourceRank(a.sourceKind) - sourceRank(b.sourceKind));
      return matches[0] ?? null;
    }
  }

  const byName = candidates
    .filter((node) => node.name === trimmed)
    .sort((a, b) => sourceRank(a.sourceKind) - sourceRank(b.sourceKind));
  return byName[0] ?? null;
}

export function graphDependencies(
  graph: FacultGraph,
  nodeId: string
): GraphRelation[] {
  return graph.edges
    .filter((edge) => edge.from === nodeId)
    .flatMap((edge) => {
      const node = graph.nodes[edge.to];
      return node ? [{ edge, node }] : [];
    })
    .sort((a, b) => {
      if (a.edge.kind !== b.edge.kind) {
        return a.edge.kind.localeCompare(b.edge.kind);
      }
      return a.node.id.localeCompare(b.node.id);
    });
}

export function graphDependents(
  graph: FacultGraph,
  nodeId: string
): GraphRelation[] {
  return graph.edges
    .filter((edge) => edge.to === nodeId)
    .flatMap((edge) => {
      const node = graph.nodes[edge.from];
      return node ? [{ edge, node }] : [];
    })
    .sort((a, b) => {
      if (a.edge.kind !== b.edge.kind) {
        return a.edge.kind.localeCompare(b.edge.kind);
      }
      return a.node.id.localeCompare(b.node.id);
    });
}
