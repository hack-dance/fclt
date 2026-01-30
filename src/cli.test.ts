import { describe, expect, it } from "bun:test";
import { parseListArgs } from "./index";

describe("parseListArgs", () => {
  it("parses list options and filters", () => {
    const opts = parseListArgs([
      "mcp",
      "--enabled-for",
      "cursor",
      "--untrusted",
      "--flagged",
      "--json",
    ]);

    expect(opts).toEqual({
      kind: "mcp",
      filters: {
        enabledFor: "cursor",
        untrusted: true,
        flagged: true,
      },
      json: true,
    });
  });

  it("defaults to skills when no type provided", () => {
    const opts = parseListArgs([]);
    expect(opts.kind).toBe("skills");
  });
});
