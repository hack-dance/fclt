import { join } from "node:path";
import { resolveCliContextRoot } from "./cli-context";
import {
  canonicalProjectAiRoot,
  facultRootDir,
  projectRootFromAiRoot,
} from "./paths";
import { resolveWritebackProject } from "./projects";

export async function resolveWritebackContext(
  args: NonNullable<Parameters<typeof resolveCliContextRoot>[0]>
): Promise<{
  rootDir: string;
  projectTag?: string;
  assetProjectRoot?: string;
}> {
  const homeDir = args.homeDir ?? process.env.HOME ?? "";
  if (args.scope === "global") {
    return { rootDir: resolveCliContextRoot(args) };
  }
  const environmentRootSelected =
    process.env.FACULT_ROOT_DIR?.trim() &&
    (args.scope !== "project" ||
      (process.env.FACULT_ROOT_SCOPE?.trim() === "project" &&
        projectRootFromAiRoot(facultRootDir(homeDir), homeDir)));
  if (args.rootArg || environmentRootSelected) {
    return {
      rootDir: canonicalProjectAiRoot(resolveCliContextRoot(args), homeDir),
    };
  }
  const project = await resolveWritebackProject({
    cwd: args.cwd ?? process.cwd(),
    homeDir,
  });
  if (!project) {
    return { rootDir: resolveCliContextRoot(args) };
  }
  if (project.enrolledRoot) {
    return { rootDir: join(project.enrolledRoot, ".ai") };
  }
  return {
    rootDir: resolveCliContextRoot({ ...args, scope: "global" }),
    projectTag: project.tag,
    assetProjectRoot: project.repositoryRoot,
  };
}
