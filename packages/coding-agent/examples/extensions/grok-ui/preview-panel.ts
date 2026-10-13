import {
	type Component,
	ScrollView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface PreviewPanelOptions {
	maxHeight: () => number;
	border: (text: string) => string;
	background: (text: string) => string;
	hint?: () => string;
	onClick?: () => void;
}

/** A bounded preview that scrolls without changing the transcript or keyboard focus. */
export class PreviewPanel implements Component {
	private content: Component;
	private options: PreviewPanelOptions;
	private scroll: ScrollView;

	constructor(content: Component, options: PreviewPanelOptions) {
		this.content = content;
		this.options = options;
		this.scroll = new ScrollView(content, { overscroll: "contain" });
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines = this.content.render(innerWidth);
		const height = Math.max(1, Math.floor(this.options.maxHeight()) - 3);
		this.scroll.updateLayout(lines.length, height, () => {});
		const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height);
		const result = [this.options.border(`╭${"─".repeat(Math.max(0, width - 2))}╮`)];
		for (const line of visible) {
			const text = truncateToWidth(line, innerWidth, "");
			result.push(
				`${this.options.border("│")} ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${this.options.border("│")}`,
			);
		}
		if (lines.length > height || this.options.hint) {
			const position = lines.length > height ? `${this.scroll.scrollTop + 1}/${lines.length} · wheel to scroll` : "";
			const hint = [position, this.options.hint?.()].filter(Boolean).join(" · ");
			result.push(this.options.border(`│ ${truncateToWidth(hint, innerWidth, "", true)} │`));
		}
		result.push(this.options.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return result.map((line) => this.options.background(truncateToWidth(line, width, "", true)));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scroll.scrollBy(event.wheelDelta ?? 0);
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left" && this.options.onClick) {
			this.options.onClick();
			return { handled: true };
		}
		// Keep pointer movement inside the preview from reaching the transcript beneath it.
		if (event.type === "move") return { handled: true, render: false };
		return undefined;
	}

	invalidate(): void {
		this.content.invalidate();
	}
}
