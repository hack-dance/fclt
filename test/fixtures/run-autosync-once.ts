import { runGitAutosyncOnce } from "../../src/autosync";

const [rootDir] = process.argv.slice(2);
if (!rootDir) {
  throw new Error("Expected an autosync repository path.");
}

const result = await runGitAutosyncOnce({
  config: {
    version: 1,
    name: "isolation-probe",
    tool: "codex",
    rootDir,
    debounceMs: 100,
    git: {
      enabled: true,
      remote: "origin",
      branch: "main",
      intervalMinutes: 60,
      autoCommit: true,
      commitPrefix: "chore(facult-autosync)",
      source: "isolation-probe",
    },
  },
});

console.log(JSON.stringify(result));
