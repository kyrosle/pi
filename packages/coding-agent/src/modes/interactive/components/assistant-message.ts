import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
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
import type { ThinkingViewMode } from "../../../core/thinking-view.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { PreviewPanel } from "./preview-panel.ts";
import { selectThinkingSteps, ThinkingSummary } from "./thinking-summary.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** A Markdown component kept for one content position, with the settings its transform captured. */
interface MarkdownRecord {
	config: string;
	text: string;
	streaming: boolean;
	markdown: Markdown;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private thinkingViewMode: ThinkingViewMode;
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
	private thinkingVisibilityOverrides = new Map<number, ThinkingViewMode>();
	// Keyed by content position, so a streamed update reuses the Markdown (and its block cache) instead of rebuilding it.
	private markdownRecords = new Map<string, MarkdownRecord>();
	private thinkingSummaries = new Map<number, ThinkingSummary>();
	private cachedRender?: { width: number; lines: string[] };

	constructor(
		message?: AssistantMessage,
		thinkingViewMode: ThinkingViewMode | boolean = "summary",
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		tui?: TUI,
		messageId?: string,
		timestamp?: string,
	) {
		super();

		this.thinkingViewMode =
			typeof thinkingViewMode === "boolean" ? (thinkingViewMode ? "collapsed" : "expanded") : thinkingViewMode;
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
		this.cachedRender = undefined;
		super.invalidate();
		// Theme and highlighter state may have changed, so rebuild every Markdown instead of reusing it.
		this.markdownRecords.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setThinkingViewMode(hide ? "collapsed" : "expanded");
	}

	setThinkingViewMode(mode: ThinkingViewMode): void {
		this.dismissThinkingPreview();
		this.thinkingViewMode = mode;
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
		// Scrolling unchanged history must not walk its Markdown and thinking subtrees again.
		if (this.cachedRender?.width === width) return this.cachedRender.lines;
		const lines = super.render(width);
		if (!this.hasToolCalls && lines.length > 0) {
			lines[0] = OSC133_ZONE_START + lines[0];
			lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		}
		this.cachedRender = { width, lines };
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.cachedRender = undefined;
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();
		const previousRecords = this.markdownRecords;
		this.markdownRecords = new Map();
		const previousSummaries = this.thinkingSummaries;
		this.thinkingSummaries = new Map();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
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

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const mode = this.thinkingVisibilityOverrides.get(runIndex) ?? this.thinkingViewMode;
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
				const steps = summary.update(thinking);
				const selected = selectThinkingSteps(steps);
				const label = this.hiddenThinkingLabel === "Thinking..." ? "Thinking Steps" : this.hiddenThinkingLabel;
				// Retain per-step Markdown across mode changes, but render it only in expanded mode.
				const details =
					mode === "expanded"
						? steps.map((step) =>
								this.acquireMarkdown(
									previousRecords,
									`thinking-step:${runStart}:${step.start}`,
									thinking.slice(step.start, step.end).trim(),
									"assistant-thinking",
									message.model,
									{ color: (text: string) => theme.fg("thinkingText", text) },
								),
							)
						: [];
				if (mode !== "expanded") {
					for (const [key, record] of previousRecords) {
						if (key.startsWith(`thinking-step:${runStart}:`)) this.markdownRecords.set(key, record);
					}
				}
				const thinkingComponent = {
					render: (width: number): string[] => {
						const pad = " ".repeat(this.outputPad);
						const row = (text: string) => theme.fg("thinkingText", truncateToWidth(pad + text, width));
						if (mode === "collapsed") {
							const active = steps.at(-1);
							return [
								row(`▸ ${label} · ${active ? `${active.role}: ${active.summary}` : "Reasoning unavailable"}`),
							];
						}
						const lines = [
							theme.fg(
								"muted",
								truncateToWidth(
									`${pad}┆ ${label} · ${mode === "summary" ? "Summary" : "Expanded"} · ${steps.length} ${steps.length === 1 ? "step" : "steps"}`,
									width,
								),
							),
						];
						if (mode === "summary") {
							for (const [index, step] of selected.entries()) {
								lines.push(
									row(
										`${index === selected.length - 1 ? "└─" : "├─"} ${steps.indexOf(step) + 1}. ${step.role}: ${step.summary}`,
									),
								);
							}
						} else if (details.length === 0) {
							lines.push(...markdown.render(width));
						} else {
							for (const [index, detail] of details.entries()) {
								lines.push(
									row(`${index === details.length - 1 ? "└─" : "├─"} ${index + 1}. ${steps[index].role}`),
								);
								lines.push(...detail.render(width));
							}
						}
						return lines;
					},
					invalidate: () => {
						for (const detail of details) detail.invalidate();
					},
				};
				const toggle = () => {
					this.dismissThinkingPreview();
					this.thinkingVisibilityOverrides.set(
						runIndex,
						mode === "expanded"
							? this.thinkingViewMode === "expanded"
								? "summary"
								: this.thinkingViewMode
							: "expanded",
					);
					if (this.lastMessage) this.updateContent(this.lastMessage);
					this.tui?.requestRender();
				};
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						const tui = this.tui;
						if (
							mode !== "expanded" &&
							event.type === "move" &&
							event.button === "none" &&
							tui &&
							isViewportTUI(tui)
						) {
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
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
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
			// Only completed step bodies skip transforms; text and full previews retain their refresh behavior.
			if (!key.startsWith("thinking-step:") || record.text !== text || record.streaming !== this.isStreaming)
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
		this.markdownRecords.set(key, { config, text, streaming: this.isStreaming, markdown });
		return markdown;
	}
}
