import { describe, expect, it } from "bun:test";
import {
  gitEnvironmentForRepository,
  withoutLocalGitEnvironment,
} from "./git-environment";

describe("git subprocess environment", () => {
  it("removes repository pointers and inline config while preserving credentials", () => {
    const env = withoutLocalGitEnvironment({
      PATH: "/usr/bin",
      GIT_DIR: "/caller/.git",
      GIT_WORK_TREE: "/caller",
      GIT_COMMON_DIR: "/caller/.git",
      GIT_INDEX_FILE: "/caller/.git/index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_ASKPASS: "/credential-helper",
      GIT_SSH_COMMAND: "ssh -i key",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      GIT_ASKPASS: "/credential-helper",
      GIT_SSH_COMMAND: "ssh -i key",
    });
  });

  it("pins discovery and config to an isolated fixture boundary", () => {
    const env = gitEnvironmentForRepository({
      repoDir: "/tmp/fixture/repo",
      isolatedHome: "/tmp/fixture/home",
      env: { PATH: "/usr/bin", GIT_DIR: "/caller/.git" },
    });

    expect(env.GIT_CEILING_DIRECTORIES).toBe("/tmp/fixture");
    expect(env.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBe("0");
    expect(env.HOME).toBe("/tmp/fixture/home");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/fixture/home/.config");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_DIR).toBeUndefined();
  });

  it("preserves managed global config for production repository commands", () => {
    const env = gitEnvironmentForRepository({
      repoDir: "/tmp/canonical",
      env: {
        GIT_DIR: "/caller/.git",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        GIT_CONFIG_GLOBAL: "/managed/global.gitconfig",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/managed/global.gitconfig");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});
