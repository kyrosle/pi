export const TOOL_VIEW_MODES = ["collapsed", "summary", "expanded"] as const;
export type ToolViewMode = (typeof TOOL_VIEW_MODES)[number];

export function isToolViewMode(value: unknown): value is ToolViewMode {
	return value === "collapsed" || value === "summary" || value === "expanded";
}
