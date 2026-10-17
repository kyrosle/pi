import { splitIncompleteAnsiSuffix, stripAnsi } from "../../../utils/ansi.ts";

const MAX_EXCERPT_SOURCE = 256;
const ANSI_STRING_START = /\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f]/g;
const ANSI_STRING_END = /\u0007|\u001b\\|\u009c/g;

interface LineState {
	fence: string;
	paragraph: boolean;
	controlString: boolean;
}

interface Summary {
	lineCount: number;
	stepCount: number;
	steps: readonly string[];
}

function extractStep(rawLine: string, state: LineState): string | undefined {
	let excerpt = "";
	let offset = 0;
	while (offset < rawLine.length) {
		if (state.controlString) {
			ANSI_STRING_END.lastIndex = offset;
			const end = ANSI_STRING_END.exec(rawLine);
			if (!end) break;
			offset = end.index + end[0].length;
			state.controlString = false;
		} else {
			ANSI_STRING_START.lastIndex = offset;
			const start = ANSI_STRING_START.exec(rawLine);
			excerpt += rawLine.slice(
				offset,
				Math.min(start?.index ?? rawLine.length, offset + MAX_EXCERPT_SOURCE - excerpt.length),
			);
			if (!start) break;
			offset = start.index + start[0].length;
			state.controlString = true;
		}
	}
	// Bound work on an unfinished line; discard escape sequences cut off by that bound.
	const line = stripAnsi(splitIncompleteAnsiSuffix(excerpt).complete)
		.replace(/[\u001b\u0090-\u009f].*$/u, "")
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
	const text = line.trim();
	const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
	if (state.fence) {
		if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && !fence[2].trim()) {
			state.fence = "";
			state.paragraph = false;
		}
		return undefined;
	}
	if (fence) {
		state.fence = fence[1];
		state.paragraph = false;
		return undefined;
	}
	if (!text) {
		state.paragraph = false;
		return undefined;
	}
	if (/^[#*`~=_\-\d.)\s]+$/.test(text)) return undefined;
	const marker = /^(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(text);
	if (!marker && state.paragraph) return undefined;
	state.paragraph = true;
	return (
		text
			.slice(marker?.[0].length ?? 0)
			.replace(/\s+#+\s*$/, "")
			.replace(/(`+|\*\*|__)(.+?)\1/g, "$2")
			.trim() || undefined
	);
}

/** Retains only three excerpts and the parser state at the last complete line. */
export class ThinkingSummary {
	private source = "";
	private lineStart = 0;
	private lineCount = 1;
	private stepCount = 0;
	private steps: string[] = [];
	private state: LineState = { fence: "", paragraph: false, controlString: false };
	private summary: Summary = { lineCount: 1, stepCount: 0, steps: [] };

	update(text: string): Summary {
		if (text === this.source) return this.summary;
		if (text.slice(0, this.source.length) !== this.source) {
			this.source = "";
			this.lineStart = 0;
			this.lineCount = 1;
			this.stepCount = 0;
			this.steps = [];
			this.state = { fence: "", paragraph: false, controlString: false };
		}
		for (let end = text.indexOf("\n", this.source.length); end !== -1; end = text.indexOf("\n", end + 1)) {
			const step = extractStep(text.slice(this.lineStart, end), this.state);
			if (step) {
				this.steps.push(step);
				if (this.steps.length > 3) this.steps.shift();
				this.stepCount++;
			}
			this.lineStart = end + 1;
			this.lineCount++;
		}
		const pending = extractStep(text.slice(this.lineStart, this.lineStart + MAX_EXCERPT_SOURCE), { ...this.state });
		this.summary = {
			lineCount: this.lineCount,
			stepCount: this.stepCount + (pending ? 1 : 0),
			steps: pending ? [...this.steps.slice(-2), pending] : this.steps.slice(),
		};
		this.source = text;
		return this.summary;
	}
}
