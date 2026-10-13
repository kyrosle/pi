import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	contentText,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	normalizeContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { completeSummarization, estimateTokens } from "../../src/core/compaction/compaction.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import toolOutputContextExtension, { getToolOutputDirectory } from "../../src/extensions/tool-output-context/index.ts";
import { createHarness as createBaseHarness, type Harness, type HarnessOptions } from "./harness.ts";

function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	return createBaseHarness({
		...options,
		extensionFactories: [toolOutputContextExtension, ...(options.extensionFactories ?? [])],
	});
}

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

function isSummary(context: TranscriptContext): boolean {
	return context.messages.some(
		(message) =>
			message.role === "system" && contentText(message.content).includes("context summarization assistant"),
	);
}

describe("context budget recovery", () => {
	it("keeps a huge complete result on disk and in the session, resumes, and reads the original without rerunning the tool", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-budget-session-"));
		directories.push(directory);
		const full = Array.from({ length: 12000 }, (_, i) => `第${i}行 ${"完整原文🌍".repeat(6)}`).join("\n");
		let executions = 0;
		const large: AgentTool = {
			name: "large_result",
			label: "Large",
			description: "Large result",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: full }], details: { receipt: "original" } };
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 64000, maxTokens: 4096 }],
			tools: [large, createReadTool(directory)],
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		});
		harnesses.push(harness);
		let step = 0;
		let originalPath = "";
		const answer: FauxResponseFactory = (context) => {
			harness.appendResponses([answer]);
			if (isSummary(context)) return fauxAssistantMessage("Checkpoint: read the large result and continue.");
			expect(context.messages.reduce((sum, message) => sum + estimateTokens(message), 0)).toBeLessThan(64000);
			if (step++ === 0)
				return fauxAssistantMessage(fauxToolCall("large_result", {}, { id: "large" }), { stopReason: "toolUse" });
			if (step === 2) {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "large",
				);
				expect(result?.role).toBe("toolResult");
				if (!result) throw new Error("Missing preserved tool result");
				originalPath = /Full text: ([^\n]+)/.exec(contentText(result.content))?.[1] ?? "";
				expect(readFileSync(originalPath, "utf8")).toBe(full);
				return fauxAssistantMessage(fauxToolCall("read", { path: originalPath, limit: 2 }), {
					stopReason: "toolUse",
				});
			}
			const reread = context.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "read",
			);
			expect(reread && contentText(reread.content)).toContain("第0行");
			return fauxAssistantMessage("Recovered and reread the original.");
		};
		harness.setResponses([answer]);
		await harness.session.prompt("Read the huge output, then read the first two original lines.");
		expect(harness.session.getLastAssistantText()).toBe("Recovered and reread the original.");
		expect(executions).toBe(1);
		const original = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "large",
			);
		expect(
			original?.type === "message" &&
				original.message.role === "toolResult" &&
				contentText(original.message.content),
		).toBe(full);
		expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf8")).toContain(JSON.stringify(full));
		expect(statSync(originalPath).mode & 0o777).toBe(0o600);
		const resumed = SessionManager.open(harness.sessionManager.getSessionFile()!);
		expect(getToolOutputDirectory(resumed)).toBe(getToolOutputDirectory(harness.sessionManager));
		expect(resumed.getEntries().some((entry) => entry.type === "context_edit")).toBe(true);
		expect(
			resumed
				.buildSessionProjection()
				.messages.some((message) => message.role === "toolResult" && contentText(message.content) === full),
		).toBe(false);
	});

	it("budgets a parallel batch while retaining every original result and tool-call pairing", async () => {
		const full = `batch-output:${"x".repeat(80000)}`;
		let executions = 0;
		const large: AgentTool = {
			name: "large_result",
			label: "Large",
			description: "Large result",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: full }], details: {} };
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 64000, maxTokens: 4096 }],
			tools: [large],
		});
		harnesses.push(harness);
		let called = false;
		const answer: FauxResponseFactory = (context) => {
			harness.appendResponses([answer]);
			if (isSummary(context)) return fauxAssistantMessage("Batch checkpoint.");
			if (!called) {
				called = true;
				return fauxAssistantMessage(
					Array.from({ length: 4 }, (_, i) => fauxToolCall("large_result", {}, { id: `batch-${i}` })),
					{ stopReason: "toolUse" },
				);
			}
			const results = context.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(4);
			expect(results.map((message) => message.role === "toolResult" && message.toolCallId)).toEqual([
				"batch-0",
				"batch-1",
				"batch-2",
				"batch-3",
			]);
			return fauxAssistantMessage("Batch recovered.");
		};
		harness.setResponses([answer]);
		await harness.session.prompt("Run the four reads.");
		expect(harness.session.getLastAssistantText()).toBe("Batch recovered.");
		expect(executions).toBe(4);
		expect(
			readdirSync(getToolOutputDirectory(harness.sessionManager)!).filter((name) => name.endsWith(".txt")),
		).toHaveLength(4);
	});

	it("automatically recovers from an actual byte-limit rejection caused by underestimated Unicode output", async () => {
		const full = "大".repeat(14000);
		const large: AgentTool = {
			name: "large_result",
			label: "Large",
			description: "Large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: full }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32000, maxTokens: 2048 }],
			tools: [large],
		});
		harnesses.push(harness);
		let called = false;
		let rejected = 0;
		const answer: FauxResponseFactory = (context) => {
			harness.appendResponses([answer]);
			if (isSummary(context)) return fauxAssistantMessage("Recovered checkpoint.");
			if (!called) {
				called = true;
				return fauxAssistantMessage(fauxToolCall("large_result", {}, { id: "unicode" }), { stopReason: "toolUse" });
			}
			if (Buffer.byteLength(JSON.stringify(context.messages)) > 16000) {
				rejected++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "413 Payload Too Large" });
			}
			return fauxAssistantMessage("Recovered from payload overflow.");
		};
		harness.setResponses([answer]);
		await harness.session.prompt("Run the Unicode read.");
		expect(rejected).toBeGreaterThan(0);
		expect(harness.session.getLastAssistantText()).toBe("Recovered from payload overflow.");
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

	it("splits an oversized summary, accounts for every chunk, and merges its checkpoints", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 16000, maxTokens: 1024 }] });
		harnesses.push(harness);
		const payload = `FIRST ${'中🌍"\n'.repeat(25000)} LAST`;
		const seen: string[] = [];
		const answer: FauxResponseFactory = (context) => {
			harness.appendResponses([answer]);
			expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual((16000 - 1024) * 3);
			const text = context.messages
				.filter((message) => message.role !== "system")
				.map((message) => contentText(message.content))
				.join("\n");
			seen.push(text);
			expect(text).not.toContain("�");
			return fauxAssistantMessage("A concise checkpoint.");
		};
		harness.setResponses([answer]);
		const result = await completeSummarization(
			harness.getModel(),
			normalizeContext({ messages: [{ role: "user", content: payload, timestamp: Date.now() }] }),
			{ maxTokens: 1024 },
			harness.session.agent.streamFunction,
		);
		expect(result.stopReason).toBe("stop");
		expect(seen.length).toBeGreaterThan(2);
		expect(seen.join("\n")).toContain("FIRST");
		expect(seen.join("\n")).toContain("LAST");
	});

	it("shrinks and rechunks summary input after a provider rejects its advertised budget", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 32000, maxTokens: 1024 }] });
		harnesses.push(harness);
		let rejected = 0;
		const answer: FauxResponseFactory = (context) => {
			harness.appendResponses([answer]);
			if (Buffer.byteLength(JSON.stringify(context)) > 12000) {
				rejected++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 50000 tokens" });
			}
			return fauxAssistantMessage("Checkpoint under the actual input limit.");
		};
		harness.setResponses([answer]);
		const result = await completeSummarization(
			harness.getModel(),
			normalizeContext({ messages: [{ role: "user", content: "a".repeat(70000), timestamp: Date.now() }] }),
			{ maxTokens: 1024 },
			harness.session.agent.streamFunction,
			{ enabled: true, maxRetries: 3, baseDelayMs: 1 },
		);
		expect(rejected).toBeGreaterThan(0);
		expect(rejected).toBeLessThanOrEqual(6);
		expect(result.stopReason).toBe("stop");
		expect(contentText(result.content)).toContain("actual input limit");
	});

	it("does not persist a partial checkpoint when a summary chunk hits its output cap", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32000, maxTokens: 2048 }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const full = "old transcript ".repeat(25000);
		harness.sessionManager.appendMessage({ role: "user", content: full, timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier answer."));
		harness.sessionManager.appendMessage({ role: "user", content: "Current question.", timestamp: Date.now() });
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("partial checkpoint", { stopReason: "length" })]);
		await expect(harness.session.compact()).rejects.toThrow("summary is incomplete");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content === full,
				),
		).toBe(true);
	});

	it("stops chunk generation immediately when the request is cancelled", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 16000, maxTokens: 1024 }] });
		harnesses.push(harness);
		const controller = new AbortController();
		harness.setResponses([
			() => {
				controller.abort();
				return fauxAssistantMessage("Checkpoint.");
			},
		]);
		const result = await completeSummarization(
			harness.getModel(),
			normalizeContext({ messages: [{ role: "user", content: "x".repeat(300000), timestamp: Date.now() }] }),
			{ maxTokens: 1024, signal: controller.signal },
			harness.session.agent.streamFunction,
		);
		expect(result.stopReason).toBe("aborted");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("summarizes the entire recent call/result pair after switching to a smaller context without executing it again", async () => {
		let harness: Harness;
		let executions = 0;
		const large: AgentTool = {
			name: "large_arguments",
			label: "Large arguments",
			description: "Accepts large input",
			parameters: Type.Object({ payload: Type.String() }),
			execute: async () => {
				executions++;
				await harness.session.setModel(harness.getModel("small")!);
				return { content: [{ type: "text", text: "Completed once." }], details: {} };
			},
		};
		harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 64000, maxTokens: 60000 },
				{ id: "small", contextWindow: 32000, maxTokens: 2048 },
			],
			tools: [large],
		});
		harnesses.push(harness);
		let called = false;
		const answer: FauxResponseFactory = (context, _options, _state, model) => {
			harness.appendResponses([answer]);
			if (isSummary(context)) return fauxAssistantMessage("Checkpoint: the large operation completed once.");
			if (!called) {
				called = true;
				return fauxAssistantMessage(fauxToolCall("large_arguments", { payload: "x".repeat(200000) }), {
					stopReason: "toolUse",
				});
			}
			expect(model.id).toBe("small");
			expect(context.messages.reduce((sum, message) => sum + estimateTokens(message), 0)).toBeLessThan(
				model.contextWindow,
			);
			return fauxAssistantMessage("Continued on the smaller model.");
		};
		harness.setResponses([answer]);
		await harness.session.prompt("Perform the operation, then continue.");
		expect(harness.session.getLastAssistantText()).toBe("Continued on the smaller model.");
		expect(executions).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some(
							(block) => block.type === "toolCall" && block.arguments.payload === "x".repeat(200000),
						),
				),
		).toBe(true);
	});
});
