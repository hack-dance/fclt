import type { ToolAdapter } from "./types";
import { detectExplicitVersion } from "./version";

export const referenceAdapter: ToolAdapter = {
  id: "reference",
  name: "Reference Adapter",
  versions: ["v1"],
  detectVersion: detectExplicitVersion,
};
