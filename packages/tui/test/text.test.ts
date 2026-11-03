import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";

describe("Text", () => {
	it("returns source text without rendering or invalidating its wrapped lines", () => {
		const source = "\x1b[31ma long header\x1b[0m\nsecond line";
		const text = new Text(source, 1, 1);
		const lines = text.render(8);
		assert.strictEqual(text.getText(), source);
		assert.strictEqual(text.render(8), lines);
		text.setText("updated text");
		assert.strictEqual(text.getText(), "updated text");
	});

	it("keeps its wrapped lines when the same text is set again", () => {
		const text = new Text("hello world", 0, 0);
		const lines = text.render(5);
		text.setText("hello world");
		assert.strictEqual(text.render(5), lines);
	});
});
