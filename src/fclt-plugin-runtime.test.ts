import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ProtocolInspection {
  executable: string;
  packageVersion: string;
  compatible: boolean;
  reason: string;
}

interface RuntimeDiscovery {
  compatible: boolean;
  selected: ProtocolInspection | null;
  candidates: ProtocolInspection[];
}

interface StagedRuntime {
  manifest: {
    version: string;
    executable: string;
    sha256: string;
  };
}

interface RuntimeModule {
  applyStagedRuntime(options: {
    approve: boolean;
    env: NodeJS.ProcessEnv;
    expectedSha256: string;
    version: string;
  }): Promise<{ active: ProtocolInspection; rollbackAvailable: boolean }>;
  assertManagedPath(target: string, root: string): Promise<string>;
  checksumForAsset(checksums: string, assetName: string): string;
  discoverRuntime(options: {
    env: NodeJS.ProcessEnv;
  }): Promise<RuntimeDiscovery>;
  rollbackRuntime(options: {
    approve: boolean;
    env: NodeJS.ProcessEnv;
    expectedActiveVersion?: string;
  }): Promise<{ active: ProtocolInspection; rolledBackFrom: string }>;
  runtimeStateRoot(env: NodeJS.ProcessEnv): string;
  sha256(bytes: Buffer): string;
  stageRuntime(options: {
    approve: boolean;
    env: NodeJS.ProcessEnv;
    fetchBuffer: (url: string) => Promise<Buffer>;
    version: string;
  }): Promise<StagedRuntime>;
}

const require = createRequire(import.meta.url);
const runtime =
  require("../plugins/fclt/scripts/fclt-runtime.cjs") as RuntimeModule;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function tempEnvironment(): Promise<{
  env: NodeJS.ProcessEnv;
  root: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "fclt-plugin-runtime-test-"));
  tempRoots.push(home);
  const root = join(home, "runtime");
  return {
    env: {
      ...process.env,
      FCLT_BIN: undefined,
      FCLT_PLUGIN_RUNTIME_DIR: root,
      HOME: home,
      PATH: "",
    },
    root,
  };
}

function runtimeScript(
  version: string,
  protocol = { minimum: 1, maximum: 1 }
): Buffer {
  return Buffer.from(
    [
      `#!${process.execPath}`,
      "if (process.argv[2] !== 'protocol') process.exit(2);",
      `console.log(JSON.stringify({schemaVersion:1,packageVersion:${JSON.stringify(version)},protocol:{version:1,minimumPluginVersion:${protocol.minimum},maximumPluginVersion:${protocol.maximum}},runtime:{platform:process.platform,architecture:process.arch,executable:process.argv[1]}}));`,
      "",
    ].join("\n")
  );
}

function releaseFixture(version: string, bytes = runtimeScript(version)) {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const extension = process.platform === "win32" ? ".exe" : "";
  const assetName = `fclt-${version}-${platform}-${process.arch}${extension}`;
  const checksum = runtime.sha256(bytes);
  return {
    bytes,
    checksum,
    fetchBuffer: async (url: string): Promise<Buffer> =>
      url.endsWith("SHA256SUMS")
        ? Buffer.from(`${checksum}  ${assetName}\n`)
        : bytes,
  };
}

async function stageAndApply(options: {
  env: NodeJS.ProcessEnv;
  version: string;
}): Promise<StagedRuntime> {
  const fixture = releaseFixture(options.version);
  const staged = await runtime.stageRuntime({
    approve: true,
    env: options.env,
    fetchBuffer: fixture.fetchBuffer,
    version: options.version,
  });
  await runtime.applyStagedRuntime({
    approve: true,
    env: options.env,
    expectedSha256: staged.manifest.sha256,
    version: options.version,
  });
  return staged;
}

describe("fclt plugin runtime discovery", () => {
  it("selects the explicit compatible runtime before all other locations", async () => {
    const { env } = await tempEnvironment();
    const executable = join(env.HOME as string, "explicit-fclt");
    await writeFile(executable, runtimeScript("7.8.9"), { mode: 0o700 });
    await chmod(executable, 0o700);

    const discovery = await runtime.discoverRuntime({
      env: { ...env, FCLT_BIN: executable },
    });

    expect(discovery.compatible).toBe(true);
    expect(discovery.selected?.executable).toBe(executable);
    expect(discovery.selected?.packageVersion).toBe("7.8.9");
  });

  it("reports protocol skew without selecting the runtime", async () => {
    const { env } = await tempEnvironment();
    const executable = join(env.HOME as string, "skewed-fclt");
    await writeFile(
      executable,
      runtimeScript("7.8.9", { minimum: 2, maximum: 2 }),
      {
        mode: 0o700,
      }
    );

    const discovery = await runtime.discoverRuntime({
      env: { ...env, FCLT_BIN: executable },
    });

    expect(discovery.compatible).toBe(false);
    expect(discovery.selected).toBeNull();
    expect(discovery.candidates[0]?.reason).toBe("protocol_version_skew");
  });
});

describe("fclt plugin runtime staging and recovery", () => {
  it("stages a checksummed immutable fixture, applies atomically, and discovers it", async () => {
    const { env } = await tempEnvironment();
    const staged = await stageAndApply({ env, version: "9.9.9" });

    const discovery = await runtime.discoverRuntime({ env });
    const active = JSON.parse(
      await readFile(join(runtime.runtimeStateRoot(env), "active.json"), "utf8")
    ) as { version: string; executable: string; sha256: string };

    expect(staged.manifest.version).toBe("9.9.9");
    expect(discovery.selected?.packageVersion).toBe("9.9.9");
    expect(active.version).toBe("9.9.9");
    expect(active.sha256).toBe(staged.manifest.sha256);
    expect(active.executable).toContain(join("versions", "9.9.9"));
  });

  it("refuses checksum mismatch without creating an active runtime", async () => {
    const { env, root } = await tempEnvironment();
    const fixture = releaseFixture("9.9.9");
    const badChecksum = "0".repeat(64);
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    const extension = process.platform === "win32" ? ".exe" : "";
    const assetName = `fclt-9.9.9-${platform}-${process.arch}${extension}`;

    await expect(
      runtime.stageRuntime({
        approve: true,
        env,
        version: "9.9.9",
        fetchBuffer: async (url) =>
          url.endsWith("SHA256SUMS")
            ? Buffer.from(`${badChecksum}  ${assetName}\n`)
            : fixture.bytes,
      })
    ).rejects.toThrow("checksum does not match");
    await expect(readFile(join(root, "active.json"), "utf8")).rejects.toThrow();
  });

  it("enforces staged checksum preconditions before activation", async () => {
    const { env } = await tempEnvironment();
    const fixture = releaseFixture("9.9.9");
    await runtime.stageRuntime({
      approve: true,
      env,
      fetchBuffer: fixture.fetchBuffer,
      version: "9.9.9",
    });

    await expect(
      runtime.applyStagedRuntime({
        approve: true,
        env,
        expectedSha256: "0".repeat(64),
        version: "9.9.9",
      })
    ).rejects.toThrow("precondition failed");
  });

  it("rejects concurrent mutation locks", async () => {
    const { env, root } = await tempEnvironment();
    const fixture = releaseFixture("9.9.9");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "mutation.lock"), "held");

    await expect(
      runtime.stageRuntime({
        approve: true,
        env,
        fetchBuffer: fixture.fetchBuffer,
        version: "9.9.9",
      })
    ).rejects.toThrow("already in progress");
  });

  it("rejects traversal and symlink escape from the managed runtime root", async () => {
    const { env, root } = await tempEnvironment();
    const outside = await mkdtemp(
      join(tmpdir(), "fclt-plugin-runtime-outside-")
    );
    tempRoots.push(outside);
    await mkdir(root, { recursive: true });

    await expect(
      runtime.assertManagedPath(join(root, "..", "escape"), root)
    ).rejects.toThrow("escapes");
    await symlink(outside, join(root, "staged"));
    await expect(
      runtime.stageRuntime({
        approve: true,
        env,
        fetchBuffer: releaseFixture("9.9.9").fetchBuffer,
        version: "9.9.9",
      })
    ).rejects.toThrow("symbolic link");
  });

  it("rolls back to the prior verified runtime and refuses corrupt recovery data", async () => {
    const { env, root } = await tempEnvironment();
    await stageAndApply({ env, version: "9.9.8" });
    await stageAndApply({ env, version: "9.9.9" });

    const rollback = await runtime.rollbackRuntime({
      approve: true,
      env,
      expectedActiveVersion: "9.9.9",
    });
    expect(rollback.active.packageVersion).toBe("9.9.8");
    expect(rollback.rolledBackFrom).toBe("9.9.9");

    const active = JSON.parse(
      await readFile(join(root, "active.json"), "utf8")
    ) as {
      previous: { executable: string };
      version: string;
    };
    expect(active.version).toBe("9.9.8");
    await writeFile(active.previous.executable, "corrupt");
    await expect(
      runtime.rollbackRuntime({
        approve: true,
        env,
        expectedActiveVersion: "9.9.8",
      })
    ).rejects.toThrow("checksum");
    const unchanged = JSON.parse(
      await readFile(join(root, "active.json"), "utf8")
    ) as {
      version: string;
    };
    expect(unchanged.version).toBe("9.9.8");
  });

  it("requires explicit approval for stage, apply, and rollback", async () => {
    const { env } = await tempEnvironment();
    await expect(
      runtime.stageRuntime({
        approve: false,
        env,
        fetchBuffer: releaseFixture("9.9.9").fetchBuffer,
        version: "9.9.9",
      })
    ).rejects.toThrow("approve=true");
    const staged = await runtime.stageRuntime({
      approve: true,
      env,
      fetchBuffer: releaseFixture("9.9.9").fetchBuffer,
      version: "9.9.9",
    });

    await expect(
      runtime.applyStagedRuntime({
        approve: false,
        env,
        expectedSha256: staged.manifest.sha256,
        version: "9.9.9",
      })
    ).rejects.toThrow("approve=true");
    await expect(
      runtime.rollbackRuntime({ approve: false, env })
    ).rejects.toThrow("approve=true");
  });

  it("parses only exact checksum asset names", () => {
    const expected = "a".repeat(64);
    expect(
      runtime.checksumForAsset(
        `${expected}  fclt-1.2.3-darwin-arm64\n`,
        "fclt-1.2.3-darwin-arm64"
      )
    ).toBe(expected);
    expect(() =>
      runtime.checksumForAsset(
        `${expected}  other-file\n`,
        "fclt-1.2.3-darwin-arm64"
      )
    ).toThrow("do not include");
  });
});
