import { expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupIsolatedTestRoot,
  createIsolatedTestRoot,
} from "./isolation-root";

test("cleanup removes exactly the root with its captured creation identity", () => {
  const receipt = createIsolatedTestRoot("fclt-test-shell-");
  writeFileSync(join(receipt.testRoot, "fixture"), "owned");
  cleanupIsolatedTestRoot(receipt);
  expect(() => readFileSync(join(receipt.testRoot, "fixture"))).toThrow();
});

test("cleanup preserves changed identities and protected boundaries", () => {
  const receipt = createIsolatedTestRoot("fclt-test-shell-");
  const sentinel = join(receipt.testRoot, "sentinel");
  writeFileSync(sentinel, "preserve");
  try {
    expect(() =>
      cleanupIsolatedTestRoot({
        ...receipt,
        inode: String(BigInt(receipt.inode) + 1n),
      })
    ).toThrow("ownership changed");
    expect(() =>
      cleanupIsolatedTestRoot({ ...receipt, realHome: receipt.testRoot })
    ).toThrow("ownership changed");
    expect(() =>
      cleanupIsolatedTestRoot({ ...receipt, realState: receipt.testRoot })
    ).toThrow("ownership changed");
    expect(() =>
      cleanupIsolatedTestRoot({
        ...receipt,
        realHome: join(receipt.testRoot, "home"),
      })
    ).toThrow("ownership changed");
    expect(() =>
      cleanupIsolatedTestRoot({
        ...receipt,
        realState: join(receipt.testRoot, "state"),
      })
    ).toThrow("ownership changed");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  } finally {
    cleanupIsolatedTestRoot(receipt);
  }
});

test.skipIf(!process.env.FCLT_TEST_SHELL_ROOT)(
  "preload roots stay short and directly under the wrapper's cleanup owner",
  () => {
    const receipt = createIsolatedTestRoot("t-", { preferWrapperRoot: true });
    try {
      expect(dirname(receipt.testRoot)).toBe(process.env.FCLT_TEST_SHELL_ROOT!);
    } finally {
      rmSync(receipt.testRoot, { recursive: true });
    }
  }
);

test("cleanup refuses a symlink or replacement directory at the original path", () => {
  const receipt = createIsolatedTestRoot("fclt-test-shell-");
  const retained = `${receipt.testRoot}-retained`;
  renameSync(receipt.testRoot, retained);
  mkdirSync(receipt.testRoot);
  const sentinel = join(receipt.testRoot, "sentinel");
  writeFileSync(sentinel, "replacement");
  try {
    expect(() => cleanupIsolatedTestRoot(receipt)).toThrow("ownership changed");
    expect(readFileSync(sentinel, "utf8")).toBe("replacement");
    rmSync(receipt.testRoot, { recursive: true });
    symlinkSync(retained, receipt.testRoot, "junction");
    expect(() => cleanupIsolatedTestRoot(receipt)).toThrow("ownership changed");
  } finally {
    rmSync(receipt.testRoot, { recursive: true, force: true });
    rmSync(retained, { recursive: true });
  }
});
