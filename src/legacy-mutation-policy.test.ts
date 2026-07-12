import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AutosyncServiceConfig,
  installAutosyncService,
  repairAutosyncServices,
  runAutosyncService,
} from "./autosync";
import {
  assertLegacyManagedMutationAllowed,
  LEGACY_MANAGED_MUTATION_ENV,
  LEGACY_MANAGED_MUTATION_FLAG,
  legacyManagedMutationApproved,
} from "./legacy-mutation-policy";
import {
  managedStatePathForRoot,
  manageTool,
  syncManagedTools,
  unmanageTool,
} from "./manage";
import { checkRemoteUpdates, installRemoteItem } from "./remote";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fclt-containment-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(pathValue: string, value: unknown): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  await Bun.write(pathValue, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("legacy managed mutation containment", () => {
  it("requires explicit approval outside dry-run", () => {
    expect(
      legacyManagedMutationApproved({
        argv: [LEGACY_MANAGED_MUTATION_FLAG],
        env: {},
      })
    ).toBe(true);
    expect(
      legacyManagedMutationApproved({
        env: { [LEGACY_MANAGED_MUTATION_ENV]: "true" },
      })
    ).toBe(true);
    expect(legacyManagedMutationApproved({ env: {} })).toBe(false);
    expect(() =>
      assertLegacyManagedMutationAllowed({
        action: "fclt sync",
        approved: false,
      })
    ).toThrow("deprecated broad managed-mode mutation");
    expect(() =>
      assertLegacyManagedMutationAllowed({
        action: "fclt sync",
        approved: false,
        dryRun: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLegacyManagedMutationAllowed({
        action: "fclt doctor --repair autosync",
        approved: false,
        safeAlternative: "fclt autosync status or uninstall",
      })
    ).toThrow("Use fclt autosync status or uninstall");
  });

  it("blocks manage before target or managed-state writes", async () => {
    const home = await makeTempRoot();
    const rootDir = join(home, ".ai");
    const mcpConfig = join(home, ".cursor", "mcp.json");
    await writeJson(join(rootDir, "mcp", "servers.json"), { servers: {} });

    await expect(
      manageTool("cursor", {
        homeDir: home,
        rootDir,
        allowLegacyManagedMutation: false,
        toolPaths: {
          cursor: { tool: "cursor", mcpConfig },
        },
      })
    ).rejects.toThrow("fclt manage cursor is a deprecated");

    expect(await Bun.file(mcpConfig).exists()).toBe(false);
    expect(
      await Bun.file(managedStatePathForRoot(home, rootDir)).exists()
    ).toBe(false);
  });

  it("blocks sync and unmanage without changing live or managed state", async () => {
    const home = await makeTempRoot();
    const rootDir = join(home, ".ai");
    const serversPath = join(rootDir, "mcp", "servers.json");
    const mcpConfig = join(home, ".cursor", "mcp.json");
    const toolPaths = {
      cursor: { tool: "cursor", mcpConfig },
    };
    await writeJson(serversPath, {
      servers: { alpha: { command: "alpha" } },
    });
    await manageTool("cursor", {
      homeDir: home,
      rootDir,
      allowLegacyManagedMutation: true,
      toolPaths,
    });
    const managedStatePath = managedStatePathForRoot(home, rootDir);
    const liveBefore = await readFile(mcpConfig, "utf8");
    const stateBefore = await readFile(managedStatePath, "utf8");
    await writeJson(serversPath, {
      servers: { beta: { command: "beta" } },
    });

    await expect(
      syncManagedTools({
        homeDir: home,
        rootDir,
        tool: "cursor",
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt sync cursor is a deprecated");
    expect(await readFile(mcpConfig, "utf8")).toBe(liveBefore);
    expect(await readFile(managedStatePath, "utf8")).toBe(stateBefore);

    await expect(
      unmanageTool("cursor", {
        homeDir: home,
        rootDir,
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt unmanage cursor is a deprecated");
    expect(await readFile(mcpConfig, "utf8")).toBe(liveBefore);
    expect(await readFile(managedStatePath, "utf8")).toBe(stateBefore);
  });

  it("blocks autosync before service or runtime-state writes", async () => {
    const home = await makeTempRoot();
    const rootDir = join(home, ".ai");
    await expect(
      installAutosyncService({
        homeDir: home,
        rootDir,
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt autosync install is a deprecated");

    const config: AutosyncServiceConfig & {
      legacyManagedMutationApproved?: boolean;
    } = {
      version: 1,
      name: "all",
      rootDir,
      debounceMs: 10,
      legacyManagedMutationApproved: true,
      git: {
        enabled: false,
        remote: "origin",
        branch: "main",
        intervalMinutes: 60,
        autoCommit: false,
        commitPrefix: "test",
        source: "test",
      },
    };
    await expect(
      runAutosyncService(config, {
        homeDir: home,
        once: true,
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt autosync run is a deprecated");
    await expect(
      runAutosyncService(config, {
        homeDir: home,
        once: true,
        env: {},
      })
    ).rejects.toThrow("fclt autosync run is a deprecated");
    expect(
      await Bun.file(
        join(
          home,
          "Library",
          "Application Support",
          "fclt",
          "global",
          "autosync"
        )
      ).exists()
    ).toBe(false);
  });

  it("blocks autosync repair before rewriting legacy service state", async () => {
    const home = await makeTempRoot();
    const rootDir = join(home, ".ai");
    const serviceConfig = join(
      rootDir,
      ".facult",
      "autosync",
      "services",
      "all.json"
    );
    const legacyPlist = join(
      home,
      "Library",
      "LaunchAgents",
      "com.facult.autosync.plist"
    );
    await writeJson(serviceConfig, {
      version: 1,
      name: "all",
      rootDir,
      debounceMs: 10,
      git: {
        enabled: false,
        remote: "origin",
        branch: "main",
        intervalMinutes: 60,
        autoCommit: false,
        commitPrefix: "test",
        source: "test",
      },
    });
    await mkdir(dirname(legacyPlist), { recursive: true });
    await Bun.write(legacyPlist, "legacy\n");

    await expect(
      repairAutosyncServices(home, rootDir, {
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt doctor --repair autosync is a deprecated");
    expect(await readFile(legacyPlist, "utf8")).toBe("legacy\n");
    expect(await Bun.file(serviceConfig).exists()).toBe(true);
  });

  it("blocks forceful remote mutation before reading or writing state", async () => {
    const home = await makeTempRoot();
    const rootDir = join(home, ".ai");
    await expect(
      installRemoteItem({
        ref: "invalid",
        force: true,
        homeDir: home,
        rootDir,
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt install --force is a deprecated");
    await expect(
      checkRemoteUpdates({
        apply: true,
        homeDir: home,
        rootDir,
        allowLegacyManagedMutation: false,
      })
    ).rejects.toThrow("fclt update --apply is a deprecated");
    expect(await Bun.file(rootDir).exists()).toBe(false);
  });
});
