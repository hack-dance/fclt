import { withoutLocalGitEnvironment } from "../src/util/git-environment";

const sanitized = withoutLocalGitEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!(name in sanitized)) {
    delete process.env[name];
  }
}
