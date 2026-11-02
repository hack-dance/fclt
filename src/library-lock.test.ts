import { expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLibraryAsset, saveLibraryAsset } from "./library-editor";

it("releases a process-held library lock after termination without canonical lock files", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fclt-library-lock-"))
  );
  const sourceRoot = join(root, "source");
  await mkdir(join(sourceRoot, "skills/example"), { recursive: true });
  const asset = { path: "skills/example/SKILL.md" };
  await writeFile(join(sourceRoot, asset.path), "# Shared\n");
  const context = {
    sourceRoot,
    localRoot: join(root, "runtime"),
    machine: "fixture",
  };
  const module = pathToFileURL(join(import.meta.dir, "library-lock.ts")).href;
  const script = `import {withLibraryMutationLock} from ${JSON.stringify(module)}; await withLibraryMutationLock(process.argv.at(-1), async () => { await Bun.stdout.write("held\\n"); await Bun.stdin.text(); });`;
  const child = Bun.spawn(
    [process.execPath, "--eval", script, "--", sourceRoot],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  try {
    const reader = child.stdout.getReader();
    let output = "";
    try {
      while (!output.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        output += new TextDecoder().decode(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    expect(output).toBe("held\n");
    const view = await readLibraryAsset(context, asset);
    await expect(
      saveLibraryAsset(context, {
        ...asset,
        revision: view.revision,
        layer: "local",
        values: { content: "# Busy\n" },
      })
    ).rejects.toMatchObject({ reason: "busy" });
    child.kill("SIGKILL");
    await child.exited;
    const saved = await saveLibraryAsset(context, {
      ...asset,
      revision: view.revision,
      layer: "local",
      values: { content: "# Recovered\n" },
    });
    expect(saved.effective.content).toBe("# Recovered\n");
    expect(await readFile(join(sourceRoot, asset.path), "utf8")).toBe(
      "# Shared\n"
    );
    expect(
      await Bun.file(join(sourceRoot, ".library-editor.lock")).exists()
    ).toBe(false);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
