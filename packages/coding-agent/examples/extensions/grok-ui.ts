import {
	type CompactToolCallComponent,
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	parseSkillBlock,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type EditorTheme,
	isViewportTUI,
	PreviewPanel,
	SelectList,
	Spacer,
	stripTerminalSequences,
	Text,
	type TranscriptTimelineEntry,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export class GrokEditor extends CustomEditor {
	private bottomBorder = "";
	private getCaption: () => string;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, getCaption: () => string) {
		super(tui, theme, keybindings, { paddingX: 1, embedWorkingStatus: true });
		this.getCaption = getCaption;
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0 || width < 6) {
			this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount);
		} else {
			const caption = truncateToWidth(` ${this.getCaption()} `, width - 2, "");
			this.bottomBorder = this.borderColor(`─${caption}${"─".repeat(width - visibleWidth(caption) - 1)}`);
		}
		return this.bottomBorder;
	}

	override render(width: number): string[] {
		if (width < 6) return super.render(width);
		const lines = super.render(width - 2);
		const bottom = lines.lastIndexOf(this.bottomBorder);
		return lines.map((line, index) => {
			if (index === 0) return this.borderColor("╭") + line + this.borderColor("╮");
			if (index === bottom) return this.borderColor("╰") + line + this.borderColor("╯");
			if (index > bottom) return ` ${line} `;
			return this.borderColor("│") + line + this.borderColor("│");
		});
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<CustomEditor["handleMouse"]> {
		if (event.width < 6) return super.handleMouse(event);
		if (event.x === 0 || event.x >= event.width - 1) return undefined;
		return super.handleMouse({ ...event, x: event.x - 1, width: event.width - 2 });
	}
}

type ToolStatusContext = {
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	expanded: boolean;
};

class GrokToolTitle implements CompactToolCallComponent {
	readonly compactToolCall: boolean;
	readonly content: Component;
	private theme: Theme;
	private status: ToolStatusContext;
	private headerWidth = 0;
	private hasStatusRow = false;
	private headerRow = 0;

	constructor(content: Component, theme: Theme, status: ToolStatusContext) {
		this.compactToolCall = !("compactToolCall" in content && content.compactToolCall === false);
		this.content = content;
		this.theme = theme;
		this.status = status;
	}

	render(width: number): string[] {
		const lines = this.content.render(width);
		if (lines.length === 0) return lines;
		this.headerRow = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		if (this.headerRow < 0) return lines;
		const { isError, isPartial, executionStarted, expanded } = this.status;
		const label = isError ? "Failed" : isPartial ? (executionStarted ? "Running" : "Queued") : "Done";
		const color = isError ? "error" : isPartial ? "muted" : "success";
		const status = this.theme.fg(color, label);
		const prefix = this.theme.fg("muted", expanded ? "▾ " : "▸ ");
		const remaining = width - visibleWidth(prefix) - visibleWidth(status) - 1;
		this.hasStatusRow = remaining < 4;
		this.headerWidth = Math.max(0, remaining);
		if (this.hasStatusRow) return [truncateToWidth(status, width), ...lines];
		const title = truncateToWidth(lines[this.headerRow], remaining);
		return [
			...lines.slice(0, this.headerRow),
			prefix + title + " ".repeat(width - visibleWidth(prefix + title + status)) + status,
			...lines.slice(this.headerRow + 1),
		];
	}

	invalidate(): void {
		this.content.invalidate();
	}

	handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		if (this.hasStatusRow) {
			if (event.y === 0) return undefined;
			return this.content.handleMouse?.({ ...event, y: event.y - 1, height: event.height - 1 });
		}
		if (event.y === this.headerRow) {
			if (event.x < 2 || event.x >= this.headerWidth + 2) return undefined;
			return this.content.handleMouse?.({ ...event, x: event.x - 2 });
		}
		return this.content.handleMouse?.(event);
	}
}

export class GrokMenu extends Container {
	private getTheme: () => Theme;
	private keybindings: KeybindingsManager;
	private list: SelectList;
	private title = new Text("", 1, 0);
	private hint = new Text("", 1, 0);

	constructor(
		getTheme: () => Theme,
		keybindings: KeybindingsManager,
		expanded: boolean,
		done: (toggle: boolean) => void,
	) {
		super();
		this.getTheme = getTheme;
		this.keybindings = keybindings;
		this.list = new SelectList(
			[
				{ value: "toggle", label: expanded ? "Collapse tool output" : "Expand tool output" },
				{ value: "close", label: "Return to prompt" },
			],
			2,
			{
				selectedPrefix: (text) => getTheme().fg("accent", text),
				selectedText: (text) => getTheme().bg("selectedBg", getTheme().fg("text", text)),
				description: (text) => getTheme().fg("muted", text),
				scrollInfo: (text) => getTheme().fg("muted", text),
				noMatch: (text) => getTheme().fg("muted", text),
			},
		);
		this.list.onSelect = (item) => done(item.value === "toggle");
		this.list.onCancel = () => done(false);
		this.addChild(this.title);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(this.hint);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	override render(width: number): string[] {
		const theme = this.getTheme();
		this.title.setText(theme.fg("text", theme.bold("Display")));
		this.hint.setText(
			theme.fg(
				"muted",
				`${this.keybindings.getKeys("tui.select.confirm").join("/")} select   ${this.keybindings.getKeys("tui.select.cancel").join("/")} close`,
			),
		);
		const innerWidth = Math.max(1, width - 2);
		const lines = super.render(innerWidth);
		const border = (text: string) => theme.fg("borderMuted", text);
		const result = [border(`╭${"─".repeat(innerWidth)}╮`)];
		for (const line of lines) {
			const text = truncateToWidth(line, innerWidth);
			result.push(border("│") + text + " ".repeat(innerWidth - visibleWidth(text)) + border("│"));
		}
		result.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return result.map((line) => theme.bg("toolPendingBg", truncateToWidth(line, width)));
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.x < 1 || event.y < 1 || event.x >= event.width - 1 || event.y >= event.height - 1) return undefined;
		return super.handleMouse({
			...event,
			x: event.x - 1,
			y: event.y - 1,
			width: event.width - 2,
			height: event.height - 2,
		});
	}
}

export default function grokUi(pi: ExtensionAPI): void {
	let activeTui: TUI | undefined;
	pi.registerToolRenderer((_name, next) => {
		const renderers = next();
		if (!renderers?.renderCall) return renderers;
		const renderCall = renderers.renderCall;
		return {
			...renderers,
			renderCall(args, theme, context) {
				const lastComponent =
					context.lastComponent instanceof GrokToolTitle ? context.lastComponent.content : context.lastComponent;
				return new GrokToolTitle(renderCall(args, theme, { ...context, lastComponent }), theme, context);
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let leaf: string | null | undefined;
		let timelineEntries: TranscriptTimelineEntry[] = [];
		ctx.ui.setHeader((tui) => {
			activeTui = tui;
			let mode: TUI["mode"] | undefined;
			const configureTimeline = () => {
				if (mode === tui.mode) return;
				mode = tui.mode;
				if (isViewportTUI(tui)) {
					tui.setMouseHoverEnabled?.(true);
					tui.setTimeline?.({
						getEntries() {
							const currentLeaf = ctx.sessionManager.getLeafId();
							if (currentLeaf === leaf) return timelineEntries;
							leaf = currentLeaf;
							timelineEntries = [];
							for (const entry of ctx.sessionManager.buildContextEntries()) {
								if (entry.type !== "message" || entry.message.role !== "user") continue;
								const content = entry.message.content;
								const preview =
									typeof content === "string"
										? content
										: content
												.filter((block) => block.type === "text")
												.map((block) => block.text)
												.join("\n");
								if (preview) {
									const skill = parseSkillBlock(preview);
									timelineEntries.push({
										preview: skill ? skill.userMessage || `[skill] ${skill.name}` : preview,
										timestamp: entry.message.timestamp,
									});
								}
							}
							return timelineEntries;
						},
						styleTick: (text, active, hovered, enabled) => {
							const theme = ctx.ui.theme;
							const styled = theme.fg(active || hovered ? "text" : "muted", text);
							return active
								? theme.bold(styled)
								: enabled
									? styled
									: theme.style(text, { fg: "muted", dim: true });
						},
						renderPreview: (entry) =>
							new PreviewPanel(
								{
									render(width) {
										const date = entry.timestamp === undefined ? undefined : new Date(entry.timestamp);
										const time =
											date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Time unavailable";
										return new Text(
											`${ctx.ui.theme.fg("muted", time)}\n${ctx.ui.theme.fg("text", stripTerminalSequences(entry.preview).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))}`,
											0,
											0,
										).render(width);
									},
									invalidate() {},
								},
								{
									maxHeight: () =>
										Math.min(
											8,
											Math.floor(tui.terminal.rows * 0.7),
											tui.transcriptViewportHeight ?? tui.terminal.rows,
										),
									border: (text) => ctx.ui.theme.fg("borderMuted", text),
									background: (text) => ctx.ui.theme.bg("toolPendingBg", text),
								},
							),
					});
				}
			};
			configureTimeline();
			return {
				render(width) {
					configureTimeline();
					const theme = ctx.ui.theme;
					return [
						truncateToWidth(theme.fg("text", theme.bold("Pi")) + theme.fg("muted", "  Grok UI prototype"), width),
						truncateToWidth(theme.fg("muted", "Message below. /grok-ui opens display options."), width),
					];
				},
				invalidate() {},
			};
		});
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new GrokEditor(tui, theme, keybindings, () => {
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected";
					return `${model} · ${pi.getThinkingLevel()}`;
				}),
		);
	});

	pi.on("session_shutdown", () => {
		if (activeTui && isViewportTUI(activeTui)) {
			activeTui.hideHoverPreview?.();
			activeTui.setTimeline?.(undefined);
			activeTui.setMouseHoverEnabled?.(false);
		}
		activeTui = undefined;
	});

	pi.registerCommand("grok-ui", {
		description: "Open Grok display options",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Grok display options require interactive mode.", "info");
				return;
			}
			const toggle = await ctx.ui.custom<boolean>(
				(_tui, _theme, keybindings, done) =>
					new GrokMenu(() => ctx.ui.theme, keybindings, ctx.ui.getToolsExpanded(), done),
				{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%", margin: 1 } },
			);
			if (toggle) ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
		},
	});
}
