import { BoxRenderable, SelectRenderable, TextRenderable, createCliRenderer, type KeyEvent, type SelectOption } from "@opentui/core";
import type { ScanResult } from "./scan";
import { computeSkillOccurrences } from "./util/skills";

export async function runSkillsTui(res: ScanResult): Promise<void> {
  const renderer = await createCliRenderer({
    // Keep default exit-on-ctrl+c behavior.
    exitOnCtrlC: true,
  });

  renderer.setBackgroundColor("#001122");

  const width = renderer.width;
  const height = renderer.height;

  const container = new BoxRenderable(renderer, {
    id: "container",
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height,
    borderStyle: "double",
    borderColor: "#4CC9F0",
    title: "tacklebox scan — skills",
    titleAlignment: "center",
    backgroundColor: "#001122",
  });

  const hint = new TextRenderable(renderer, {
    id: "hint",
    position: "absolute",
    left: 2,
    top: 1,
    width: Math.max(10, width - 4),
    height: 1,
    fg: "#E0FBFC",
    content: "↑/↓ or j/k to scroll • Enter to copy name • q / Esc to quit",
  });

  const occurrences = computeSkillOccurrences(res);
  const options: SelectOption[] = occurrences.map((o) => ({
    name: `${o.name}  (${o.count})`,
    description: o.locations.join(" · "),
    value: o.name,
  }));

  const select = new SelectRenderable(renderer, {
    id: "skills",
    position: "absolute",
    left: 1,
    top: 3,
    width: Math.max(10, width - 2),
    height: Math.max(5, height - 4),
    options,
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: true,
  });

  // Focus so it receives key input.
  select.focus();

  // Key handling: quit + enter to copy.
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    if (key.name === "escape" || key.name === "q") {
      renderer.destroy();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      const opt = select.getSelectedOption();
      const value = typeof opt?.value === "string" ? opt.value : "";
      if (value) {
        // Best-effort clipboard support (macOS pbcopy).
        try {
          await Bun.$`printf %s ${value} | pbcopy`.quiet();
        } catch {
          // ignore
        }
      }
    }
  });

  renderer.root.add(container);
  renderer.root.add(hint);
  renderer.root.add(select);

  // Keep it live for smoother scrolling.
  renderer.start();

  // Wait until renderer destroys (q/esc/ctrl+c).
  await renderer.idle();
}
