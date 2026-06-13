/**
 * IDE Bridge
 *
 * Gives pi Claude-Code-style `/ide` awareness: an editor (e.g. VS Code) pushes
 * the current file + selection over a unix socket; pi keeps a live mirror in a
 * widget above the editor and lets you reference it inline via `@selection` and
 * `@file` tokens that expand at submit time.
 *
 * Topology: pi hosts the socket, keyed on cwd so the right pi instance receives
 * state. A registry file lets the editor side discover the matching socket.
 *
 * Shared snapshot: the latest state (minus selected text) is mirrored to
 * `~/.pi/ide/<cwd-hash>.state.json` so other extensions (e.g. a status bar) can
 * render the current file/selection without talking to the socket.
 *
 * Protocol (newline-delimited JSON, editor -> pi):
 *   {"type":"state","file":"src/x.ts","startLine":10,"endLine":20,
 *    "selectedText":"...","languageId":"typescript"}
 *   {"type":"clear"}   // active editor has no selection
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";

interface IdeState {
  file?: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
  languageId?: string;
}

const IDE_DIR = join(homedir(), ".pi", "ide");

export function cwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function ideSnapshotPath(cwd: string): string {
  return join(IDE_DIR, `${cwdHash(cwd)}.state.json`);
}

export function publicIdeSnapshot(state: IdeState): IdeState {
  return {
    file: state.file,
    startLine: state.startLine,
    endLine: state.endLine,
    languageId: state.languageId,
  };
}

function lineRange(state: IdeState): string | undefined {
  if (state.startLine == null) return undefined;
  if (state.endLine == null || state.endLine === state.startLine) return `${state.startLine}`;
  return `${state.startLine}-${state.endLine}`;
}

/** Header like `src/x.ts:10-20`, or just the path, or undefined. */
function fileRef(state: IdeState): string | undefined {
  if (!state.file) return undefined;
  const range = lineRange(state);
  return range ? `${state.file}:${range}` : state.file;
}

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let ctx: ExtensionContext | undefined;
  let state: IdeState = {};
  let sockPath: string | undefined;
  let regPath: string | undefined;
  let statePath: string | undefined;

  const writeSharedState = () => {
    if (!statePath) return;
    const snapshot = publicIdeSnapshot(state);
    if (!snapshot.file) {
      try {
        unlinkSync(statePath);
      } catch {
        // already gone
      }
      return;
    }
    try {
      writeFileSync(statePath, JSON.stringify(snapshot));
    } catch (err: any) {
      process.stderr.write(`[ide-bridge] state write failed: ${err?.message}\n`);
    }
  };

  // Right-aligned indicator below the editor, e.g. `IDE  src/foo.ts:10-20`.
  const renderWidget = () => {
    const ref = fileRef(state);
    if (!ref) {
      ctx?.ui.setWidget("ide-bridge", undefined);
      return;
    }
    ctx?.ui.setWidget(
      "ide-bridge",
      (_tui: any, theme: Theme) => ({
        invalidate: () => {},
        render: (width: number) => {
          const plain = `IDE  ${ref}`;
          const pad = Math.max(0, width - plain.length);
          const colored = theme.fg("accent", "IDE") + theme.fg("borderMuted", `  ${ref}`);
          return [" ".repeat(pad) + colored];
        },
      }),
      { placement: "belowEditor" },
    );
  };

  const cleanup = () => {
    server?.close();
    server = undefined;
    for (const p of [sockPath, regPath, statePath]) {
      if (!p) continue;
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    }
  };

  pi.on("session_start", async (_event, eventCtx) => {
    ctx = eventCtx;
    cleanup();
    state = {};

    const hash = cwdHash(eventCtx.cwd);
    sockPath = join(IDE_DIR, `${hash}.sock`);
    regPath = join(IDE_DIR, `${hash}.json`);
    statePath = ideSnapshotPath(eventCtx.cwd);

    try {
      mkdirSync(IDE_DIR, { recursive: true });
      unlinkSync(sockPath); // clear stale socket from a crashed run
    } catch {
      // dir exists / no stale socket
    }

    server = createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "clear") {
              state = {};
            } else if (msg.type === "state") {
              state = {
                file: msg.file,
                startLine: msg.startLine,
                endLine: msg.endLine,
                selectedText: msg.selectedText,
                languageId: msg.languageId,
              };
            }
            writeSharedState();
            renderWidget();
          } catch (err: any) {
            process.stderr.write(`[ide-bridge] bad message: ${err?.message}\n`);
          }
        }
      });
    });

    server.on("error", (err) => {
      process.stderr.write(`[ide-bridge] socket error: ${err.message}\n`);
    });

    server.listen(sockPath, () => {
      try {
        writeFileSync(
          regPath!,
          JSON.stringify({ cwd: eventCtx.cwd, socket: sockPath, pid: process.pid }),
        );
      } catch (err: any) {
        process.stderr.write(`[ide-bridge] registry write failed: ${err?.message}\n`);
      }
    });
  });

  // Expand @selection / @file from the cached IDE state at submit time.
  pi.on("input", async (event) => {
    if (!/@selection\b|@file\b/.test(event.text)) return;

    let text = event.text;

    if (/@selection\b/.test(text)) {
      const ref = fileRef(state);
      let block: string;
      if (ref && state.selectedText) {
        const lang = state.languageId ?? "";
        block = `<selection ${ref}>\n\`\`\`${lang}\n${state.selectedText}\n\`\`\`\n</selection>`;
      } else if (ref) {
        block = `<selection ${ref} />`;
      } else {
        block = "(no active IDE selection)";
      }
      text = text.replace(/@selection\b/g, block);
    }

    if (/@file\b/.test(text)) {
      text = text.replace(/@file\b/g, state.file ?? "(no active IDE file)");
    }

    return { action: "transform", text };
  });

  pi.on("session_shutdown", async () => {
    ctx?.ui.setWidget("ide-bridge", undefined);
    cleanup();
  });
}
