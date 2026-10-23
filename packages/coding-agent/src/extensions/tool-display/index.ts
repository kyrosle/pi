import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { toolDisplayRenderers } from "./renderer.ts";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
	pi.registerToolRenderer((_name, next) => {
		const renderers = next();
		return renderers ? toolDisplayRenderers(renderers) : undefined;
	});
}
