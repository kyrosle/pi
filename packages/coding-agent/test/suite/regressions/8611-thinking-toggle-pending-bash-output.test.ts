import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ThinkingViewMode } from "../../../src/core/thinking-view.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

type UpdateThinkingBlockVisibility = (this: { chatContainer: Container; ui: TUI }) => void;

type ThinkingViewContext = {
	thinkingViewMode: ThinkingViewMode;
	uncollapsedThinkingView: ThinkingViewMode;
	settingsManager: { setThinkingViewMode(mode: ThinkingViewMode): void };
	setThinkingViewMode(mode: ThinkingViewMode): void;
	updateThinkingBlockVisibility(): void;
	showStatus(message: string): void;
};

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("thinking visibility while a bash tool is running (#8611)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves partial bash output", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const component = new ToolExecutionComponent(
			"bash",
			"tool-8611",
			{ command: "echo first; sleep 10" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		chatContainer.addChild(component);

		const updateThinkingBlockVisibility = Reflect.get(
			InteractiveMode.prototype,
			"updateThinkingBlockVisibility",
		) as UpdateThinkingBlockVisibility;
		const toggleThinkingBlockVisibility = Reflect.get(InteractiveMode.prototype, "toggleThinkingBlockVisibility") as (
			this: ThinkingViewContext,
		) => void;
		const setThinkingViewMode = Reflect.get(InteractiveMode.prototype, "setThinkingViewMode") as (
			this: ThinkingViewContext,
			mode: ThinkingViewMode,
		) => void;
		const fakeThis = {
			thinkingViewMode: "summary" as ThinkingViewMode,
			uncollapsedThinkingView: "summary" as ThinkingViewMode,
			settingsManager: { setThinkingViewMode: vi.fn() },
			setThinkingViewMode(mode: ThinkingViewMode) {
				setThinkingViewMode.call(this, mode);
			},
			chatContainer,
			ui,
			updateThinkingBlockVisibility() {
				updateThinkingBlockVisibility.call(this);
			},
			showStatus: vi.fn(),
		};

		expect(renderChat(chatContainer)).toContain("first");
		toggleThinkingBlockVisibility.call(fakeThis);

		expect(fakeThis.settingsManager.setThinkingViewMode).toHaveBeenCalledWith("collapsed");
		expect(chatContainer.children).toContain(component);
		expect(renderChat(chatContainer)).toContain("first");
	});
});
