import { expect, test } from "bun:test";

test("test preload removes repository-local Git context", () => {
  expect(process.env.GIT_DIR).toBeUndefined();
  expect(process.env.GIT_WORK_TREE).toBeUndefined();
  expect(process.env.GIT_COMMON_DIR).toBeUndefined();
  expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  expect(process.env.GIT_CEILING_DIRECTORIES).toBeUndefined();
});
