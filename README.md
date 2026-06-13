# pi IDE Bridge

A VS Code extension that gives [pi](https://github.com/earendil-works/pi-mono)
Claude-Code-style `/ide` awareness. It tracks your active file and selection and
pushes them to a running pi session over a local unix socket. pi mirrors the
state in a widget and lets you reference it inline with `@selection` / `@file`.

Pairs with the `ide-bridge.ts` pi extension (the consumer).

## How it works

- This extension watches `onDidChangeTextEditorSelection` /
  `onDidChangeActiveTextEditor`, debounces, and writes newline-delimited JSON to
  the socket pi hosts at `~/.pi/ide/<cwd-hash>.sock`.
- Socket resolution order: active file's workspace-root hash → home-dir hash →
  most recently active pi (newest registry by mtime). This routes correctly for
  both project sessions (pi launched at the repo root) and general sessions
  (pi launched from `~`).

## Protocol

Editor → pi, one JSON object per line:

```json
{"type":"state","file":"src/x.ts","startLine":10,"endLine":20,"selectedText":"...","languageId":"typescript"}
{"type":"clear"}
```

## Install (local, no build)

It's plain JS — symlink it into VS Code's extensions dir and reload:

```bash
ln -s "$PWD" ~/.vscode/extensions/pi-bridge
```

Then run **Developer: Reload Window** in VS Code.

## Settings

- `piBridge.debounceMs` (default `120`) — debounce window before pushing.
