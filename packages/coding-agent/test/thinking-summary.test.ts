import { describe, expect, test } from "vitest";
import { ThinkingSummary } from "../src/modes/interactive/components/thinking-summary.ts";

describe("ThinkingSummary", () => {
	test("extracts headings, list items and paragraph openings without inferring completion", () => {
		const summary = new ThinkingSummary();
		expect(
			summary.update(
				"## Inspect `config`\ncontinued explanation\n\n- Check **paths**\n  and permissions\n2. Run tests",
			),
		).toEqual({
			lineCount: 6,
			stepCount: 3,
			steps: ["Inspect config", "Check paths", "Run tests"],
		});
		expect(summary.update("I will check this.\nStill the same paragraph.\n\nNot verified yet.").steps).toEqual([
			"I will check this.",
			"Not verified yet.",
		]);
	});

	test("keeps the latest three excerpts in source order", () => {
		expect(new ThinkingSummary().update("One\n\nTwo\n\nThree\n\nFour")).toEqual({
			lineCount: 7,
			stepCount: 4,
			steps: ["Two", "Three", "Four"],
		});
	});

	test("omits fenced code and resumes after the matching closing fence", () => {
		const source = "Before\n\n````ts\n- code\n```\n# still code\n````\n\nAfter\n~~~\nmore code\n~~~\nLast";
		expect(new ThinkingSummary().update(source).steps).toEqual(["Before", "After", "Last"]);
		expect(new ThinkingSummary().update("```ts\n- not a step").steps).toEqual([]);
	});

	test.each([
		"# Inspect\r\n\r\n- Check paths\r\n  continuation\r\n2. Run tests\r\n\r\nDone",
		"Before\n\n```ts\n# code\n```\n\nAfter",
		"\x1b]8;;https://example.com\n```\x07\nVisible",
		"Safe \x1b]52;c;payload\n\n# hidden\x07\n\nVisible",
		"中文 e\u0301 👨‍👩‍👧‍👦\n\nNext paragraph",
		"\x1b[31mInspect\x1b[0m\n\n\x1b]8;;https://example.com\x07Check\x1b]8;;\x07\n\nFinish",
	])("matches a fresh parse at every streamed prefix: %s", (source) => {
		const streamed = new ThinkingSummary();
		for (let end = 1; end <= source.length; end++) {
			const text = source.slice(0, end);
			expect(streamed.update(text)).toEqual(new ThinkingSummary().update(text));
		}
	});

	test("resets for same-length replacements, truncation and empty content", () => {
		const summary = new ThinkingSummary();
		for (const source of ["One\n\nTwo", "New\n\nEnd", "Short", "", "```\ncode\n```\nAfter"]) {
			expect(summary.update(source)).toEqual(new ThinkingSummary().update(source));
		}
	});

	test("bounds long unfinished excerpts and does not retain code lines as steps", () => {
		const summary = new ThinkingSummary();
		for (const length of [1024, 65536, 262144]) {
			const result = summary.update(`Inspect ${"x".repeat(length)}`);
			expect(result.steps).toHaveLength(1);
			expect(result.steps[0].length).toBeLessThanOrEqual(512);
		}
		const source = `Before\n\n\`\`\`ts\n${"const x = 1;\n".repeat(10000)}\`\`\`\n\nAfter`;
		expect(summary.update(source).steps).toEqual(["Before", "After"]);
	});

	test("removes terminal controls and suppresses an unfinished escape at the excerpt boundary", () => {
		const summary = new ThinkingSummary();
		expect(summary.update("\x1b[31mCheck\x1b[0m\tpaths\u2028now").steps).toEqual(["Check paths now"]);
		expect(summary.update(`Safe \x1b]52;c;${"payload".repeat(200)}`).steps).toEqual(["Safe"]);
		expect(summary.update("Safe \x1b[").steps).toEqual(["Safe"]);
		expect(summary.update("\x1b]8;;https://example.com\n```\x07\nVisible").steps).toEqual(["Visible"]);
		expect(summary.update("Safe \x1b]52;c;payload\n\n# hidden\x07\n\nVisible").steps).toEqual(["Safe", "Visible"]);
		expect(summary.update(`Before \x1b]52;c;${"payload".repeat(200)}\n# hidden\x07\n\nAfter`).steps).toEqual([
			"Before",
			"After",
		]);
	});

	test("keeps cached results for identical source and commits a pending line only once", () => {
		const summary = new ThinkingSummary();
		const result = summary.update("First\n\nSecond");
		expect(summary.update("First\n\nSecond")).toBe(result);
		expect(summary.update("First\n\nSecond\n").steps).toEqual(result.steps);
		expect(summary.update("First\n\nSecond\n\nThird").stepCount).toBe(3);
	});
});
