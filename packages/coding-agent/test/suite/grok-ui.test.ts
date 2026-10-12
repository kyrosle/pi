import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	setKeybindings,
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
import grokUi, { GrokEditor, GrokMenu } from "../../examples/extensions/grok-ui.ts";
import type { ToolRenderContext, ToolRenderers } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createChatViewport } from "../../src/modes/interactive/chat-viewport.ts";
import { WorkingStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import { initTheme, loadThemeFromPath, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createInteractiveTuiReference } from "../../src/modes/interactive/tui-renderer.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	setKeybindings(new KeybindingsManager());
	vi.restoreAllMocks();
});

function createEditor(columns = 80) {
	const tui = new TuiMainScreen(new VirtualTerminal(columns, 24));
	return new GrokEditor(tui, defaultEditorTheme, new KeybindingsManager(), () => "provider/model · medium");
}

describe("Grok editor", () => {
	it.each([4, 12, 24, 80, 120])("fits Chinese, combining characters and emoji in %i columns", (width) => {
		const editor = createEditor(width);
		editor.focused = true;
		editor.setText("你好，世界 e\u0301 👨‍👩‍👧‍👦\nsecond line");
		const lines = editor.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain(CURSOR_MARKER);
		if (width >= 6) {
			expect(stripAnsi(lines[0])).toMatch(/^╭.*╮$/);
			expect(stripAnsi(lines.at(-1) ?? "")).toMatch(/^╰.*╯$/);
		}
	});

	it("retains configurable submission, interruption, history and bracketed paste", () => {
		const keybindings = new KeybindingsManager({ "tui.input.submit": "ctrl+enter", "app.interrupt": "ctrl+q" });
		setKeybindings(keybindings);
		const editor = new GrokEditor(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			keybindings,
			() => "Pi",
		);
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
		const editor = new GrokEditor(tui, defaultEditorTheme, new KeybindingsManager(), () => "Pi");
		const working = new WorkingStatusIndicator(tui, "Working", { frames: ["*"] });
		try {
			editor.setWorkingStatusIndicator(working);
			expect(stripAnsi(editor.render(80)[0])).toContain("Working");
		} finally {
			working.dispose();
		}
	});

	it("positions the cursor at the clicked character inside the frame", () => {
		const editor = createEditor();
		editor.setText("abcd");
		editor.render(80);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 4,
			y: 1,
			screenX: 4,
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
		expect(resolve("edit")?.renderResult).toBe(harness.session.getToolDefinition("edit")?.renderResult);
		expect(resolve("unknown")).toBeUndefined();
	});

	it("shows queued, running, success and failure without replacing result renderers", async () => {
		const harness = await createHarness({ extensionFactories: [grokUi] });
		harnesses.push(harness);
		const original = harness.session.getToolDefinition("read");
		const renderer = harness.session.extensionRunner.resolveToolRenderers("read", () => original);
		expect(renderer?.renderResult).toBe(original?.renderResult);
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
		const editor = new GrokEditor(tui, defaultEditorTheme, new KeybindingsManager(), () => "Pi");
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
		const component = new ToolExecutionComponent(toolName, "preview-test", args, {}, renderer, tui, harness.tempDir);
		component.markExecutionStarted();
		component.updateResult(result);
		const editor = new GrokEditor(tui, defaultEditorTheme, new KeybindingsManager(), () => "Pi");
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
		return { harness, terminal, tui, component, editor, viewport };
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
