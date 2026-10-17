import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
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
		expect(collapsed).toContain("1. reasoning: first reasoning");
		expect(collapsed).toContain("Thinking Steps · Expanded");
		expect(collapsed).toContain("second reasoning");
	});

	test("keeps thinking excerpts to safe single rows at narrow and Unicode widths without rendering Markdown", () => {
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
				expect(lines).toHaveLength(2);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.join("")).not.toMatch(/[\r\t\x1b]/);
			}
			expect(stripAnsi(component.render(100)[1])).toContain("reasoning: 中文");
		}
		expect(transforms).toBe(0);
	});

	test("caps streamed summaries at five salient steps and preserves their height on completion and restore", () => {
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
			expect(streaming).toHaveLength(2 + Math.min(count, 5));
			component.updateContent(message, false);
			expect(component.render(80)).toEqual(streaming);
			expect(component.render(80)).toEqual(new AssistantMessageComponent(message, "summary").render(80));
			expect(message).toEqual(original);
		}
		const lines = component.render(80).map(stripAnsi);
		expect(lines.slice(2)).toEqual([
			" ├─ 1. inspect: Inspect",
			" ├─ 2. failure: Failed to open file",
			" ├─ 3. decision: Decided to retry",
			" ├─ 6. verify: Run tests",
			" └─ 7. plan: Next task",
		]);
		component.setOutputPad(0);
		expect(stripAnsi(component.render(80)[2])).toBe("├─ 1. inspect: Inspect");
		component.invalidate();
		expect(component.render(20)).toHaveLength(7);
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
