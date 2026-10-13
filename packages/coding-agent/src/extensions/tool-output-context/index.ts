import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";
import { APP_NAME } from "../../config.ts";
import type { ContextBudgetEntryDraft, ExtensionFactory } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { truncateMiddle } from "../../core/tools/truncate.ts";

const archiveType = "tool-output-archive";

function sessionArchiveDirectory(session: ReadonlySessionManager): string | undefined {
	const sessionFile = session.getSessionFile();
	return sessionFile
		? join(dirname(sessionFile), "tool-output", createHash("sha256").update(session.getSessionId()).digest("hex"))
		: undefined;
}

export function getToolOutputDirectory(session: ReadonlySessionManager): string | undefined {
	const entry = session.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === archiveType);
	if (entry?.type === "custom" && typeof entry.data === "object" && entry.data !== null && "directory" in entry.data) {
		if (typeof entry.data.directory === "string") return entry.data.directory;
	}
	// Sessions archived before the extension migration have no custom metadata entry.
	const directory = sessionArchiveDirectory(session);
	return directory && existsSync(directory) ? directory : undefined;
}

export function createToolOutputContextExtension(): ExtensionFactory {
	return (pi) => {
		pi.on("context_budget", async (event, ctx) => {
			const session = ctx.sessionManager;
			let directory = getToolOutputDirectory(session);
			const entries: ContextBudgetEntryDraft[] = [];
			if (event.maxBytes !== undefined) {
				const outputs = event.context.contextEntries.flatMap((entry) =>
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
				const bytesPerOutput = Math.max(512, Math.floor(event.maxBytes / Math.max(1, outputs.length)));
				const oversized =
					totalBytes > event.maxBytes
						? outputs.filter(
								(output) => Buffer.byteLength(JSON.stringify(output.message.content)) > bytesPerOutput,
							)
						: [];
				if (oversized.length) {
					directory ??=
						sessionArchiveDirectory(session) ?? (await mkdtemp(join(tmpdir(), `${APP_NAME}-tool-output-`)));
					await mkdir(directory, { recursive: true, mode: 0o700 });
					if (!session.getBranch().some((entry) => entry.type === "custom" && entry.customType === archiveType)) {
						entries.push({ type: "custom", customType: archiveType, data: { directory } });
					}
					for (const output of oversized) {
						const name = createHash("sha256").update(output.id).digest("hex");
						const textPath = join(directory, `${name}.txt`);
						const jsonPath = join(directory, `${name}.json`);
						await writeFile(jsonPath, JSON.stringify(output.original, null, 2), { mode: 0o600 });
						await writeFile(textPath, contentText(output.original.content), { mode: 0o600 });
						const notice = `[Tool output reduced to fit context. Full text: ${textPath}\nFull result (including images and metadata): ${jsonPath}\nUse read with offset/limit; use bash for a long single line.]\n`;
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
						entries.push({ type: "context_edit", targetId: output.id, replacement: { content } });
					}
				}
			}
			return {
				entries,
				recoveryContext: directory
					? `Full tool outputs are retained in ${directory}. Read the .txt files in bounded pieces; .json files retain complete results and images.`
					: undefined,
			};
		});
	};
}

export default createToolOutputContextExtension();
