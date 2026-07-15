export type AuditPersistenceContract = "fail-closed" | "supported";

export function auditPersistenceContract(
  platform: NodeJS.Platform
): AuditPersistenceContract {
  return platform === "darwin" || platform === "linux"
    ? "supported"
    : "fail-closed";
}
