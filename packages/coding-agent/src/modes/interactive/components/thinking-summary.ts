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
	score: number;
}

interface SummaryCandidate {
	text: string;
	role: ThinkingRole;
	score: number;
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
	const tentative =
		/\b(if|whether|might|may|could|would|should|perhaps|possibly|expect\w*|avoid\w*|prevent\w*)\b|可能|是否|如果|假如|避免|防止|不一定|也许|或许|尚不确定/u.test(
			text.toLowerCase(),
		);
	const negated =
		/\b(?:not|never|no|\w+n['’]t)\b[^,.;!?，。；！？]*\b(?:fail\w*|error\w*|blocked)\b|(?:没(?:有)?|并未|未(?:曾)?|不(?:会|曾)?)[^,.;!?，。；！？]*(?:失败|错误|阻塞)/iu.test(
			text,
		);
	if (
		!tentative &&
		!negated &&
		(/\b(?:failed(?:\s+to)?|failure occurred|(?:is|was|remain\w*) blocked|cannot\s+(?:open|read|write|connect|access|run|build))\b/iu.test(
			text,
		) ||
			/(?:已|仍然|依然|再次|最终)?(?:失败了|失败[，。；]|失败$)|(?:发生|出现|返回).{0,16}错误|(?:被|仍然|已经)阻塞|无法(?:打开|读取|写入|连接|访问|运行|构建)/u.test(
				text,
			))
	)
		return "failure";
	if (/\b(decid(?:e|ed)|decision|conclusion|therefore|choose)\b|决定|结论|因此|选择/iu.test(text)) return "decision";
	if (
		/^(?:current|actual|before|baseline|ideal|expected|after|target|现状|实际|之前|目标|理想|预期|之后)\s*[:：]/iu.test(
			text,
		)
	)
		return "compare";
	if (/\b(verif\w*|test\w*|validat\w*|assert\w*)\b|验证|测试|校验/iu.test(text)) return "verify";
	if (/\b(compar\w*|versus|trade.?off)\b|对比|比较|权衡/iu.test(text)) return "compare";
	if (/\b(search\w*|find|locat\w*)\b|搜索|查找|定位/iu.test(text)) return "search";
	if (/\b(inspect\w*|read|check\w*|review\w*|examin\w*)\b|检查|读取|审查|查看/iu.test(text)) return "inspect";
	if (/\b(writ\w*|edit\w*|implement\w*|chang\w*|fix\w*)\b|编写|修改|实现|修复/iu.test(text)) return "write";
	if (/\b(run|execut\w*|build\w*)\b|运行|执行|构建/iu.test(text)) return "run";
	if (/\b(plan\w*|approach|next|need to|will)\b|计划|接下来|需要|准备/iu.test(text)) return "plan";
	return "reasoning";
}

function summaryCandidate(raw: string, state: ParseState, prefix = ""): SummaryCandidate | undefined {
	const line = excerptLine(raw, state).trim();
	let text = line
		.replace(/^(?:#{1,6}\s+|(?:[-+*]|\d+[.)]|[a-z][.)])\s+(?:\[[ xX]\]\s+)?)/i, "")
		.replace(/\s+#+\s*$/, "")
		.replace(/(`+|\*\*|__)(.+?)\1/g, "$2")
		.trim();
	if (!text) return undefined;
	if (
		prefix &&
		!state.heading &&
		!state.blank &&
		!state.fence &&
		!/^(?:#{1,6}\s|`{3,}|~{3,}|(?:[-+*]|\d+[.)]|[a-z][.)])\s)/iu.test(line)
	)
		text = `${prefix} ${text}`.slice(0, MAX_EXCERPT_SOURCE);
	const role = stepRole(text);
	const score =
		role === "failure" ||
		role === "decision" ||
		/\b(?:passed|succeeded|recovered|resolved|now works|instead)\b|通过了|已通过|验证通过|测试通过|成功|恢复|已解决|改为|改用/iu.test(
			text,
		)
			? 4
			: /\b(?:must|cannot|requires?|constraint|need to)\b|必须|无法|限制|需要/iu.test(text)
				? 3
				: role === "plan"
					? 2
					: role !== "reasoning" ||
							!/^(?:let me|i (?:should|need|want)|thinking|让我|先想|我(?:需要|应该|想))/iu.test(text)
						? 1
						: 0;
	return { text, role, score };
}

function preferCandidate(
	current: SummaryCandidate | undefined,
	next: SummaryCandidate | undefined,
): SummaryCandidate | undefined {
	return next &&
		(!current ||
			next.score > current.score ||
			(next.score === current.score && (next.score >= 3 || next.text.startsWith(`${current.text} `))))
		? next
		: current;
}

function parseLine(
	raw: string,
	start: number,
	end: number,
	state: ParseState,
	finish: (step: ThinkingStep) => void,
	candidate: SummaryCandidate | undefined,
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
		state.step = {
			start,
			end,
			summary: fence ? "Code block" : (candidate?.text ?? text),
			role: fence ? "reasoning" : (candidate?.role ?? "reasoning"),
		};
		state.score = fence ? -1 : (candidate?.score ?? 0);
		state.heading = heading;
		state.listIndent = list ? indent : undefined;
	} else {
		state.step.end = end;
		state.heading = false;
		if (
			!fence &&
			candidate &&
			(candidate.score > state.score ||
				(candidate.score === state.score &&
					(candidate.score >= 3 || candidate.text.startsWith(`${state.step.summary} `))))
		) {
			state.step.summary = candidate.text;
			state.step.role = candidate.role;
			state.score = candidate.score;
		}
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
		score: 0,
	};
	private steps: readonly ThinkingStep[] = [];
	private sentenceStart = 0;
	private candidate: SummaryCandidate | undefined;
	private candidateState = { ...this.state };
	private sentencePrefix = "";

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
				score: 0,
			};
			this.sentenceStart = 0;
			this.candidate = undefined;
			this.candidateState = { ...this.state };
			this.sentencePrefix = "";
		}
		const boundaries = /\n|[。！？；]|[.!?](?=\s)/gu;
		boundaries.lastIndex = Math.max(this.sentenceStart, this.source.length - 1);
		for (let match = boundaries.exec(text); match; match = boundaries.exec(text)) {
			const end = match.index;
			if (
				match[0] === "." &&
				this.sentenceStart === this.lineStart &&
				/^\s*(?:\d+|[a-z])$/iu.test(text.slice(this.lineStart, end))
			)
				continue;
			const newline = match[0] === "\n";
			const candidate = summaryCandidate(
				text.slice(this.sentenceStart, newline ? end : end + 1),
				this.candidateState,
				this.sentenceStart === this.lineStart ? this.sentencePrefix : "",
			);
			this.candidate = preferCandidate(this.candidate, candidate);
			this.sentenceStart = end + 1;
			if (!newline) continue;
			// A wrapped qualifier belongs to the following claim, not a standalone outcome.
			this.sentencePrefix =
				candidate &&
				/\b(?:not|never|no|if|whether|may|might|could|would|should|cannot|perhaps|possibly|\w+n['’]t)\b|尚未|还未|并未|没有|未能|可能|是否|如果|假如|也许|或许/iu.test(
					candidate.text,
				)
					? candidate.text
					: "";
			parseLine(
				text.slice(this.lineStart, end),
				this.lineStart,
				end + 1,
				this.state,
				(step) => this.completed.push(step),
				this.candidate,
			);
			this.lineStart = this.sentenceStart;
			this.candidate = undefined;
			this.candidateState = { ...this.state };
		}
		const pending = { ...this.state, step: this.state.step ? { ...this.state.step } : undefined };
		const steps = this.completed.slice();
		parseLine(
			text.slice(this.lineStart, this.lineStart + MAX_EXCERPT_SOURCE),
			this.lineStart,
			text.length,
			pending,
			(step) => steps.push(step),
			preferCandidate(
				this.candidate,
				summaryCandidate(
					text.slice(this.sentenceStart, this.sentenceStart + MAX_EXCERPT_SOURCE),
					{ ...this.candidateState },
					this.sentenceStart === this.lineStart ? this.sentencePrefix : "",
				),
			),
		);
		if (pending.step) steps.push(pending.step);
		this.steps = steps;
		this.source = text;
		return this.steps;
	}
}
