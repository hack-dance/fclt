import {
  type AutoDecision,
  type AutoMode,
  type ConflictMeta,
  decideAuto,
  hashesMatch,
} from "./conflicts";

export type ConflictDecision = AutoDecision | "skip";

export interface PromptConflictResolutionArgs {
  title: string;
  currentLabel: string;
  incomingLabel: string;
  currentContent: string;
  incomingContent: string;
}

export interface ResolveConflictActionArgs {
  title: string;
  currentLabel: string;
  incomingLabel: string;
  currentContent: string | null;
  incomingContent: string | null;
  currentHash: string | null;
  incomingHash: string | null;
  autoMode: AutoMode | undefined;
  currentMeta: ConflictMeta;
  incomingMeta: ConflictMeta;
  promptConflictResolution: (
    args: PromptConflictResolutionArgs
  ) => Promise<ConflictDecision>;
}

export async function resolveConflictAction(
  args: ResolveConflictActionArgs
): Promise<ConflictDecision> {
  if (!args.currentContent) {
    return "keep-incoming";
  }
  if (!args.incomingContent) {
    return "keep-current";
  }
  if (hashesMatch(args.currentHash, args.incomingHash)) {
    return "keep-current";
  }
  if (args.autoMode) {
    return decideAuto(args.autoMode, args.currentMeta, args.incomingMeta);
  }
  return await args.promptConflictResolution({
    title: args.title,
    currentLabel: args.currentLabel,
    incomingLabel: args.incomingLabel,
    currentContent: args.currentContent,
    incomingContent: args.incomingContent,
  });
}
