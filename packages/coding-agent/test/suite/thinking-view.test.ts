import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ThinkingViewMode } from "../../src/core/thinking-view.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";

test("native thinking controls change the view without changing model history or calling a provider", async () => {
	initTheme("dark");
	const harness = await createHarness();
	const ui = new TuiMainScreen(new VirtualTerminal());
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, defaultEditorTheme, keybindings);
	const chatContainer = new Container();
	const context = {
		isBashMode: false,
		thinkingViewMode: "summary" as ThinkingViewMode,
		uncollapsedThinkingView: "summary" as ThinkingViewMode,
		settingsManager: harness.settingsManager,
		session: harness.session,
		ui,
		editor,
		defaultEditor: editor,
		chatContainer,
		showExtensionSelector: vi.fn<() => Promise<string | undefined>>().mockResolvedValue("summary"),
		showStatus: vi.fn(),
		showError: vi.fn(),
		setThinkingViewMode(mode: ThinkingViewMode) {
			invoke("setThinkingViewMode", mode);
		},
		toggleThinkingBlockVisibility() {
			invoke("toggleThinkingBlockVisibility");
		},
		updateThinkingBlockVisibility() {
			invoke("updateThinkingBlockVisibility");
		},
	};
	function invoke(name: string, ...args: unknown[]): void {
		Reflect.apply(Reflect.get(InteractiveMode.prototype, name), context, args);
	}
	try {
		harness.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Inspect file\nbody detail\n\nRun tests" },
				{ type: "text", text: "Done" },
			]),
		]);
		await harness.session.prompt("fixture");
		const message = harness.session.messages.find((message) => message.role === "assistant");
		if (!message || message.role !== "assistant") throw new Error("Missing faux response");
		chatContainer.addChild(new AssistantMessageComponent(message, "summary"));
		const original = structuredClone(harness.session.messages);
		const calls = harness.faux.state.callCount;
		invoke("setupKeyHandlers");
		invoke("setupEditorSubmitHandler");
		const render = () => stripAnsi(chatContainer.render(100).join("\n"));
		expect(render()).toContain("Summary");
		expect(render()).not.toContain("body detail");
		editor.handleInput("\x1bt");
		expect(render()).not.toContain("Thinking Steps");
		expect(render()).toContain("body detail");
		editor.handleInput("\x14");
		expect(render()).toContain("▸ Thinking Steps · ✓ Run tests");
		editor.handleInput("\x14");
		expect(render()).not.toContain("Thinking Steps");
		expect(render()).toContain("body detail");
		editor.handleInput("\x1bt");
		expect(context.thinkingViewMode).toBe("collapsed");
		editor.handleInput("\x1bt");
		expect(context.thinkingViewMode).toBe("summary");
		await editor.onSubmit?.("/thinking-steps expanded");
		expect(harness.settingsManager.getThinkingViewMode()).toBe("expanded");
		await editor.onSubmit?.("/thinking-steps invalid");
		expect(context.showError).toHaveBeenCalledOnce();
		expect(context.thinkingViewMode).toBe("expanded");
		await editor.onSubmit?.("/thinking-steps");
		expect(context.thinkingViewMode).toBe("summary");
		context.showExtensionSelector.mockResolvedValueOnce(undefined);
		await editor.onSubmit?.("/thinking-steps");
		expect(context.thinkingViewMode).toBe("summary");
		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.session.messages).toEqual(original);
	} finally {
		ui.stop();
		harness.cleanup();
		setKeybindings(new KeybindingsManager());
	}
});
