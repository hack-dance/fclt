import type { AuditFinding } from "./types";
import { SEVERITY_ORDER } from "./types";

export type StoredAuditStatus = "pending" | "passed" | "flagged";

export function computeStoredAuditStatus(
  findings: Pick<AuditFinding, "severity" | "ruleId">[]
): StoredAuditStatus {
  if (findings.some((finding) => finding.ruleId === "agent-error")) {
    return "pending";
  }
  const worst = findings.reduce(
    (max, finding) => Math.max(max, SEVERITY_ORDER[finding.severity]),
    -1
  );
  return worst >= SEVERITY_ORDER.high ? "flagged" : "passed";
}

export function isStoredAuditStatusPassed(status: StoredAuditStatus): boolean {
  return status === "passed";
}
