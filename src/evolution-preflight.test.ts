import { afterEach, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enableEvolutionLoop } from "./evolution-loop";
import { preflightEvolutionLoop } from "./evolution-preflight";
import {
  facultAiActivityHistorySegmentDir,
  facultAiDraftDir,
  facultAiEvolutionLoopConfigPath,
  facultAiEvolutionLoopStatePath,
  facultAiEvolutionReviewDir,
  facultAiReconciliationStatePath,
} from "./paths";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(scope: "project" | "global") {
  const homeDir = await mkdtemp(join(tmpdir(), "fclt-preflight-test-"));
  roots.push(homeDir);
  const rootDir =
    scope === "project" ? join(homeDir, "repo", ".ai") : join(homeDir, ".ai");
  await mkdir(rootDir, { recursive: true });
  await enableEvolutionLoop({ homeDir, rootDir, scope });
  return { homeDir, rootDir, scope };
}
for (const scope of ["project", "global"] as const) {
  it(`preflights ${scope} writes without creating queue state or leaving probes`, async () => {
    const args = await setup(scope);
    const result = await preflightEvolutionLoop(args);
    expect(result.status).toBe("ready");
    expect(result.loopInvoked).toBe(false);
    expect(
      await Bun.file(
        facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
      ).exists()
    ).toBe(false);
    for (const check of result.checks) {
      expect(check.writable).toBe(true);
      expect(
        (await readdir(check.path)).some((name) =>
          name.startsWith(".fclt-preflight-")
        )
      ).toBe(false);
    }
  });
}
it("reports an inaccessible review destination before loop execution", async () => {
  const args = await setup("project");
  const path = facultAiEvolutionReviewDir(args.homeDir, args.rootDir);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, "occupied");
  const result = await preflightEvolutionLoop(args);
  expect(result.status).toBe("blocked");
  expect(result.loopInvoked).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ path, writable: false })
  );
  expect(result.recovery).toContain(path);
  expect(
    await Bun.file(
      facultAiEvolutionLoopStatePath(args.homeDir, args.rootDir)
    ).exists()
  ).toBe(false);
});

it("does not report malformed enabled configuration as ready", async () => {
  const args = await setup("project");
  await Bun.write(
    facultAiEvolutionLoopConfigPath(args.homeDir, args.rootDir),
    JSON.stringify({ enabled: true })
  );
  const result = await preflightEvolutionLoop(args);
  expect(result.status).toBe("blocked");
  expect(result.configError).toContain("schema");
  expect(result.loopInvoked).toBe(false);
});

for (const destination of [
  (home: string, root: string) =>
    dirname(facultAiReconciliationStatePath(home, root)),
  facultAiActivityHistorySegmentDir,
  facultAiDraftDir,
]) {
  it("blocks on an unavailable runtime sibling even when the loop directory is writable", async () => {
    const args = await setup("project");
    const path = destination(args.homeDir, args.rootDir);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, "occupied");
    const result = await preflightEvolutionLoop(args);
    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ path, writable: false })
    );
    expect(result.loopInvoked).toBe(false);
  });
}
