import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import type { ContextEditEntry, SessionManager } from "./session-manager.ts";
import { truncateMiddle } from "./tools/truncate.ts";

const archives = new WeakMap<
	SessionManager,
	{ sessionId: string; directory: string; outputs: Map<string, { text: string; json: string }> }
>();

export function getToolOutputDirectory(session: SessionManager): string | undefined {
	const archive = archives.get(session);
	return archive?.sessionId === session.getSessionId() ? archive.directory : undefined;
}

/** Bound the model-visible copy; the original message and its tool-call identity stay in history. */
export async function limitToolOutputContext(session: SessionManager, maxBytes: number): Promise<ContextEditEntry[]> {
	const outputs = session
		.buildSessionProjection()
		.entries.flatMap((entry) =>
			entry.messages.flatMap((message) =>
				message.role === "toolResult" &&
				entry.sourceEntry.type === "message" &&
				entry.sourceEntry.message.role === "toolResult"
					? [{ id: entry.sourceEntry.id, message, original: entry.sourceEntry.message }]
					: [],
			),
		);
	const totalBytes = outputs.reduce(
		(sum, output) => sum + Buffer.byteLength(JSON.stringify(output.message.content)),
		0,
	);
	if (totalBytes <= maxBytes || outputs.length === 0) return [];
	const bytesPerOutput = Math.max(512, Math.floor(maxBytes / outputs.length));
	if (outputs.every((output) => Buffer.byteLength(JSON.stringify(output.message.content)) <= bytesPerOutput))
		return [];
	const edits: ContextEditEntry[] = [];
	let archive = archives.get(session);
	if (!archive || archive.sessionId !== session.getSessionId()) {
		const sessionFile = session.getSessionFile();
		const directory = sessionFile
			? join(dirname(sessionFile), "tool-output", createHash("sha256").update(session.getSessionId()).digest("hex"))
			: await mkdtemp(join(tmpdir(), `${APP_NAME}-tool-output-`));
		await mkdir(directory, { recursive: true, mode: 0o700 });
		archive = { sessionId: session.getSessionId(), directory, outputs: new Map() };
		archives.set(session, archive);
	}
	for (const output of outputs) {
		if (Buffer.byteLength(JSON.stringify(output.message.content)) <= bytesPerOutput) continue;
		let saved = archive.outputs.get(output.id);
		if (!saved) {
			const name = createHash("sha256").update(output.id).digest("hex");
			saved = { text: join(archive.directory, `${name}.txt`), json: join(archive.directory, `${name}.json`) };
			await writeFile(saved.json, JSON.stringify(output.original, null, 2), { mode: 0o600 });
			await writeFile(saved.text, contentText(output.original.content), { mode: 0o600 });
			archive.outputs.set(output.id, saved);
		}
		const notice = `[Tool output reduced to fit context. Full text: ${saved.text}\nFull result (including images and metadata): ${saved.json}\nUse read with offset/limit; use bash for a long single line.]\n`;
		const content: ToolResultMessage["content"] = [
			{
				type: "text",
				text:
					notice +
					truncateMiddle(
						contentText(output.message.content),
						Math.max(0, bytesPerOutput - Buffer.byteLength(notice) - 128),
					).content,
			},
		];
		const edit = session.getEntry(session.appendContextEdit(output.id, { content }));
		if (edit?.type === "context_edit") edits.push(edit);
	}
	return edits;
}
