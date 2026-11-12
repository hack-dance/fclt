import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathIsInsideOrEqual } from "../src/paths";

test("shell test wrapper isolates inherited paths and clears Git context before Bun starts", async () => {
  const repoRoot = join(import.meta.dir, "..");
  const proc = Bun.spawn({
    cmd: [join(repoRoot, "scripts", "test-safe.sh"), "test/setup.test.ts"],
    cwd: repoRoot,
    env: {
      ...process.env,
      FACULT_ROOT_DIR: "/unowned/canonical",
      FACULT_LOCAL_STATE_DIR: "/unowned/state",
      FACULT_CACHE_DIR: "/unowned/cache",
      GIT_DIR: "/tmp/escape.git",
      GIT_WORK_TREE: "/tmp/escape",
      GIT_COMMON_DIR: "/tmp/common.git",
      GIT_INDEX_FILE: "/tmp/escape.index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CEILING_DIRECTORIES: "/tmp",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(code).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("5 pass");
  expect(`${stdout}\n${stderr}`).toContain("0 fail");
});

test("shell wrapper isolates the environment even without the Bun preload", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrapper-probe-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "bun");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = --print ]; then printf "%s\\n" "$0"; exit 0; fi',
      `if [ "$1" != test ]; then exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi`,
      'printf "%s\\n" "$FCLT_TEST_SHELL_ROOT" "$HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$TMPDIR" "$FACULT_ROOT_DIR" "$FACULT_ROOT_SCOPE" "$NODE_ENV" "$FACULT_TEST_SKIP_LOCAL" "$*"',
      "",
    ].join("\n")
  );
  await chmod(executable, 0o755);
  const child = Bun.spawn({
    cmd: [
      join(import.meta.dir, "..", "scripts", "test-safe.sh"),
      "--ci",
      "fixture.test.ts",
    ],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FACULT_ROOT_DIR: "/unowned/canonical",
      FACULT_ROOT_SCOPE: "project",
      XDG_STATE_HOME: "/unowned/state",
      XDG_CONFIG_HOME: "/unowned/config",
      XDG_DATA_HOME: "/unowned/data",
      XDG_CACHE_HOME: "/unowned/cache",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  const [shellRoot, ...values] = stdout.trimEnd().split("\n");
  expect(shellRoot).toBeTruthy();
  for (const path of values.slice(0, 6)) {
    expect(pathIsInsideOrEqual(path, shellRoot!)).toBe(true);
    expect(pathIsInsideOrEqual(path, process.env.FCLT_TEST_REAL_HOME!)).toBe(
      false
    );
  }
  expect(values.slice(6)).toEqual([
    "",
    "",
    "test",
    "1",
    "test fixture.test.ts",
  ]);
});

async function wrapperLifecycleProbe(args: {
  status: number;
  keep?: boolean;
  replace?: boolean;
  interrupt?: boolean;
  childSignal?: boolean;
  setupFailure?: boolean;
}) {
  const fixture = await mkdtemp(join(tmpdir(), "wrapper-lifecycle-"));
  const bin = join(fixture, "bin");
  await mkdir(bin);
  const executable = join(bin, "bun");
  const actualBun = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = --print ]; then printf "%s\\n" "$0"; exit 0; fi',
      'if [ "$1" != test ]; then',
      ...(args.setupFailure
        ? [
            'case "$1" in */test/run-isolated.ts)',
            'printf "%s\\n" "$FCLT_TEST_SHELL_ROOT"',
            'printf "block setup\\n" > "$HOME"',
            ";; esac",
          ]
        : []),
      `exec ${actualBun} "$@"`,
      "fi",
      'printf "fixture evidence\\n" > "$HOME/evidence.txt"',
      ...(args.replace
        ? [
            'mv "$FCLT_TEST_SHELL_ROOT" "$FCLT_TEST_SHELL_ROOT-retained"',
            'mkdir "$FCLT_TEST_SHELL_ROOT"',
            'printf "unowned replacement\\n" > "$FCLT_TEST_SHELL_ROOT/sentinel"',
          ]
        : []),
      'printf "%s\\n" "$FCLT_TEST_SHELL_ROOT"',
      'printf "fixture output\\n"',
      ...(args.childSignal
        ? [
            `${actualBun} -e 'await Bun.sleep(150); console.log(await Bun.file(process.env.HOME + "/evidence.txt").exists() ? "descendant-scratch-present" : "descendant-scratch-missing")' &`,
            'kill -TERM "$$"',
          ]
        : args.interrupt
          ? [`exec ${actualBun} -e 'setInterval(() => {}, 1000)'`]
          : [`exit ${args.status}`]),
      "",
    ].join("\n")
  );
  await chmod(executable, 0o755);
  return Bun.spawn(
    [join(import.meta.dir, "..", "scripts/test-safe.sh"), "fixture.test.ts"],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FCLT_TEST_KEEP_TMP: args.keep ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

for (const status of [0, 27, 143]) {
  for (const keep of [false, true]) {
    test(`wrapper preserves exit ${status} and ${keep ? "retains" : "cleans"} its scratch`, async () => {
      const child = await wrapperLifecycleProbe({ status, keep });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(status);
      const [root, output] = stdout.trim().split("\n");
      expect(output).toBe("fixture output");
      expect(root).toBeTruthy();
      if (keep) {
        expect(stderr).toContain(`Preserved test scratch: ${root}`);
        expect(await Bun.file(join(root!, "home/evidence.txt")).text()).toBe(
          "fixture evidence\n"
        );
        await rm(root!, { recursive: true });
      } else {
        expect(stderr).toBe("");
        expect(
          await lstat(root!).then(
            () => true,
            () => false
          )
        ).toBe(false);
      }
    });
  }
  test(`wrapper preserves replacement content and ${status ? "the failing test status" : "fails cleanup"}`, async () => {
    const child = await wrapperLifecycleProbe({ status, replace: true });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const root = stdout.split("\n")[0]!;
    expect(code).toBe(status || 1);
    expect(stderr).toContain("ownership changed");
    expect(await Bun.file(join(root, "sentinel")).text()).toBe(
      "unowned replacement\n"
    );
    expect(
      await Bun.file(join(`${root}-retained`, "home/evidence.txt")).text()
    ).toBe("fixture evidence\n");
    await rm(root, { recursive: true });
    await rm(`${root}-retained`, { recursive: true });
  });
}

test("child-only signals retain scratch while a descendant still uses it", async () => {
  const child = await wrapperLifecycleProbe({ status: 0, childSignal: true });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const root = stdout.split("\n")[0]!;
  expect(code).toBe(143);
  expect(stdout).toContain("descendant-scratch-present");
  expect(stdout).not.toContain("descendant-scratch-missing");
  expect(stderr).toContain(`Preserved test scratch: ${root}`);
  expect(await Bun.file(join(root, "home/evidence.txt")).text()).toBe(
    "fixture evidence\n"
  );
  await rm(root, { recursive: true });
});

test("setup failure cleans the allocated root before any test child starts", async () => {
  const child = await wrapperLifecycleProbe({ status: 0, setupFailure: true });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const root = stdout.trim();
  expect(code).toBe(1);
  expect(root).toContain("fclt-test-shell-");
  expect(stdout).not.toContain("fixture output");
  expect(stderr).toContain("EEXIST");
  expect(
    await lstat(root).then(
      () => true,
      () => false
    )
  ).toBe(false);
});

test("wrapper interruption stops its runner and retains scratch for active descendants", async () => {
  const child = await wrapperLifecycleProbe({ status: 0, interrupt: true });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("Probe exited before becoming ready");
    }
    output += new TextDecoder().decode(chunk.value);
  }
  const root = output.split("\n")[0]!;
  child.kill("SIGTERM");
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(143);
  expect(stderr).toContain(`Preserved test scratch: ${root}`);
  expect(await Bun.file(join(root, "home/evidence.txt")).text()).toBe(
    "fixture evidence\n"
  );
  await reader.cancel();
  await rm(root, { recursive: true });
}, 10_000);
