// pi IDE Bridge — VS Code publisher.
// Tracks the active file + selection and pushes them to a running pi session
// over the unix socket that pi's ide-bridge extension hosts.

const vscode = require("vscode");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const IDE_DIR = path.join(os.homedir(), ".pi", "ide");

// Must match the hashing in pi's ide-bridge.ts: sha256(cwd) -> first 16 hex.
function cwdHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function sockForHash(hash) {
  return path.join(IDE_DIR, `${hash}.sock`);
}

// Resolve which pi socket should receive state for the given file URI.
// Order: workspace-root hash -> home hash -> newest registry by mtime.
function resolveSocket(uri) {
  const candidates = [];

  if (uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const root = folder?.uri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (root) candidates.push(cwdHash(root));
  }
  candidates.push(cwdHash(os.homedir()));

  for (const hash of candidates) {
    const sock = sockForHash(hash);
    if (fs.existsSync(sock)) return sock;
  }

  // Fallback: most recently active pi (newest registry file).
  try {
    const regs = fs
      .readdirSync(IDE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(IDE_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (regs.length > 0) {
      const reg = JSON.parse(fs.readFileSync(regs[0].full, "utf8"));
      if (reg.socket && fs.existsSync(reg.socket)) return reg.socket;
    }
  } catch {
    // IDE_DIR may not exist yet (no pi running)
  }

  return undefined;
}

// Build the state payload for the active editor, or a clear signal.
function buildPayload(editor) {
  if (!editor) return { type: "clear" };

  const doc = editor.document;
  const sel = editor.selection;
  const file = vscode.workspace.asRelativePath(doc.uri, false);
  const languageId = doc.languageId;

  if (sel.isEmpty) {
    // Active file, no selection — mirror the file without a range/text.
    return { type: "state", file, languageId };
  }

  const startLine = sel.start.line + 1;
  // If the selection ends at column 0 of a later line, that line isn't really
  // selected — trim it so the range matches what the user sees highlighted.
  let endLine = sel.end.line + 1;
  if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    endLine = sel.end.line;
  }

  return {
    type: "state",
    file,
    startLine,
    endLine,
    selectedText: doc.getText(sel),
    languageId,
  };
}

function activate(context) {
  let lastSent;
  let timer;

  // Stateless: connect fresh per push. A persistent connection goes stale when
  // pi reloads (it unlinks + recreates the socket at the same path), and the
  // dead socket isn't reliably flagged, so writes silently vanish. Short-lived
  // connections are immune to pi restarts and cheap at debounced rates.
  const send = (sockPath, line) => {
    const socket = net.createConnection(sockPath);
    socket.on("error", () => socket.destroy()); // no pi listening / race
    socket.on("connect", () => socket.end(line + "\n"));
  };

  const push = (editor) => {
    const payload = buildPayload(editor);
    const uri = editor?.document?.uri;
    const sockPath = resolveSocket(uri);
    if (!sockPath) return; // no pi listening

    const line = JSON.stringify(payload);
    // Dedupe identical consecutive states (keyed on socket too, so switching
    // pis re-sends current state).
    const key = `${sockPath}\u0000${line}`;
    if (key === lastSent) return;
    lastSent = key;

    send(sockPath, line);
  };

  const schedule = (editor) => {
    const debounceMs = vscode.workspace.getConfiguration("piBridge").get("debounceMs", 120);
    clearTimeout(timer);
    timer = setTimeout(() => push(editor), debounceMs);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => schedule(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => schedule(editor)),
    { dispose: () => clearTimeout(timer) },
  );

  // Push current state on activation.
  schedule(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate };
