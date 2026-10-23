import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type Component,
	getCapabilities,
	setCapabilities,
	type TUI,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import type { CodemodeToolDetails } from "../src/extensions/codemode/tool.ts";
import { toolDisplayRenderers } from "../src/extensions/tool-display/renderer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function render(
	result: AgentToolResult<CodemodeToolDetails | undefined>,
	isError = false,
	expanded = true,
	width = 200,
): string {
	const context = {
		args: { code: "" },
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError,
		durationMs: undefined,
		outputPad: 1,
	} satisfies ToolRenderContext;
	const component = codemodeRenderers.renderResult?.(
		result,
		{ expanded, isPartial: false },
		theme,
		context,
	) as Component;
	return stripVTControlCharacters(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function createCompactTool(duplicateWrapper = false) {
	const tui = new TuiAltScreen(new VirtualTerminal(160, 30));
	const renderers = toolDisplayRenderers(codemodeRenderers);
	const component = new ToolExecutionComponent(
		"codemode",
		"call",
		{ code: 'const hiddenScript = "code"; text(hiddenScript);' },
		{},
		duplicateWrapper ? toolDisplayRenderers(renderers) : renderers,
		tui,
		"/",
	);
	return { tui, component, text: () => stripVTControlCharacters(component.render(160).join("\n")) };
}

describe("codemode renderer", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	it("hides the script header and shows the output", () => {
		const text = render({
			content: [
				{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text", text: "hello" },
			],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 }] },
		});
		expect(text).toBe('✓ read {"path":"a"} 5ms\n\nhello');
	});

	it("shows the cost of model calls and their total", () => {
		const call = { name: "models.classify", args: "scorer/judge", status: "ok" as const, durationMs: 5 };
		const text = render({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: {
				calls: [
					{ ...call, id: "call/models.classify/1", cost: 0.000012936 },
					{ ...call, id: "call/models.classify/2", cost: 0.02 },
					{ ...call, id: "call/models.classify/3" },
				],
			},
		});
		expect(text).toBe(
			[
				"✓ models.classify scorer/judge 5ms $0.000013",
				"✓ models.classify scorer/judge 5ms $0.02",
				"✓ models.classify scorer/judge 5ms",
				"Model calls: $0.02",
			].join("\n"),
		);
	});

	it("shows results without a header, such as rejected options", () => {
		const text = render(
			{
				content: [{ type: "text", text: "The @options line must be followed by JavaScript source" }],
				details: undefined,
			},
			true,
		);
		expect(text).toBe("The @options line must be followed by JavaScript source");
	});

	it("limits collapsed output to wrapped lines, not logical lines", () => {
		const text = render(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
					{ type: "text", text: "x".repeat(1000) },
				],
				details: { calls: [], fullOutputPath: "/tmp/out.txt" },
			},
			false,
			false,
			50,
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(7);
		expect(lines.slice(0, 5)).toEqual(Array(5).fill("x".repeat(50)));
		expect(lines[5]).toMatch(/^\.\.\. \(15 more lines,/);
		expect(lines[6]).toBe("Full output: /tmp/out.txt");
	});

	it.each([false, true])(
		"shows every nested call without script or raw output (duplicate wrapper: %s)",
		(duplicateWrapper) => {
			const { component, text } = createCompactTool(duplicateWrapper);
			component.updateResult({
				content: [{ type: "text", text: "hidden raw output" }],
				details: {
					calls: Array.from({ length: 12 }, (_, index) => ({
						id: `call/${index}`,
						name: "read",
						args: `{"path":"src/file-${index}.ts","offset":1,"limit":130}`,
						status: "ok",
						durationMs: 12,
					})),
				},
				isError: false,
			});
			const output = text();
			expect(output).toContain("Done");
			for (let index = 0; index < 12; index++) {
				expect(output).toContain(`✓ read {"path":"src/file-${index}.ts","offset":1,"limit":130} 12ms`);
			}
			expect(output).not.toContain("hiddenScript");
			expect(output).not.toContain("hidden raw output");
			expect(output).not.toContain("earlier calls");
			for (const width of [12, 40, 80, 160]) {
				const lines = component.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(component.render(width)).toEqual(lines);
			}
		},
	);

	it.each([false, true])("distinguishes all three tool modes (duplicate wrapper: %s)", (duplicateWrapper) => {
		const { component, text } = createCompactTool(duplicateWrapper);
		component.updateResult({
			content: [{ type: "text", text: "full script output" }],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"file.ts"}', status: "ok" }] },
			isError: false,
		});
		component.setToolViewMode("collapsed");
		expect(text()).toContain("codemode");
		expect(text()).not.toContain("file.ts");
		expect(text()).not.toContain("hiddenScript");
		expect(text()).not.toContain("full script output");
		component.setToolViewMode("summary");
		expect(text()).toContain('✓ read {"path":"file.ts"}');
		expect(text()).not.toContain("hiddenScript");
		expect(text()).not.toContain("full script output");
		component.setToolViewMode("expanded");
		expect(text()).toContain("hiddenScript");
		expect(text()).toContain('✓ read {"path":"file.ts"}');
		expect(text()).toContain("full script output");
	});

	it("updates nested statuses and retains a caught failure after the script completes", () => {
		const { component, text } = createCompactTool();
		const call = { id: "call/1", name: "read", args: '{"path":"missing.txt"}' };
		component.markExecutionStarted();
		component.updateResult(
			{ content: [], details: { calls: [{ ...call, status: "running" }] }, isError: false },
			true,
		);
		const height = component.render(160).length;
		expect(text()).toContain("Running");
		expect(text()).toContain('… read {"path":"missing.txt"}');
		component.updateResult({
			content: [{ type: "text", text: "caught the error" }],
			details: { calls: [{ ...call, status: "error", error: "File missing", durationMs: 5 }] },
			isError: false,
		});
		expect(text()).toContain("Done");
		expect(text()).toContain('✗ read {"path":"missing.txt"} 5ms');
		expect(text()).not.toContain("caught the error");
		expect(component.render(160)).toHaveLength(height);
	});

	it("keeps script errors visible even after a long earlier output", () => {
		const { component, text } = createCompactTool();
		component.updateResult({
			content: [
				{
					type: "text",
					text: `${"earlier output\n".repeat(100)}Script error:\nReferenceError: missingValue is not defined`,
				},
			],
			details: { calls: [{ id: "call/1", name: "read", args: "{}", status: "ok" }] },
			isError: true,
		});
		expect(text()).toContain("Failed");
		expect(text()).toContain("ReferenceError: missingValue is not defined");
		expect(text()).not.toContain("earlier output");
	});

	it("retains output and rejected-input errors for scripts with no nested calls", () => {
		const { component, text } = createCompactTool();
		component.updateResult({
			content: [{ type: "text", text: "computed output" }],
			details: { calls: [] },
			isError: false,
		});
		expect(text()).toContain("computed output");
		expect(text()).not.toContain("hiddenScript");
		component.updateResult({ content: [{ type: "text", text: "Invalid script options" }], isError: true });
		expect(text()).toContain("Invalid script options");
	});

	it.each([
		["collapsed", false],
		["collapsed", true],
		["summary", false],
		["summary", true],
	] as const)("retains hover and click details from %s mode (duplicate wrapper: %s)", (mode, duplicateWrapper) => {
		const { tui, component, text } = createCompactTool(duplicateWrapper);
		component.setToolViewMode(mode);
		vi.spyOn(tui, "transcriptViewportHeight", "get").mockReturnValue(20);
		const show = vi.spyOn(tui, "showHoverPreview").mockImplementation(() => {});
		component.updateResult({
			content: [{ type: "text", text: "full script output" }],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"file.ts"}', status: "ok" }] },
			isError: false,
		});
		const lines = component.render(160);
		const beforePreview = text();
		const y = lines.findIndex((line) => stripVTControlCharacters(line).includes("codemode"));
		const event = {
			type: "move" as const,
			button: "none" as const,
			x: 4,
			y,
			screenX: 4,
			screenY: y,
			width: 160,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		component.handleMouse(event);
		const panel = show.mock.lastCall?.[1];
		expect(panel).toBeDefined();
		const preview = stripVTControlCharacters(panel!.render(160).join("\n"));
		expect(preview).toContain("hiddenScript");
		expect(preview).toContain("full script output");
		expect(text()).toBe(beforePreview);
		component.handleMouse({ ...event, type: "click", button: "left" });
		expect(text()).toContain("hiddenScript");
		expect(text()).toContain("full script output");
		component.handleMouse({ ...event, type: "click", button: "left" });
		expect(text()).not.toContain("hiddenScript");
		expect(text()).not.toContain("full script output");
		expect(text().includes("file.ts")).toBe(mode === "summary");
	});

	it("preserves the native image path instead of compacting its output", () => {
		const capabilities = getCapabilities();
		setCapabilities({ ...capabilities, images: "kitty" });
		try {
			const { component, text } = createCompactTool();
			component.updateResult({
				content: [
					{ type: "text", text: "image output" },
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0m0AAAAASUVORK5CYII=",
					},
				],
				details: { calls: [{ id: "call/1", name: "read", args: "{}", status: "ok" }] },
				isError: false,
			});
			expect(text()).toContain("image output");
			expect(component.render(160).join("\n")).toContain("\x1b_G");
		} finally {
			setCapabilities(capabilities);
		}
	});

	// #10708
	it("shows the elapsed time while the script runs and the total once it finished", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const tui = { requestRender: () => {} } as unknown as TUI;
		const component = new ToolExecutionComponent("codemode", "call", { code: "" }, {}, codemodeRenderers, tui, "/");
		const text = () => stripVTControlCharacters(component.render(120).join("\n"));
		component.markExecutionStarted();
		component.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
		vi.advanceTimersByTime(3_000);
		expect(text()).toContain("Elapsed 3.0s");

		component.updateResult({ content: [], details: { calls: [] }, isError: false, durationMs: 5_100 }, false);
		expect(text()).toContain("Took 5.1s");
		expect(text()).not.toContain("Elapsed");
	});
});
