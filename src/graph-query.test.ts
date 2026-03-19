import { describe, expect, it } from "bun:test";
import type { FacultGraph } from "./graph";
import {
  graphDependencies,
  graphDependents,
  resolveGraphNode,
} from "./graph-query";

const graph: FacultGraph = {
  version: 1,
  generatedAt: "2026-03-18T00:00:00.000Z",
  nodes: {
    "instruction:global:global:FEEDBACK": {
      id: "instruction:global:global:FEEDBACK",
      kind: "instruction",
      name: "FEEDBACK",
      sourceKind: "global",
      scope: "global",
      canonicalRef: "@ai/instructions/FEEDBACK.md",
    },
    "instruction:project:project:FEEDBACK": {
      id: "instruction:project:project:FEEDBACK",
      kind: "instruction",
      name: "FEEDBACK",
      sourceKind: "project",
      scope: "project",
      canonicalRef: "@project/instructions/FEEDBACK.md",
    },
    "doc:project:project:AGENTS.global.md": {
      id: "doc:project:project:AGENTS.global.md",
      kind: "doc",
      name: "AGENTS.global.md",
      sourceKind: "project",
      scope: "project",
    },
  },
  edges: [
    {
      from: "doc:project:project:AGENTS.global.md",
      to: "instruction:project:project:FEEDBACK",
      kind: "canonical_ref",
      locator: "@project/instructions/FEEDBACK.md",
    },
  ],
};

describe("resolveGraphNode", () => {
  it("prefers project provenance for ambiguous name lookups", () => {
    const node = resolveGraphNode(graph, "instruction:FEEDBACK");
    expect(node?.id).toBe("instruction:project:project:FEEDBACK");
  });

  it("resolves canonical refs exactly", () => {
    const node = resolveGraphNode(graph, "@ai/instructions/FEEDBACK.md");
    expect(node?.id).toBe("instruction:global:global:FEEDBACK");
  });
});

describe("graph relations", () => {
  it("returns direct dependencies and dependents", () => {
    const deps = graphDependencies(
      graph,
      "doc:project:project:AGENTS.global.md"
    );
    const dependents = graphDependents(
      graph,
      "instruction:project:project:FEEDBACK"
    );

    expect(deps).toHaveLength(1);
    expect(deps[0]?.node.id).toBe("instruction:project:project:FEEDBACK");
    expect(dependents).toHaveLength(1);
    expect(dependents[0]?.node.id).toBe("doc:project:project:AGENTS.global.md");
  });
});
