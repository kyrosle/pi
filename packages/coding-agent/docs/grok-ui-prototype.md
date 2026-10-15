# Grok UI prototype

This fork selectively adopts interactions from the sibling `grok-pi-tui` checkout that make Pi easier to use. Acceptance is based on the usability improvement, Pi semantics and extension compatibility; matching Grok's complete appearance or feature set is not required. The first prototype uses the official extension and theme APIs and keeps Pi's interactive mode and agent core.

## Adoption priorities

This iteration adds a right-side turn timeline and compact tool calls with pointer previews. Grok's timeline also includes compaction boundaries; its reply-top control is a separate interaction. Compaction ticks, an independent reply-top control and a sticky prompt remain candidates for later work.

A sticky view of the current turn's prompt is another useful candidate: it keeps the question visible while reading a long answer or tool log. Pi already provides search, scrolling, selection, tool expansion and edit previews, so reuse those capabilities when improving their discoverability or presentation.

The extension uses optional fullscreen timeline/hover hooks and wraps tool renderers for compact display. The presentation-layer changes supply viewport positioning, turn markers and preview lifecycle. Scrolling does not navigate the session tree, change the active conversation branch, alter context or rerun a tool.

The UI is an extension backed by small presentation changes in this fork. Editor framing, role headings, colors, tool statuses, compact-call composition, the private `PreviewPanel`, popup choices and hover settings live in `grok-ui.ts`, its `grok-ui/` helpers and the theme. Fullscreen transcript positions, turn markers and cancellable pointer previews remain in the TUI because the extension API does not expose those transcript details. Tool renderers receive narrow host callbacks for the active TUI and expanding one tool. The extension still depends on these fork hooks; it is not a standalone drop-in for unmodified upstream Pi. Prefer public APIs and existing extensions before adding another host hook. Output archival belongs to a separate built-in extension; request-budget checks and automatic recovery remain in the agent core.

The implementation follows Pi's [official tool-settings example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tools.ts) and [overlay examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts). [pi-extension-settings](https://github.com/juanibiapina/pi-extension-settings) provides shared extension-owned configuration; this prototype keeps its single setting in its own JSON file and adds no settings dependency.

## Run

From this checkout, run `./pi-test.sh`. Once Pi's normal project-trust flow allows project resources, `.pi/settings.json` selects fullscreen mode and the `grok` theme, and `.pi/extensions/grok-ui.ts` loads the presentation extension.

To run only the prototype resources explicitly, from the repository root:

```bash
./pi-test.sh --no-extensions \
  --extension packages/coding-agent/examples/extensions/grok-ui.ts \
  --theme .pi/themes/grok.json --use-theme grok --tui-mode fullscreen
```

The extension also works with another Pi theme. `/settings` retains Pi's theme selector; `--tui-mode regular` retains terminal scrollback. Neither the extension nor the project settings selects a model or changes active tools.

## Hover delay

Tool and timeline previews wait 2000 milliseconds by default. Passing over a row briefly does not open a panel. Clicking a tool still expands it immediately.

Use `/grok-hover-delay` to show the current value, `/grok-hover-delay 3500` for a 3.5-second delay, or `/grok-hover-delay 0` for immediate previews. Changes apply immediately and are saved across reloads and restarts in `grok-ui.json` inside Pi's agent directory (normally `~/.pi/agent/grok-ui.json`):

```json
{ "hoverDelayMs": 2000 }
```

This is extension configuration, separate from Pi's core `settings.json`. Only integer milliseconds from 0 through 2147483647 are accepted. An invalid file produces a warning and retains the two-second default.

## First-stage surfaces

- **Fullscreen:** Pi's existing `TuiAltScreen` and `createChatViewport()` provide a scrolling transcript and fixed input dock, including mouse scrolling, selection, search, and resize handling.
- **Input:** the native `CustomEditor` uses top and bottom horizontal rules, retaining autocomplete, paste, prompt history, configurable keys, hardware-cursor markers, mouse positioning and embedded working/retry/compaction indicators. Model and thinking level remain in the footer.
- **Messages:** the Markdown transformer adds the current system username above user text and each reply's recorded model ID above assistant text, including streamed and historical replies. The host supplies that model ID in the read-only Markdown rendering context. Repeated Grok transformers keep one heading. Thinking keeps its own presentation. These headings appear only in rendered Markdown; stored messages, model requests and timeline previews retain the original text.
- **Timeline:** when there are at least two rendered user turns and at least 60 terminal columns, a two-column rail shows one tick per turn. The bright thick tick identifies the viewport's current turn. Hover previews the stored user timestamp and prompt; click jumps to the turn, and ▲/▼ target the nearest turn above/below the viewport top. The original prompt-navigation keybindings now navigate turns in this view. A short last turn can align to the top without resuming automatic following.
- **Tools:** `registerToolRenderer()` wraps the call and result renderers returned by `next()`, adds Queued/Running/Done/Failed status, and composes compact fullscreen display in the extension. Result renderers still run while collapsed so asynchronous edit previews reconcile with the final result. Hover shows the existing expanded call/result rendering in a bounded, independently scrollable panel. Clicking the row or panel expands inline; the original expansion shortcut still works. Previous components are unwrapped before delegation, result renderers/shared state remain intact, and self-framed tools keep their shell. Explicit compact opt-outs, output-only renderers and native image output retain their display.
- **Diff:** Pi's edit renderer keeps its asynchronous preview, final-result reconciliation, errors, file links and highlighting. Its diff is available in the hover panel and expanded inline view; compact mode keeps the call summary visible.
- **Popup:** `/grok-ui` opens a centered overlay using `ctx.ui.custom()` and Pi's `SelectList`. It toggles tool expansion or returns to the prompt. Configured select/cancel keys and mouse selection work through Pi's existing controls.

The built-in footer remains in place so usage, cost, branch and other extensions' status text keep their existing behavior. Model selection, settings, session tree and extension dialogs retain Pi's current components; restyling all of them is outside this first prototype.

Editor and header replacement follow Pi's existing extension load order; extensions sharing either slot need combination checks.

Previews do not capture keyboard focus or cover the input dock. Leaving the source/panel, typing, scrolling the transcript, resizing, opening a focused dialog or replacing the session dismisses them. Tool details update while a preview is open. The extension resets its hooks on shutdown/reload and reinstalls them when the renderer changes from regular to fullscreen. Timeline preview text is stripped of terminal control sequences before display.

## Call chain and ownership

```text
src/cli.ts -> src/main.ts
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

User messages use a blue-gray background and white text, with the system username to distinguish them from replies without relying on color alone. Assistant prose stays on the terminal background, with the replying model's name. Thinking and tool output use muted text; tool titles use secondary text, while green/red retain execution and diff meaning. Violet marks active controls. Horizontal rules delimit the input; rounded borders identify popups. Typography stays in the terminal's configured monospace font for consistent cell geometry. Spacing separates turns while keeping tool details close to their calls. This is a calm terminal interface with consistent layout and only Pi's existing progress animation.

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

The role/contrast iteration on 2026-10-12 passed 164 focused tests and `npm run check`. The compiled extension ran two offline CLI turns with `pi-thinking-steps` and the native write/edit/read tools. Role headings survived streaming, `/reload` and a 40×14 resize without changing stored prompts or replies. Local captures and original test-session messages are under `.artifacts/grok-contrast-20261012/`.

The hover-delay iteration passed 167 coding-agent tests, 115 TUI tests, `npm run check` and the TUI/coding-agent builds. A freshly packaged CLI completed a faux-provider reply and displayed a retained edit diff only after the default two-second hover; leaving early cancelled it. A 500 ms setting survived `/reload`, and zero displayed immediately. The installed release keeps captures and reports under its `verification/` directory. No real provider API was used.

The fresh checkout needed `npm ci --ignore-scripts` and its ignored model data. Model data was hydrated from the existing `nix/model-catalog.json` revision after verifying its SHA-256; model source files and dependency versions were unchanged. No build command or live provider call was run. Real IME candidate-window placement, clipboard/image input and third-party extension combinations still need human terminal checks. The test tmux server had extended keys disabled, so modified Enter behavior was checked in the virtual terminal rather than claimed from tmux.
