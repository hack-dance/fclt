import { expect, test } from "bun:test";
import { parseJsonLenient } from "./json";

test("parseJsonLenient parses strict JSON", () => {
  const obj = parseJsonLenient('{"a":1,"b":["x"]}') as any;
  expect(obj).toEqual({ a: 1, b: ["x"] });
});

test("parseJsonLenient parses JSONC with comments and trailing commas", () => {
  const obj = parseJsonLenient(`
  {
    // a comment
    "mcpServers": {
      "filesystem": { "command": "node", "args": ["x"], },
    },
  }
  `) as any;

  expect(obj?.mcpServers?.filesystem?.command).toBe("node");
  expect(obj?.mcpServers?.filesystem?.args).toEqual(["x"]);
});
