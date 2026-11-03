export const THINKING_VIEW_MODES = ["collapsed", "summary", "expanded"] as const;
export type ThinkingViewMode = (typeof THINKING_VIEW_MODES)[number];

export function isThinkingViewMode(value: unknown): value is ThinkingViewMode {
	return value === "collapsed" || value === "summary" || value === "expanded";
}
