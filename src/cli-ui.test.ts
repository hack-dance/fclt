import { describe, expect, it } from "bun:test";
import {
  renderCatalog,
  renderKeyValue,
  renderPage,
  renderTable,
} from "./cli-ui";

describe("renderTable", () => {
  it("renders aligned headers and rows", () => {
    const lines = renderTable({
      headers: ["Name", "Type"],
      rows: [["alpha", "skill"]],
    });

    expect(lines[0]).toContain("Name");
    expect(lines[0]).toContain("Type");
    expect(lines[2]).toContain("alpha");
    expect(lines[2]).toContain("skill");
  });
});

describe("renderPage", () => {
  it("renders titled sections", () => {
    const page = renderPage({
      title: "fclt list",
      subtitle: "1 matching entry",
      sections: [
        {
          title: "Entries",
          lines: ["alpha"],
        },
      ],
    });

    expect(page).toContain("fclt list");
    expect(page).toContain("1 matching entry");
    expect(page).toContain("Entries");
    expect(page).toContain("alpha");
  });
});

describe("renderCatalog", () => {
  it("renders catalog items with metadata and descriptions", () => {
    const lines = renderCatalog([
      {
        title: "alpha",
        meta: "global/project",
        badges: ["[trusted]"],
        description: "A clear description for alpha.",
      },
    ]);

    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("global/project");
    expect(lines[1]).toContain("[trusted]");
    expect(lines[2]).toContain("A clear description");
  });
});

describe("renderKeyValue", () => {
  it("renders aligned labels", () => {
    const lines = renderKeyValue([
      ["type", "skill"],
      ["path", "/tmp/alpha"],
    ]);

    expect(lines[0]).toContain("type");
    expect(lines[0]).toContain("skill");
    expect(lines[1]).toContain("path");
    expect(lines[1]).toContain("/tmp/alpha");
  });
});
