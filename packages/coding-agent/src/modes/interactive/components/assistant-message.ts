import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type DefaultTextStyle,
	isViewportTUI,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { PreviewPanel } from "./preview-panel.ts";
import { ThinkingSummary } from "./thinking-summary.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** A Markdown component kept for one content position, with the settings its transform captured. */
interface MarkdownRecord {
	config: string;
	markdown: Markdown;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private messageId?: string;
	private timestamp?: string;
	private tui?: TUI;
	private previewMarkdown?: Markdown;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	// Keyed by content position, so a streamed update reuses the Markdown (and its block cache) instead of rebuilding it.
	private markdownRecords = new Map<string, MarkdownRecord>();
	private thinkingSummaries = new Map<number, ThinkingSummary>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		tui?: TUI,
		messageId?: string,
		timestamp?: string,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.tui = tui;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Theme and highlighter state may have changed, so rebuild every Markdown instead of reusing it.
		this.markdownRecords.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.dismissThinkingPreview();
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();
		const previousRecords = this.markdownRecords;
		this.markdownRecords = new Map();
		const previousSummaries = this.thinkingSummaries;
		this.thinkingSummaries = new Map();

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		let needsSpacer = true;
		const addVisibleChild = (child: Component) => {
			if (needsSpacer) {
				this.contentContainer.addChild(new Spacer(1));
				needsSpacer = false;
			}
			this.contentContainer.addChild(child);
		};

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				addVisibleChild(
					this.acquireMarkdown(previousRecords, `text:${i}`, content.text.trim(), "assistant", message.model),
				);
			} else if (content.type === "thinking") {
				const runStart = i;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				// A hidden run with an empty label renders nothing, including no spacing.
				if (hidden && !this.hiddenThinkingLabel.trim()) {
					continue;
				}
				const thinking = thinkingBlocks.join("\n\n");
				// Keep the component and block cache while collapsed, but render Markdown only on demand.
				const markdown = this.acquireMarkdown(
					previousRecords,
					`thinking:${runStart}`,
					thinking,
					"assistant-thinking",
					message.model,
					{ color: (text: string) => theme.fg("thinkingText", text), italic: true },
				);
				const summary = previousSummaries.get(runStart) ?? new ThinkingSummary();
				this.thinkingSummaries.set(runStart, summary);
				const { lineCount, stepCount, steps } = summary.update(thinking);
				const label = `▸ ${this.hiddenThinkingLabel} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
				const thinkingComponent = hidden
					? {
							render: (width: number) => [
								theme.fg("muted", truncateToWidth(" ".repeat(this.outputPad) + label, width)),
								...steps.map((step, index) =>
									theme.fg(
										"thinkingText",
										truncateToWidth(
											`${" ".repeat(this.outputPad)}  ${stepCount - steps.length + index + 1}. ${step}`,
											width,
										),
									),
								),
							],
							invalidate() {},
						}
					: markdown;
				const toggle = () => {
					this.dismissThinkingPreview();
					this.thinkingVisibilityOverrides.set(runIndex, !hidden);
					if (this.lastMessage) this.updateContent(this.lastMessage);
					this.tui?.requestRender();
				};
				addVisibleChild(
					new MouseRegion(thinkingComponent, (event) => {
						const tui = this.tui;
						if (hidden && event.type === "move" && event.button === "none" && tui && isViewportTUI(tui)) {
							this.previewMarkdown = markdown;
							tui.showHoverPreview?.(
								markdown,
								new PreviewPanel(markdown, {
									maxHeight: () =>
										Math.min(tui.terminal.rows * 0.7, tui.transcriptViewportHeight ?? tui.terminal.rows),
									border: (text) => theme.fg("borderMuted", text),
									background: (text) => theme.bg("toolPendingBg", text),
									hint: () => "Click to expand",
									onClick: toggle,
								}),
								event,
							);
							return { handled: true, render: false };
						}
						if (event.type !== "click" || event.button !== "left") return undefined;
						toggle();
						return { handled: true };
					}),
				);
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				needsSpacer = true;
			}
		}

		if (
			this.previewMarkdown &&
			![...this.markdownRecords.values()].some((r) => r.markdown === this.previewMarkdown)
		) {
			this.dismissThinkingPreview();
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}

	private dismissThinkingPreview(): void {
		if (!this.previewMarkdown) return;
		if (this.tui && isViewportTUI(this.tui)) this.tui.hideHoverPreview?.();
		this.previewMarkdown = undefined;
	}

	private acquireMarkdown(
		previousRecords: ReadonlyMap<string, MarkdownRecord>,
		key: string,
		text: string,
		messageType: MarkdownTransformContext["messageType"],
		model: string | undefined,
		defaultTextStyle?: DefaultTextStyle,
	): Markdown {
		const config = JSON.stringify([messageType, model ?? null, this.outputPad]);
		const record = previousRecords.get(key);
		let markdown: Markdown;
		if (record?.config === config) {
			markdown = record.markdown;
			// setText always clears the full-output cache, so the transform runs again even for identical text.
			markdown.setText(text);
		} else {
			markdown = new Markdown(text, this.outputPad, 0, this.markdownTheme, defaultTextStyle, {
				// Ending a stream must rerun transformers without discarding unchanged block layouts.
				transform: (source, width) =>
					createMarkdownTransform(
						messageType,
						this.isStreaming,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
						model,
					)(source, width),
			});
		}
		this.markdownRecords.set(key, { config, markdown });
		return markdown;
	}
}
