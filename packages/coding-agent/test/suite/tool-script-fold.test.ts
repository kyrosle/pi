import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, expect, test } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createAllToolRenderers } from "../../src/core/tools/renderers/index.ts";
import toolDisplay from "../../src/extensions/tool-display/index.ts";
import { createChatViewport } from "../../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";

beforeAll(() => initTheme("dark"));

test("keeps every recorded tool invocation while folding each script body", async () => {
	const commands = Array.from(
		{ length: 12 },
		(_, index) =>
			`echo CALL_${index};echo SEQ_${index}|cat||echo OR_${index}&&echo AND_${index}|&cat\n# HIDDEN_SCRIPT_BODY_${index}; || | &&\necho HIDDEN_SCRIPT_TAIL_${index}`,
	);
	const harness = await createHarness({
		extensionFactories: [
			toolDisplay,
			(pi) => {
				pi.registerTool({
					name: "bash",
					label: "bash",
					description: "Return fixture output without executing the command.",
					parameters: Type.Object({ command: Type.String() }),
					...createAllToolRenderers().bash,
					execute: async () => ({ content: [{ type: "text", text: "HIDDEN_RAW_OUTPUT" }], details: {} }),
				});
			},
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				commands.map((command) => fauxToolCall("bash", { command })),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Fixture complete."),
		]);
		await harness.session.prompt("Run the fixture calls.");
		const messages = structuredClone(harness.session.messages);
		const requests = harness.faux.state.callCount;
		const results = messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "bash",
		);
		expect(results).toHaveLength(commands.length);
		const tui = new TuiAltScreen(new VirtualTerminal());
		const renderers = harness.session.extensionRunner.resolveToolRenderers("bash", () =>
			harness.session.getToolDefinition("bash"),
		);
		const document = new Container();
		for (let index = 0; index < commands.length; index++) {
			const component = new ToolExecutionComponent(
				"bash",
				results[index].toolCallId,
				{ command: commands[index] },
				{},
				renderers,
				tui,
				harness.tempDir,
			);
			component.updateResult(results[index]);
			document.addChild(component);
		}
		const output = stripAnsi(document.render(80).join("\n"));
		for (let index = 0; index < commands.length; index++) {
			expect(output).toContain(`$ echo CALL_${index}`);
			expect(output).toContain(`; echo SEQ_${index}`);
			expect(output).toContain(`|| echo OR_${index}`);
			expect(output).toContain(`&& echo AND_${index}`);
		}
		expect(output.match(/\| cat/g)).toHaveLength(commands.length);
		expect(output.match(/\|& cat/g)).toHaveLength(commands.length);
		expect(output.match(/3 lines/g)).toHaveLength(commands.length);
		expect(output.match(/Done/g)).toHaveLength(commands.length);
		expect(output).not.toContain("HIDDEN_SCRIPT_BODY");
		expect(output).not.toContain("HIDDEN_SCRIPT_TAIL");
		expect(output).not.toContain("HIDDEN_RAW_OUTPUT");
		expect(harness.session.messages).toEqual(messages);
		expect(harness.faux.state.callCount).toBe(requests);
	} finally {
		harness.cleanup();
	}
});

test("script hover preserves the scrolled transcript and draft, and click opens the complete body", async () => {
	const harness = await createHarness({ extensionFactories: [toolDisplay] });
	const terminal = new VirtualTerminal(100, 24);
	const tui = new TuiAltScreen(terminal);
	try {
		const renderer = harness.session.extensionRunner.resolveToolRenderers("bash", () =>
			harness.session.getToolDefinition("bash"),
		);
		const component = new ToolExecutionComponent(
			"bash",
			"script-hover",
			{ command: "echo ENTRY; printf '%s' '\nFULL_SCRIPT_BODY ; || | &&\nFULL_SCRIPT_TAIL'\necho FINISH" },
			{},
			renderer,
			tui,
			harness.tempDir,
		);
		component.updateResult({ content: [{ type: "text", text: "FULL_SCRIPT_RESULT" }], isError: false });
		const document = new Container();
		document.addChild(new Text(Array.from({ length: 35 }, (_, index) => `history ${index}`).join("\n"), 0, 0));
		document.addChild(component);
		document.addChild(new Text("later transcript\n".repeat(20), 0, 0));
		const editor = new CustomEditor(tui, defaultEditorTheme, new KeybindingsManager());
		editor.setText("unsent script review draft");
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
		viewport.transcript.scrollTo(30, { disableFollow: true });
		await terminal.waitForRender();
		const before = terminal.getViewport().join("\n");
		expect(before).toContain("4 lines");
		expect(before).not.toContain("FULL_SCRIPT_BODY");
		const scrollTop = viewport.transcript.scrollTop;
		const height = component.render(100).length;
		const row = terminal.getViewport().findIndex((line) => line.includes("4 lines")) + 1;
		expect(row).toBeGreaterThan(0);
		terminal.sendInput(`\x1b[<35;5;${row}M`);
		await terminal.waitForRender();
		const preview = terminal.getViewport().join("\n");
		for (const marker of ["FULL_SCRIPT_BODY", "FULL_SCRIPT_TAIL", "FULL_SCRIPT_RESULT"])
			expect(preview).toContain(marker);
		expect(viewport.transcript.scrollTop).toBe(scrollTop);
		expect(component.render(100)).toHaveLength(height);
		expect(editor.getText()).toBe("unsent script review draft");
		expect(tui.getFocusedComponent()).toBe(editor);
		const previewRow = terminal.getViewport().findIndex((line) => line.includes("Click to expand")) + 1;
		expect(previewRow).toBeGreaterThan(0);
		terminal.sendInput(`\x1b[<0;10;${previewRow}M`);
		terminal.sendInput(`\x1b[<0;10;${previewRow}m`);
		await terminal.waitForRender();
		expect(tui.hasOverlay()).toBe(false);
		const expanded = stripAnsi(component.render(100).join("\n"));
		for (const marker of ["FULL_SCRIPT_BODY", "FULL_SCRIPT_TAIL", "FULL_SCRIPT_RESULT"])
			expect(expanded).toContain(marker);
		expect(component.render(100).length).toBeGreaterThan(height);
		expect(editor.getText()).toBe("unsent script review draft");
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		tui.stop();
		harness.cleanup();
	}
});
