import {
	isViewportTUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ThinkingRenderContext, ThinkingRenderer } from "../../core/extensions/types.ts";
import { PreviewPanel } from "../../modes/interactive/components/preview-panel.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import { type ThinkingRole, type ThinkingStep, ThinkingSummary } from "./summary.ts";

const THINKING_ROLES: Record<ThinkingRole, { icon: string; color: ThemeColor }> = {
	inspect: { icon: "◫", color: "mdLink" },
	search: { icon: "⌕", color: "mdLink" },
	plan: { icon: "◇", color: "accent" },
	write: { icon: "✎", color: "accent" },
	run: { icon: "▷", color: "accent" },
	compare: { icon: "↔", color: "warning" },
	verify: { icon: "✓", color: "success" },
	failure: { icon: "!", color: "error" },
	decision: { icon: "◆", color: "accent" },
	reasoning: { icon: "·", color: "muted" },
};

function thinkingHeader(
	step: ThinkingStep,
	width: number,
	prefix: string,
	continuation: string,
	active: boolean,
	theme: Theme,
): string[] {
	const { icon, color } = THINKING_ROLES[step.role];
	let lead = `${prefix}${theme.fg(color, icon)} `;
	let follow = `${continuation}  `;
	// At very narrow widths, keep the text readable instead of spending every cell on decoration.
	if (width - visibleWidth(lead) < 8) lead = follow = "";
	const text = active
		? theme.style(step.summary, { fg: "thinkingText", bold: true })
		: theme.fg("thinkingText", step.summary);
	const available = width - visibleWidth(lead);
	if (visibleWidth(step.summary) <= available) return [lead + text];
	return wrapTextWithAnsi(text, Math.max(1, available)).map((line, index) =>
		truncateToWidth(`${index === 0 ? lead : follow}${line}`, width),
	);
}

class ThinkingStepsComponent {
	private summary = new ThinkingSummary();
	private steps: readonly ThinkingStep[] = [];
	private thinking = "";
	private theme: Theme;
	private context: ThinkingRenderContext;
	private previewed = false;

	constructor(thinking: string, theme: Theme, context: ThinkingRenderContext) {
		this.theme = theme;
		this.context = context;
		this.update(thinking, theme, context);
	}

	update(thinking: string, theme: Theme, context: ThinkingRenderContext): void {
		if (
			this.previewed &&
			(context.mode !== this.context.mode ||
				context.markdown !== this.context.markdown ||
				!thinking.startsWith(this.thinking))
		) {
			this.dismissPreview();
		}
		this.thinking = thinking;
		this.theme = theme;
		this.context = context;
		this.steps = context.mode === "expanded" ? [] : this.summary.update(thinking);
	}

	render(width: number): string[] {
		const { mode, markdown, active, hiddenLabel, outputPad } = this.context;
		if (mode === "expanded") return markdown.render(width);
		const theme = this.theme;
		const label = hiddenLabel === "Thinking..." ? "Thinking Steps" : hiddenLabel;
		const activeStep = active ? this.steps.at(-1) : undefined;
		const pad = " ".repeat(outputPad);
		if (mode === "collapsed") {
			const step = this.steps.at(-1);
			if (!step) return [];
			const prefix = `${pad}▸ ${label} · `;
			return thinkingHeader(
				step,
				width,
				theme.fg(activeStep ? "accent" : "muted", prefix),
				" ".repeat(visibleWidth(prefix)),
				step === activeStep,
				theme,
			);
		}
		const lines = [
			theme.fg(
				"muted",
				truncateToWidth(
					`${pad}┆ ${label} · Summary · ${this.steps.length} ${this.steps.length === 1 ? "step" : "steps"}`,
					width,
				),
			),
		];
		for (const [index, step] of this.steps.entries()) {
			const last = index === this.steps.length - 1;
			const active = step === activeStep;
			const connector = theme.fg(active ? "accent" : "muted", last ? "└─" : "├─");
			const continuation = theme.fg("muted", last ? "   " : "│  ");
			lines.push(
				...thinkingHeader(
					{ ...step, summary: `Step ${index + 1} · ${step.summary}` },
					width,
					`${pad}${connector} `,
					pad + continuation,
					active,
					theme,
				),
			);
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { tui, mode, markdown } = this.context;
		if (mode !== "expanded" && event.type === "move" && event.button === "none" && tui && isViewportTUI(tui)) {
			this.previewed = true;
			tui.showHoverPreview?.(
				markdown,
				new PreviewPanel(markdown, {
					maxHeight: () => Math.min(tui.terminal.rows * 0.7, tui.transcriptViewportHeight ?? tui.terminal.rows),
					border: (text) => this.theme.fg("borderMuted", text),
					background: (text) => this.theme.bg("toolPendingBg", text),
					hint: () => "Click to expand all",
					onClick: () => this.toggle(),
				}),
				event,
			);
			return { handled: true, render: false };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.toggle();
		return { handled: true };
	}

	private toggle(): void {
		this.dismissPreview();
		this.context.setExpanded(this.context.mode !== "expanded");
	}

	private dismissPreview(): void {
		if (!this.previewed) return;
		const { tui, markdown } = this.context;
		if (tui && isViewportTUI(tui)) tui.hideHoverPreview?.(markdown);
		this.previewed = false;
	}

	invalidate(): void {
		this.context.markdown.invalidate();
	}

	dispose(): void {
		this.dismissPreview();
	}
}

export const thinkingStepsRenderer: ThinkingRenderer = (thinking, theme, context) => {
	const component = context.lastComponent;
	if (component instanceof ThinkingStepsComponent) {
		component.update(thinking, theme, context);
		return component;
	}
	return new ThinkingStepsComponent(thinking, theme, context);
};
