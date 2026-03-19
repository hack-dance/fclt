import { describe, expect, it } from "bun:test";
import { renderHomebrewFormula } from "./render-homebrew-formula";

describe("renderHomebrewFormula", () => {
  it("renders a binary formula for fclt with a facult alias", () => {
    const formula = renderHomebrewFormula("2.0.0", {
      darwinArm64:
        "b0dee9e2b955a1c31f1771fdf4dc62cb3a89df42c704be5820839052d3b6bfbc",
      darwinX64:
        "6f705a974cc88f304b0d9f768a88e4cd599edf8d791967969164bcd3740c8200",
      linuxX64:
        "4b614cb5cdbcb72d02bfe1f38ec4bfab57b7bb8494ce9902781c876de508b4f5",
    });

    expect(formula).toContain("class Fclt < Formula");
    expect(formula).toContain(
      'url "https://github.com/hack-dance/fclt/releases/download/v2.0.0/fclt-2.0.0-darwin-arm64"'
    );
    expect(formula).toContain('bin.install cached_download => "fclt"');
    expect(formula).toContain('bin.install_symlink "fclt" => "facult"');
  });
});
