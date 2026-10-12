# Grok UI prototype

This fork selectively adopts interactions from the sibling `grok-pi-tui` checkout that make Pi easier to use. Acceptance is based on the usability improvement, Pi semantics and extension compatibility; matching Grok's complete appearance or feature set is not required. The first prototype uses the official extension and theme APIs and keeps Pi's interactive mode and agent core.

## Adoption priorities

This iteration adds a right-side turn timeline and compact tool calls with pointer previews. Grok's timeline also includes compaction boundaries; its reply-top control is a separate interaction. Compaction ticks, an independent reply-top control and a sticky prompt remain candidates for later work.

A sticky view of the current turn's prompt is another useful candidate: it keeps the question visible while reading a long answer or tool log. Pi already provides search, scrolling, selection, tool expansion and edit previews, so reuse those capabilities when improving their discoverability or presentation.

The extension enables the new optional fullscreen timeline/hover hooks and opts call components into compact rendering. The presentation-layer changes supply viewport positioning, turn markers and preview lifecycle. Scrolling does not navigate the session tree, change the active conversation branch, alter context or rerun a tool.

## Run

From this checkout, run `./pi-test.sh`. Once Pi's normal project-trust flow allows project resources, `.pi/settings.json` selects fullscreen mode and the `grok` theme, and `.pi/extensions/grok-ui.ts` loads the presentation extension.

To run only the prototype resources explicitly, from the repository root:

```bash
./pi-test.sh --no-extensions \
  --extension packages/coding-agent/examples/extensions/grok-ui.ts \
  --theme .pi/themes/grok.json --use-theme grok --tui-mode fullscreen
```

The extension also works with another Pi theme. `/settings` retains Pi's theme selector; `--tui-mode regular` retains terminal scrollback. Neither the extension nor the project settings selects a model or changes active tools.

## First-stage surfaces

- **Fullscreen:** Pi's existing `TuiAltScreen` and `createChatViewport()` provide a scrolling transcript and fixed input dock, including mouse scrolling, selection, search, and resize handling.
- **Input:** `GrokEditor` extends `CustomEditor`, adds rounded framing and a model/thinking caption, and retains autocomplete, paste, prompt history, configurable keys, hardware-cursor markers and embedded working/retry/compaction indicators. Mouse coordinates account for the frame.
- **Timeline:** when there are at least two rendered user turns and at least 60 terminal columns, a two-column rail shows one tick per turn. The bright thick tick identifies the viewport's current turn. Hover previews the stored user timestamp and prompt; click jumps to the turn, and ▲/▼ target the nearest turn above/below the viewport top. The original prompt-navigation keybindings now navigate turns in this view. A short last turn can align to the top without resuming automatic following.
- **Tools:** `registerToolRenderer()` delegates to `next()`, adds Queued/Running/Done/Failed status, and opts call components into compact fullscreen display. Hover shows the existing expanded call/result rendering in a bounded, independently scrollable panel. Clicking the row or panel expands inline; the original expansion shortcut still works. Previous components are unwrapped before delegation, result renderers/shared state remain intact, and self-framed tools keep their shell. Explicit compact opt-outs, output-only renderers and native image output retain their display.
- **Diff:** Pi's edit renderer keeps its asynchronous preview, final-result reconciliation, errors, file links and highlighting. Its diff is available in the hover panel and expanded inline view; compact mode keeps the call summary visible.
- **Popup:** `/grok-ui` opens a centered overlay using `ctx.ui.custom()` and Pi's `SelectList`. It toggles tool expansion or returns to the prompt. Configured select/cancel keys and mouse selection work through Pi's existing controls.

The built-in footer remains in place so usage, cost, branch and other extensions' status text keep their existing behavior. Model selection, settings, session tree and extension dialogs retain Pi's current components; restyling all of them is outside this first prototype.

Editor and header replacement follow Pi's existing extension load order; extensions sharing either slot need combination checks. Below six terminal columns the editor omits its extra frame to leave room for wide characters.

Previews do not capture keyboard focus or cover the input dock. Leaving the source/panel, typing, scrolling the transcript, resizing, opening a focused dialog or replacing the session dismisses them. Tool details update while a preview is open. The extension resets its hooks on shutdown/reload and reinstalls them when the renderer changes from regular to fullscreen. Timeline preview text is stripped of terminal control sequences before display.

## Call chain and ownership

```text
src/experimental/cli.ts -> src/main.ts
  -> InteractiveMode
     -> createInteractiveTui() -> TuiAltScreen / TuiMainScreen
     -> createChatViewport() -> ScrollView + fixed input dock
     -> extension UI context
        -> setHeader() / setEditorComponent() / custom(overlay)
     -> ToolExecutionComponent
        -> ExtensionRunner.resolveToolRenderers() -> next()
        -> existing tool renderCall() / renderResult()
```

Rendering uses the current theme and Pi's terminal-width helpers. AgentSession continues to own provider requests, tool validation/execution, streamed results, queues, retries, compaction and session persistence. The extension observes rendering context without changing prompts, tool definitions, tool results or messages. TUI setup is guarded by `ctx.mode === "tui"`; RPC/JSON/print retain their own presentation.

## Visual choices

GrokNight's gray panels separate input, messages and tool output; violet marks active controls, while green/red retain execution and diff meaning. Secondary text is brighter than the reference's dim grays to remain legible on the dark panels. Rounded input and popup borders identify editable and temporary surfaces. Typography stays in the terminal's configured monospace font for consistent cell geometry. Spacing separates turns while keeping tool details close to their calls. This is a calm terminal interface with consistent layout and only Pi's existing progress animation.

The `grok` palette targets a dark terminal background. It colors panels, rather than changing the terminal's global background. Other Pi themes continue to work with the extension.

## Verification

Run the focused offline suite from `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/suite/grok-ui.test.ts test/chat-viewport.test.ts test/interactive-tui.test.ts
```

The suites check width/Unicode/cursor behavior, remapped keys and paste/history, working status, component reuse, RPC isolation, popup focus restoration, theme loading and real write/edit turns with the faux provider. Timeline/hover checks cover tick selection, chevrons, final-turn alignment, preview updates/scrolling, draft/focus preservation, renderer changes, shutdown cleanup, self-framed diffs, custom-renderer opt-outs and terminal-command stripping. No provider credentials or paid API calls are needed. Run `npm run check` from the repository root after code changes. Follow `.pi/skills/interactive-testing.md` for a tmux smoke test.

The current focused checks are:

```bash
# packages/tui
node --test test/tui-timeline-hover.test.ts test/tui-alt-screen.test.ts test/tui-render.test.ts test/tui-main-screen.test.ts
# packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/grok-ui.test.ts test/tool-execution-component.test.ts test/user-message.test.ts test/assistant-message.test.ts test/interactive-tui.test.ts test/chat-viewport.test.ts
```

Verified on 2026-10-11:

- The three focused files passed, with 38 tests in total. The repository's full `npm run check` passed, including TypeScript and browser entry checks.
- tmux at 100×30 ran an offline faux-provider turn through the real CLI, AgentSession and built-in write/read/edit/bash tools. The edited temporary file contained `after` and a Chinese second line; the native edit diff showed the removed and added lines, and a missing-file read displayed Failed with its original error.
- `/grok-ui` opened in the center and changed tool output from collapsed to expanded. Reopening showed Collapse tool output. Closing restored the input dock. Default project-resource discovery loaded the extension and theme in a separate 80×24 session, and the input dock still fit after resizing to 40×12.

The timeline/hover iteration passed the full `npm run check`, 104 focused TUI tests and 99 coding-agent tests. A fresh tmux CLI at 100×30 ran two offline faux-provider turns through write/edit/read, including a failed read: tool calls stayed compact, a timeline hover displayed the stored prompt/time, clicking its first tick brought the first turn to the top, and hovering edit displayed the real before/after diff. The temporary files contained `after` and the Chinese second line. `/reload` retained the two turns and compact cards; resizing to 40×12 hid the rail and kept the input dock, and restoring 100×30 restored the rail. Local terminal captures are under `.artifacts/grok-ux/`.

The fresh checkout needed `npm ci --ignore-scripts` and its ignored model data. Model data was hydrated from the existing `nix/model-catalog.json` revision after verifying its SHA-256; model source files and dependency versions were unchanged. No build command or live provider call was run. Real IME candidate-window placement, clipboard/image input and third-party extension combinations still need human terminal checks. The test tmux server had extended keys disabled, so modified Enter behavior was checked in the virtual terminal rather than claimed from tmux.
