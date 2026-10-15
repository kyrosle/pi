import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	getCapabilities,
	setCapabilities,
	setKeybindings,
	stripTerminalSequences,
	Text,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { PreviewPanel } from "../../examples/extensions/grok-ui/preview-panel.ts";
import grokUi, { GrokMenu } from "../../examples/extensions/grok-ui.ts";
import type { ToolRenderContext, ToolRenderers } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createChatViewport } from "../../src/modes/interactive/chat-viewport.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import { initTheme, loadThemeFromPath, setThemeInstance, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createInteractiveTuiReference } from "../../src/modes/interactive/tui-renderer.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getToolResult, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-grok-settings-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	setKeybindings(new KeybindingsManager());
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(agentDirectory, { recursive: true, force: true });
});

function createEditor(columns = 80) {
	const tui = new TuiMainScreen(new VirtualTerminal(columns, 24));
	return new CustomEditor(tui, defaultEditorTheme, new KeybindingsManager(), {
		paddingX: 1,
		embedWorkingStatus: true,
	});
}

describe("Grok editor", () => {
	it.each([4, 12, 24, 80, 120])("fits Chinese, combining characters and emoji in %i columns", (width) => {
		const editor = createEditor(width);
		const emptyLines = editor.render(width);
		expect(stripAnsi(emptyLines[0])).toBe("─".repeat(width));
		expect(stripAnsi(emptyLines.at(-1) ?? "")).toBe("─".repeat(width));
		editor.focused = true;
		editor.setText("你好，世界 e\u0301 👨‍👩‍👧‍👦\nsecond line");
		const lines = editor.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain(CURSOR_MARKER);
	});

	it("retains configurable submission, interruption, history and bracketed paste", () => {
		const keybindings = new KeybindingsManager({ "tui.input.submit": "ctrl+enter", "app.interrupt": "ctrl+q" });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings, {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		const submit = vi.fn();
		const interrupt = vi.fn();
		editor.onSubmit = submit;
		editor.onEscape = interrupt;
		editor.handleInput("\x1b[200~你好\nsecond line\x1b[201~");
		expect(editor.getText()).toBe("你好\nsecond line");
		editor.handleInput("\x11");
		expect(interrupt).toHaveBeenCalledOnce();
		editor.handleInput("\x1b[13;5u");
		expect(submit).toHaveBeenCalledWith("你好\nsecond line");
		editor.addToHistory("previous prompt");
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("previous prompt");
	});

	it("keeps working status in the top border", () => {
		const tui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(tui, defaultEditorTheme, new KeybindingsManager(), {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		const working = new WorkingStatusIndicator(tui, "Working", { frames: ["*"] });
		try {
			editor.setWorkingStatusIndicator(working);
			expect(stripAnsi(editor.render(80)[0])).toContain("Working");
		} finally {
			working.dispose();
		}
	});

	it("positions the cursor at the clicked character with native padding", () => {
		const editor = createEditor();
		editor.setText("abcd");
		editor.render(80);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 3,
			y: 1,
			screenX: 3,
			screenY: 1,
			width: 80,
			height: 3,
			shift: false,
			alt: false,
			ctrl: false,
		};
		editor.handleMouse(event);
		editor.handleInput("!");
		expect(editor.getText()).toBe("ab!cd");
	});
});

describe("Grok extension compatibility", () => {
	it("installs the native editor with horizontal rules and embedded working status", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const tui = new TuiAltScreen(new VirtualTerminal());
		const setEditorComponent = vi.fn<ReturnType<typeof createTestUiContext>["setEditorComponent"]>();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ setEditorComponent }),
		});
		const editor = setEditorComponent.mock.lastCall?.[0]?.(tui, defaultEditorTheme, new KeybindingsManager());
		expect(editor).toBeInstanceOf(CustomEditor);
		if (!(editor instanceof CustomEditor)) throw new Error("Missing native editor");
		editor.setText("draft");
		const lines = editor.render(80).map(stripAnsi);
		expect(lines[0]).toBe("─".repeat(80));
		expect(lines.at(-1)).toBe("─".repeat(80));
		expect(stripTerminalSequences(lines[1]).trim()).toBe("draft");
		const working = new WorkingStatusIndicator(tui, "Working", { frames: ["*"] });
		try {
			editor.setWorkingStatusIndicator(working);
			expect(stripAnsi(editor.render(80)[0])).toContain("Working");
		} finally {
			working.dispose();
		}
	});

	it("defaults hover to two seconds and applies persistent settings without changing model context", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const tui = new TuiAltScreen(new VirtualTerminal());
		const setDelay = vi.spyOn(tui, "setHoverPreviewDelay");
		const notify = vi.fn();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setHeader: (factory) => {
					factory?.(tui, theme);
				},
				notify,
			}),
		});
		expect(setDelay).toHaveBeenLastCalledWith(2000);
		await harness.session.prompt("/grok-hover-delay 3500");
		expect(setDelay).toHaveBeenLastCalledWith(3500);
		expect(JSON.parse(readFileSync(join(agentDirectory, "grok-ui.json"), "utf8"))).toEqual({ hoverDelayMs: 3500 });
		for (const value of ["-1", "NaN", "Infinity", "0.1", "2147483648"]) {
			await harness.session.prompt(`/grok-hover-delay ${value}`);
			expect(setDelay).toHaveBeenLastCalledWith(3500);
			expect(notify).toHaveBeenLastCalledWith(expect.any(String), "error");
		}
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(setDelay).toHaveBeenLastCalledWith(0);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(setDelay).toHaveBeenLastCalledWith(3500);
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("validates stored hover settings and preserves other extension settings when updating the delay", async () => {
		writeFileSync(join(agentDirectory, "grok-ui.json"), JSON.stringify({ hoverDelayMs: -1, otherSetting: "keep" }));
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const tui = new TuiAltScreen(new VirtualTerminal());
		const setDelay = vi.spyOn(tui, "setHoverPreviewDelay");
		const notify = vi.fn();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setHeader: (factory) => {
					factory?.(tui, theme);
				},
				notify,
			}),
		});
		expect(setDelay).toHaveBeenLastCalledWith(2000);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("hoverDelayMs"), "warning");
		await harness.session.prompt("/grok-hover-delay 0");
		expect(setDelay).toHaveBeenLastCalledWith(0);
		expect(JSON.parse(readFileSync(join(agentDirectory, "grok-ui.json"), "utf8"))).toEqual({
			hoverDelayMs: 0,
			otherSetting: "keep",
		});
	});

	it("labels messages with the system username and recorded model without changing their content", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const transformers = harness.session.extensionRunner.getMarkdownTransformers();
		const username = userInfo().username;
		const userText = "检查文件 🌍";
		const user = new UserMessageComponent(userText, undefined, 1, transformers);
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "Checking the file." },
			{ type: "text", text: "检查完成 🌍" },
		]);
		const assistant = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, transformers);
		for (const width of [12, 40, 80]) {
			const userLines = user.render(width);
			const assistantLines = assistant.render(width);
			expect(userLines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(assistantLines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(userLines.map((line) => stripAnsi(line).trim()).filter((line) => line === username)).toHaveLength(1);
			expect(
				assistantLines.map((line) => stripAnsi(line).trim()).filter((line) => line === message.model),
			).toHaveLength(1);
		}
		assistant.updateContent(fauxAssistantMessage("检查完成 🌍，继续处理。"), true);
		for (const width of [40, 80]) {
			expect(
				assistant
					.render(width)
					.map((line) => stripAnsi(line).trim())
					.filter((line) => line === message.model),
			).toHaveLength(1);
		}
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "Checking the file." },
			{ type: "text", text: "检查完成 🌍" },
		]);
		expect(transformers[0]?.("", { messageType: "assistant", isStreaming: true, availableWidth: 80 })).toBe("");
	});

	it("keeps one heading with duplicate Grok extensions across dark and Grok themes and model changes", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi, grokUi] });
		harnesses.push(harness);
		const transformers = harness.session.extensionRunner.getMarkdownTransformers();
		expect(transformers).toHaveLength(2);
		const username = userInfo().username;
		const userText = "检查当前pi版本";
		const user = new UserMessageComponent(userText, undefined, 1, transformers);
		const firstMessage = { ...fauxAssistantMessage("first answer"), model: "gpt-6-sol" };
		const secondMessage = { ...fauxAssistantMessage("second answer"), model: "claude-sonnet" };
		const first = new AssistantMessageComponent(firstMessage, false, undefined, "Thinking...", 1, transformers);
		const second = new AssistantMessageComponent(secondMessage, false, undefined, "Thinking...", 1, transformers);
		for (const palette of ["dark", "grok", "dark"]) {
			if (palette === "grok") {
				setThemeInstance(loadThemeFromPath(join(import.meta.dirname, "../../../../.pi/themes/grok.json")));
			} else {
				initTheme(palette);
			}
			for (const [component, label] of [
				[user, username],
				[first, firstMessage.model],
				[second, secondMessage.model],
			] as const) {
				component.invalidate();
				const lines = component.render(80).map((line) => stripAnsi(line).trim());
				expect(lines.filter((line) => line === label)).toHaveLength(1);
				expect(lines).not.toContain("你");
				expect(lines).not.toContain("Pi");
			}
		}
		expect(stripAnsi(first.render(80).join("\n"))).not.toContain(secondMessage.model);
		expect(firstMessage.content).toEqual([{ type: "text", text: "first answer" }]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("escapes Markdown in model headings and leaves thinking and unavailable model names alone", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const transformers = harness.session.extensionRunner.getMarkdownTransformers();
		for (const model of ["model_*[test]", "model`test", "model``test", "model\\[test\\]"]) {
			const message = { ...fauxAssistantMessage("answer"), model };
			const assistant = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, transformers);
			expect(assistant.render(80).map((line) => stripAnsi(line).trim())).toContain(model);
		}
		expect(
			transformers[0]?.("reasoning", {
				messageType: "assistant-thinking",
				isStreaming: false,
				availableWidth: 80,
				model: "gpt-6-sol",
			}),
		).toBe("reasoning");
		expect(transformers[0]?.("answer", { messageType: "assistant", isStreaming: false, availableWidth: 80 })).toBe(
			"answer",
		);
	});

	it("preserves model, tool definitions and prompt through startup and actual write/edit turns", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const original = {
			model: harness.session.model,
			prompt: harness.session.systemPrompt,
			tools: harness.session.getActiveToolNames(),
			edit: harness.session.getToolDefinition("edit"),
		};
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
		expect(harness.session.model).toBe(original.model);
		expect(harness.session.systemPrompt).toBe(original.prompt);
		expect(harness.session.getActiveToolNames()).toEqual(original.tools);
		expect(harness.session.getToolDefinition("edit")).toBe(original.edit);
		const file = join(harness.tempDir, "notes.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "before\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: file, oldText: "before", newText: "after" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Write and edit notes.");
		expect(getUserTexts(harness)).toEqual(["Write and edit notes."]);
		expect(harness.session.getLastAssistantText()).toBe("Done");
		expect(readFileSync(file, "utf8")).toBe("after\n");
		expect(getToolResult(harness, "edit").isError).toBe(false);
		expect(getToolResult(harness, "edit").details).toMatchObject({ diff: expect.stringContaining("after") });
		expect(harness.session.model).toBe(original.model);
	});

	it("leaves RPC presentation alone", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const setHeader = vi.fn();
		const setEditorComponent = vi.fn();
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({ setHeader, setEditorComponent }),
		});
		expect(setHeader).not.toHaveBeenCalled();
		expect(setEditorComponent).not.toHaveBeenCalled();
	});

	it("keeps self-framed tool shells, result renderers and missing-tool behavior", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const resolve = (name: string) =>
			harness.session.extensionRunner.resolveToolRenderers(name, () => harness.session.getToolDefinition(name));
		expect(resolve("edit")?.renderShell).toBe("self");
		expect(resolve("edit")?.renderResult).toBeTypeOf("function");
		expect(resolve("unknown")).toBeUndefined();
	});

	it("shows queued, running, success and failure while retaining original results", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const original = harness.session.getToolDefinition("read");
		const renderer = harness.session.extensionRunner.resolveToolRenderers("read", () => original);
		expect(renderer?.renderResult).toBeTypeOf("function");
		const tui = new TuiMainScreen(new VirtualTerminal());
		const component = new ToolExecutionComponent(
			"read",
			"read-1",
			{ path: "notes.txt" },
			{},
			renderer,
			tui,
			harness.tempDir,
		);
		const output = () => stripAnsi(component.render(80).join("\n"));
		expect(output()).toContain("Queued");
		component.markExecutionStarted();
		expect(output()).toContain("Running");
		component.updateResult({ content: [{ type: "text", text: "notes" }], isError: false });
		expect(output()).toContain("Done");
		component.updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
		expect(output()).toContain("Failed");
		expect(output()).toContain("Permission denied");
	});

	it("unwraps the previous component before calling another extension's renderer", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const content = new Text("custom call", 0, 0);
		const renderCall = vi.fn<NonNullable<ToolRenderers["renderCall"]>>(() => content);
		const original: ToolRenderers = { renderCall };
		const renderer = harness.session.extensionRunner.resolveToolRenderers("custom", () => original);
		const context: ToolRenderContext<unknown, unknown> = {
			args: {},
			toolCallId: "custom-1",
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd: harness.tempDir,
			executionStarted: true,
			argsComplete: true,
			isPartial: true,
			expanded: false,
			showImages: true,
			isError: false,
			durationMs: undefined,
			outputPad: 1,
		};
		const first = renderer?.renderCall?.({}, theme, context);
		renderer?.renderCall?.({}, theme, { ...context, lastComponent: first });
		expect(renderCall.mock.calls[1]?.[2]).toMatchObject({ lastComponent: content });
	});

	it("preserves both renderer slots and their shared state across result updates", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const call = new Text("custom call", 0, 0);
		const result = new Text("custom result", 0, 0);
		const renderCall = vi.fn<NonNullable<ToolRenderers["renderCall"]>>((_args, _theme, context) => {
			context.state.call = call;
			return call;
		});
		const renderResult = vi.fn<NonNullable<ToolRenderers["renderResult"]>>((_result, _options, _theme, context) => {
			expect(context.state.call).toBe(call);
			return result;
		});
		const renderer = harness.session.extensionRunner.resolveToolRenderers("custom", () => ({
			renderCall,
			renderResult,
		}));
		const component = new ToolExecutionComponent(
			"custom",
			"reuse",
			{},
			{},
			renderer,
			new TuiAltScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		component.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		component.updateResult({ content: [{ type: "text", text: "last" }], isError: false });
		expect(renderCall.mock.lastCall?.[2].lastComponent).toBe(call);
		expect(renderResult.mock.lastCall?.[3].lastComponent).toBe(result);
		expect(renderResult.mock.lastCall?.[0].content).toEqual([{ type: "text", text: "last" }]);
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("custom result");
	});

	it("drops stale partial output when the final result renderer fails", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const renderer = harness.session.extensionRunner.resolveToolRenderers("custom", () => ({
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: (_result, options) => {
				if (!options.isPartial) throw new Error("final renderer failed");
				return new Text("old partial", 0, 0);
			},
		}));
		const component = new ToolExecutionComponent(
			"custom",
			"failure",
			{},
			{},
			renderer,
			new TuiAltScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("old partial");
		component.updateResult({ content: [{ type: "text", text: "final fallback" }], isError: true });
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("final fallback");
		expect(output).not.toContain("old partial");
	});

	it("falls back safely when expanded call and result components throw while rendering a hover", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const tui = new TuiAltScreen(new VirtualTerminal());
		vi.spyOn(tui, "transcriptViewportHeight", "get").mockReturnValue(20);
		const show = vi.spyOn(tui, "showHoverPreview").mockImplementation(() => {});
		let failCall = false;
		const call = {
			render: () => {
				if (failCall) throw new Error("call render failed");
				return ["custom call"];
			},
			invalidate() {},
		};
		const renderer = harness.session.extensionRunner.resolveToolRenderers("custom", () => ({
			renderCall: () => call,
			renderResult: (_result, options) => ({
				render() {
					if (options.expanded) throw new Error("result render failed");
					return ["custom result"];
				},
				invalidate() {},
			}),
		}));
		const component = new ToolExecutionComponent("custom", "hover-errors", {}, {}, renderer, tui, harness.tempDir);
		component.updateResult({ content: [{ type: "text", text: "retained result" }], isError: false });
		expect(component.render(80)).toHaveLength(2);
		component.handleMouse({
			type: "move",
			button: "none",
			x: 4,
			y: 1,
			screenX: 4,
			screenY: 1,
			width: 80,
			height: 2,
			shift: false,
			alt: false,
			ctrl: false,
		});
		failCall = true;
		const panel = show.mock.lastCall?.[1];
		expect(panel).toBeDefined();
		const preview = stripAnsi(panel!.render(72).join("\n"));
		expect(preview).toContain("Tool call preview unavailable");
		expect(preview).toContain("retained result");
	});

	it("keeps asynchronous edit previews and the final result diff", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const file = join(harness.tempDir, "preview.txt");
		writeFileSync(file, "before\n");
		const renderer = harness.session.extensionRunner.resolveToolRenderers("edit", () =>
			harness.session.getToolDefinition("edit"),
		);
		const component = new ToolExecutionComponent(
			"edit",
			"async-edit",
			{ path: file, oldText: "before", newText: "after" },
			{},
			renderer,
			new TuiAltScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		component.setExpanded(true);
		component.setArgsComplete();
		await vi.waitFor(() => expect(stripAnsi(component.render(80).join("\n"))).toContain("+1 after"));
		component.updateResult({
			content: [{ type: "text", text: "edited" }],
			details: { diff: "-1 before\n+1 final", firstChangedLine: 1 },
			isError: false,
		});
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("+1 final");
		expect(rendered).not.toContain("+1 after");
	});

	it("retains native images and fallback output when a custom call renderer fails", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const capabilities = getCapabilities();
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			for (const fail of [false, true]) {
				const renderer = harness.session.extensionRunner.resolveToolRenderers("custom", () => ({
					renderCall: () => {
						if (fail) throw new Error("broken custom renderer");
						return new Text("image call", 0, 0);
					},
				}));
				const component = new ToolExecutionComponent(
					"custom",
					"image",
					{},
					{},
					renderer,
					new TuiAltScreen(new VirtualTerminal()),
					harness.tempDir,
				);
				component.updateResult({
					content: [
						{ type: "text", text: "retained output" },
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
						},
					],
					isError: false,
				});
				const rendered = component.render(80).join("\n");
				expect(rendered).toContain("\x1b_G");
				expect(stripAnsi(rendered)).toContain("retained output");
			}
		} finally {
			setCapabilities(capabilities);
		}
	});
});

describe("Grok popup", () => {
	it.each([4, 12, 24, 80])("fits %i columns", (width) => {
		const menu = new GrokMenu(
			() => theme,
			new KeybindingsManager(),
			false,
			() => {},
		);
		expect(menu.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("uses remapped keys for selection and cancellation", () => {
		const keybindings = new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q" });
		setKeybindings(keybindings);
		const done = vi.fn();
		const menu = new GrokMenu(() => theme, keybindings, false, done);
		menu.handleInput?.("\x19");
		expect(done).toHaveBeenLastCalledWith(true);
		menu.handleInput?.("\x11");
		expect(done).toHaveBeenLastCalledWith(false);
	});

	it("selects a popup option by mouse inside its border", () => {
		const done = vi.fn();
		const menu = new GrokMenu(() => theme, new KeybindingsManager(), false, done);
		const height = menu.render(50).length;
		menu.handleMouse({
			type: "click",
			button: "left",
			x: 5,
			y: 3,
			screenX: 5,
			screenY: 3,
			width: 50,
			height,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(done).toHaveBeenCalledWith(true);
	});

	it("returns fullscreen keyboard focus to the existing draft after closing", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TuiAltScreen(terminal);
		const editor = new CustomEditor(tui, defaultEditorTheme, new KeybindingsManager(), {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		editor.setText("未发送的草稿");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			tui.showOverlay(
				new GrokMenu(
					() => theme,
					new KeybindingsManager(),
					false,
					() => tui.hideOverlay(),
				),
				{ width: 50, anchor: "center" },
			);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Display");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			terminal.sendInput("!");
			expect(editor.getText()).toBe("未发送的草稿!");
		} finally {
			tui.stop();
		}
	});

	it("loads the Grok project palette with Pi's theme parser", () => {
		const grok = loadThemeFromPath(join(import.meta.dirname, "../../../../.pi/themes/grok.json"));
		expect(grok.name).toBe("grok");
		expect(grok.appearance).toBe("dark");
		expect(grok.fg("toolDiffAdded", "+after")).toContain("+after");
	});
});

describe("Grok timeline and compact tool previews", () => {
	it("preserves an explicit compact opt-out and output-only custom renderers", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const tui = new TuiAltScreen(new VirtualTerminal());
		for (const content of [
			Object.assign(new Text("custom control", 0, 0), { compactToolCall: false }),
			new Container(),
		]) {
			const renderers = harness.session.extensionRunner.resolveToolRenderers("custom", () => ({
				renderCall: () => content,
				renderResult: () => new Text("visible custom result", 0, 0),
			}));
			const component = new ToolExecutionComponent(
				"custom",
				"custom-renderer",
				{},
				{},
				renderers,
				tui,
				harness.tempDir,
			);
			component.updateResult({ content: [{ type: "text", text: "data" }], isError: false });
			expect(stripAnsi(component.render(80).join("\n"))).toContain("visible custom result");
		}
	});

	it("reinstalls the timeline when Pi changes its active renderer from regular to fullscreen", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1700000000000 });
		harness.sessionManager.appendMessage({ role: "user", content: "second", timestamp: 1700000001000 });
		let current: TUI = new TuiMainScreen(new VirtualTerminal());
		const reference = createInteractiveTuiReference(() => current);
		let header: Component | undefined;
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setHeader: (factory) => {
					header = factory?.(reference, theme);
				},
			}),
		});
		header?.render(80);
		const terminal = new VirtualTerminal(80, 12);
		const fullscreen = new TuiAltScreen(terminal);
		current = fullscreen;
		fullscreen.addChild(new UserMessageComponent("first"));
		fullscreen.addChild(new UserMessageComponent("second"));
		header?.render(80);
		fullscreen.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().filter((line) => /(?:━━| ─)$/.test(line))).toHaveLength(2);
		} finally {
			fullscreen.stop();
		}
	});

	it("strips terminal commands from timeline previews and handles unavailable timestamps", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const tui = new TuiAltScreen(new VirtualTerminal());
		const install = vi.spyOn(tui, "setTimeline");
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setHeader: (factory) => {
					factory?.(tui, theme);
				},
			}),
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await tui.terminal.drainInput();
		tui.renderNow();
		const options = install.mock.calls[0]?.[0];
		const rendered =
			options
				?.renderPreview({ preview: "hello\x1b]52;c;secret\x07\r", timestamp: Number.POSITIVE_INFINITY })
				.render(72)
				.join("\n") ?? "";
		expect(rendered).toContain("hello");
		expect(rendered).toContain("Time unavailable");
		expect(rendered).not.toContain("52;c;");
		expect(rendered).not.toContain("secret");
		expect(rendered).not.toContain("\r");
		tui.stop();
	});
	async function scene(
		toolName: string,
		args: Record<string, unknown>,
		result: Parameters<ToolExecutionComponent["updateResult"]>[0],
	) {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "first question", timestamp: 1700000000000 });
		harness.sessionManager.appendMessage({ role: "user", content: "second question", timestamp: 1700000001000 });
		const terminal = new VirtualTerminal(100, 24);
		const tui = new TuiAltScreen(terminal);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				setHeader: (factory) => {
					factory?.(tui, theme);
				},
			}),
		});
		const renderer = harness.session.extensionRunner.resolveToolRenderers(toolName, () =>
			harness.session.getToolDefinition(toolName),
		);
		tui.setHoverPreviewDelay(0);
		const component = new ToolExecutionComponent(toolName, "preview-test", args, {}, renderer, tui, harness.tempDir);
		component.markExecutionStarted();
		component.updateResult(result);
		const editor = new CustomEditor(tui, defaultEditorTheme, new KeybindingsManager(), {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		editor.setText("draft");
		const document = new Container();
		document.addChild(new UserMessageComponent("first question"));
		document.addChild(component);
		document.addChild(new UserMessageComponent("second question"));
		const viewport = createChatViewport({
			document,
			pendingMessages: new Container(),
			status: new Container(),
			editor,
			footer: new Text("footer", 0, 0),
		});
		tui.setLayoutRoot(viewport.root);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		return { harness, terminal, tui, component, editor, viewport, document };
	}

	it("auto-collapses tool results and shows a scrollable, current preview without changing the draft or session", async () => {
		const h = await scene(
			"read",
			{ path: "notes.txt" },
			{
				content: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `output ${i}`).join("\n") }],
				isError: false,
			},
		);
		try {
			const leaf = h.harness.sessionManager.getLeafId();
			const rows = h.component.render(100);
			expect(rows).toHaveLength(2);
			expect(rows.join("\n")).not.toContain("output 0");
			const row = h.terminal.getViewport().findIndex((line) => line.includes("notes.txt"));
			h.terminal.sendInput(`\x1b[<35;5;${row + 1}M`);
			await h.terminal.waitForRender();
			expect(h.terminal.getViewport().join("\n")).toContain("output 0");
			expect(h.terminal.getViewport().join("\n")).toContain("Click to expand");
			expect(h.component.render(100)).toHaveLength(2);
			expect(h.tui.getFocusedComponent()).toBe(h.editor);
			const before = h.viewport.transcript.scrollTop;
			const previewRow = h.terminal.getViewport().findIndex((line) => line.includes("Click to expand"));
			h.terminal.sendInput(`\x1b[<65;10;${previewRow}M`);
			await h.terminal.waitForRender();
			expect(h.viewport.transcript.scrollTop).toBe(before);
			expect(h.terminal.getViewport().join("\n")).toContain("2/");
			h.component.updateResult({ content: [{ type: "text", text: "updated output" }], isError: false });
			h.tui.requestRender();
			await h.terminal.waitForRender();
			expect(h.terminal.getViewport().join("\n")).toContain("updated output");
			h.terminal.sendInput("Z");
			await h.terminal.waitForRender();
			expect(h.tui.hasOverlay()).toBe(false);
			expect(h.editor.getText()).toBe("draftZ");
			expect(h.harness.sessionManager.getLeafId()).toBe(leaf);
			expect(h.harness.faux.state.callCount).toBe(0);
		} finally {
			h.tui.stop();
		}
	});

	it("previews self-framed edit diffs and expands them by clicking the tool row", async () => {
		const h = await scene(
			"edit",
			{ path: "notes.txt", oldText: "before", newText: "after" },
			{
				content: [{ type: "text", text: "Successfully replaced text" }],
				details: { diff: "-1 before\n+1 after", firstChangedLine: 1 },
				isError: false,
			},
		);
		try {
			expect(h.component.render(100)).toHaveLength(2);
			expect(stripAnsi(h.component.render(100).join("\n"))).toContain("edit");
			const row = h.terminal.getViewport().findIndex((line) => line.includes("notes.txt"));
			h.terminal.sendInput(`\x1b[<35;5;${row + 1}M`);
			await h.terminal.waitForRender();
			expect(h.terminal.getViewport().join("\n")).toContain("-1 before");
			expect(h.terminal.getViewport().join("\n")).toContain("+1 after");
			h.tui.hideHoverPreview();
			h.terminal.sendInput(`\x1b[<0;5;${row + 1}M`);
			h.terminal.sendInput(`\x1b[<0;5;${row + 1}m`);
			await h.terminal.waitForRender();
			expect(h.component.render(100).length).toBeGreaterThan(2);
			expect(stripAnsi(h.component.render(100).join("\n"))).toContain("+1 after");
			expect(h.tui.getFocusedComponent()).toBe(h.editor);
		} finally {
			h.tui.stop();
		}
	});

	it("expands a tool immediately when clicked during its preview delay", async () => {
		const h = await scene(
			"read",
			{ path: "notes.txt" },
			{
				content: [{ type: "text", text: "visible result" }],
				isError: false,
			},
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			h.tui.setHoverPreviewDelay(2000);
			const row = h.terminal.getViewport().findIndex((line) => line.includes("notes.txt")) + 1;
			h.terminal.sendInput(`\x1b[<35;5;${row}M`);
			expect(h.tui.hasOverlay()).toBe(false);
			h.terminal.sendInput(`\x1b[<0;5;${row}M`);
			h.terminal.sendInput(`\x1b[<0;5;${row}m`);
			expect(stripAnsi(h.component.render(100).join("\n"))).toContain("visible result");
			await vi.advanceTimersByTimeAsync(2100);
			expect(h.tui.hasOverlay()).toBe(false);
			expect(h.tui.getFocusedComponent()).toBe(h.editor);
		} finally {
			h.tui.stop();
			vi.useRealTimers();
		}
	});

	it("expands only the previewed tool when the panel is clicked", async () => {
		const h = await scene(
			"read",
			{ path: "notes.txt" },
			{
				content: [{ type: "text", text: "first result" }],
				isError: false,
			},
		);
		try {
			const renderer = h.harness.session.extensionRunner.resolveToolRenderers("read", () =>
				h.harness.session.getToolDefinition("read"),
			);
			const second = new ToolExecutionComponent(
				"read",
				"second",
				{ path: "second.txt" },
				{},
				renderer,
				h.tui,
				h.harness.tempDir,
			);
			second.updateResult({ content: [{ type: "text", text: "second result" }], isError: false });
			h.document.addChild(second);
			h.tui.renderNow();
			const row = h.terminal.getViewport().findIndex((line) => line.includes("notes.txt")) + 1;
			h.terminal.sendInput(`\x1b[<35;5;${row}M`);
			await h.terminal.waitForRender();
			const panelRow = h.terminal.getViewport().findIndex((line) => line.includes("Click to expand")) + 1;
			expect(panelRow).toBeGreaterThan(0);
			h.terminal.sendInput(`\x1b[<0;10;${panelRow}M`);
			h.terminal.sendInput(`\x1b[<0;10;${panelRow}m`);
			await h.terminal.waitForRender();
			expect(h.tui.hasOverlay()).toBe(false);
			expect(stripAnsi(h.component.render(100).join("\n"))).toContain("first result");
			expect(second.render(100)).toHaveLength(2);
			expect(h.tui.getFocusedComponent()).toBe(h.editor);
		} finally {
			h.tui.stop();
		}
	});

	it("uses persisted user timestamps for timeline previews and releases its callbacks on shutdown", async () => {
		const h = await scene(
			"read",
			{ path: "notes.txt" },
			{ content: [{ type: "text", text: "text" }], isError: false },
		);
		try {
			const ticks = h.terminal.getViewport().flatMap((line, row) => (/(?:━━| ─)$/.test(line) ? [row] : []));
			expect(ticks).toHaveLength(2);
			h.terminal.sendInput(`\x1b[<35;100;${ticks[0] + 1}M`);
			await h.terminal.waitForRender();
			expect(h.terminal.getViewport().join("\n")).toContain("2023");
			expect(h.terminal.getViewport().join("\n")).toContain("first question");
			await h.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			await h.terminal.waitForRender();
			expect(h.tui.hasOverlay()).toBe(false);
			expect(h.viewport.transcript.rightGutterWidth).toBe(0);
		} finally {
			h.tui.stop();
		}
	});
});

describe("Grok preview panel", () => {
	it("scrolls long content inside its own bounds and keeps Unicode within the width", () => {
		const panel = new PreviewPanel(
			new Text(Array.from({ length: 20 }, (_, i) => `行 ${i} e\u0301`).join("\n"), 0, 0),
			{
				maxHeight: () => 7,
				border: (text) => text,
				background: (text) => text,
			},
		);
		expect(panel.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
		expect(panel.render(24).join("\n").includes("行 0")).toBe(true);
		panel.handleMouse({
			type: "wheel",
			button: "none",
			x: 2,
			y: 2,
			screenX: 2,
			screenY: 2,
			width: 24,
			height: 7,
			wheelDelta: 5,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(!panel.render(24).join("\n").includes("行 0")).toBe(true);
		expect(panel.render(24).join("\n").includes("行 5")).toBe(true);
		for (const width of [1, 4, 12, 24])
			expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});
