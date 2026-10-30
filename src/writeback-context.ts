import { join } from "node:path";
import { resolveCliContextRoot } from "./cli-context";
import {
  canonicalProjectAiRoot,
  facultRootDir,
  projectRootFromAiRoot,
} from "./paths";
import { resolveWritebackProject } from "./projects";
import { writebackWarnings } from "./writeback-arrays";

export async function resolveWritebackContext(
  args: NonNullable<Parameters<typeof resolveCliContextRoot>[0]>
): Promise<{
  rootDir: string;
  projectTag?: string;
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
  const rootDir = resolveCliContextRoot({ ...args, scope: "global" });
  if (args.scope === "project") {
    const warning = `Using global destination ${rootDir} with tag ${project.tag}; no trusted enrolled checkout was found. Use --root for an explicit destination.`;
    const reported = writebackWarnings.getStore();
    if (!reported?.has(warning)) {
      console.error(`Warning: ${warning}`);
      reported?.add(warning);
    }
  }
  return {
    rootDir,
    projectTag: project.tag,
  };
}
