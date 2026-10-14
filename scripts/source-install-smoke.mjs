// Copied into the isolated installation so all imports resolve against its packages.
import assert from "node:assert/strict";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

initTheme("dark");
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const grokUi = await jiti.import(join(process.env.PI_CODING_AGENT_DIR, "extensions", "grok-ui.js"), { default: true });
let start;
grokUi({
	registerMarkdownTransformer() {},
	registerToolRenderer() {},
	registerCommand() {},
	on(name, handler) { if (name === "session_start") start = handler; },
});
assert.equal(typeof start, "function");
const tui = new TuiAltScreen({ columns: 80, rows: 24 });
// Supply layout bounds without starting a terminal or reading stdin.
Object.defineProperty(tui, "transcriptViewportHeight", { value: 12 });
let timeline;
tui.setTimeline = (options) => { timeline = options; };
const identity = (_color, text) => text;
await start({}, {
	mode: "tui",
	ui: {
		theme: { fg: identity, bg: identity },
		notify(message) { throw new Error(message); },
		setHeader(factory) { factory(tui); },
		setEditorComponent() {},
	},
});
assert.ok(timeline);
const rendered = timeline.renderPreview({ preview: "source install preview", timestamp: 1700000000000 }).render(60);
assert.ok(rendered.join("\n").includes("source install preview"));
console.log("Installed Grok timeline preview passed.");
