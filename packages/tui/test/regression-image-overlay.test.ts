import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PreviewPanel } from "../src/components/preview-panel.ts";
import { Text } from "../src/components/text.ts";
import {
	allocateImageId,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	registerKittyImageMetadata,
	setCapabilities,
} from "../src/terminal-image.ts";
import { CURSOR_MARKER, compositeTuiLine, type TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
const capabilities = getCapabilities();
const activeTuis: Array<TuiAltScreen | TuiMainScreen> = [];

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

async function createScene(mode: "fullscreen" | "regular" = "fullscreen", prefix = "") {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const terminal = new RecordingTerminal(80, 12);
	const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	activeTuis.push(tui);
	const imageId = allocateImageId();
	registerKittyImageMetadata({ imageId, columns: 12, rows: 3, widthPx: 1, heightPx: 1 });
	const image = encodeKitty(PNG, { imageId, columns: 12, rows: 3, moveCursor: false });
	tui.addChild({ render: () => ["before", prefix + image, "", "", "after"], invalidate() {} });
	tui.start();
	await terminal.waitForRender();
	terminal.writes.length = 0;
	return { terminal, tui, image, imageId };
}

afterEach(() => {
	for (const tui of activeTuis.splice(0)) tui.stop();
	setCapabilities(capabilities);
});

describe("images below overlays", () => {
	for (const mode of ["fullscreen", "regular"] as const) {
		it(`renders every overlay row beside an image in ${mode} mode`, async () => {
			const { terminal, tui, imageId } = await createScene(mode);
			tui.showOverlay(new Text("TOP\nIMAGE_ROW\nNEXT\nBOTTOM", 0, 0), {
				row: 0,
				col: 25,
				width: 25,
				nonCapturing: true,
			});
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			for (const [row, text] of ["TOP", "IMAGE_ROW", "NEXT", "BOTTOM"].entries()) {
				assert.equal(viewport[row].indexOf(text), 25);
			}
			assert.ok(terminal.writes.join("").includes(`i=${imageId}`));
			assert.ok(!terminal.writes.join("").includes("z=-1073741825"));
		});
	}

	it("keeps a hover panel continuous, lowers only overlapping images and restores their layer", async () => {
		const { terminal, tui, imageId } = await createScene();
		assert.ok(tui instanceof TuiAltScreen);
		const editor = new Text("draft", 0, 0);
		tui.addChild(editor);
		tui.setFocus(editor);
		const panel = new PreviewPanel(new Text("DIFF_ONE\nDIFF_TWO\nDIFF_THREE", 0, 0), {
			maxHeight: () => 7,
			border: (text) => text,
			background: (text) => `\x1b[48;2;20;20;20m${text}\x1b[49m`,
		});
		const source: TuiMouseEvent = {
			type: "move",
			button: "none",
			x: 0,
			y: 0,
			screenX: 40,
			screenY: 0,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		};
		tui.showHoverPreview({}, panel, source);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.ok(viewport[1].includes("╭"));
		assert.ok(viewport[2].includes("DIFF_ONE"));
		assert.ok(viewport[3].includes("DIFF_TWO"));
		assert.ok(viewport[4].includes("DIFF_THREE"));
		assert.equal(tui.getFocusedComponent(), editor);
		const showing = terminal.writes.join("");
		assert.ok(showing.includes("z=-1073741825"));
		assert.ok(showing.includes(`i=${imageId}`));
		assert.ok(!showing.includes(PNG), "uploaded image data should be reused");
		terminal.writes.length = 0;
		tui.hideHoverPreview();
		await terminal.waitForRender();
		const restored = terminal.writes.join("");
		assert.ok(restored.includes(`i=${imageId}`));
		assert.ok(!restored.includes("z=-1073741825"));
		assert.ok(!terminal.getViewport().join("\n").includes("DIFF_ONE"));
	});

	it("lowers an image even when only its lower rows intersect the overlay", async () => {
		const { terminal, tui } = await createScene();
		tui.showOverlay(new Text("LOWER", 0, 0), { row: 3, col: 4, width: 20, nonCapturing: true });
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[3].includes("LOWER"));
		assert.ok(terminal.writes.join("").includes("z=-1073741825"));
	});

	it("uses the image's horizontal offset when deciding overlap", async () => {
		const { terminal, tui } = await createScene("fullscreen", "中文");
		const overlay = tui.showOverlay(new Text("LEFT", 0, 0), { row: 1, col: 0, width: 4, nonCapturing: true });
		await terminal.waitForRender();
		assert.equal(terminal.getViewport()[1].indexOf("LEFT"), 0);
		assert.ok(!terminal.writes.join("").includes("z=-1073741825"));
		overlay.hide();
		terminal.writes.length = 0;
		tui.showOverlay(new Text("OVERLAP", 0, 0), { row: 1, col: 12, width: 20, nonCapturing: true });
		await terminal.waitForRender();
		const row = terminal.getViewport()[1];
		assert.equal(visibleWidth(row.slice(0, row.indexOf("OVERLAP"))), 12);
		assert.ok(terminal.writes.join("").includes("z=-1073741825"));
	});

	it("preserves multipart image bytes, source columns, stacked overlays and cursor columns", () => {
		const image = encodeKitty("A".repeat(10000), { columns: 12, rows: 3, moveCursor: false });
		const first = compositeTuiLine(`中文${image}tail`, "FIRST", 20, 10, 80);
		const second = compositeTuiLine(first, `XX${CURSOR_MARKER}SECOND`, 0, 10, 80);
		assert.ok(second.includes(image));
		assert.equal(second.split(image).length, 2);
		assert.ok(second.includes(`\x1b[5G${image}`));
		assert.equal(stripTerminalSequences(second).indexOf("FIRST"), 20);
		assert.equal(visibleWidth(second.slice(0, second.indexOf(CURSOR_MARKER))), 2);
		assert.equal(visibleWidth(second), 80);
	});

	it("does not lower images for an overlay without rows", async () => {
		const { terminal, tui } = await createScene();
		tui.showOverlay({ render: () => [], invalidate() {} }, { row: 2, col: 4, width: 20, nonCapturing: true });
		await terminal.waitForRender();
		assert.ok(!terminal.writes.join("").includes("z=-1073741825"));
	});

	it("keeps adjacent image commands at their positioned column", async () => {
		const { terminal, tui, image } = await createScene();
		const secondId = allocateImageId();
		registerKittyImageMetadata({ imageId: secondId, columns: 12, rows: 3, widthPx: 1, heightPx: 1 });
		const second = encodeKitty(PNG, { imageId: secondId, columns: 12, rows: 3, moveCursor: false });
		tui.clear();
		tui.addChild({ render: () => ["before", `\x1b[5G${image}${second}`, "", "", "after"], invalidate() {} });
		tui.showOverlay(new Text("LEFT", 0, 0), { row: 1, col: 0, width: 4, nonCapturing: true });
		await terminal.waitForRender();
		assert.ok(!terminal.writes.join("").includes("z=-1073741825"));
	});

	it("leaves image commands that move vertically unchanged", () => {
		for (const image of [encodeKitty(PNG), `\x1b[2A${encodeITerm2(PNG)}`]) {
			assert.equal(compositeTuiLine(image, "overlay", 10, 20, 80), image);
		}
	});
});
