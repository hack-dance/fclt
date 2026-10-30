import { afterEach, expect, test } from "bun:test";
import { closeSync, constants, readFileSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWritebacks } from "./ai";
import { AiDirectoryBoundary, aiPathWithin } from "./ai-boundary";
import {
  appendAiJsonLine,
  readAiText,
  withAiMutationScope,
  writeAiText,
} from "./ai-filesystem";
import { indexFile, withGuardedIndexReads } from "./index-filesystem";

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
  }
});

async function directoryFixture() {
  fixture = await mkdtemp(join(tmpdir(), "fclt-ai-boundary-"));
  return fixture;
}

test.each([
  [
    "C:\\Users\\runner\\.facult\\ai\\global\\writeback\\queue.jsonl",
    "C:\\Users\\runner\\.facult\\ai\\global",
    true,
  ],
  ["c:\\USERS\\runner\\.ai\\graph.json", "C:\\Users\\runner\\.ai", true],
  [
    "C:\\Users\\runner\\.ai-other\\queue.jsonl",
    "C:\\Users\\runner\\.ai",
    false,
  ],
  ["D:\\other\\queue.jsonl", "C:\\Users\\runner\\.ai", false],
  ["\\\\server\\share\\.ai\\graph.json", "\\\\server\\share\\.ai", true],
] as const)("Windows containment handles %s", (path, root, expected) => {
  expect(aiPathWithin(path, root, "win32")).toBe(expected);
});

test("Windows directory backend creates and binds parents without directory descriptors", async () => {
  const root = await directoryFixture();
  const boundary = new AiDirectoryBoundary(root, false, "win32");
  const target = join(root, "nested/file.md");
  const parent = boundary.parentFor(target, true);
  try {
    expect(boundary.fd).toBe(-1);
    expect(parent.fd).toBe(-1);
    expect(() =>
      parent.open("../outside.md", constants.O_WRONLY + constants.O_CREAT)
    ).toThrow("single path segments");
    expect(() =>
      parent.open("file.md:stream", constants.O_WRONLY + constants.O_CREAT)
    ).toThrow("single path segments");
    const file = parent.open(
      "file.md",
      constants.O_RDWR + constants.O_CREAT + constants.O_EXCL
    );
    try {
      writeSync(file, "Bound file\n");
      expect(readFileSync(target, "utf8")).toBe("Bound file\n");
    } finally {
      closeSync(file);
    }
    expect(parent.entries()).toEqual(["file.md"]);
    parent.validate();
    parent.unlink("file.md");
    expect(parent.entries()).toEqual([]);
  } finally {
    parent.close();
    boundary.close();
  }
});

test("Windows directory backend rejects a replaced parent identity", async () => {
  const root = await directoryFixture();
  await mkdir(join(root, "parent"));
  const boundary = new AiDirectoryBoundary(root, false, "win32");
  const parent = boundary.parentFor(join(root, "parent/file.md"), false);
  try {
    await rename(join(root, "parent"), join(root, "moved"));
    await mkdir(join(root, "parent"));
    expect(() => parent.validate()).toThrow("AI bound parent changed");
  } finally {
    parent.close();
    boundary.close();
  }
});

test("native AI boundary reads, appends and replaces isolated state", async () => {
  const homeDir = await directoryFixture();
  await withAiMutationScope({ homeDir, allowEphemeral: true }, async () => {
    const path = join(homeDir, "state/queue.jsonl");
    await appendAiJsonLine(path, { value: 1 }, homeDir, undefined, homeDir);
    await appendAiJsonLine(path, { value: 2 }, homeDir, undefined, homeDir);
    expect(await readAiText(path, "utf8", homeDir)).toBe(
      '{"value":1}\n{"value":2}\n'
    );
    if (process.platform === "win32") {
      await expect(
        writeAiText(path, '{"value":3}\n', homeDir, undefined, homeDir)
      ).rejects.toThrow("unavailable on win32");
      expect(await readAiText(path, "utf8", homeDir)).toBe(
        '{"value":1}\n{"value":2}\n'
      );
    } else {
      await writeAiText(path, '{"value":3}\n', homeDir, undefined, homeDir);
      expect(await readAiText(path, "utf8", homeDir)).toBe('{"value":3}\n');
    }
  });
});

test("native AI boundary can inspect an absent legacy global queue", async () => {
  const homeDir = await directoryFixture();
  const rootDir = join(homeDir, ".ai");
  await mkdir(join(homeDir, ".facult/ai/global/writeback"), {
    recursive: true,
  });
  await writeFile(join(homeDir, ".facult/ai/global/writeback/queue.jsonl"), "");
  await mkdir(rootDir);
  // The explicit root keeps this read isolated even when the caller has a configured store.
  expect(await listWritebacks({ homeDir, rootDir })).toEqual([]);
});

test("guarded index reads retain the same root identity across files", async () => {
  const fixtureRoot = await directoryFixture();
  const root = join(fixtureRoot, "source");
  await mkdir(root);
  await writeFile(join(root, "first.md"), "First authorized file\n");
  await withGuardedIndexReads([root], async () => {
    expect(await indexFile(join(root, "first.md")).text()).toBe(
      "First authorized file\n"
    );
    await rename(root, `${root}.original`);
    await mkdir(root);
    await writeFile(join(root, "second.md"), "Replacement root contents\n");
    await expect(indexFile(join(root, "second.md")).text()).rejects.toThrow(
      "bound parent changed"
    );
  });
});
