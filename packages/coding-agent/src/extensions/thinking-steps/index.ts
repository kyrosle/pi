import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { thinkingStepsRenderer } from "./renderer.ts";

export default function thinkingStepsExtension(pi: ExtensionAPI): void {
	pi.registerThinkingRenderer(thinkingStepsRenderer);
}
