# pi IDE Bridge

Claude-Code-style `/ide` awareness for the [pi](https://github.com/earendil-works/pi-mono)
coding agent. Your editor's active file and selection show up live in pi, and you
reference them inline with `@selection` / `@file` — no copy-paste, no manual path
typing.

pi is a terminal-native TUI; it has no editor surface of its own. This bridges
that gap with a small VS Code extension that publishes editor state, and a pi
extension that consumes it.

## What you get

- A live indicator in pi that mirrors your current file and selection as you move
  around the editor — `IDE  src/foo.ts:10-20`.
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
  → write JSON line             ┘             update widget (live mirror)

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

`clear` is sent when the active editor has no selection or focus leaves the
editor. With an empty selection, a `state` carrying just `file` + `languageId`
is sent (mirrors the active file without a range).

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

- `piBridge.debounceMs` (default `120`) — debounce window before pushing
  selection changes.

## Limitations

- Routing keys on pi's working directory. If you run pi in a subdirectory of the
  workspace (not the root, not home), neither hash matches and it falls back to
  the newest active pi.
- One editor selection per pi instance — the most recent push wins.
