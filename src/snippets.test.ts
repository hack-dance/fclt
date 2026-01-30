import { describe, expect, it } from "bun:test";
import {
  validateSnippetMarkerName,
  validateSnippetMarkersInText,
} from "./snippets";

describe("validateSnippetMarkerName", () => {
  it("accepts valid marker names", () => {
    const valid = [
      "alpha",
      "alpha-beta",
      "alpha_beta",
      "alpha/beta",
      "alpha/beta_gamma",
      "a1_b2-c3/d4",
    ];
    for (const name of valid) {
      expect(validateSnippetMarkerName(name)).toBeNull();
    }
  });

  it("rejects invalid marker names", () => {
    const invalid = [
      "",
      " alpha",
      "alpha ",
      "alpha beta",
      "/alpha",
      "alpha/",
      "alpha//beta",
      "alpha..",
      "../alpha",
      "alpha/../beta",
      "alpha\\beta",
      "alpha:beta",
    ];

    for (const name of invalid) {
      expect(validateSnippetMarkerName(name)).not.toBeNull();
    }
  });
});

describe("validateSnippetMarkersInText", () => {
  it("returns errors with file path and line number", () => {
    const text = [
      "line 1",
      "<!-- fclty:good/name -->",
      "<!-- fclty:bad name -->",
      "<!-- /fclty:good/name -->",
    ].join("\n");

    const errors = validateSnippetMarkersInText(text, "/tmp/file.md");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("/tmp/file.md:3");
    expect(errors[0]).toContain("invalid snippet marker name");
  });
});
