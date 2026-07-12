export const LEGACY_MANAGED_MUTATION_FLAG = "--allow-legacy-managed-mutation";
export const LEGACY_MANAGED_MUTATION_ENV = "FCLT_ALLOW_LEGACY_MANAGED_MUTATION";

const ENABLED_ENV_VALUES = new Set(["1", "true", "yes"]);

export function legacyManagedMutationApproved(args?: {
  argv?: string[];
  explicit?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (args?.explicit !== undefined) {
    return args.explicit;
  }
  if (args?.argv?.includes(LEGACY_MANAGED_MUTATION_FLAG)) {
    return true;
  }
  const value = (args?.env ?? process.env)[LEGACY_MANAGED_MUTATION_ENV]?.trim();
  return value ? ENABLED_ENV_VALUES.has(value.toLowerCase()) : false;
}

export function legacyManagedMutationNotice(action: string): string {
  return `${action} is a deprecated broad managed-mode mutation. Preview and inventory remain available, but apply is contained until transaction-safe per-asset deployment ships.`;
}

export function assertLegacyManagedMutationAllowed(args: {
  action: string;
  approved?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  safeAlternative?: string;
}): void {
  if (args.dryRun) {
    return;
  }
  if (
    legacyManagedMutationApproved({
      explicit: args.approved,
      env: args.env,
    })
  ) {
    return;
  }
  const safeAlternative = args.safeAlternative ?? "--dry-run";
  throw new Error(
    `${legacyManagedMutationNotice(args.action)} Use ${safeAlternative}, or rerun with ${LEGACY_MANAGED_MUTATION_FLAG} (or ${LEGACY_MANAGED_MUTATION_ENV}=1) only for an explicitly reviewed legacy migration.`
  );
}
