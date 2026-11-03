import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text, TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ThinkingRenderContext, ThinkingRenderer } from "../src/core/extensions/types.ts";
import { thinkingStepsRenderer } from "../src/extensions/thinking-steps/renderer.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

test.each(["collapsed", "summary", "expanded"] as const)("native %s fallback works without an extension", (mode) => {
	const component = new AssistantMessageComponent(
		fauxAssistantMessage([{ type: "thinking", thinking: "Original reasoning" }]),
		mode,
	);
	const rendered = stripAnsi(component.render(80).join("\n"));
	expect(rendered).toContain(mode === "collapsed" ? "Thinking..." : "Original reasoning");
	expect(rendered).not.toContain("Thinking Steps");
});

test("renderer errors retain the original thinking", () => {
	const component = new AssistantMessageComponent(
		fauxAssistantMessage([{ type: "thinking", thinking: "Original reasoning" }]),
		"summary",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		() => {
			throw new Error("Renderer unavailable");
		},
	);
	expect(stripAnsi(component.render(80).join("\n"))).toContain("Original reasoning");
});

test("renderer invalidation refreshes parent lines while retaining the Markdown component", () => {
	let context: ThinkingRenderContext | undefined;
	let value = "First view";
	const renderer: ThinkingRenderer = (_thinking, _theme, nextContext) => {
		context = nextContext;
		return { render: () => [value], invalidate() {} };
	};
	const component = new AssistantMessageComponent(
		fauxAssistantMessage([{ type: "thinking", thinking: "Original reasoning" }]),
		"summary",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		renderer,
	);
	const first = component.render(80);
	const markdown = context?.markdown;
	value = "Updated view";
	expect(component.render(80)).toBe(first);
	context?.invalidate();
	expect(stripAnsi(component.render(80).join("\n"))).toContain("Updated view");
	expect(context?.markdown).toBe(markdown);
});

test("removed and replaced thinking components are disposed without disposing reused components", () => {
	const dispose = vi.fn();
	const first = Object.assign(new Text("First", 0, 0), { dispose });
	const secondDispose = vi.fn();
	const second = Object.assign(new Text("Second", 0, 0), { dispose: secondDispose });
	let replace = false;
	const renderer: ThinkingRenderer = () => (replace ? second : first);
	const message = fauxAssistantMessage([{ type: "thinking", thinking: "Original reasoning" }]);
	const component = new AssistantMessageComponent(
		message,
		"summary",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		renderer,
	);
	component.updateContent(message, true);
	expect(dispose).not.toHaveBeenCalled();
	replace = true;
	component.updateContent(message, true);
	expect(dispose).toHaveBeenCalledOnce();
	component.updateContent(fauxAssistantMessage("Done"), false);
	expect(secondDispose).toHaveBeenCalledOnce();
});

test("disposing a message releases renderer resources once and ignores stale callbacks", () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const tui = new TuiAltScreen(new VirtualTerminal());
	const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
	let context: ThinkingRenderContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const dispose = vi.fn(() => clearInterval(timer));
	const renderer: ThinkingRenderer = (_thinking, _theme, nextContext) => {
		context = nextContext;
		timer = setInterval(() => nextContext.invalidate(), 10);
		return Object.assign(new Text("Thinking renderer", 0, 0), { dispose });
	};
	const message = fauxAssistantMessage([{ type: "thinking", thinking: "Inspect files" }]);
	const component = new AssistantMessageComponent(
		message,
		"summary",
		undefined,
		undefined,
		undefined,
		undefined,
		tui,
		undefined,
		undefined,
		renderer,
	);
	try {
		vi.advanceTimersByTime(10);
		expect(requestRender).toHaveBeenCalledOnce();
		requestRender.mockClear();
		component.dispose();
		component.dispose();
		context?.invalidate();
		context?.setExpanded(true);
		component.updateContent(message, true);
		component.invalidate();
		vi.advanceTimersByTime(100);
		expect(dispose).toHaveBeenCalledOnce();
		expect(requestRender).not.toHaveBeenCalled();
		expect(component.render(80)).toEqual([]);
	} finally {
		component.dispose();
		requestRender.mockRestore();
		vi.useRealTimers();
	}
});

test("a failing renderer cleanup does not keep other thinking runs alive", () => {
	const dispose = vi.fn(() => {
		throw new Error("Renderer cleanup failed");
	});
	const laterDispose = vi.fn();
	const renderer: ThinkingRenderer = (thinking) =>
		Object.assign(new Text(thinking, 0, 0), { dispose: thinking === "First" ? dispose : laterDispose });
	const component = new AssistantMessageComponent(
		fauxAssistantMessage([
			{ type: "thinking", thinking: "First" },
			{ type: "text", text: "Answer" },
			{ type: "thinking", thinking: "Second" },
		]),
		"summary",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		renderer,
	);
	expect(() => component.updateContent(fauxAssistantMessage("Replacement"))).not.toThrow();
	expect(dispose).toHaveBeenCalledOnce();
	expect(laterDispose).toHaveBeenCalledOnce();
	expect(stripAnsi(component.render(80).join("\n"))).toContain("Replacement");
	component.updateContent(fauxAssistantMessage([{ type: "thinking", thinking: "First" }]));
	expect(() => component.dispose()).not.toThrow();
	expect(dispose).toHaveBeenCalledTimes(2);
});

test.each(["pending", "visible", "another owner"])(
	"disposing Thinking Steps dismisses only its own %s preview",
	(state) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const tui = new TuiAltScreen(new VirtualTerminal(80, 24));
		tui.setHoverPreviewDelay(100);
		const component = new AssistantMessageComponent(
			fauxAssistantMessage([{ type: "thinking", thinking: "Inspect files\nOriginal thinking detail" }]),
			"summary",
			undefined,
			undefined,
			undefined,
			undefined,
			tui,
			undefined,
			undefined,
			thinkingStepsRenderer,
		);
		tui.addChild(component);
		tui.start();
		try {
			tui.renderNow();
			const event: TuiMouseEvent = {
				type: "move",
				button: "none",
				x: 1,
				y: 1,
				screenX: 1,
				screenY: 1,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			};
			component.handleMouse(event);
			if (state !== "pending") vi.advanceTimersByTime(101);
			if (state === "another owner") {
				tui.showHoverPreview({}, new Text("Other preview", 0, 0), event);
				vi.advanceTimersByTime(101);
			}
			expect(tui.hasOverlay()).toBe(state !== "pending");
			component.dispose();
			vi.advanceTimersByTime(101);
			expect(tui.hasOverlay()).toBe(state === "another owner");
		} finally {
			component.dispose();
			tui.stop();
			vi.useRealTimers();
		}
	},
);
