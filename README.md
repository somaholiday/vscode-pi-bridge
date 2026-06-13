# pi IDE Bridge

Claude-Code-style `/ide` awareness for the [pi](https://github.com/earendil-works/pi-mono)
coding agent. Your editor's active file and selection show up live in pi, and you
reference them inline with `@selection` / `@file` — no copy-paste, no manual path
typing.

pi is a terminal-native TUI; it has no editor surface of its own. This bridges
that gap with a small VS Code extension that publishes editor state, and a pi
extension that consumes it.

## What you get

- A live indicator below pi's input, right-aligned, that mirrors your current
  file and selection as you move around the editor — an icon plus
  `src/foo.ts:10-20`. (Suppressible; see [Settings](#settings).)
- `@selection` in a prompt expands, at submit time, to the highlighted code:

  ````
  <selection src/foo.ts:10-20>
  ```ts
  const x = 42;
  ```
  </selection>
  ````
- `@file` expands to the active file's path.

## How it works

Claude Code's `/ide` is a client/server split: the IDE extension hosts a server,
continuously tracks the editor selection, and the CLI subscribes and pulls the
current state at prompt time. The live status indicator is *push*; the context
injection is a snapshot of the latest pushed state.

This reimplements the same shape without the MCP/WebSocket ceremony — one local
unix socket:

```
VS Code extension (publisher)              pi extension (consumer)
─────────────────────────────             ────────────────────────
onDidChangeTextEditorSelection ─┐         hosts socket at
onDidChangeActiveTextEditor     │           ~/.pi/ide/<cwd-hash>.sock
  → debounce                    ├─push───►  on message:
  → resolve target socket       │             cache latest state
  → write JSON line             ┘             update widget + write snapshot

                                            on prompt (input hook):
                                              expand @selection / @file
                                              from the cached state
```

The pi side *hosts* the socket (keyed on its working directory) and the editor
connects out. This keeps routing simple — the socket path encodes which pi
instance should receive state — and means you can test the pi half with nothing
but `nc`.

## Repo layout

```
extension.js            VS Code publisher (plain JS, no build step)
package.json            VS Code extension manifest
pi-extension/
  ide-bridge.ts         the pi consumer extension
```

## Install

### 1. pi consumer

Copy the consumer into pi's extensions directory:

```bash
cp pi-extension/ide-bridge.ts ~/.pi/agent/extensions/
```

Then `/reload` in pi (or restart it). pi auto-discovers any `.ts` in that
directory.

> The consumer imports pi's extension types as a *type-only* import, which jiti
> erases at runtime — so it works whether your pi build publishes as
> `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent`.

### 2. VS Code publisher

It's plain JS — no build. Symlink it into VS Code's extensions directory and
reload the window:

```bash
ln -s "$PWD" ~/.vscode/extensions/pi-bridge
```

Then run **Developer: Reload Window** in VS Code.

## Usage

1. Run pi in a terminal (standalone or integrated — doesn't matter).
2. In VS Code, select some text.
3. pi's indicator updates to the file + range you highlighted.
4. Reference it in a prompt: `why does @selection throw?`

The indicator only shows when there's an active file; the selection text is
captured at the moment you submit, so what you reference is always what you're
currently looking at.

## Protocol

Newline-delimited JSON, editor → pi:

```json
{"type":"state","file":"src/x.ts","startLine":10,"endLine":20,"selectedText":"...","languageId":"typescript"}
{"type":"clear"}
```

`clear` is sent when the active editor has no selection, focus leaves the
editor, or VS Code shuts down cleanly. With an empty selection, a `state`
carrying just `file` + `languageId` is sent (mirrors the active file without a
range).

## Shared snapshot

On each update the consumer mirrors the latest state — **minus the selected
text** — to a JSON file, so other extensions (e.g. a status bar) can render the
current file/selection without speaking the socket protocol:

```
~/.pi/ide/<cwd-hash>.state.json
{"file":"src/x.ts","startLine":10,"endLine":20,"languageId":"typescript"}
```

The file is removed when there's no active file (e.g. on `clear`). A consumer
re-derives the path with `sha256(cwd)` (first 16 hex) and reads it on demand.

## Socket routing

The publisher resolves which pi socket to target, in order:

1. **Workspace-root hash** — `sha256(workspaceRoot)`, first 16 hex. Matches a pi
   launched at the repo root (project work).
2. **Home-dir hash** — `sha256(~)`. Matches a general-purpose pi launched from
   your home directory.
3. **Newest active pi** — the most recently updated registry in `~/.pi/ide/`.

Sockets and registries live in `~/.pi/ide/<cwd-hash>.{sock,json}`. The consumer
writes the registry on startup and cleans up on shutdown.

## Settings

**VS Code** (`piBridge.*`):

- `piBridge.debounceMs` (default `120`) — debounce window before pushing
  selection changes.

**pi consumer** (environment):

- `IDE_BRIDGE_WIDGET` — set to `0` to suppress the below-editor widget. The
  shared snapshot is still written, so a status bar can render the indicator
  instead. Defaults to on.

## Development

Both halves are dependency-free and need no build. Edit `extension.js` and run
**Developer: Reload Window** in VS Code; edit `pi-extension/ide-bridge.ts` and
`/reload` in pi.

If you vendor this repo as a git submodule (e.g. inside a dotfiles repo that
symlinks both halves into place), develop in the submodule and push from there.
To release the pinned version to your other machines, bump the submodule ref in
the parent repo:

```bash
git -C /path/to/dotfiles add path/to/vscode-pi-bridge
git -C /path/to/dotfiles commit -m "bump pi-bridge"
```

## Limitations

- Routing keys on pi's working directory. If you run pi in a subdirectory of the
  workspace (not the root, not home), neither hash matches and it falls back to
  the newest active pi.
- One editor selection per pi instance — the most recent push wins.
- A *hard* kill of VS Code (crash/SIGKILL) skips the clean-shutdown `clear`, so
  the last snapshot can linger until the next selection change or pi restart.
  Clean quits clear it.
