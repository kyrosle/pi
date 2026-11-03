import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer, ThinkingRenderComponent, ThinkingRenderer } from "../../../core/extensions/types.ts";
import type { ThinkingViewMode } from "../../../core/thinking-view.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * A Markdown block of the last update. The next update reuses it at the same position for the same kind of content, so
 * a streamed answer keeps the blocks it already rendered, also once the stream ends.
 */
interface MarkdownSlot {
	kind: "text" | "thinking";
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
	private thinkingRenderer?: ThinkingRenderer;
	private thinkingVisibilityOverrides = new Map<number, ThinkingViewMode>();
	private markdownSlots: MarkdownSlot[] = [];
	private markdownModel?: string;
	private thinkingComponents = new Map<number, ThinkingRenderComponent>();
	private cachedRender?: { width: number; lines: string[] };
	private disposed = false;

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
		thinkingRenderer?: ThinkingRenderer,
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
		this.thinkingRenderer = thinkingRenderer;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		if (this.disposed) return;
		this.cachedRender = undefined;
		super.invalidate();
		// Theme and highlighter state may have changed, so rebuild every Markdown instead of reusing it.
		this.markdownSlots = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const component of this.thinkingComponents.values()) this.disposeThinkingComponent(component);
		this.thinkingComponents.clear();
		this.markdownSlots = [];
		this.thinkingVisibilityOverrides.clear();
		this.contentContainer.clear();
		this.cachedRender = undefined;
		this.lastMessage = undefined;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setThinkingViewMode(hide ? "collapsed" : "expanded");
	}

	setThinkingViewMode(mode: ThinkingViewMode): void {
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
		// Markdown takes its padding at construction.
		this.markdownSlots = [];
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
		if (this.disposed) return;
		this.cachedRender = undefined;
		// The transform captures the model, which can change even when the message is updated in place.
		if (this.markdownModel !== message.model) this.markdownSlots = [];
		this.markdownModel = message.model;
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();
		const previousSlots = this.markdownSlots;
		this.markdownSlots = [];
		const markdownBlock = (kind: MarkdownSlot["kind"], text: string, create: () => Markdown): Markdown => {
			const slot = previousSlots[this.markdownSlots.length];
			const markdown = slot?.kind === kind ? slot.markdown : create();
			markdown.setText(text);
			this.markdownSlots.push({ kind, markdown });
			return markdown;
		};
		const previousThinkingComponents = this.thinkingComponents;
		this.thinkingComponents = new Map();

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content; an omitted native fallback contributes nothing.
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
				const text = content.text.trim();
				addVisibleChild(
					markdownBlock(
						"text",
						text,
						() =>
							new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
								transform: createMarkdownTransform(
									"assistant",
									() => this.isStreaming,
									this.markdownTransformers,
									this.messageId,
									this.timestamp,
									message.model,
								),
							}),
					),
				);
			} else if (content.type === "thinking") {
				const runStart = i;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking;
					if (thinking.trim()) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const runIndex = thinkingRunIndex++;
				const mode = this.thinkingVisibilityOverrides.get(runIndex) ?? this.thinkingViewMode;
				const thinking = thinkingBlocks.join("\n\n");
				// Keep the component and block cache while collapsed, but render Markdown only on demand.
				const markdown = markdownBlock(
					"thinking",
					thinking,
					() =>
						new Markdown(
							thinking,
							this.outputPad,
							0,
							this.markdownTheme,
							{ color: (text: string) => theme.fg("thinkingText", text), italic: true },
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									() => this.isStreaming,
									this.markdownTransformers,
									this.messageId,
									this.timestamp,
									message.model,
								),
							},
						),
				);
				const setExpanded = (expanded: boolean) => {
					if (this.disposed) return;
					this.thinkingVisibilityOverrides.set(
						runIndex,
						expanded ? "expanded" : this.thinkingViewMode === "expanded" ? "summary" : this.thinkingViewMode,
					);
					if (this.lastMessage) this.updateContent(this.lastMessage);
					this.tui?.requestRender();
				};
				let component: ThinkingRenderComponent | undefined;
				try {
					component = this.thinkingRenderer?.(thinking, theme, {
						mode,
						isStreaming,
						active: isStreaming && i === message.content.length - 1,
						hiddenLabel: this.hiddenThinkingLabel,
						outputPad: this.outputPad,
						markdown,
						lastComponent: previousThinkingComponents.get(runStart),
						tui: this.tui,
						setExpanded,
						invalidate: () => {
							if (this.disposed) return;
							this.cachedRender = undefined;
							this.tui?.requestRender();
						},
					});
				} catch {
					// Keep the original thinking available if an extension cannot render it.
				}
				if (component) {
					this.thinkingComponents.set(runStart, component);
					addVisibleChild(component);
				} else {
					if (mode === "collapsed" && !this.hiddenThinkingLabel.trim()) {
						continue;
					}
					const fallback =
						mode === "collapsed"
							? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
							: markdown;
					addVisibleChild(
						new MouseRegion(fallback, (event) => {
							if (event.type !== "click" || event.button !== "left") return undefined;
							setExpanded(mode !== "expanded");
							return { handled: true };
						}),
					);
				}
				needsSpacer = true;
			}
		}

		for (const [position, component] of previousThinkingComponents) {
			if (this.thinkingComponents.get(position) !== component) this.disposeThinkingComponent(component);
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

	private disposeThinkingComponent(component: ThinkingRenderComponent): void {
		try {
			component.dispose?.();
		} catch {
			// A failing extension must not prevent the other thinking components from being released.
		}
	}
}
