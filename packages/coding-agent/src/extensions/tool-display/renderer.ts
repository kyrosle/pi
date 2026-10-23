import {
	Box,
	type Component,
	Container,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	isViewportTUI,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolRenderContext, ToolRenderers } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { PreviewPanel } from "../../modes/interactive/components/preview-panel.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

type RenderContext = ToolRenderContext<Record<string, unknown>, unknown>;
type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type CompactToolCall = Component & { compactToolCall?: Component | false };
type CompactToolComponent = Component & { compactToolResult?: Component };

class ToolTitle implements Component {
	private content: Component;
	private theme: Theme;
	private context: RenderContext;
	private headerWidth = 0;
	private hasStatusRow = false;
	private headerRow = 0;

	constructor(content: Component, theme: Theme, context: RenderContext) {
		this.content = content;
		this.theme = theme;
		this.context = context;
	}

	private status(): string {
		const { isError, isPartial, executionStarted } = this.context;
		const label = isError ? "Failed" : isPartial ? (executionStarted ? "Running" : "Queued") : "Done";
		return this.theme.fg(isError ? "error" : isPartial ? "muted" : "success", label);
	}

	renderSummary(width: number): string[] {
		const status = this.status();
		const prefix = this.theme.fg("muted", "▸ ");
		// Reserve the longest status so completion does not change the visible excerpt.
		const contentWidth = width - visibleWidth(prefix) - "Running".length - 1;
		if (contentWidth < 4) {
			const padding = width > 2 ? "  " : "";
			const available = Math.max(1, width - padding.length);
			const lines =
				this.content instanceof Text ? this.content.renderTruncated(available) : this.content.render(available);
			return [truncateToWidth(status, width), ...lines.map((line) => padding + truncateToWidth(line, available))];
		}
		const lines = (
			this.content instanceof Text ? this.content.renderTruncated(contentWidth) : this.content.render(contentWidth)
		).map((line) => truncateToWidth(line, contentWidth));
		const header = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		return lines.map((line, index) =>
			index === header
				? prefix + line + " ".repeat(Math.max(0, width - visibleWidth(prefix + line + status))) + status
				: `  ${line}`,
		);
	}

	render(width: number): string[] {
		const lines = this.content.render(width);
		this.headerRow = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		if (this.headerRow < 0) return lines;
		const status = this.status();
		const prefix = this.theme.fg("muted", this.context.expanded ? "▾ " : "▸ ");
		const remaining = width - visibleWidth(prefix) - visibleWidth(status) - 1;
		this.hasStatusRow = remaining < 4 || (this.context.expanded && visibleWidth(lines[this.headerRow]) > remaining);
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

class ToolRow implements Component {
	call?: Component;
	resultComponent?: Component;
	context: RenderContext;
	private renderers: ToolRenderers;
	private theme: Theme;
	private result?: ToolResult;
	private body?: Component;
	private compactVisible = false;

	constructor(renderers: ToolRenderers, theme: Theme, context: RenderContext) {
		this.renderers = renderers;
		this.theme = theme;
		this.context = context;
	}

	get compactToolCall(): Component | false | undefined {
		const call = this.call as CompactToolCall | undefined;
		return call?.compactToolCall ?? call;
	}

	updateCall(args: unknown, theme: Theme, context: RenderContext): void {
		this.theme = theme;
		this.context = { ...context, args };
		const lastComponent = this.call ?? context.lastComponent;
		this.call = undefined;
		this.call = this.renderers.renderCall?.(args, theme, {
			...this.context,
			lastComponent,
		});
	}

	updateResult(result: ToolResult, theme: Theme, context: RenderContext): void {
		this.result = result;
		this.theme = theme;
		this.context = context;
		const lastComponent = this.resultComponent;
		this.resultComponent = undefined;
		try {
			this.resultComponent = this.renderResult(context, lastComponent);
		} catch {
			this.resultComponent = this.fallbackResult(context.expanded);
		}
	}

	private renderResult(context: RenderContext, lastComponent?: Component): Component | undefined {
		if (!this.result) return undefined;
		if (this.renderers.renderResult) {
			return this.renderers.renderResult(
				this.result,
				{ expanded: context.expanded, isPartial: context.isPartial },
				this.theme,
				{ ...context, lastComponent },
			);
		}
		return this.fallbackResult(context.expanded);
	}

	private fallbackResult(expanded: boolean): Component | undefined {
		if (!this.result) return undefined;
		let output = this.result.content
			.filter((block) => block.type === "text")
			.map((block) => stripTerminalSequences(block.text ?? "").replace(/[\x00-\x08\x0B-\x1F\uFFF9-\uFFFB]/g, ""))
			.join("\n");
		if (!this.context.showImages || !getCapabilities().images) {
			const images = this.result.content
				.filter((block) => block.type === "image")
				.map((block) =>
					imageFallback(
						block.mimeType ?? "image/unknown",
						block.data && block.mimeType
							? (getImageDimensions(block.data, block.mimeType) ?? undefined)
							: undefined,
					),
				)
				.join("\n");
			if (images) output = output ? `${output}\n${images}` : images;
		}
		if (!output) return undefined;
		const lines = output.split("\n");
		const shown = expanded ? lines : lines.slice(0, 10);
		let text = shown.map((line) => this.theme.fg("toolOutput", line)).join("\n");
		if (shown.length < lines.length)
			text += `${this.theme.fg("muted", `\n... (${lines.length - shown.length} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${this.theme.fg("muted", ")")}`;
		return new Text(text, 0, 0);
	}

	render(width: number): string[] {
		this.compactVisible = false;
		const context = this.context;
		const call = this.call;
		const title = call && new ToolTitle(call, this.theme, context);
		const compactCall = this.compactToolCall;
		const hasNativeImages =
			context.showImages &&
			getCapabilities().images &&
			this.result?.content.some((block) => block.type === "image" && block.data && block.mimeType);
		const padding = this.renderers.renderShell === "self" ? 0 : context.outputPad;
		if (
			call &&
			title &&
			context.tui &&
			isViewportTUI(context.tui) &&
			!context.expanded &&
			!hasNativeImages &&
			compactCall
		) {
			const compactTitle = new ToolTitle(compactCall, this.theme, context);
			const innerWidth = Math.max(1, width - padding * 2);
			const collapsed = context.toolViewMode === "collapsed";
			let callLines: string[];
			if (collapsed) {
				const header = compactTitle
					.render(innerWidth)
					.find((line) => stripTerminalSequences(line).trim().length > 0);
				callLines = header === undefined ? [] : [header];
			} else {
				callLines = compactTitle.renderSummary(innerWidth);
			}
			if (callLines.length > 0) {
				this.compactVisible = true;
				const result = this.resultComponent as CompactToolComponent | undefined;
				const lines = [...callLines, ...(collapsed ? [] : (result?.compactToolResult?.render(innerWidth) ?? []))];
				return lines.map((line) => this.background(truncateToWidth(" ".repeat(padding) + line, width, "", true)));
			}
		}
		const body =
			this.renderers.renderShell === "self"
				? new Container()
				: new Box(context.outputPad, 1, (text) => this.background(text));
		if (title) body.addChild(title);
		if (this.resultComponent) body.addChild(this.resultComponent);
		this.body = body;
		return body.render(width);
	}

	private background(text: string): string {
		return this.theme.bg(
			this.context.isPartial ? "toolPendingBg" : this.context.isError ? "toolErrorBg" : "toolSuccessBg",
			text,
		);
	}

	private renderPreview(width: number): string[] {
		const context: RenderContext = {
			...this.context,
			expanded: true,
			toolViewMode: "expanded",
			lastComponent: undefined,
			// Nested wrappers key their inline rows by state identity.
			state: { ...this.context.state },
		};
		let call: Component | undefined;
		try {
			call = this.renderers.renderCall?.(context.args, this.theme, context);
		} catch {
			call = new Text(this.theme.fg("muted", "Tool call preview unavailable"), 0, 0);
		}
		let result: Component | undefined;
		try {
			result = this.renderResult(context);
		} catch {
			result = this.fallbackResult(true);
		}
		const lines: string[] = [];
		try {
			if (call) lines.push(...new ToolTitle(call, this.theme, context).render(width));
		} catch {
			lines.push(...new Text(this.theme.fg("muted", "Tool call preview unavailable"), 0, 0).render(width));
		}
		try {
			lines.push(...(result?.render(width) ?? []));
		} catch {
			lines.push(...(this.fallbackResult(true)?.render(width) ?? []));
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		const tui = this.context.tui;
		if (!this.compactVisible || !tui || !isViewportTUI(tui)) return this.body?.handleMouse?.(event);
		if (event.type === "move" && event.button === "none") {
			tui.showHoverPreview?.(
				this,
				new PreviewPanel(
					{ render: (width) => this.renderPreview(width), invalidate() {} },
					{
						maxHeight: () =>
							Math.min(Math.floor(tui.terminal.rows * 0.7), tui.transcriptViewportHeight ?? tui.terminal.rows),
						border: (text) => this.theme.fg("borderMuted", text),
						background: (text) => this.theme.bg("toolPendingBg", text),
						hint: () => "Click to expand",
						onClick: () => {
							tui.hideHoverPreview?.();
							this.context.setExpanded?.(true);
						},
					},
				),
				event,
			);
			return { handled: true, render: false };
		}
		return undefined;
	}

	invalidate(): void {
		this.call?.invalidate();
		this.resultComponent?.invalidate();
	}
}

export function toolDisplayRenderers(renderers: ToolRenderers): ToolRenderers {
	if (!renderers.renderCall) return renderers;
	const rows = new WeakMap<object, ToolRow>();
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!context.tui) return renderers.renderCall!(args, theme, context);
			const row = rows.get(context.state) ?? new ToolRow(renderers, theme, context);
			rows.set(context.state, row);
			row.updateCall(args, theme, context);
			return row;
		},
		renderResult(result, options, theme, context) {
			if (!context.tui) {
				if (renderers.renderResult) return renderers.renderResult(result, options, theme, context);
				const row = new ToolRow(renderers, theme, context);
				row.updateResult(result, theme, context);
				return row.resultComponent ?? new Container();
			}
			const row = rows.get(context.state);
			row?.updateResult(result, theme, context);
			if (!row?.call && row?.resultComponent) return row.resultComponent;
			const component = row?.resultComponent as CompactToolComponent | undefined;
			return Object.assign(new Container(), { compactToolResult: component?.compactToolResult });
		},
	};
}
