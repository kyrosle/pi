import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText, type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { BoundaryContextPreview } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import toolOutputContextExtension, { getToolOutputDirectory } from "../../src/extensions/tool-output-context/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const full = `hidden-sentinel ${"tool output ".repeat(30000)}`;
const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
const structuredContent = { count: 30000, value: full };
const large: AgentTool = {
	name: "large",
	label: "Large",
	description: "Returns a large result",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: full }, image],
		details: { receipt: "original" },
		structuredContent,
	}),
};

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		const archive = getToolOutputDirectory(harness.sessionManager);
		if (archive) rmSync(archive, { recursive: true, force: true });
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function respond(harness: Harness, inspect?: FauxResponseFactory): void {
	let called = false;
	const answer: FauxResponseFactory = (context, options, state, model) => {
		harness.appendResponses([answer]);
		if (
			context.messages.some(
				(message) =>
					message.role === "system" && contentText(message.content).includes("context summarization assistant"),
			)
		) {
			return fauxAssistantMessage("Checkpoint: the tool completed.");
		}
		if (!called) {
			called = true;
			return fauxAssistantMessage(fauxToolCall("large", {}, { id: "large-call" }), { stopReason: "toolUse" });
		}
		return inspect?.(context, options, state, model) ?? fauxAssistantMessage("done");
	};
	harness.setResponses([answer]);
}

function metadata(harness: Harness) {
	return harness.session.extensionRunner.emitContextBudget(
		undefined,
		(): BoundaryContextPreview => ({
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		}),
	);
}

describe("tool output context extension", () => {
	it("retains images and metadata, respects prior edits, and restores references across RPC reload and session resume", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-archive-extension-"));
		directories.push(directory);
		const seenStructured: unknown[] = [];
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 32000, maxTokens: 2048 }],
			tools: [large],
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
			extensionFactories: [
				toolOutputContextExtension,
				(pi) => {
					pi.on("tool_result", (event) => {
						seenStructured.push(event.structuredContent);
					});
					pi.on("turn_end", (event) => ({
						entries: event.toolResultEntryIds.map((targetId) => ({
							type: "context_edit" as const,
							targetId,
							replacement: {
								content: [{ type: "text" as const, text: full.replace("hidden-sentinel", "redacted") }],
							},
						})),
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "rpc" });
		respond(harness, (context) => {
			const result = context.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ toolCallId: "large-call", toolName: "large" });
			if (!result) throw new Error("Missing projected result");
			expect(contentText(result.content)).not.toContain("hidden-sentinel");
			const jsonPath = /Full result \(including images and metadata\): ([^\n]+)/.exec(
				contentText(result.content),
			)?.[1];
			expect(jsonPath).toBeTruthy();
			expect(JSON.parse(readFileSync(jsonPath!, "utf8"))).toMatchObject({
				toolCallId: "large-call",
				toolName: "large",
				content: [{ type: "text", text: full }, image],
				details: { receipt: "original" },
				isError: false,
			});
			return fauxAssistantMessage("done");
		});
		await harness.session.prompt("Run the large tool.");
		expect(harness.session.getLastAssistantText()).toBe("done");
		expect(seenStructured).toEqual([structuredContent]);
		const archive = getToolOutputDirectory(harness.sessionManager)!;
		expect((await metadata(harness)).recoveryContext).toContain(archive);
		const resumed = SessionManager.open(harness.sessionManager.getSessionFile()!);
		expect(getToolOutputDirectory(resumed)).toBe(archive);
		await harness.session.reload();
		expect((await metadata(harness)).recoveryContext).toContain(archive);
		harness.sessionManager.newSession();
		expect((await metadata(harness)).recoveryContext).toBeUndefined();
	});

	it("stops before the next provider request if an archive cannot be written", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 32000, maxTokens: 2048 }],
			tools: [large],
			extensionFactories: [toolOutputContextExtension],
		});
		harnesses.push(harness);
		const directory = join(harness.tempDir, "not-a-directory");
		writeFileSync(directory, "occupied");
		harness.sessionManager.appendCustomEntry("tool-output-archive", { directory });
		respond(harness);
		await expect(harness.session.prompt("Run the large tool.")).rejects.toThrow("EEXIST");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("EEXIST"),
		});
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						contentText(entry.message.content) === full,
				),
		).toBe(true);
	});

	it("does not commit earlier handler drafts when a later budget handler fails", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 32000, maxTokens: 2048 }],
			tools: [large],
			extensionFactories: [
				(pi) => {
					pi.on("context_budget", () => ({ entries: [{ type: "custom", customType: "uncommitted" }] }));
				},
				(pi) => {
					pi.on("context_budget", () => {
						throw new Error("budget policy failed");
					});
				},
			],
		});
		harnesses.push(harness);
		respond(harness);
		await expect(harness.session.prompt("Run the large tool.")).rejects.toThrow("budget policy failed");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			errorMessage: expect.stringContaining("budget policy failed"),
		});
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "uncommitted"),
		).toBe(false);
	});

	it("rejects edits during a read-only metadata query", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context_budget", () => ({ entries: [{ type: "custom", customType: "unexpected" }] }));
				},
			],
		});
		harnesses.push(harness);
		await expect(metadata(harness)).rejects.toThrow("metadata query cannot append entries");
	});

	it("validates all drafts before committing metadata or calling the provider again", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 32000, maxTokens: 2048 }],
			tools: [large],
			extensionFactories: [
				(pi) => {
					pi.on("context_budget", () => ({
						entries: [
							{ type: "custom", customType: "uncommitted" },
							{ type: "context_edit", targetId: "missing-entry", replacement: null },
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		respond(harness);
		await expect(harness.session.prompt("Run the large tool.")).rejects.toThrow("missing-entry");
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "uncommitted"),
		).toBe(false);
	});

	it("keeps the core budget error when the archive extension is disabled and compaction cannot reduce context", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 32000, maxTokens: 2048 }],
			tools: [large],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		respond(harness);
		await harness.session.prompt("Run the large tool.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("model input budget"),
		});
		expect(getToolOutputDirectory(harness.sessionManager)).toBeUndefined();
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						contentText(entry.message.content) === full,
				),
		).toBe(true);
	});

	it("enables protection in the default SDK and services loaders without loading other CLI builtins", async () => {
		const harness = await createHarness({ models: [{ id: "small", contextWindow: 32000, maxTokens: 2048 }] });
		harnesses.push(harness);
		const options = {
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
		};
		const { session, extensionsResult } = await createAgentSession({
			...options,
			model: harness.getModel(),
			sessionManager: harness.sessionManager,
			customTools: [createToolDefinitionFromAgentTool(large)],
			tools: ["large"],
		});
		try {
			expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
				"builtin:tool-output-context",
			]);
			respond(harness);
			await session.prompt("Run the large tool.");
			expect(session.getLastAssistantText()).toBe("done");
			expect(getToolOutputDirectory(harness.sessionManager)).toBeTruthy();
			const services = await createAgentSessionServices({
				...options,
				resourceLoaderOptions: { extensionFactories: undefined },
			});
			expect(services.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
				"builtin:tool-output-context",
			]);
			const customServices = await createAgentSessionServices({
				...options,
				resourceLoaderOptions: { extensionFactories: [] },
			});
			expect(customServices.resourceLoader.getExtensions().extensions).toEqual([]);
		} finally {
			session.dispose();
		}
	});
});
