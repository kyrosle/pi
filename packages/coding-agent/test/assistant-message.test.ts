import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isImageLine, Markdown, Text, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

function clickRenderedRow(component: AssistantMessageComponent, text: string, width = 120) {
	const lines = component.render(width);
	const y = lines.findIndex((line) => stripAnsi(line).includes(text));
	expect(y).toBeGreaterThanOrEqual(0);
	return component.handleMouse({
		type: "click",
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	});
}

describe("AssistantMessageComponent", () => {
	test.each(["collapsed", "summary", "expanded"] as const)(
		"reuses %s history without walking its children and refreshes on content, width, and theme changes",
		(mode) => {
			initTheme("dark");
			const message = createAssistantMessage([
				{ type: "thinking", thinking: "Inspect the cache\n\nVerify the result" },
				{ type: "text", text: "Answer" },
			]);
			const component = new AssistantMessageComponent(message, mode);
			const childRender = vi.spyOn(component.children[0], "render");
			const first = component.render(80);
			for (let frame = 0; frame < 20; frame++) expect(component.render(80)).toBe(first);
			expect(childRender).toHaveBeenCalledTimes(1);
			expect(first.join("").split(OSC133_ZONE_START)).toHaveLength(2);

			component.render(40);
			expect(childRender).toHaveBeenCalledTimes(2);
			component.invalidate();
			component.render(40);
			expect(childRender).toHaveBeenCalledTimes(3);
			message.content.push({ type: "text", text: "Updated answer" });
			component.updateContent(message, false);
			expect(stripAnsi(component.render(40).join("\n"))).toContain("Updated answer");
			expect(childRender).toHaveBeenCalledTimes(4);
			component.setThinkingViewMode(mode === "expanded" ? "summary" : "expanded");
			component.render(40);
			expect(childRender).toHaveBeenCalledTimes(5);
			childRender.mockRestore();
		},
	);

	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking Steps");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking Steps/g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("renders nothing for hidden thinking with an empty label", () => {
		initTheme("dark");

		const thinkingOnly = new AssistantMessageComponent(
			createAssistantMessage(
				[
					{ type: "thinking", thinking: "reasoning" },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
				],
				{ stopReason: "toolUse" },
			),
			true,
			undefined,
			"",
		);
		expect(thinkingOnly.render(80)).toEqual([]);

		const withText = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			true,
			undefined,
			"",
		);
		expect(withText.render(80).map((line) => stripAnsi(line).trim())).toEqual(["", "answer"]);
	});

	test("keeps label row and spacing for hidden thinking with a label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		expect(component.render(80).map((line) => stripAnsi(line).trim())).toEqual(["", "Thinking...", "", "answer"]);
	});

	test("collapses individual thinking runs when clicked", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
			"expanded",
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) => stripAnsi(line).includes("first reasoning"));
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: firstThinkingRow,
			screenX: 1,
			screenY: firstThinkingRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).toContain("Thinking Steps · Summary · 1 step");
		expect(collapsed).toContain("└─ · Step 1 · first reasoning");
		expect(collapsed.match(/Thinking Steps/g)).toHaveLength(1);
		expect(collapsed).toContain("second reasoning");
	});

	test("wraps thinking summaries safely at narrow and Unicode widths without rendering Markdown", () => {
		initTheme("dark");
		let transforms = 0;
		const component = new AssistantMessageComponent(undefined, true, undefined, "Thinking...", 1, [
			(text) => {
				transforms++;
				return text;
			},
		]);
		for (const size of [1, 100, 1000]) {
			component.updateContent(
				createAssistantMessage([
					{
						type: "thinking",
						thinking: `\x1b[31m中文 e\u0301 👨‍👩‍👧‍👦\x1b[0m\r\t安全\n${"more\n".repeat(size)}last`,
					},
				]),
				true,
			);
			for (const width of [1, 4, 12, 24, 80]) {
				const lines = component.render(width).map(stripAnsi);
				expect(lines.length).toBeGreaterThan(1);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.join("")).not.toMatch(/[\r\t\x1b]/);
			}
			expect(stripAnsi(component.render(100).join("\n"))).toContain("中文");
		}
		expect(transforms).toBe(0);
	});

	test("shows every step in source order while streaming, on completion, and after restore", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, "summary");
		const blocks = [
			"Inspect",
			"Failed to open file",
			"Decided to retry",
			"Read config",
			"Write output",
			"Run tests",
			"Next task",
		];
		for (let count = 1; count <= blocks.length; count++) {
			const message = createAssistantMessage([{ type: "thinking", thinking: blocks.slice(0, count).join("\n\n") }]);
			const original = structuredClone(message);
			component.updateContent(message, true);
			const streaming = component.render(80);
			expect(streaming).toHaveLength(2 + count);
			component.updateContent(message, false);
			expect(component.render(80).map(stripAnsi)).toEqual(streaming.map(stripAnsi));
			expect(component.render(80)).toEqual(new AssistantMessageComponent(message, "summary").render(80));
			expect(message).toEqual(original);
		}
		const lines = component.render(80).map(stripAnsi);
		expect(lines[1]).toContain("Thinking Steps · Summary · 7 steps");
		expect(lines.slice(2)).toEqual([
			" ├─ ◫ Step 1 · Inspect",
			" ├─ ! Step 2 · Failed to open file",
			" ├─ ◆ Step 3 · Decided to retry",
			" ├─ ◫ Step 4 · Read config",
			" ├─ ✎ Step 5 · Write output",
			" ├─ ✓ Step 6 · Run tests",
			" └─ ◇ Step 7 · Next task",
		]);
		component.setOutputPad(0);
		expect(stripAnsi(component.render(80)[2])).toBe("├─ ◫ Step 1 · Inspect");
		component.invalidate();
		expect(component.render(20).length).toBeGreaterThan(7);
		expect(component.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
	});

	test("reuses completed thinking code layouts across folding and subsequent streamed updates", () => {
		initTheme("dark");
		let highlights = 0;
		const component = new AssistantMessageComponent(undefined, true, {
			...getMarkdownTheme(),
			highlightCode: (code) => {
				highlights++;
				return code.split("\n");
			},
		});
		const message = createAssistantMessage([{ type: "thinking", thinking: "```ts\nconst a = 1;\n```\n\nTail" }]);
		component.updateContent(message, true);
		component.render(80);
		expect(highlights).toBe(0);
		component.setHideThinkingBlock(false);
		component.render(80);
		expect(highlights).toBe(1);
		component.setHideThinkingBlock(true);
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "```ts\nconst a = 1;\n```\n\nTail grows" }]),
			false,
		);
		component.render(80);
		expect(highlights).toBe(1);
		component.setHideThinkingBlock(false);
		component.render(80);
		expect(highlights).toBe(1);
	});

	test("reuses all thinking code layouts across whole-run click toggles", () => {
		initTheme("dark");
		const highlight = vi.fn((code: string) => code.split("\n"));
		const source =
			"Inspect first\n```ts\nconst first = 1;\n```\n\nInspect second\n```ts\nconst second = 2;\n```\n\nTail";
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: source }]),
			"summary",
			{
				...getMarkdownTheme(),
				highlightCode: highlight,
			},
		);
		component.render(120);
		expect(highlight).not.toHaveBeenCalled();
		clickRenderedRow(component, "Step 1 · Inspect first");
		const opened = component.render(120);
		expect(highlight).toHaveBeenCalledTimes(2);
		expect(highlight.mock.calls[0][0]).toContain("const first = 1;");
		expect(highlight.mock.calls[1][0]).toContain("const second = 2;");
		for (let frame = 0; frame < 20; frame++) expect(component.render(120)).toBe(opened);
		clickRenderedRow(component, "Inspect first");
		component.render(120);
		clickRenderedRow(component, "Step 1 · Inspect first");
		component.render(120);
		expect(highlight).toHaveBeenCalledTimes(2);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: `${source}\nmore detail` }]), true);
		component.render(120);
		expect(highlight).toHaveBeenCalledTimes(2);
		clickRenderedRow(component, "Inspect second");
		component.render(120);
		expect(highlight).toHaveBeenCalledTimes(2);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("const first = 1;");
	});

	test.each(["collapsed", "summary"] as const)(
		"emphasizes only the currently streaming step in %s and clears it when text begins",
		(mode) => {
			initTheme("dark");
			const component = new AssistantMessageComponent(undefined, mode);
			const message = createAssistantMessage([{ type: "thinking", thinking: "Inspect input\n\nRun tests" }]);
			component.updateContent(message, true);
			const active = theme.style(mode === "collapsed" ? "Run tests" : "Step 2 · Run tests", {
				fg: "thinkingText",
				bold: true,
			});
			expect(component.render(100).join("\n")).toContain(active);
			expect(component.render(100).join("\n")).not.toContain(
				theme.style(mode === "collapsed" ? "Inspect input" : "Step 1 · Inspect input", {
					fg: "thinkingText",
					bold: true,
				}),
			);
			const cached = component.render(100);
			expect(component.render(100)).toBe(cached);
			message.content.push({ type: "text", text: "Answer starts" });
			component.updateContent(message, true);
			expect(component.render(100).join("\n")).not.toContain(active);
			component.updateContent(message, false);
			expect(component.render(100).join("\n")).not.toContain(active);
		},
	);

	test("uses role colors and wraps summaries with tree continuations instead of truncating them", () => {
		initTheme("dark");
		const long = "Inspect configuration across several directories and preserve the final detail";
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: `${long}\n\nCompare options\n\nRun tests` }]),
			"summary",
		);
		const lines = component.render(32);
		const ansi = lines.join("\n");
		expect(ansi).toContain(theme.fg("mdLink", "◫"));
		expect(ansi).toContain(theme.fg("warning", "↔"));
		expect(ansi).toContain(theme.fg("success", "✓"));
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
		const plain = lines.map(stripAnsi);
		expect(plain.some((line) => line.startsWith(" │    "))).toBe(true);
		expect(plain.slice(2).join(" ").replaceAll("│", "").replace(/\s+/g, " ")).toContain(long);
		expect(plain.slice(2).join("\n")).not.toContain("…");
		const y = plain.findIndex((line) => line.startsWith(" │    "));
		expect(
			component.handleMouse({
				type: "click",
				button: "left",
				x: 8,
				y,
				screenX: 8,
				screenY: y,
				width: 32,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
		).toBe(true);
		const opened = stripAnsi(component.render(120).join("\n"));
		expect(opened).not.toMatch(/Thinking Steps|Step \d|[├└]─/u);
		expect(opened).toContain(long);
		expect(opened).toContain("Compare options");
		expect(opened).toContain("Run tests");
		expect(component.render(120)).toEqual(
			new AssistantMessageComponent(
				createAssistantMessage([{ type: "thinking", thinking: `${long}\n\nCompare options\n\nRun tests` }]),
				"expanded",
			).render(120),
		);
	});

	test("renders the untrimmed complete thinking source with native Markdown and no generated structure", () => {
		initTheme("dark");
		const blocks = [
			"    const indented = 1;\n\nInspect **config**\n```ts\n  const value = 1;\n```\n\n- Check path\n  continuation\n\n",
			"\nDecided to stop\n\n",
		];
		const thinking = blocks.join("\n\n");
		const transform = vi.fn((source: string) => source);
		const message = createAssistantMessage(blocks.map((source) => ({ type: "thinking", thinking: source })));
		const component = new AssistantMessageComponent(message, "expanded", undefined, "Thinking...", 1, [transform]);
		const markdown = new Markdown(thinking, 1, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("thinkingText", text),
			italic: true,
		});
		for (const width of [64, 24, 12, 4, 1]) {
			const lines = component.render(width).map(stripAnsi);
			expect(lines.slice(1)).toEqual(markdown.render(width).map(stripAnsi));
			expect(lines.join("\n")).not.toMatch(/Thinking Steps|Step \d|[├└]─/u);
		}
		expect(transform.mock.calls.every(([source]) => source === thinking)).toBe(true);
		expect(transform).toHaveBeenCalled();
		const completed = component.render(64);
		component.updateContent(message, true);
		expect(component.render(64)).toEqual(completed);
	});

	test("clicking Step 2 expands all seven paragraphs exactly like the global expanded mode", () => {
		initTheme("dark");
		const paragraphs = [
			"The user wants a brief comparison. No code is needed.",
			"Let me give a concise answer.",
			"Current: A wrapper around an external library.",
			"Ideal: A service that owns its lifecycle.",
			"Keep it short and clear.",
			"I need to end with a brief note about the response.",
			"Let me write it tight.",
		];
		const message = createAssistantMessage([{ type: "thinking", thinking: paragraphs.join("\n\n") }]);
		const original = structuredClone(message);
		const component = new AssistantMessageComponent(message, "summary");
		const summary = stripAnsi(component.render(120).join("\n"));
		expect(summary).toContain("Summary · 7 steps");
		expect(summary).toContain(paragraphs[2]);
		expect(summary).toContain(paragraphs[3]);
		expect(summary).toContain(paragraphs[4]);
		expect(summary).toContain(paragraphs[5]);
		expect(summary).not.toContain("No code is needed.");
		expect(clickRenderedRow(component, "Step 2 ·")?.handled).toBe(true);
		expect(component.render(120)).toEqual(new AssistantMessageComponent(message, "expanded").render(120));
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).not.toMatch(/Thinking Steps|Step \d|[├└]─/u);
		let previous = -1;
		for (const paragraph of paragraphs) {
			expect(expanded.split(paragraph)).toHaveLength(2);
			const start = expanded.indexOf(paragraph);
			expect(start).toBeGreaterThan(previous);
			previous = start;
		}
		expect(clickRenderedRow(component, "No code is needed.")?.handled).toBe(true);
		expect(stripAnsi(component.render(120).join("\n"))).toBe(summary);
		expect(message).toEqual(original);
	});

	test("toggles the entire clicked run from a step or body while leaving other runs unchanged", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "thinking",
					thinking: "Inspect first\nfirst hidden detail\n\nInspect second\nsecond hidden detail",
				},
				{ type: "text", text: "Answer" },
				{ type: "thinking", thinking: "Inspect other run\nother hidden detail" },
			]),
			"summary",
		);
		expect(clickRenderedRow(component, "Step 2 · Inspect second")?.handled).toBe(true);
		let rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("first hidden detail");
		expect(rendered).toContain("second hidden detail");
		expect(rendered).not.toContain("other hidden detail");
		expect(clickRenderedRow(component, "first hidden detail")?.handled).toBe(true);
		rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).not.toContain("first hidden detail");
		expect(rendered).not.toContain("second hidden detail");
		expect(rendered).not.toContain("other hidden detail");
		expect(rendered.match(/Thinking Steps · Summary/g)).toHaveLength(2);
		component.setThinkingViewMode("expanded");
		expect(clickRenderedRow(component, "other hidden detail")?.handled).toBe(true);
		rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("first hidden detail");
		expect(rendered).toContain("second hidden detail");
		expect(rendered).not.toContain("other hidden detail");
	});

	test("preserves run overrides through append and layout changes and clears them on global mode changes", () => {
		initTheme("dark");
		const source = "Inspect first\nfirst hidden detail\n\nInspect second\nsecond hidden detail";
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: source }]),
			"summary",
		);
		clickRenderedRow(component, "Step 1 · Inspect first");
		const appended = `${source}\nmore second detail`;
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: appended }]), true);
		component.invalidate();
		component.render(40);
		let rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("first hidden detail");
		expect(rendered).toContain("more second detail");
		component.setThinkingViewMode("summary");
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("first hidden detail");
		clickRenderedRow(component, "Thinking Steps");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("second hidden detail");
		clickRenderedRow(component, "second hidden detail");
		rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Summary");
		expect(rendered).not.toContain("first hidden detail");
		component.setThinkingViewMode("expanded");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("more second detail");
		clickRenderedRow(component, "first hidden detail");
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("more second detail");
		component.setThinkingViewMode("expanded");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("more second detail");
	});

	test.each(["summary", "expanded"] as const)(
		"previews the entire folded run when hovering a step in %s and expands the run from the preview",
		async (mode) => {
			initTheme("dark");
			const terminal = new VirtualTerminal(100, 30);
			const tui = new TuiAltScreen(terminal);
			tui.setMouseHoverEnabled(true);
			const source = "Inspect first\nfirst hidden detail\n\nInspect second\nsecond hidden detail";
			const component = new AssistantMessageComponent(
				createAssistantMessage([{ type: "thinking", thinking: source }]),
				mode,
				undefined,
				"Thinking...",
				1,
				[],
				tui,
			);
			if (mode === "expanded") {
				clickRenderedRow(component, "Inspect first");
			}
			tui.addChild(component);
			tui.start();
			try {
				await terminal.waitForRender();
				const row = terminal.getViewport().findIndex((line) => line.includes("Step 2 · Inspect second")) + 1;
				expect(row).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<35;5;${row}M`);
				await terminal.waitForRender();
				expect(tui.hasOverlay()).toBe(true);
				expect(terminal.getViewport().join("\n")).toContain("second hidden detail");
				expect(terminal.getViewport().join("\n")).toContain("first hidden detail");
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: `${source}\nnew preview tail` }]),
					true,
				);
				tui.renderNow();
				await terminal.flush();
				expect(tui.hasOverlay()).toBe(true);
				expect(terminal.getViewport().join("\n")).toContain("new preview tail");
				const panelRow = terminal.getViewport().findIndex((line) => line.includes("Click to expand")) + 1;
				expect(panelRow).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<0;10;${panelRow}M`);
				terminal.sendInput(`\x1b[<0;10;${panelRow}m`);
				await terminal.waitForRender();
				expect(tui.hasOverlay()).toBe(false);
				const rendered = stripAnsi(component.render(120).join("\n"));
				expect(rendered).not.toMatch(/Thinking Steps|Step \d|[├└]─/u);
				expect(rendered).toContain("first hidden detail");
				expect(rendered).toContain("second hidden detail");
				expect(rendered).toContain("new preview tail");
			} finally {
				tui.stop();
			}
		},
	);

	test("caches a long summary without rendering its full Markdown bodies", () => {
		initTheme("dark");
		const paragraphs = Array.from({ length: 100 }, (_, i) => `Inspect section ${i}. Additional detail ${i}.`);
		const transform = vi.fn((text: string) => text);
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: paragraphs.join("\n\n") }]),
			"summary",
			undefined,
			"Thinking...",
			1,
			[transform],
		);
		const childRender = vi.spyOn(component.children[0], "render");
		const lines = component.render(100);
		expect(lines).toHaveLength(102);
		for (const [index] of paragraphs.entries())
			expect(stripAnsi(lines[index + 2])).toContain(`Inspect section ${index}.`);
		for (let frame = 0; frame < 100; frame++) expect(component.render(100)).toBe(lines);
		expect(childRender).toHaveBeenCalledTimes(1);
		expect(transform).not.toHaveBeenCalled();
	});

	test("preserves opaque terminal image commands from expanded Markdown transformers", () => {
		initTheme("dark");
		const image = "\x1b[4A\x1b]1337;File=inline=1;size=3;width=2;height=auto:AAAA\x07";
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "Inspect diagram" },
				{ type: "text", text: "Done" },
			]),
			"expanded",
			undefined,
			"Thinking...",
			1,
			[(text, context) => (context.messageType === "assistant-thinking" ? image : text)],
		);
		for (const width of [8, 40]) {
			const lines = component.render(width);
			expect(lines.filter(isImageLine)).toEqual([theme.fg("thinkingText", image)]);
			expect(lines.filter((line) => !isImageLine(line)).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	test.each(["collapsed", "summary", "expanded"] as const)(
		"keeps the transcript viewport anchored while %s thinking streams below it",
		async (mode) => {
			initTheme("dark");
			const terminal = new VirtualTerminal(60, 16);
			const tui = new TuiAltScreen(terminal);
			const component = new AssistantMessageComponent(undefined, mode, undefined, "Thinking...", 1, [], tui);
			const thinking = "First\n\nSecond\n\nThird";
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking }]), true);
			tui.addChild(new Text(Array.from({ length: 60 }, (_, index) => `history ${index}`).join("\n"), 0, 0));
			tui.addChild(component);
			tui.start();
			try {
				await terminal.waitForRender();
				tui.scrollBy(-20);
				await terminal.waitForRender();
				const top = tui.viewportTop;
				const viewport = terminal.getViewport();
				for (const isStreaming of [true, false]) {
					component.updateContent(
						createAssistantMessage([{ type: "thinking", thinking: `${thinking}\n\nFourth\n\nFifth` }]),
						isStreaming,
					);
					tui.renderNow();
					await terminal.flush();
					expect(tui.isFollowingOutput).toBe(false);
					expect(tui.viewportTop).toBe(top);
					expect(terminal.getViewport()).toEqual(viewport);
				}
			} finally {
				tui.stop();
			}
		},
	);

	test.each(["collapsed", "summary"] as const)(
		"previews %s thinking, scrolls independently, expands on click and respects the global mode",
		async (mode) => {
			initTheme("dark");
			const terminal = new VirtualTerminal(100, 30);
			const tui = new TuiAltScreen(terminal);
			tui.setMouseHoverEnabled(true);
			const component = new AssistantMessageComponent(undefined, mode, undefined, "Thinking...", 1, [], tui);
			const thinking = Array.from({ length: 60 }, (_, i) => `reasoning ${i}`).join("\n");
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking }]), true);
			tui.addChild(component);
			tui.start();
			try {
				await terminal.waitForRender();
				const row = terminal.getViewport().findIndex((line) => line.includes("Thinking Steps")) + 1;
				expect(row).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<35;5;${row}M`);
				await terminal.waitForRender();
				expect(tui.hasOverlay()).toBe(true);
				expect(terminal.getViewport().join("\n")).toContain("reasoning 1");
				const inline = component.render(100);
				const panelRow = terminal.getViewport().findIndex((line) => line.includes("wheel to scroll")) + 1;
				terminal.sendInput(`\x1b[<65;10;${panelRow}M`);
				await terminal.waitForRender();
				expect(component.render(100)).toEqual(inline);
				expect(terminal.getViewport().join("\n")).not.toMatch(/│\s+reasoning 0\s+│/);
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: `${thinking}\nnew tail` }]),
					false,
				);
				tui.renderNow();
				await terminal.flush();
				expect(tui.hasOverlay()).toBe(true);
				expect(terminal.getViewport().join("\n")).toContain("/61");
				terminal.sendInput(`\x1b[<0;10;${panelRow}M`);
				terminal.sendInput(`\x1b[<0;10;${panelRow}m`);
				await terminal.waitForRender();
				expect(tui.hasOverlay()).toBe(false);
				expect(stripAnsi(component.render(100).join("\n"))).toContain("new tail");
				component.setHideThinkingBlock(true);
				expect(component.render(100)).toHaveLength(2);
			} finally {
				tui.stop();
			}
		},
	);

	test("keeps the hover delay across streamed updates and dismisses previews when thinking is removed", () => {
		initTheme("dark");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tui = new TuiAltScreen(new VirtualTerminal(80, 24));
		tui.setHoverPreviewDelay(100);
		let transforms = 0;
		const component = new AssistantMessageComponent(
			undefined,
			true,
			undefined,
			"Thinking...",
			1,
			[
				(text) => {
					transforms++;
					return text;
				},
			],
			tui,
		);
		const event: TuiMouseEvent = {
			type: "move",
			button: "none",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 80,
			height: 2,
			shift: false,
			alt: false,
			ctrl: false,
		};
		tui.addChild(component);
		tui.start();
		try {
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "First" }]), true);
			tui.renderNow();
			component.handleMouse(event);
			vi.advanceTimersByTime(50);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "First\nlatest" }]), true);
			component.render(80);
			component.handleMouse(event);
			expect(transforms).toBe(0);
			expect(tui.hasOverlay()).toBe(false);
			vi.advanceTimersByTime(51);
			expect(tui.hasOverlay()).toBe(true);
			expect(transforms).toBe(1);
			component.updateContent(createAssistantMessage([{ type: "text", text: "answer" }]));
			expect(tui.hasOverlay()).toBe(false);
		} finally {
			tui.stop();
			vi.useRealTimers();
		}
	});

	test("preserves a run preview and its hover delay when unrelated thinking runs are appended", () => {
		initTheme("dark");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tui = new TuiAltScreen(new VirtualTerminal(100, 30));
		tui.setHoverPreviewDelay(100);
		const first = { type: "thinking" as const, thinking: "Inspect first\nfirst hidden detail" };
		const message = createAssistantMessage([first]);
		const component = new AssistantMessageComponent(message, "summary", undefined, "Thinking...", 1, [], tui);
		const y = component.render(100).findIndex((line) => stripAnsi(line).includes("Step 1 · Inspect first"));
		expect(y).toBeGreaterThanOrEqual(0);
		const hover: TuiMouseEvent = {
			type: "move",
			button: "none",
			x: 1,
			y,
			screenX: 1,
			screenY: y,
			width: 100,
			height: 30,
			shift: false,
			alt: false,
			ctrl: false,
		};
		tui.addChild(component);
		tui.start();
		try {
			tui.renderNow();
			component.handleMouse(hover);
			vi.advanceTimersByTime(50);
			message.content.push({ type: "text", text: "First answer" }, { type: "thinking", thinking: "Inspect second" });
			component.updateContent(message, true);
			component.render(100);
			component.handleMouse(hover);
			vi.advanceTimersByTime(51);
			expect(tui.hasOverlay()).toBe(true);
			message.content.push({ type: "text", text: "Second answer" }, { type: "thinking", thinking: "Inspect third" });
			component.updateContent(message, true);
			component.render(100);
			expect(tui.hasOverlay()).toBe(true);
			first.thinking = "Inspect replacement\nreplacement detail";
			component.updateContent(message, true);
			expect(tui.hasOverlay()).toBe(false);
			component.render(100);
			component.handleMouse(hover);
			vi.advanceTimersByTime(101);
			expect(tui.hasOverlay()).toBe(true);
			component.updateContent(createAssistantMessage([{ type: "text", text: "Only the answer remains" }]));
			expect(tui.hasOverlay()).toBe(false);
		} finally {
			tui.stop();
			vi.useRealTimers();
		}
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({
					messageType: "assistant",
					isStreaming: false,
					availableWidth: 78,
					model: message.model,
				});
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});

	test("streamed updates render the same lines as a fresh component", () => {
		initTheme("dark");
		const steps: AssistantMessage["content"][] = [
			[{ type: "text", text: "Intro" }],
			[{ type: "text", text: "Intro\n\n```ts\nconst a = 1;\n```" }],
			[{ type: "text", text: "Intro\n\n```ts\nconst a = 1;\n```\n\nTail words" }],
			[
				{ type: "thinking", thinking: "Reasoning" },
				{ type: "text", text: "Intro\n\n```ts\nconst a = 1;\n```\n\nTail words here" },
			],
			[
				{ type: "thinking", thinking: "Reasoning more" },
				{ type: "text", text: "Changed\n\n```ts\nconst a = 1;\n```\n\nTail words here" },
			],
			[
				{ type: "thinking", thinking: "Reasoning more" },
				{ type: "text", text: "Changed\n\n```ts\nconst a = 1;\n```\n\nTail words here" },
			],
		];

		const streaming = new AssistantMessageComponent();
		for (const content of steps) {
			streaming.updateContent(createAssistantMessage(content), true);
			const fresh = new AssistantMessageComponent();
			fresh.updateContent(createAssistantMessage(content), true);
			expect(streaming.render(60)).toEqual(fresh.render(60));
		}
	});

	test("keeps completed code layouts while text streams and when the stream ends", () => {
		initTheme("dark");
		let highlightCalls = 0;
		const markdownTheme = {
			...getMarkdownTheme(),
			highlightCode: (code: string) => {
				highlightCalls++;
				return code.split("\n");
			},
		};
		const component = new AssistantMessageComponent(undefined, false, markdownTheme);

		component.updateContent(
			createAssistantMessage([{ type: "text", text: "```ts\nconst a = 1;\n```\n\nFirst" }]),
			true,
		);
		component.render(80);
		expect(highlightCalls).toBe(1);

		component.updateContent(
			createAssistantMessage([{ type: "text", text: "```ts\nconst a = 1;\n```\n\nFirst paragraph grows" }]),
			true,
		);
		component.render(80);
		expect(highlightCalls).toBe(1);

		component.updateContent(
			createAssistantMessage([{ type: "text", text: "```ts\nconst a = 1;\n```\n\nFirst paragraph grows" }]),
			false,
		);
		component.render(80);
		expect(highlightCalls).toBe(1);
		component.invalidate();
		component.render(80);
		expect(highlightCalls).toBe(2);
	});

	test("runs final transformers when streaming ends without new text", () => {
		initTheme("dark");
		const message = createAssistantMessage([{ type: "text", text: "answer" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, { isStreaming }) => (isStreaming ? markdown : `final:${markdown}`),
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("final:");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("final:answer");
	});

	test("invalidate re-renders content after external theme state changes", () => {
		initTheme("dark");
		let headingPrefix = "A";
		const markdownTheme = {
			...getMarkdownTheme(),
			heading: (text: string) => `${headingPrefix}${text}`,
		};
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "# Title" }]),
			false,
			markdownTheme,
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("ATitle");

		headingPrefix = "B";
		component.invalidate();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("BTitle");
	});

	test.each(["stop", "aborted", "error", "length"] as const)(
		"matches a fresh component after a streamed %s and repeated renders",
		(stopReason) => {
			initTheme("dark");
			const message = createAssistantMessage([{ type: "text", text: "```ts\nconst a = 1;\n```\n\nPartial" }]);
			const component = new AssistantMessageComponent();
			component.updateContent(message, true);
			component.render(60);
			message.stopReason = stopReason;
			message.errorMessage = "fixture error";
			component.updateContent(message, false);
			const expected = new AssistantMessageComponent(message).render(60);
			expect(component.render(60)).toEqual(expected);
			expect(component.render(60)).toEqual(expected);
		},
	);

	test("refreshes model context and reruns transforms for identical text", () => {
		initTheme("dark");
		let revision = 0;
		const message = createAssistantMessage([{ type: "text", text: "answer" }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(text, { model }) => `${model}:${revision}:${text}`,
		]);
		component.render(60);
		revision++;
		component.updateContent(message, true);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("gpt-4o-mini:1:answer");
		revision++;
		component.updateContent(message, true);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("gpt-4o-mini:2:answer");
		message.model = "fixture-model";
		component.updateContent(message, true);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("fixture-model:2:answer");
	});
});
