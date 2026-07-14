import { expect, test } from "bun:test";
import { auditPersistenceContract } from "./verify-binary-audit-contract";

test("compiled audit verifier uses the truthful Windows fail-closed contract", () => {
  expect(auditPersistenceContract("darwin")).toBe("supported");
  expect(auditPersistenceContract("linux")).toBe("supported");
  expect(auditPersistenceContract("win32")).toBe("fail-closed");
});
