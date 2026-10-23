import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, test } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import grokUi from "../../examples/extensions/grok-ui.ts";
import { createToolHtmlRenderer } from "../../src/core/export-html/tool-renderer.ts";
import type { ToolRenderers } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { codemodeRenderers } from "../../src/extensions/codemode/renderer.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import toolDisplay from "../../src/extensions/tool-display/index.ts";
import { createChatViewport } from "../../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, getToolResult } from "./harness.ts";

beforeAll(() => initTheme("dark"));

test("tool-display works without Grok and leaves execution and model context intact", async () => {
	const harness = await createHarness({ extensionFactories: [toolDisplay] });
	try {
		const file = join(harness.tempDir, "notes.txt");
		writeFileSync(file, "original tool output\n");
		const original = {
			model: harness.session.model,
			prompt: harness.session.systemPrompt,
			tools: harness.session.getActiveToolNames(),
			read: harness.session.getToolDefinition("read"),
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read complete"),
		]);
		await harness.session.prompt("Read notes.");
		const messages = structuredClone(harness.session.messages);
		const calls = harness.faux.state.callCount;
		const renderer = harness.session.extensionRunner.resolveToolRenderers("read", () => original.read);
		const component = new ToolExecutionComponent(
			"read",
			"standalone",
			{ path: file },
			{},
			renderer,
			new TuiAltScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		const output = () => stripAnsi(component.render(100).join("\n"));
		expect(output()).toContain("Queued");
		component.markExecutionStarted();
		expect(output()).toContain("Running");
		component.updateResult(getToolResult(harness, "read"));
		expect(output()).toContain("Done");
		expect(output()).not.toContain("original tool output");
		component.setToolViewMode("expanded");
		expect(output()).toContain("original tool output");
		component.setToolViewMode("collapsed");
		expect(output()).not.toContain("original tool output");
		expect(harness.session.extensionRunner.getMarkdownTransformers()).toEqual([]);
		expect(harness.session.getToolDefinition("read")).toBe(original.read);
		expect(harness.session.getActiveToolNames()).toEqual(original.tools);
		expect(harness.session.model).toBe(original.model);
		expect(harness.session.systemPrompt).toBe(original.prompt);
		expect(harness.session.messages).toEqual(messages);
		expect(harness.faux.state.callCount).toBe(calls);
	} finally {
		harness.cleanup();
	}
});

test("Grok alone leaves tool renderers unchanged", async () => {
	const harness = await createHarness({ extensionFactories: [grokUi] });
	try {
		const native: ToolRenderers = { renderCall: () => new Text("Native tool", 0, 0) };
		expect(harness.session.extensionRunner.resolveToolRenderers("custom", () => native)).toBe(native);
	} finally {
		harness.cleanup();
	}
});

test.each([1, 2])(
	"HTML export preserves native codemode results with %i freshly resolved display wrappers",
	async (count) => {
		const harness = await createHarness({ extensionFactories: Array.from({ length: count }, () => toolDisplay) });
		try {
			const renderer = createToolHtmlRenderer({
				getToolRenderers: (name) =>
					harness.session.extensionRunner.resolveToolRenderers(name, () => codemodeRenderers),
				theme,
				cwd: harness.tempDir,
			});
			const call = renderer.renderCall("html-codemode", "codemode", {
				code: 'const SCRIPT_BODY_MARKER = true;\ntext("RAW_OUTPUT_MARKER");',
			});
			expect(call).toContain("SCRIPT_BODY_MARKER");
			expect(call).not.toContain("Queued");
			const result = renderer.renderResult(
				"html-codemode",
				"codemode",
				[{ type: "text", text: "RAW_OUTPUT_MARKER" }],
				{ calls: [{ id: "nested/1", name: "read", args: '{"path":"NESTED_CALL_MARKER"}', status: "ok" }] },
				false,
			);
			expect(result?.expanded).toContain("RAW_OUTPUT_MARKER");
			expect(result?.expanded).toContain("NESTED_CALL_MARKER");
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			harness.cleanup();
		}
	},
);

test.each([1, 2])(
	"HTML export keeps fallback results for a call-only tool with %i freshly resolved display wrappers",
	async (count) => {
		const harness = await createHarness({ extensionFactories: Array.from({ length: count }, () => toolDisplay) });
		try {
			const native: ToolRenderers = { renderCall: () => new Text("CUSTOM_CALL_MARKER", 0, 0) };
			const renderer = createToolHtmlRenderer({
				getToolRenderers: (name) => harness.session.extensionRunner.resolveToolRenderers(name, () => native),
				theme,
				cwd: harness.tempDir,
			});
			expect(renderer.renderCall("html-call-only", "custom", {})).toContain("CUSTOM_CALL_MARKER");
			const result = renderer.renderResult(
				"html-call-only",
				"custom",
				[{ type: "text", text: Array.from({ length: 12 }, (_, index) => `RESULT_LINE_${index}`).join("\n") }],
				undefined,
				false,
			);
			expect(result?.collapsed).toContain("RESULT_LINE_0");
			expect(result?.collapsed).not.toContain("RESULT_LINE_11");
			expect(result?.expanded).toContain("RESULT_LINE_0");
			expect(result?.expanded).toContain("RESULT_LINE_11");
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			harness.cleanup();
		}
	},
);

test("standalone tool previews preserve the draft and scroll position, then expand only on click", async () => {
	const harness = await createHarness({ extensionFactories: [toolDisplay] });
	const terminal = new VirtualTerminal(100, 24);
	const tui = new TuiAltScreen(terminal);
	try {
		const renderer = harness.session.extensionRunner.resolveToolRenderers("read", () =>
			harness.session.getToolDefinition("read"),
		);
		const component = new ToolExecutionComponent(
			"read",
			"standalone-hover",
			{ path: "notes.txt" },
			{},
			renderer,
			tui,
			harness.tempDir,
		);
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `preview ${index}`).join("\n") }],
			isError: false,
		});
		const editor = new CustomEditor(tui, defaultEditorTheme, new KeybindingsManager());
		editor.setText("unsent draft");
		const document = new Container();
		document.addChild(component);
		const viewport = createChatViewport({
			document,
			pendingMessages: new Container(),
			status: new Container(),
			editor,
			footer: new Text("footer", 0, 0),
		});
		tui.setLayoutRoot(viewport.root);
		tui.setMouseHoverEnabled(true);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const height = component.render(100).length;
		const row = terminal.getViewport().findIndex((line) => line.includes("notes.txt")) + 1;
		expect(row).toBeGreaterThan(0);
		terminal.sendInput(`\x1b[<35;5;${row}M`);
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("preview 0");
		expect(component.render(100)).toHaveLength(height);
		const scrollTop = viewport.transcript.scrollTop;
		const previewRow = terminal.getViewport().findIndex((line) => line.includes("Click to expand")) + 1;
		expect(previewRow).toBeGreaterThan(0);
		terminal.sendInput(`\x1b[<65;10;${previewRow}M`);
		await terminal.waitForRender();
		expect(viewport.transcript.scrollTop).toBe(scrollTop);
		expect(editor.getText()).toBe("unsent draft");
		expect(tui.getFocusedComponent()).toBe(editor);
		terminal.sendInput(`\x1b[<0;10;${previewRow}M`);
		terminal.sendInput(`\x1b[<0;10;${previewRow}m`);
		await terminal.waitForRender();
		expect(tui.hasOverlay()).toBe(false);
		expect(component.render(100).length).toBeGreaterThan(height);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("preview 0");
		expect(editor.getText()).toBe("unsent draft");
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		tui.stop();
		harness.cleanup();
	}
});

test.each([
	{ name: "default", noExtensions: false, paths: [], enabled: true },
	{ name: "disabled", noExtensions: false, paths: ["-builtin:tool-display"], enabled: false },
	{ name: "no extensions", noExtensions: true, paths: [], enabled: false },
	{ name: "explicit", noExtensions: true, paths: [], additional: ["builtin:tool-display"], enabled: true },
])("tool-display follows built-in resource loading: $name", async ({ noExtensions, paths, additional, enabled }) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-tool-display-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const settingsManager = SettingsManager.inMemory({ extensions: paths });
	const builtin = builtInExtensions.find(
		(extension) => typeof extension !== "function" && extension.name === "tool-display",
	);
	if (!builtin) throw new Error("Missing tool-display built-in registration");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [builtin],
		noExtensions,
		additionalExtensionPaths: additional,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	try {
		expect(loader.getExtensions().errors).toEqual([]);
		const native: ToolRenderers = { renderCall: () => new Text("Native tool", 0, 0) };
		const resolved = harness.session.extensionRunner.resolveToolRenderers("custom", () => native);
		expect(resolved === native).toBe(!enabled);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual(
			enabled ? ["builtin:tool-display"] : [],
		);
	} finally {
		harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("reload removes and restores the tool wrapper without changing tool definitions", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-tool-display-reload-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "tool-display", builtin: true, factory: toolDisplay }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	try {
		const native: ToolRenderers = { renderCall: () => new Text("Native tool", 0, 0) };
		const read = harness.session.getToolDefinition("read");
		const resolve = () => harness.session.extensionRunner.resolveToolRenderers("custom", () => native);
		expect(resolve()).not.toBe(native);
		settingsManager.setExtensionPaths(["-builtin:tool-display"]);
		await harness.session.reload();
		expect(resolve()).toBe(native);
		settingsManager.setExtensionPaths([]);
		await harness.session.reload();
		expect(resolve()).not.toBe(native);
		expect(harness.session.getToolDefinition("read")).toMatchObject({
			name: "read",
			description: read?.description,
			parameters: read?.parameters,
		});
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
