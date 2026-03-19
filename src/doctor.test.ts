import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facultAiIndexPath } from "./paths";

async function writeJson(p: string, data: unknown) {
  await mkdir(join(p, ".."), { recursive: true }).catch(() => null);
  await Bun.write(p, `${JSON.stringify(data, null, 2)}\n`);
}

test("doctor --repair migrates a legacy root index into generated ai state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-"));
  const rootDir = join(dir, "root");
  const legacyIndex = join(rootDir, "index.json");
  const generatedIndex = facultAiIndexPath(dir, rootDir);

  try {
    await mkdir(rootDir, { recursive: true });
    await Bun.write(
      legacyIndex,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          skills: {},
          mcp: { servers: {} },
          agents: {},
          snippets: {},
          instructions: {},
        },
        null,
        2
      )}\n`
    );

    const env = { ...process.env, HOME: dir, FACULT_ROOT_DIR: rootDir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Repaired generated AI index");

    const repaired = JSON.parse(await readFile(generatedIndex, "utf8")) as {
      version: number;
    };
    expect(repaired.version).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("doctor --repair updates legacy root config to ~/.ai when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facult-doctor-config-"));
  const aiRoot = join(dir, ".ai");

  try {
    await mkdir(join(aiRoot, "agents"), { recursive: true });
    await writeJson(join(dir, ".facult", "config.json"), {
      rootDir: join(dir, "agents", ".facult"),
    });

    const env = { ...process.env, HOME: dir };
    const proc = Bun.spawn(
      ["bun", "run", "./src/index.ts", "doctor", "--repair"],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(`Updated fclt root config to ${aiRoot}`);

    const config = JSON.parse(
      await readFile(join(dir, ".ai", ".facult", "config.json"), "utf8")
    ) as { rootDir: string };
    expect(config.rootDir).toBe(aiRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
