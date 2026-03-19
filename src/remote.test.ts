import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facultAiIndexPath } from "./paths";
import {
  checkRemoteUpdates,
  installRemoteItem,
  searchRemoteItems,
  sourcesCommand,
  templatesCommand,
  verifySourceCommand,
} from "./remote";

const BLOCKED_BY_POLICY_RE = /blocked by policy/i;
const INTEGRITY_CHECK_FAILED_RE = /integrity check failed/i;
const MULTIPLE_SIGNATURE_KEYS_RE = /multiple configured keys/i;
const REQUIRES_REVIEW_RE = /requires review/i;
const REVOKED_SIGNATURE_KEY_RE = /is revoked/i;
const SIGNATURE_CHECK_FAILED_RE = /signature check failed/i;

let tempDir: string | null = null;
const originalCwd = process.cwd();

function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

async function makeTempRoot(): Promise<{ home: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "facult-remote-"));
  tempDir = dir;
  const home = join(dir, "home");
  const root = join(home, "agents", ".facult");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  return { home, root };
}

async function withMutedConsole(fn: () => Promise<void>) {
  const prevLog = console.log;
  const prevError = console.error;
  console.log = () => {
    // mute logs during CLI command tests
  };
  console.error = () => {
    // mute errors during CLI command tests
  };
  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
}

async function withCapturedConsole(
  fn: () => Promise<void>
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((v) => String(v)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((v) => String(v)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
  return { logs, errors };
}

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  if (!tempDir) {
    return;
  }
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("remote search/install/update", () => {
  it("searches builtin index and returns template results", async () => {
    const { home } = await makeTempRoot();
    const rows = await searchRemoteItems({
      query: "template",
      homeDir: home,
      cwd: home,
    });
    expect(
      rows.some((r) => r.index === "facult" && r.item.id === "skill-template")
    ).toBe(true);
    expect(
      rows.some(
        (r) => r.index === "facult" && r.item.id === "mcp-stdio-template"
      )
    ).toBe(true);
  });

  it("installs builtin skill and MCP templates into canonical store", async () => {
    const { home, root } = await makeTempRoot();

    const skill = await installRemoteItem({
      ref: "facult:skill-template",
      as: "shipping-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });
    expect(skill.type).toBe("skill");
    const skillPath = join(root, "skills", "shipping-skill", "SKILL.md");
    const skillMd = await readFile(skillPath, "utf8");
    expect(skillMd).toContain("# shipping-skill");

    const mcp = await installRemoteItem({
      ref: "facult:mcp-stdio-template",
      as: "github",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });
    expect(mcp.type).toBe("mcp");
    const servers = JSON.parse(
      await readFile(join(root, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { command?: string }>;
    };
    expect(servers.servers.github?.command).toBe("node");

    const index = JSON.parse(
      await readFile(facultAiIndexPath(home), "utf8")
    ) as {
      skills: Record<string, unknown>;
      mcp: { servers: Record<string, unknown> };
    };
    expect(Boolean(index.skills["shipping-skill"])).toBe(true);
    expect(Boolean(index.mcp.servers.github)).toBe(true);
  });

  it("detects and applies updates from configured file-based indices", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "local-index.json");
    const writeIndex = async (version: string, heading: string) => {
      const manifest = {
        name: "local",
        items: [
          {
            id: "ops-skill",
            type: "skill",
            version,
            skill: {
              name: "ops-skill",
              files: {
                "SKILL.md": `# ${heading}\n`,
              },
            },
          },
        ],
      };
      await writeFile(indexPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };

    await writeIndex("1.0.0", "v1");
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [{ name: "local", url: indexPath }],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "local:ops-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    await writeIndex("1.1.0", "v2");
    const report = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      apply: false,
    });
    expect(report.checks.some((c) => c.status === "outdated")).toBe(true);

    const applied = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      apply: true,
    });
    expect(applied.applied.length).toBe(1);

    const next = await readFile(
      join(root, "skills", "ops-skill", "SKILL.md"),
      "utf8"
    );
    expect(next).toContain("# v2");
  });

  it("verifies checksum-pinned manifest sources before install", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "integrity-index.json");
    const manifest = {
      items: [
        {
          id: "safe-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "safe-skill",
            files: {
              "SKILL.md": "# safe-skill\n",
            },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "integrity-local",
              url: indexPath,
              integrity: `sha256:${sha256Hex(manifestText)}`,
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "integrity-local:safe-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    expect(
      await Bun.file(join(root, "skills", "safe-skill", "SKILL.md")).exists()
    ).toBe(true);
  });

  it("rejects installs when pinned manifest integrity does not match", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "integrity-index.json");
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          items: [
            {
              id: "safe-skill",
              type: "skill",
              version: "1.0.0",
              skill: {
                name: "safe-skill",
                files: {
                  "SKILL.md": "# safe-skill\n",
                },
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "integrity-local",
              url: indexPath,
              integrity:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "integrity-local:safe-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(INTEGRITY_CHECK_FAILED_RE);
  });

  it("verifies ed25519-signed manifest sources before install", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const publicKeyPath = join(home, "index-signing.pub");
    await writeFile(publicKeyPath, publicKeyPem);

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "signed-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "signed-skill",
            files: {
              "SKILL.md": "# signed-skill\n",
            },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                publicKeyPath,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "signed-local:signed-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    expect(
      await Bun.file(join(root, "skills", "signed-skill", "SKILL.md")).exists()
    ).toBe(true);
  });

  it("rejects installs when pinned manifest signature does not match", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const publicKeyPath = join(home, "index-signing.pub");
    await writeFile(publicKeyPath, publicKeyPem);

    const indexPath = join(home, "signed-index.json");
    const initialManifest = {
      items: [
        {
          id: "signed-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "signed-skill",
            files: {
              "SKILL.md": "# signed-skill\n",
            },
          },
        },
      ],
    };
    const initialText = `${JSON.stringify(initialManifest, null, 2)}\n`;
    const signature = sign(null, Buffer.from(initialText), privateKey).toString(
      "base64"
    );

    const tamperedManifest = {
      items: [
        {
          id: "signed-skill",
          type: "skill",
          version: "9.9.9",
          skill: {
            name: "signed-skill",
            files: {
              "SKILL.md": "# tampered\n",
            },
          },
        },
      ],
    };
    await writeFile(
      indexPath,
      `${JSON.stringify(tamperedManifest, null, 2)}\n`
    );

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                publicKeyPath,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "signed-local:signed-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(SIGNATURE_CHECK_FAILED_RE);
  });

  it("supports keyId selection when multiple signature keys are configured", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    const keyAPath = join(home, "index-signing-a.pub");
    const keyBPath = join(home, "index-signing-b.pub");
    await writeFile(
      keyAPath,
      keyA.publicKey.export({ type: "spki", format: "pem" }).toString()
    );
    await writeFile(
      keyBPath,
      keyB.publicKey.export({ type: "spki", format: "pem" }).toString()
    );

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "keyid-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "keyid-skill",
            files: { "SKILL.md": "# keyid-skill\n" },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      keyB.privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          signatureKeys: [
            { id: "a", publicKeyPath: keyAPath, status: "active" },
            { id: "b", publicKeyPath: keyBPath, status: "active" },
          ],
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                keyId: "b",
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await installRemoteItem({
      ref: "signed-local:keyid-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    expect(
      await Bun.file(join(root, "skills", "keyid-skill", "SKILL.md")).exists()
    ).toBe(true);
  });

  it("rejects signature verification when multiple keys are configured without keyId", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    const keyAPath = join(home, "index-signing-a.pub");
    const keyBPath = join(home, "index-signing-b.pub");
    await writeFile(
      keyAPath,
      keyA.publicKey.export({ type: "spki", format: "pem" }).toString()
    );
    await writeFile(
      keyBPath,
      keyB.publicKey.export({ type: "spki", format: "pem" }).toString()
    );

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "ambiguous-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "ambiguous-skill",
            files: { "SKILL.md": "# ambiguous-skill\n" },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      keyB.privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          signatureKeys: [
            { id: "a", publicKeyPath: keyAPath, status: "active" },
            { id: "b", publicKeyPath: keyBPath, status: "active" },
          ],
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "signed-local:ambiguous-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(MULTIPLE_SIGNATURE_KEYS_RE);
  });

  it("rejects signature verification when referenced keyId is revoked", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const key = generateKeyPairSync("ed25519");
    const keyPath = join(home, "index-signing-revoked.pub");
    await writeFile(
      keyPath,
      key.publicKey.export({ type: "spki", format: "pem" }).toString()
    );

    const indexPath = join(home, "signed-index.json");
    const manifest = {
      items: [
        {
          id: "revoked-skill",
          type: "skill",
          version: "1.0.0",
          skill: {
            name: "revoked-skill",
            files: { "SKILL.md": "# revoked-skill\n" },
          },
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(indexPath, manifestText);
    const signature = sign(
      null,
      Buffer.from(manifestText),
      key.privateKey
    ).toString("base64");

    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          signatureKeys: [
            { id: "team-key", publicKeyPath: keyPath, status: "revoked" },
          ],
          indices: [
            {
              name: "signed-local",
              url: indexPath,
              signature: {
                algorithm: "ed25519",
                value: signature,
                keyId: "team-key",
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      installRemoteItem({
        ref: "signed-local:revoked-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(REVOKED_SIGNATURE_KEY_RE);
  });

  it("supports smithery alias search/install without local index config", async () => {
    const { home, root } = await makeTempRoot();
    const requests: string[] = [];

    const rows = await searchRemoteItems({
      query: "github",
      index: "smithery",
      homeDir: home,
      cwd: home,
      fetchJson: (url) => {
        requests.push(url);
        return Promise.resolve({
          servers: [
            {
              qualifiedName: "github",
              displayName: "GitHub",
              description: "GitHub MCP",
              homepage: "https://smithery.ai/servers/github",
              verified: true,
              remote: true,
            },
          ],
        });
      },
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.index).toBe("smithery");
    expect(rows[0]?.item.id).toBe("github");
    expect(requests.some((url) => url.includes("/servers"))).toBe(true);

    await installRemoteItem({
      ref: "smithery:github",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () =>
        Promise.resolve({
          qualifiedName: "github",
          displayName: "GitHub",
          version: "1.2.3",
          homepage: "https://smithery.ai/servers/github",
          deploymentUrl: "https://github.run.tools",
          connections: [
            {
              type: "http",
              deploymentUrl: "https://github.run.tools",
              configSchema: {
                type: "object",
                required: ["GITHUB_TOKEN"],
                properties: {
                  GITHUB_TOKEN: { type: "string" },
                },
              },
            },
          ],
        }),
    });

    const mcp = JSON.parse(
      await readFile(join(root, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<string, { url?: string; env?: Record<string, string> }>;
    };
    expect(mcp.servers.github?.url).toBe("https://github.run.tools/mcp");
    expect(mcp.servers.github?.env?.GITHUB_TOKEN).toBe("<set-me>");
  });

  it("installs glama items as MCP scaffolds and checks provider-based updates", async () => {
    const { home, root } = await makeTempRoot();

    await installRemoteItem({
      ref: "glama:systeminit/si",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () =>
        Promise.resolve({
          id: "e2dlqxr1fd",
          name: "System Initiative",
          namespace: "systeminit",
          slug: "si",
          version: "1.0.0",
          description: "System Initiative MCP",
          url: "https://glama.ai/mcp/servers/e2dlqxr1fd",
          attributes: ["hosting:hybrid"],
          environmentVariablesJsonSchema: {
            type: "object",
            required: ["SI_API_TOKEN"],
            properties: {
              SI_API_TOKEN: { type: "string" },
            },
          },
        }),
    });

    const mcp = JSON.parse(
      await readFile(join(root, "mcp", "servers.json"), "utf8")
    ) as {
      servers: Record<
        string,
        { command?: string; env?: Record<string, string> }
      >;
    };
    expect(mcp.servers.si?.command).toBe("<set-command>");
    expect(mcp.servers.si?.env?.SI_API_TOKEN).toBe("<set-me>");

    const report = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () =>
        Promise.resolve({
          id: "e2dlqxr1fd",
          name: "System Initiative",
          namespace: "systeminit",
          slug: "si",
          version: "1.1.0",
          description: "System Initiative MCP",
          url: "https://glama.ai/mcp/servers/e2dlqxr1fd",
          attributes: ["hosting:hybrid"],
          environmentVariablesJsonSchema: {
            type: "object",
            required: ["SI_API_TOKEN"],
            properties: {
              SI_API_TOKEN: { type: "string" },
            },
          },
        }),
    });
    expect(report.checks.some((c) => c.status === "outdated")).toBe(true);
  });

  it("supports clawhub alias search/install/update for skill providers", async () => {
    const { home, root } = await makeTempRoot();

    const rows = await searchRemoteItems({
      query: "release",
      index: "clawhub",
      homeDir: home,
      cwd: home,
      fetchJson: (url) => {
        if (url.includes("/skills?")) {
          return Promise.resolve({
            items: [
              {
                slug: "release-checklist",
                name: "Release Checklist",
                description: "Release operations skill",
                latestVersion: "1.0.0",
                sourceUrl: "https://github.com/acme/release-checklist",
              },
            ],
          });
        }
        if (url.includes("/skills/release-checklist")) {
          return Promise.resolve({
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Release operations skill",
            latestVersion: "1.0.0",
            sourceUrl: "https://github.com/acme/release-checklist",
          });
        }
        if (url.includes("/versions/1.0.0")) {
          return Promise.resolve({
            files: ["SKILL.md", "references/checklist.md"],
          });
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      },
      fetchText: (url) => {
        if (url.includes("path=SKILL.md")) {
          return Promise.resolve("# Release Checklist\n");
        }
        if (url.includes("path=references%2Fchecklist.md")) {
          return Promise.resolve("Use this checklist before release.\n");
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      },
    });

    expect(rows.some((row) => row.item.id === "release-checklist")).toBe(true);

    await installRemoteItem({
      ref: "clawhub:release-checklist",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: (url) => {
        if (url.includes("/skills/release-checklist/versions/1.0.0")) {
          return Promise.resolve({
            files: ["SKILL.md", "references/checklist.md"],
          });
        }
        if (url.includes("/skills/release-checklist")) {
          return Promise.resolve({
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Release operations skill",
            latestVersion: "1.0.0",
            sourceUrl: "https://github.com/acme/release-checklist",
          });
        }
        return Promise.resolve({});
      },
      fetchText: (url) => {
        if (url.includes("path=SKILL.md")) {
          return Promise.resolve("# Release Checklist\n");
        }
        if (url.includes("path=references%2Fchecklist.md")) {
          return Promise.resolve("Use this checklist before release.\n");
        }
        return Promise.resolve("");
      },
    });

    expect(
      await Bun.file(
        join(root, "skills", "release-checklist", "SKILL.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(root, "skills", "release-checklist", "references", "checklist.md")
      ).exists()
    ).toBe(true);

    const report = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: (url) => {
        if (url.includes("/skills/release-checklist")) {
          return Promise.resolve({
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Release operations skill",
            latestVersion: "1.1.0",
            sourceUrl: "https://github.com/acme/release-checklist",
          });
        }
        return Promise.resolve({});
      },
      fetchText: () => Promise.resolve(""),
    });

    expect(report.checks.some((check) => check.status === "outdated")).toBe(
      true
    );
  });

  it("supports skills.sh alias search/install with github raw fallback", async () => {
    const { home, root } = await makeTempRoot();
    const html = `<html><body>{"source":"https://github.com/acme/deploy-skill","skillId":"acme/deploy-skill","name":"Deploy Skill","description":"Ship safely"}</body></html>`;

    const rows = await searchRemoteItems({
      query: "deploy",
      index: "skills.sh",
      homeDir: home,
      cwd: home,
      fetchJson: () => Promise.resolve({}),
      fetchText: () => Promise.resolve(html),
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.item.id).toBe("acme/deploy-skill");
    expect(rows[0]?.item.type).toBe("skill");

    await installRemoteItem({
      ref: "skills.sh:acme/deploy-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
      fetchJson: () => Promise.resolve({}),
      fetchText: (url) => {
        if (url.includes("skills.sh")) {
          return Promise.resolve(html);
        }
        if (
          url.includes(
            "raw.githubusercontent.com/acme/deploy-skill/main/SKILL.md"
          )
        ) {
          return Promise.resolve("# Deploy Skill\n\nUse safe deploy steps.\n");
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      },
    });

    const skill = await readFile(
      join(root, "skills", "deploy-skill", "SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("# Deploy Skill");
  });

  it("enforces source trust policies for install and update checks", async () => {
    const { home, root } = await makeTempRoot();
    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });

    const indexPath = join(home, "local-index.json");
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          items: [
            {
              id: "ops-skill",
              type: "skill",
              version: "1.0.0",
              skill: {
                name: "ops-skill",
                files: {
                  "SKILL.md": "# Ops Skill\n",
                },
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [{ name: "local", url: indexPath }],
        },
        null,
        2
      )}\n`
    );

    await withMutedConsole(async () => {
      await sourcesCommand(["block", "local"], { homeDir: home, cwd: home });
    });

    await expect(
      installRemoteItem({
        ref: "local:ops-skill",
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(BLOCKED_BY_POLICY_RE);

    await withMutedConsole(async () => {
      await sourcesCommand(["trust", "local"], { homeDir: home, cwd: home });
    });

    await installRemoteItem({
      ref: "local:ops-skill",
      homeDir: home,
      rootDir: root,
      cwd: home,
    });

    await withMutedConsole(async () => {
      await sourcesCommand(["review", "local"], { homeDir: home, cwd: home });
    });

    await expect(
      installRemoteItem({
        ref: "local:ops-skill",
        as: "ops-skill-strict",
        strictSourceTrust: true,
        homeDir: home,
        rootDir: root,
        cwd: home,
      })
    ).rejects.toThrow(REQUIRES_REVIEW_RE);

    await withMutedConsole(async () => {
      await sourcesCommand(["block", "local"], { homeDir: home, cwd: home });
    });
    const blockedReport = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      apply: true,
    });
    expect(
      blockedReport.checks.some((check) => check.status === "blocked-source")
    ).toBe(true);

    await withMutedConsole(async () => {
      await sourcesCommand(["review", "local"], { homeDir: home, cwd: home });
    });
    const strictReport = await checkRemoteUpdates({
      homeDir: home,
      rootDir: root,
      cwd: home,
      strictSourceTrust: true,
    });
    expect(
      strictReport.checks.some((check) => check.status === "review-source")
    ).toBe(true);
  });
});

describe("templates command", () => {
  it("scaffolds templates through the DX command", async () => {
    const { home, root } = await makeTempRoot();
    process.chdir(home);

    await withMutedConsole(async () => {
      await templatesCommand(["init", "skill", "dx-skill"], {
        homeDir: home,
        rootDir: root,
        cwd: home,
      });
      await templatesCommand(["init", "agents"], {
        homeDir: home,
        rootDir: root,
        cwd: home,
      });
    });

    expect(
      await Bun.file(join(root, "skills", "dx-skill", "SKILL.md")).exists()
    ).toBe(true);
    expect(await Bun.file(join(root, "agents", "AGENTS.md")).exists()).toBe(
      true
    );
    expect(process.exitCode).toBe(0);
  });

  it("scaffolds the builtin project-ai pack into a repo-local .ai", async () => {
    const { home } = await makeTempRoot();
    const repoDir = join(home, "repo");
    await mkdir(repoDir, { recursive: true });
    process.chdir(repoDir);

    await withMutedConsole(async () => {
      await templatesCommand(["init", "project-ai"], {
        homeDir: home,
        cwd: repoDir,
      });
    });

    expect(
      await Bun.file(
        join(
          repoDir,
          ".ai",
          "skills",
          "project-operating-layer-design",
          "SKILL.md"
        )
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(repoDir, ".ai", "instructions", "PROJECT_CAPABILITY.md")
      ).exists()
    ).toBe(true);
    const evolutionText = await Bun.file(
      join(repoDir, ".ai", "instructions", "EVOLUTION.md")
    ).text();
    expect(evolutionText).toContain("fclt ai writeback add");
    expect(evolutionText).toContain("Current supported proposal kinds");

    const skillText = await Bun.file(
      join(repoDir, ".ai", "skills", "capability-evolution", "SKILL.md")
    ).text();
    expect(skillText).toContain("Proposal Kind Selection");
    expect(skillText).toContain("fclt ai evolve draft EV-00001 --append");
    expect(
      await Bun.file(
        join(repoDir, ".ai", ".facult", "ai", "index.json")
      ).exists()
    ).toBe(true);
  });
});

describe("sources command", () => {
  it("lists default and explicit source policies", async () => {
    const { home } = await makeTempRoot();
    process.chdir(home);

    await mkdir(join(home, ".ai", ".facult"), { recursive: true });
    const indexPath = join(home, "local-index.json");
    await writeFile(indexPath, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    await writeFile(
      join(home, ".ai", ".facult", "indices.json"),
      `${JSON.stringify(
        {
          indices: [{ name: "local", url: indexPath }],
        },
        null,
        2
      )}\n`
    );

    await withMutedConsole(async () => {
      await sourcesCommand(["trust", "local", "--note", "reviewed"], {
        homeDir: home,
        cwd: home,
      });
    });

    const { logs, errors } = await withCapturedConsole(async () => {
      await sourcesCommand(["list", "--json"], {
        homeDir: home,
        cwd: home,
      });
    });
    expect(errors.length).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as {
      source: string;
      level: string;
      explicit: boolean;
      note?: string;
    }[];

    const local = parsed.find((row) => row.source === "local");
    expect(local?.level).toBe("trusted");
    expect(local?.explicit).toBe(true);
    expect(local?.note).toBe("reviewed");

    const builtin = parsed.find((row) => row.source === "facult");
    expect(builtin?.level).toBe("trusted");
    expect(builtin?.explicit).toBe(false);
  });
});

describe("verify-source command", () => {
  it("reports trust and integrity checks for manifest sources", async () => {
    const { home } = await makeTempRoot();
    process.chdir(home);

    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });
    const indexPath = join(home, "local-index.json");
    const manifestText = `${JSON.stringify(
      {
        items: [
          {
            id: "verify-skill",
            type: "skill",
            version: "1.0.0",
            skill: {
              name: "verify-skill",
              files: { "SKILL.md": "# verify\n" },
            },
          },
        ],
      },
      null,
      2
    )}\n`;
    await writeFile(indexPath, manifestText);
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "local",
              url: indexPath,
              integrity: `sha256:${sha256Hex(manifestText)}`,
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await withMutedConsole(async () => {
      await sourcesCommand(["trust", "local"], { homeDir: home, cwd: home });
    });

    const { logs, errors } = await withCapturedConsole(async () => {
      await verifySourceCommand(["local", "--json"], {
        homeDir: home,
        cwd: home,
      });
    });
    expect(errors.length).toBe(0);
    const report = JSON.parse(logs.join("\n")) as {
      source: { name: string; kind: string };
      trust: { level: string; explicit: boolean };
      checks: {
        fetch: string;
        parse: string;
        integrity: string;
        signature: string;
        items: number;
      };
      error?: string;
    };
    expect(report.source.name).toBe("local");
    expect(report.source.kind).toBe("manifest");
    expect(report.trust.level).toBe("trusted");
    expect(report.trust.explicit).toBe(true);
    expect(report.checks.fetch).toBe("passed");
    expect(report.checks.parse).toBe("passed");
    expect(report.checks.integrity).toBe("passed");
    expect(report.checks.signature).toBe("not-configured");
    expect(report.checks.items).toBe(1);
    expect(report.error).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("returns a failing status when verification checks fail", async () => {
    const { home } = await makeTempRoot();
    process.chdir(home);

    const stateDir = join(home, ".ai", ".facult");
    await mkdir(stateDir, { recursive: true });
    const indexPath = join(home, "local-index.json");
    await writeFile(indexPath, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    await writeFile(
      join(stateDir, "indices.json"),
      `${JSON.stringify(
        {
          indices: [
            {
              name: "local",
              url: indexPath,
              integrity:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const { logs, errors } = await withCapturedConsole(async () => {
      await verifySourceCommand(["local", "--json"], {
        homeDir: home,
        cwd: home,
      });
    });
    expect(errors.length).toBe(0);
    const report = JSON.parse(logs.join("\n")) as {
      checks: { integrity: string };
      error?: string;
    };
    expect(report.checks.integrity).toBe("failed");
    expect(report.error).toMatch(INTEGRITY_CHECK_FAILED_RE);
    expect(process.exitCode).toBe(1);
  });
});
