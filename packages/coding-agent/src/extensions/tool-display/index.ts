import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { toolDisplayRenderers } from "./renderer.ts";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		return renderers ? toolDisplayRenderers(toolName, renderers) : undefined;
	});
}
