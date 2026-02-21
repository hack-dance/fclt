export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function parseSeverity(raw: string): Severity | null {
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "critical") {
    return v;
  }
  return null;
}

export function isAtLeastSeverity(sev: Severity, min?: Severity): boolean {
  if (!min) {
    return true;
  }
  return SEVERITY_ORDER[sev] >= SEVERITY_ORDER[min];
}

export interface AuditRule {
  id: string;
  severity: Severity;
  pattern: string;
  message: string;
  target?: "skill" | "mcp" | "any";
}

export interface CompiledAuditRule extends AuditRule {
  regex: RegExp;
}

export interface AuditFinding {
  severity: Severity;
  ruleId: string;
  message: string;
  location?: string;
  evidence?: string;
}

export interface AuditItemResult {
  item: string;
  type: "skill" | "mcp" | "mcp-config" | "asset";
  sourceId?: string;
  path: string;
  passed: boolean;
  findings: AuditFinding[];
  /** Optional extra context (mostly for agent-assisted audits). */
  notes?: string;
}

export interface StaticAuditReport {
  timestamp: string;
  mode: "static";
  minSeverity?: Severity;
  rulesPath?: string | null;
  results: AuditItemResult[];
  summary: {
    totalItems: number;
    totalFindings: number;
    bySeverity: Record<Severity, number>;
    flaggedItems: number;
  };
}
