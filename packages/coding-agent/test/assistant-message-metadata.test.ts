import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, test } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import { thinkingStepsRenderer } from "../src/extensions/thinking-steps/renderer.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const messageId = "assistant-entry";
const timestamp = "2026-10-23T01:02:03.000Z";

function createAssistantMessageComponent(...args: ConstructorParameters<typeof AssistantMessageComponent>) {
	args[9] ??= thinkingStepsRenderer;
	return new AssistantMessageComponent(...args);
}

beforeEach(() => initTheme("dark"));

describe("assistant Markdown transformer metadata", () => {
	test("preserves persisted identity and model for text and expanded thinking", () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "Inspect the result." },
			{ type: "text", text: "The result is ready." },
		]);
		const contexts: MarkdownTransformContext[] = [];
		const component = createAssistantMessageComponent(
			message,
			"expanded",
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					contexts.push(context);
					return markdown;
				},
			],
			undefined,
			messageId,
			timestamp,
		);
		const rendered = component.render(80);
		expect(stripAnsi(rendered.join("\n"))).toContain("Inspect the result.");
		expect(stripAnsi(rendered.join("\n"))).toContain("The result is ready.");
		expect(contexts).toEqual([
			{
				messageType: "assistant-thinking",
				isStreaming: false,
				availableWidth: 78,
				model: message.model,
				messageId,
				timestamp,
			},
			{
				messageType: "assistant",
				isStreaming: false,
				availableWidth: 78,
				model: message.model,
				messageId,
				timestamp,
			},
		]);
		expect(component.render(80)).toBe(rendered);
		expect(contexts).toHaveLength(2);
	});

	test("keeps identity when expanding a summary and updating cached Markdown with the same or another model", () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "Inspect the result." },
			{ type: "text", text: "The result is ready." },
		]);
		const contexts: MarkdownTransformContext[] = [];
		const component = createAssistantMessageComponent(
			message,
			"summary",
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					contexts.push(context);
					return `${context.model}: ${markdown}`;
				},
			],
			undefined,
			messageId,
			timestamp,
		);
		component.render(80);
		expect(contexts.map((context) => context.messageType)).toEqual(["assistant"]);
		component.setThinkingViewMode("expanded");
		component.render(80);
		expect(contexts.some((context) => context.messageType === "assistant-thinking")).toBe(true);

		for (const model of [message.model, "another-model"]) {
			contexts.length = 0;
			message.model = model;
			component.updateContent(message, true);
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain(`${model}: Inspect the result.`);
			expect(rendered).toContain(`${model}: The result is ready.`);
			expect(contexts.map((context) => context.messageType)).toEqual(["assistant-thinking", "assistant"]);
			for (const context of contexts) {
				expect(context).toMatchObject({ isStreaming: true, model, messageId, timestamp });
			}
		}
	});

	test("leaves persisted identity undefined for live streaming text and thinking", () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "Inspect the result." },
			{ type: "text", text: "The result is ready." },
		]);
		const contexts: MarkdownTransformContext[] = [];
		const component = createAssistantMessageComponent(undefined, "expanded", undefined, "Thinking...", 1, [
			(markdown, context) => {
				contexts.push(context);
				return markdown;
			},
		]);

		for (const isStreaming of [true, false]) {
			contexts.length = 0;
			component.updateContent(message, isStreaming);
			component.render(80);
			expect(contexts.map((context) => context.messageType)).toEqual(["assistant-thinking", "assistant"]);
			for (const context of contexts) {
				expect(context.isStreaming).toBe(isStreaming);
				expect(context.model).toBe(message.model);
				expect(context.messageId).toBeUndefined();
				expect(context.timestamp).toBeUndefined();
			}
		}
	});
});
