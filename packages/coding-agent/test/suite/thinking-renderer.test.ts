import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import type { ThinkingRenderer } from "../../src/index.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";

beforeAll(() => initTheme("dark"));

test("registered thinking renderers receive grouped source and reuse their component and Markdown", async () => {
	const renderer = vi.fn<ThinkingRenderer>((thinking, _theme, context) => {
		const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		component.setText(`Custom ${context.mode}: ${thinking}`);
		return component;
	});
	const laterRenderer = vi.fn<ThinkingRenderer>(() => new Text("Later", 0, 0));
	const harness = await createHarness({
		extensionFactories: [
			(pi) => pi.registerThinkingRenderer(renderer),
			(pi) => pi.registerThinkingRenderer(laterRenderer),
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Inspect files" },
				{ type: "thinking", thinking: "Check paths" },
				{ type: "text", text: "Done" },
			]),
		]);
		await harness.session.prompt("fixture");
		const message = harness.session.messages.find((message) => message.role === "assistant");
		if (!message || message.role !== "assistant") throw new Error("Missing faux response");
		const originalMessages = structuredClone(harness.session.messages);
		const providerCalls = harness.faux.state.callCount;
		expect(harness.session.extensionRunner.getThinkingRenderer()).toBe(renderer);
		const component = new AssistantMessageComponent(
			message,
			"summary",
			undefined,
			"Custom label",
			2,
			[],
			undefined,
			undefined,
			undefined,
			harness.session.extensionRunner.getThinkingRenderer(),
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Custom summary: Inspect files");
		expect(renderer).toHaveBeenCalledOnce();
		expect(renderer.mock.calls[0][0]).toBe("Inspect files\n\nCheck paths");
		expect(renderer.mock.calls[0][2]).toMatchObject({
			mode: "summary",
			isStreaming: false,
			active: false,
			hiddenLabel: "Custom label",
			outputPad: 2,
		});
		const markdown = renderer.mock.calls[0][2].markdown;
		const renderedThinking = renderer.mock.results[0].value;
		const streamingMessage = {
			...message,
			content: [{ type: "thinking" as const, thinking: "Inspect files\n\nCheck paths\nRead config" }],
		};
		component.updateContent(streamingMessage, true);
		expect(renderer.mock.calls.at(-1)?.[2]).toMatchObject({
			isStreaming: true,
			active: true,
		});
		expect(renderer.mock.calls.at(-1)?.[2].lastComponent).toBe(renderedThinking);
		expect(renderer.mock.calls.at(-1)?.[2].markdown).toBe(markdown);
		expect(laterRenderer).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(providerCalls);
		expect(harness.session.messages).toEqual(originalMessages);
	} finally {
		harness.cleanup();
	}
});

test("a thinking renderer can leave original Markdown to the host", async () => {
	const renderer = vi.fn<ThinkingRenderer>(() => undefined);
	const harness = await createHarness({ extensionFactories: [(pi) => pi.registerThinkingRenderer(renderer)] });
	try {
		harness.setResponses([fauxAssistantMessage([{ type: "thinking", thinking: "Original reasoning details" }])]);
		await harness.session.prompt("fixture");
		const message = harness.session.messages.find((message) => message.role === "assistant");
		if (!message || message.role !== "assistant") throw new Error("Missing faux response");
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
			harness.session.extensionRunner.getThinkingRenderer(),
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Original reasoning details");
		expect(renderer).toHaveBeenCalledOnce();
	} finally {
		harness.cleanup();
	}
});

test.each([
	{ name: "default", noExtensions: false, paths: [], enabled: true },
	{ name: "disabled", noExtensions: false, paths: ["-builtin:thinking-steps"], enabled: false },
	{ name: "no extensions", noExtensions: true, paths: [], enabled: false },
	{ name: "explicit", noExtensions: true, paths: [], additional: ["builtin:thinking-steps"], enabled: true },
])("thinking-steps follows built-in resource loading: $name", async ({ noExtensions, paths, additional, enabled }) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-thinking-renderer-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const settingsManager = SettingsManager.inMemory({ extensions: paths });
	const builtin = builtInExtensions.find(
		(extension) => typeof extension !== "function" && extension.name === "thinking-steps",
	);
	if (!builtin) throw new Error("Missing thinking-steps built-in registration");
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
		expect(Boolean(harness.session.extensionRunner.getThinkingRenderer())).toBe(enabled);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual(
			enabled ? ["builtin:thinking-steps"] : [],
		);
	} finally {
		harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("reload drops a disabled thinking renderer and loads a fresh one when re-enabled", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-thinking-reload-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const settingsManager = SettingsManager.inMemory();
	const rendererFactory = vi.fn((): ThinkingRenderer => () => new Text("Custom reasoning", 0, 0));
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "custom-thinking",
				builtin: true,
				factory: (pi) => pi.registerThinkingRenderer(rendererFactory()),
			},
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	try {
		const originalRenderer = harness.session.extensionRunner.getThinkingRenderer();
		expect(originalRenderer).toBeDefined();
		settingsManager.setExtensionPaths(["-builtin:custom-thinking"]);
		await harness.session.reload();
		expect(harness.session.extensionRunner.getThinkingRenderer()).toBeUndefined();
		settingsManager.setExtensionPaths([]);
		await harness.session.reload();
		expect(harness.session.extensionRunner.getThinkingRenderer()).toBeDefined();
		expect(harness.session.extensionRunner.getThinkingRenderer()).not.toBe(originalRenderer);
		expect(rendererFactory).toHaveBeenCalledTimes(2);
	} finally {
		harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
