/**
 * Streaming assistant Markdown benchmark.
 *
 * Replays a deterministic assistant text stream in 128-character appends. Each append calls
 * AssistantMessageComponent.updateContent() and renders one frame at width 100, using the built-in
 * Mermaid transformer in streaming mode. Measures the content path only: no TUI scheduling, terminal
 * output, or profiler overhead by default. Use --tui for the fullscreen path, --history=100 for
 * completed messages, --chunk=512 for batching, or --paced for 2ms arrivals through requestRender.
 * Frames before 2K characters are excluded as warm-up. JSON includes individual runs and samples' hashes.
 *
 * Run from packages/coding-agent:
 *   node --import ./src/experimental/source-resolver.ts test/markdown-streaming-bench.ts --runs=5 --json
 *   Add --sizes=32768,65536 --kinds=chinese,code to select cases, or --memory with node --expose-gc.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { writeHeapSnapshot } from "node:v8";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, ScrollView, type Terminal, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const WIDTH = 100;
const RESIZE_WIDTH = 60;
const APPEND_CHARS = 128;
const WARMUP_CHARS = 2048;
const STEADY_RENDERS = 20;
const SIZES = [8_192, 32_768, 65_536];
const SAMPLE_KINDS = ["english", "chinese", "mixed", "code"] as const;

interface RunOptions {
	chunk: number;
	history: number;
	tui: boolean;
	paced: boolean;
}

class NullTerminal implements Terminal {
	columns = WIDTH;
	rows = 30;
	bytes = 0;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += Buffer.byteLength(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

class MeasuredTui extends TuiAltScreen {
	frames: number[] = [];
	protected override doRender(): void {
		const start = performance.now();
		super.doRender();
		this.frames.push(performance.now() - start);
	}
}

type SampleKind = (typeof SAMPLE_KINDS)[number];

interface Metrics {
	frames: number;
	p50: number;
	p95: number;
	max: number;
	cumulative: number;
	lastQuarterAverage: number;
	finish: number;
	steady: number;
	resize: number;
	wall: number;
	renders: number;
	outputBytes: number;
}

interface RunMetrics extends Metrics {
	frameTimes: number[];
}

const EN_SENTENCE =
	"The **streaming** renderer keeps `inline code`, [a link](https://example.com/guide), and *emphasis* in place while the answer grows. ";
const ZH_SENTENCE =
	"流式渲染需要在**不重复计算**的前提下保留`行内代码`、[链接](https://example.com/zh)和*强调*的样式，并且正确处理中文换行。";

function buildBlock(kind: SampleKind, index: number): string {
	if (kind === "english") {
		if (index % 11 === 10) return `## Section ${index}\n\n`;
		if (index % 7 === 6) return `- Item ${index}: ${EN_SENTENCE}\n- Second item with \`code\`\n\n`;
		return `Paragraph ${index}. ${EN_SENTENCE}${EN_SENTENCE}\n\n`;
	}
	if (kind === "chinese") {
		if (index % 11 === 10) return `## 第 ${index} 节\n\n`;
		return `第 ${index} 段。${ZH_SENTENCE}${ZH_SENTENCE}\n\n`;
	}
	if (kind === "mixed") {
		if (index % 4 === 3) {
			return `\`\`\`ts\nconst value${index} = compute(${index});\nexport default value${index};\n\`\`\`\n\n`;
		}
		return `Paragraph ${index}. ${EN_SENTENCE}${EN_SENTENCE}\n\n`;
	}
	return `function step${index}(input: number): number {\n  // 第 ${index} 步\n  return input * ${index} + 1;\n}\n`;
}

/** Builds a deterministic sample. The "code" sample ends inside an unclosed TypeScript fence. */
function buildSample(kind: SampleKind, length: number): string {
	let text = kind === "code" ? "下面是实现。\n\n```ts\n" : "";
	for (let index = 0; text.length < length; index++) {
		text += buildBlock(kind, index);
	}
	return text.slice(0, length);
}

function createMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function createComponent(transformers: readonly MarkdownTransformer[]): AssistantMessageComponent {
	return new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, transformers);
}

function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(sorted: readonly number[], percent: number): number {
	const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)] ?? 0;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return percentile(sorted, 50);
}

/**
 * Frames run in separate event-loop turns, as in the TUI. Without the yield, every frame of a run is one synchronous job,
 * and WeakRef targets created by one frame stay alive until the run ends, which is not how the TUI behaves.
 */
async function measureOnce(
	sample: string,
	transformers: readonly MarkdownTransformer[],
	options: RunOptions,
): Promise<RunMetrics> {
	const component = createComponent(transformers);
	const transcript = new Container();
	for (let i = 0; i < options.history; i++) {
		const history = createComponent(transformers);
		history.updateContent(createMessage(buildBlock("english", i)), false);
		transcript.addChild(history);
	}
	transcript.addChild(component);
	const terminal = new NullTerminal();
	const tui = options.tui ? new MeasuredTui(terminal, false) : undefined;
	if (tui) {
		tui.setLayoutRoot(
			new VStack([
				{
					component: new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" }),
					basis: 0,
					grow: 1,
					minSize: 1,
				},
				{ component: new Text("> benchmark\nfooter", 0, 0), basis: 2, minSize: 2 },
			]),
		);
		tui.start();
		tui.renderNow();
		tui.frames = [];
	}
	const render = (width: number): void => {
		if (tui) {
			terminal.columns = width;
			tui.renderNow();
		} else transcript.render(width);
	};
	const frames: number[] = [];
	const wallStart = performance.now();
	for (let length = options.chunk; ; length += options.chunk) {
		const text = sample.slice(0, Math.min(length, sample.length));
		const started = performance.now();
		component.updateContent(createMessage(text), true);
		if (options.paced) tui!.requestRender();
		else render(WIDTH);
		const elapsed = performance.now() - started;
		if (text.length > WARMUP_CHARS) frames.push(elapsed);
		if (text.length <= WARMUP_CHARS && tui) tui.frames = [];
		if (text.length === sample.length) break;
		if (options.paced) await delay(2);
		else await yieldToEventLoop();
	}
	if (options.paced) await delay(40);
	const wall = performance.now() - wallStart;
	const renderCount = tui?.frames.length ?? frames.length;
	const measuredFrames = options.paced ? tui!.frames.slice() : frames;
	await yieldToEventLoop();

	const started = performance.now();
	component.updateContent(createMessage(sample), false);
	render(WIDTH);
	const finish = performance.now() - started;

	const steadyStarted = performance.now();
	for (let i = 0; i < STEADY_RENDERS; i++) render(WIDTH);
	const steady = (performance.now() - steadyStarted) / STEADY_RENDERS;

	const resizeStarted = performance.now();
	render(RESIZE_WIDTH);
	render(WIDTH);
	const resize = (performance.now() - resizeStarted) / 2;
	tui?.stop();

	const sorted = [...measuredFrames].sort((left, right) => left - right);
	const quarter = Math.max(1, Math.floor(measuredFrames.length / 4));
	return {
		frames: frames.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted[sorted.length - 1] ?? 0,
		cumulative: measuredFrames.reduce((total, value) => total + value, 0),
		lastQuarterAverage: average(measuredFrames.slice(-quarter)),
		finish,
		steady,
		resize,
		wall,
		renders: renderCount,
		outputBytes: terminal.bytes,
		frameTimes: measuredFrames,
	};
}

function medianMetrics(runs: readonly Metrics[]): Metrics {
	const pick = (key: keyof Metrics) => median(runs.map((run) => run[key]));
	return {
		frames: pick("frames"),
		p50: pick("p50"),
		p95: pick("p95"),
		max: pick("max"),
		cumulative: pick("cumulative"),
		lastQuarterAverage: pick("lastQuarterAverage"),
		finish: pick("finish"),
		steady: pick("steady"),
		resize: pick("resize"),
		wall: pick("wall"),
		renders: pick("renders"),
		outputBytes: pick("outputBytes"),
	};
}

function parseRuns(args: readonly string[]): number {
	const option = args.find((arg) => arg.startsWith("--runs="));
	const runs = option ? Number(option.slice("--runs=".length)) : 5;
	if (!Number.isInteger(runs) || runs < 1) throw new Error(`Invalid --runs value: ${option}`);
	return runs;
}

function gitCommit(): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
}

function formatMs(value: number): string {
	return value.toFixed(2);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const runCount = parseRuns(args);
	const jsonOutput = args.includes("--json");
	const values = (name: string, fallback: string): string =>
		args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
	const options: RunOptions = {
		chunk: Number(values("chunk", String(APPEND_CHARS))),
		history: Number(values("history", "0")),
		tui: args.includes("--tui") || args.includes("--paced"),
		paced: args.includes("--paced"),
	};
	const sizes = values("sizes", SIZES.join(",")).split(",").map(Number);
	const kinds = values("kinds", SAMPLE_KINDS.join(",")).split(",");
	if (
		!Number.isInteger(options.chunk) ||
		options.chunk < 1 ||
		!Number.isInteger(options.history) ||
		options.history < 0 ||
		sizes.some((size) => !Number.isInteger(size) || size <= WARMUP_CHARS) ||
		kinds.some((kind) => !SAMPLE_KINDS.includes(kind as SampleKind))
	) {
		throw new Error("Invalid benchmark sizes, kinds, chunk or history");
	}

	initTheme("dark");
	const transformers: readonly MarkdownTransformer[] = [
		createMermaidMarkdownTransformer({ getMode: () => "streaming", theme }),
	];

	// Warm up JIT and module-level caches before any recorded run.
	await measureOnce(buildSample("english", 4 * 1024), transformers, options);
	if (args.includes("--memory")) {
		if (!globalThis.gc) throw new Error("--memory requires node --expose-gc");
		const kind = values("kinds", "mixed").split(",")[0] as SampleKind;
		const heap = async (): Promise<number> => {
			await yieldToEventLoop();
			globalThis.gc!();
			await yieldToEventLoop();
			globalThis.gc!();
			return process.memoryUsage().heapUsed;
		};
		const before = await heap();
		const snapshotDir = values("snapshots", "");
		if (snapshotDir) mkdirSync(snapshotDir, { recursive: true });
		const history: AssistantMessageComponent[] = [];
		for (let i = 0; i < 100; i++) {
			const component = createComponent(transformers);
			const sample = `${i}: ${buildSample(kind, 8192)}`;
			component.updateContent(createMessage(sample), true);
			component.render(WIDTH);
			component.updateContent(createMessage(`${sample} end`), false);
			component.render(WIDTH);
			history.push(component);
			await yieldToEventLoop();
		}
		const retained = await heap();
		if (snapshotDir) writeHeapSnapshot(`${snapshotDir}/retained.heapsnapshot`);
		const liveMessages = history.length;
		history.length = 0;
		const released = await heap();
		if (snapshotDir) writeHeapSnapshot(`${snapshotDir}/released.heapsnapshot`);
		console.log(
			JSON.stringify({
				kind,
				before,
				retained,
				released,
				liveMessages,
				retainedBytes: retained - before,
				releasedBytes: released - before,
			}),
		);
		return;
	}

	const results: Array<{
		kind: SampleKind;
		size: number;
		bytes: number;
		sha256: string;
		metrics: Metrics;
		runs: Metrics[];
	}> = [];
	for (const kind of kinds as SampleKind[]) {
		await measureOnce(buildSample(kind, 4096), transformers, options);
		for (const size of sizes) {
			const sample = buildSample(kind, size);
			const runs: RunMetrics[] = [];
			for (let run = 0; run < runCount; run++) {
				runs.push(await measureOnce(sample, transformers, options));
			}
			results.push({
				kind,
				size,
				bytes: Buffer.byteLength(sample, "utf8"),
				sha256: createHash("sha256").update(sample).digest("hex"),
				metrics: medianMetrics(runs),
				runs,
			});
		}
	}

	printResults(results, runCount, jsonOutput, options);
}

function printResults(
	results: ReadonlyArray<{ kind: SampleKind; size: number; bytes: number; metrics: Metrics }>,
	runCount: number,
	jsonOutput: boolean,
	options: RunOptions,
): void {
	if (jsonOutput) {
		console.log(
			JSON.stringify(
				{
					commit: gitCommit(),
					source: import.meta.url,
					node: process.version,
					cpu: cpus()[0]?.model,
					runCount,
					options,
					width: WIDTH,
					theme: "dark",
					mermaid: "streaming",
					results,
				},
				null,
				2,
			),
		);
	} else {
		console.log(
			`commit ${gitCommit()} | node ${process.version} | ${platform()} ${release()} | ${cpus()[0]?.model ?? "unknown cpu"}`,
		);
		console.log(
			`width ${WIDTH} (resize ${RESIZE_WIDTH}) | ${JSON.stringify(options)} | warm-up ${WARMUP_CHARS} | runs ${runCount} (median) | mermaid streaming | theme dark`,
		);
		console.log("");
		console.log(
			"| sample | chars | utf8 bytes | frames | P50 ms | P95 ms | max ms | cumulative ms | last-quarter avg ms | finish ms | steady ms | resize ms |",
		);
		console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
		for (const { kind, size, bytes, metrics } of results) {
			console.log(
				`| ${kind} | ${size} | ${bytes} | ${metrics.frames} | ${formatMs(metrics.p50)} | ${formatMs(metrics.p95)} | ${formatMs(metrics.max)} | ${formatMs(metrics.cumulative)} | ${formatMs(metrics.lastQuarterAverage)} | ${formatMs(metrics.finish)} | ${formatMs(metrics.steady)} | ${formatMs(metrics.resize)} |`,
			);
		}
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
