import { withoutLocalGitEnvironment } from "../src/util/git-environment";

process.env.FCLT_ALLOW_LEGACY_MANAGED_MUTATION = "1";

const sanitized = withoutLocalGitEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!(name in sanitized)) {
    delete process.env[name];
  }
}
