import { describe, expect, it } from "bun:test";
import { parseFindArgs, parseGraphArgs, parseListArgs } from "./index";

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

  it("accepts instructions as a list type", () => {
    const opts = parseListArgs(["instructions", "--json"]);
    expect(opts.kind).toBe("instructions");
    expect(opts.json).toBe(true);
  });
});

describe("parseFindArgs", () => {
  it("parses text query and json flag", () => {
    const opts = parseFindArgs(["feedback", "loops", "--json"]);
    expect(opts).toEqual({
      text: "feedback loops",
      json: true,
    });
  });
});

describe("parseGraphArgs", () => {
  it("defaults to show when only an asset is provided", () => {
    const opts = parseGraphArgs(["skills:alpha"]);

    expect(opts).toEqual({
      kind: "show",
      target: "skills:alpha",
      json: false,
    });
  });

  it("parses explicit graph modes", () => {
    const opts = parseGraphArgs(["deps", "skills:alpha", "--json"]);

    expect(opts).toEqual({
      kind: "deps",
      target: "skills:alpha",
      json: true,
    });
  });
});
