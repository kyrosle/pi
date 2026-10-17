import { splitIncompleteAnsiSuffix, stripAnsi } from "../../../utils/ansi.ts";

const MAX_EXCERPT_SOURCE = 512;
const ANSI_STRING_START = /\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f]/g;
const ANSI_STRING_END = /\u0007|\u001b\\|\u009c/g;

export type ThinkingRole =
	| "inspect"
	| "search"
	| "plan"
	| "write"
	| "run"
	| "compare"
	| "verify"
	| "failure"
	| "decision"
	| "reasoning";

export interface ThinkingStep {
	start: number;
	end: number;
	summary: string;
	role: ThinkingRole;
}

interface ParseState {
	fence: string;
	controlString: boolean;
	blank: boolean;
	heading: boolean;
	listIndent: number | undefined;
	step: ThinkingStep | undefined;
}

function excerptLine(raw: string, state: ParseState): string {
	let excerpt = "";
	let offset = 0;
	while (offset < raw.length) {
		if (state.controlString) {
			ANSI_STRING_END.lastIndex = offset;
			const end = ANSI_STRING_END.exec(raw);
			if (!end) break;
			offset = end.index + end[0].length;
			state.controlString = false;
		} else {
			ANSI_STRING_START.lastIndex = offset;
			const start = ANSI_STRING_START.exec(raw);
			excerpt += raw.slice(
				offset,
				Math.min(start?.index ?? raw.length, offset + MAX_EXCERPT_SOURCE - excerpt.length),
			);
			if (!start) break;
			offset = start.index + start[0].length;
			state.controlString = true;
		}
	}
	return stripAnsi(splitIncompleteAnsiSuffix(excerpt).complete)
		.replace(/[\u001b\u0090-\u009f].*$/u, "")
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}

function stepRole(text: string): ThinkingRole {
	// These labels describe the source's subject, never whether a tool actually succeeded.
	if (/\b(fail(?:ed|ure)?|error|blocked|cannot)\b|失败|错误|阻塞|无法/iu.test(text)) return "failure";
	if (/\b(decid(?:e|ed)|decision|conclusion|therefore|choose)\b|决定|结论|因此|选择/iu.test(text)) return "decision";
	if (/\b(verif\w*|test\w*|validat\w*|assert\w*)\b|验证|测试|校验/iu.test(text)) return "verify";
	if (/\b(compar\w*|versus|trade.?off)\b|对比|比较|权衡/iu.test(text)) return "compare";
	if (/\b(search\w*|find|locat\w*)\b|搜索|查找|定位/iu.test(text)) return "search";
	if (/\b(inspect\w*|read|check\w*|review\w*|examin\w*)\b|检查|读取|审查|查看/iu.test(text)) return "inspect";
	if (/\b(writ\w*|edit\w*|implement\w*|chang\w*|fix\w*)\b|编写|修改|实现|修复/iu.test(text)) return "write";
	if (/\b(run|execut\w*|build\w*)\b|运行|执行|构建/iu.test(text)) return "run";
	if (/\b(plan\w*|approach|next|need to|will)\b|计划|接下来|需要|准备/iu.test(text)) return "plan";
	return "reasoning";
}

function parseLine(
	raw: string,
	start: number,
	end: number,
	state: ParseState,
	finish: (step: ThinkingStep) => void,
): void {
	const line = excerptLine(raw, state);
	const text = line.trim();
	const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
	if (state.fence) {
		if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && !fence[2].trim())
			state.fence = "";
		if (state.step) state.step.end = end;
		state.blank = false;
		return;
	}
	if (!text) {
		state.blank = true;
		if (state.step) state.step.end = end;
		return;
	}
	const heading = /^\s{0,3}#{1,6}\s+/.test(line);
	const list = /^(\s*)(?:[-+*]|\d+[.)]|[a-z][.)])\s+/i.exec(line);
	const indent = line.length - line.trimStart().length;
	const startsStep =
		heading ||
		Boolean(list && (state.listIndent === undefined || indent <= state.listIndent)) ||
		(state.blank && !state.heading && (state.listIndent === undefined || indent <= state.listIndent));
	if (state.step && startsStep) {
		state.step.end = start;
		finish(state.step);
		state.step = undefined;
	}
	if (!state.step) {
		const summary = text
			.replace(/^(?:#{1,6}\s+|(?:[-+*]|\d+[.)]|[a-z][.)])\s+(?:\[[ xX]\]\s+)?)/i, "")
			.replace(/\s+#+\s*$/, "")
			.replace(/(`+|\*\*|__)(.+?)\1/g, "$2")
			.trim();
		state.step = { start, end, summary: fence ? "Code block" : summary, role: stepRole(summary) };
		state.heading = heading;
		state.listIndent = list ? indent : undefined;
	} else {
		state.step.end = end;
		state.heading = false;
	}
	if (fence) state.fence = fence[1];
	state.blank = false;
}

/** Keeps completed steps and scans only new lines plus the unfinished tail. */
export class ThinkingSummary {
	private source = "";
	private lineStart = 0;
	private completed: ThinkingStep[] = [];
	private state: ParseState = {
		fence: "",
		controlString: false,
		blank: false,
		heading: false,
		listIndent: undefined,
		step: undefined,
	};
	private steps: readonly ThinkingStep[] = [];

	update(text: string): readonly ThinkingStep[] {
		if (text === this.source) return this.steps;
		if (!text.startsWith(this.source)) {
			this.lineStart = 0;
			this.source = "";
			this.completed = [];
			this.state = {
				fence: "",
				controlString: false,
				blank: false,
				heading: false,
				listIndent: undefined,
				step: undefined,
			};
		}
		for (let end = text.indexOf("\n", this.source.length); end !== -1; end = text.indexOf("\n", end + 1)) {
			parseLine(text.slice(this.lineStart, end), this.lineStart, end + 1, this.state, (step) =>
				this.completed.push(step),
			);
			this.lineStart = end + 1;
		}
		const pending = { ...this.state, step: this.state.step ? { ...this.state.step } : undefined };
		const steps = this.completed.slice();
		parseLine(
			text.slice(this.lineStart, this.lineStart + MAX_EXCERPT_SOURCE),
			this.lineStart,
			text.length,
			pending,
			(step) => steps.push(step),
		);
		if (pending.step) steps.push(pending.step);
		this.steps = steps;
		this.source = text;
		return this.steps;
	}
}

/** Keep the opening, current step and salient decisions/failures in source order. */
export function selectThinkingSteps(steps: readonly ThinkingStep[]): readonly ThinkingStep[] {
	const limit = 5;
	if (steps.length <= limit) return steps;
	const selected = new Set([0, steps.length - 1]);
	for (const roles of [["failure", "decision"], ["verify", "compare"], []]) {
		for (let i = steps.length - 2; i > 0 && selected.size < limit; i--) {
			if (roles.length === 0 || roles.includes(steps[i].role)) selected.add(i);
		}
	}
	return [...selected].sort((a, b) => a - b).map((index) => steps[index]);
}
