import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TRANSCRIPT_TURN_MARKER, type TranscriptTimelineEntry } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

async function createTimeline() {
	const terminal = new VirtualTerminal(80, 12);
	const tui = new TuiAltScreen(terminal);
	const entries: TranscriptTimelineEntry[] = Array.from({ length: 4 }, (_, index) => ({
		preview: `question ${index}`,
		timestamp: 1700000000000 + index * 1000,
	}));
	const document = new Text(
		entries
			.flatMap((entry, index) => [
				TRANSCRIPT_TURN_MARKER + entry.preview,
				...Array.from({ length: 5 }, (_, line) => `answer ${index}, line ${line}`),
			])
			.join("\n"),
		0,
		0,
	);
	const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar: "auto" });
	const inputs: string[] = [];
	const editor = {
		render: () => ["editor", "footer"],
		invalidate() {},
		handleInput: (data: string) => inputs.push(data),
	};
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1 },
		{ component: editor, basis: "auto" },
	]);
	let previews = 0;
	const options = {
		getEntries: () => entries,
		styleTick: (text: string) => text,
		renderPreview: (entry: TranscriptTimelineEntry) => {
			previews++;
			return new Text(`${entry.timestamp}\n${entry.preview}`, 0, 0);
		},
	};
	const mount = () => {
		tui.setLayoutRoot(root);
		tui.setTimeline(options);
	};
	mount();
	tui.setMouseHoverEnabled(true);
	tui.setFocus(editor);
	tui.start();
	await terminal.waitForRender();
	const ticks = () => terminal.getViewport().flatMap((line, row) => (/(?:━━| ─|──)$/.test(line) ? [row] : []));
	return { tui, terminal, scroll, entries, editor, inputs, previews: () => previews, mount, ticks };
}

describe("fullscreen conversation timeline", () => {
	it("waits for the configured delay without restarting when the pointer moves inside the same tick", async (context) => {
		const h = await createTimeline();
		context.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			h.tui.setHoverPreviewDelay(2000);
			const row = h.ticks()[0] + 1;
			h.terminal.sendInput(`\x1b[<35;80;${row}M`);
			assert.equal(h.tui.hasOverlay(), false);
			context.mock.timers.tick(1999);
			assert.equal(h.tui.hasOverlay(), false);
			h.terminal.sendInput(`\x1b[<35;79;${row}M`);
			context.mock.timers.tick(1);
			assert.equal(h.tui.hasOverlay(), true);
			assert.equal(h.tui.getFocusedComponent(), h.editor);
		} finally {
			h.tui.stop();
		}
	});

	for (const cancellation of [
		"leave",
		"key",
		"wheel",
		"resize",
		"dialog",
		"transcript",
		"focus",
		"stop",
		"disable",
	] as const) {
		it(`cancels a pending preview on ${cancellation}`, async (context) => {
			const h = await createTimeline();
			context.mock.timers.enable({ apis: ["setTimeout"] });
			try {
				h.tui.setHoverPreviewDelay(2000);
				h.terminal.sendInput(`\x1b[<35;80;${h.ticks()[0] + 1}M`);
				context.mock.timers.tick(1000);
				switch (cancellation) {
					case "leave":
						h.terminal.sendInput("\x1b[<35;5;12M");
						break;
					case "key":
						h.terminal.sendInput("Z");
						break;
					case "wheel":
						h.terminal.sendInput("\x1b[<64;5;2M");
						break;
					case "resize":
						h.terminal.resize(40, 12);
						break;
					case "dialog": {
						const dialog = h.tui.showOverlay({ render: () => ["dialog"], invalidate() {}, handleInput() {} });
						h.tui.renderNow();
						dialog.hide();
						break;
					}
					case "transcript":
						h.tui.setLayoutRoot(new Text("other transcript", 0, 0));
						break;
					case "focus":
						h.terminal.sendInput("\x1b[O");
						break;
					case "stop":
						h.tui.stop();
						break;
					case "disable":
						h.tui.setMouseHoverEnabled(false);
						break;
				}
				context.mock.timers.tick(2000);
				assert.equal(h.tui.hasOverlay(), false);
			} finally {
				h.tui.stop();
			}
		});
	}

	it("restarts the delay for another tick and rejects invalid timer values", async (context) => {
		const h = await createTimeline();
		context.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			h.tui.setHoverPreviewDelay(2000);
			h.terminal.sendInput(`\x1b[<35;80;${h.ticks()[0] + 1}M`);
			context.mock.timers.tick(1500);
			h.terminal.sendInput(`\x1b[<35;80;${h.ticks()[1] + 1}M`);
			context.mock.timers.tick(1999);
			assert.equal(h.tui.hasOverlay(), false);
			context.mock.timers.tick(1);
			assert.equal(h.tui.hasOverlay(), true);
			for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 0x80000000]) {
				assert.throws(() => h.tui.setHoverPreviewDelay(delay), RangeError);
			}
		} finally {
			h.tui.stop();
		}
	});

	it("shows one tick per turn, highlights the current turn, and jumps to the clicked turn", async () => {
		const h = await createTimeline();
		try {
			assert.equal(h.ticks().length, 4);
			assert.ok(h.terminal.getViewport()[h.ticks()[2]].endsWith("━━"));
			const first = h.ticks()[0] + 1;
			h.terminal.sendInput(`\x1b[<0;80;${first}M`);
			h.terminal.sendInput(`\x1b[<0;80;${first}m`);
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 0);
			assert.ok(h.terminal.getViewport()[0].startsWith("question 0"));
			assert.ok(h.terminal.getViewport()[h.ticks()[0]].endsWith("━━"));
			assert.equal(h.tui.getFocusedComponent(), h.editor);
			assert.equal(h.scroll.isFollowingEnd, false);
		} finally {
			h.tui.stop();
		}
	});

	it("uses chevrons and configurable keyboard navigation for turns", async () => {
		const h = await createTimeline();
		try {
			h.tui.scrollToTop();
			await h.terminal.waitForRender();
			const down = h.terminal.getViewport().findIndex((line) => line.endsWith("▼"));
			h.terminal.sendInput(`\x1b[<0;80;${down + 1}M`);
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 6);
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.altScreen.previousPrompt": "ctrl+u",
					"tui.altScreen.nextPrompt": "ctrl+d",
				}),
			);
			h.terminal.sendInput("\x15");
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 0);
			h.terminal.sendInput("\x04");
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 6);
		} finally {
			h.tui.stop();
		}
	});

	it("aligns a short final turn to the top and scrolls away without snapping", async () => {
		const h = await createTimeline();
		try {
			const last = h.ticks().at(-1)!;
			h.terminal.sendInput(`\x1b[<0;80;${last + 1}M`);
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 18);
			assert.ok(h.terminal.getViewport()[0].startsWith("question 3"));
			assert.equal(h.scroll.isFollowingEnd, false);
			h.terminal.sendInput("\x1b[<64;5;2M");
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 17);
			h.tui.scrollToBottom();
			await h.terminal.waitForRender();
			assert.equal(h.scroll.scrollTop, 14);
			assert.equal(h.scroll.isFollowingEnd, true);
		} finally {
			h.tui.stop();
		}
	});

	it("previews a turn and time without moving the viewport or capturing editor input", async () => {
		const h = await createTimeline();
		try {
			const before = h.scroll.scrollTop;
			h.terminal.sendInput(`\x1b[<35;80;${h.ticks()[0] + 1}M`);
			await h.terminal.waitForRender();
			assert.ok(h.terminal.getViewport().join("\n").includes("1700000000000"));
			assert.ok(h.terminal.getViewport().join("\n").includes("question 0"));
			assert.equal(h.scroll.scrollTop, before);
			assert.equal(h.tui.getFocusedComponent(), h.editor);
			h.terminal.sendInput("Z");
			await h.terminal.waitForRender();
			assert.deepEqual(h.inputs, ["Z"]);
			assert.equal(h.tui.hasOverlay(), false);
		} finally {
			h.tui.stop();
		}
	});

	it("hides previews and the rail on narrow resize, then restores the rail", async () => {
		const h = await createTimeline();
		try {
			h.terminal.sendInput(`\x1b[<35;80;${h.ticks()[0] + 1}M`);
			await h.terminal.waitForRender();
			h.terminal.resize(40, 12);
			await h.terminal.waitForRender();
			assert.equal(h.tui.hasOverlay(), false);
			assert.equal(h.scroll.rightGutterWidth, 0);
			assert.ok(!h.terminal.getViewport().some((line) => line.endsWith("▲")));
			h.terminal.resize(80, 12);
			await h.terminal.waitForRender();
			assert.equal(h.ticks().length, 4);
			assert.equal(h.scroll.rightGutterWidth, 2);
		} finally {
			h.tui.stop();
		}
	});

	it("drops previews when the transcript is replaced and does not cover focused dialogs", async () => {
		const h = await createTimeline();
		try {
			h.terminal.sendInput(`\x1b[<35;80;${h.ticks()[0] + 1}M`);
			await h.terminal.waitForRender();
			assert.ok(h.tui.hasOverlay());
			h.tui.setLayoutRoot(new Text("another transcript", 0, 0));
			await h.terminal.waitForRender();
			assert.equal(h.tui.hasOverlay(), false);
			h.mount();
			await h.terminal.waitForRender();
			const overlay = h.tui.showOverlay(
				{ render: () => ["dialog"], invalidate() {}, handleInput() {} },
				{ width: 30 },
			);
			await h.terminal.waitForRender();
			const before = h.previews();
			h.terminal.sendInput("\x1b[<35;80;4M");
			await h.terminal.waitForRender();
			assert.equal(h.previews(), before);
			assert.ok(h.terminal.getViewport().join("\n").includes("dialog"));
			overlay.hide();
		} finally {
			h.tui.stop();
		}
	});
});
