import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

describe("context budget errors", () => {
	it.each(["413 Payload Too Large", "Request is too large", "Request Entity Too Large"])(
		"recognizes byte-size rejection: %s",
		(errorMessage) => {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			expect(isContextOverflow(message)).toBe(true);
			expect(isRetryableAssistantError(message)).toBe(false);
		},
	);
	it("does not repeat identical overflowing input because its token count happens to contain an HTTP error number", async () => {
		let attempts = 0;
		const response = await retryAssistantCall(
			async () => {
				attempts++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 50000 tokens" });
			},
			{ enabled: true, maxRetries: 3, baseDelayMs: 1 },
			undefined,
		);
		expect(response.stopReason).toBe("error");
		expect(attempts).toBe(1);
	});
	it("preserves transient rate-limit classification", () => {
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Rate limit exceeded: too many requests",
		});
		expect(isContextOverflow(message)).toBe(false);
		expect(isRetryableAssistantError(message)).toBe(true);
	});
});
