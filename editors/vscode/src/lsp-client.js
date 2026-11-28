// [xihanzu-NR]
'use strict';

/**
 * A dependency-free LSP client over stdio.
 *
 * `hydra lsp` already speaks the protocol; what an editor needs is the framing,
 * request/response correlation, and a way to be told about pushes. That is all
 * this is. It deliberately does NOT know about VS Code: `extension.js` maps the
 * replies onto editor types, and the tests drive this class against the real
 * compiler binary with no editor in the loop.
 *
 * Why not `vscode-languageclient`: it is a dependency tree larger than this
 * whole extension for `Content-Length` headers and a switch statement. This file
 * is the same two things, and the .vsix stays installable on a machine with no
 * network.
 */

const { spawn } = require('node:child_process');

/** `Content-Length` framing. Bytes, not characters: a message with an emoji in
 *  it is longer than its string length, and getting that wrong desynchronises
 *  the stream rather than failing loudly. */
function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

class LspClient {
  /**
   * @param {object} options
   * @param {string} options.command  executable to run (`hydra`, or node for a .js shim)
   * @param {string[]} [options.args] arguments, `['lsp']` by default
   * @param {string} [options.cwd]
   * @param {object} [options.env]
   * @param {(params: object) => void} [options.onDiagnostics]
   * @param {(method: string, params: object) => void} [options.onNotification]
   * @param {(text: string) => void} [options.onStderr]
   * @param {(code: number|null, signal: string|null) => void} [options.onExit]
   * @param {number} [options.requestTimeoutMs] a hung server must not hang the editor
   */
  constructor(options) {
    this.command = options.command;
    this.args = options.args || ['lsp'];
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.onDiagnostics = options.onDiagnostics || (() => {});
    this.onNotification = options.onNotification || (() => {});
    this.onStderr = options.onStderr || (() => {});
    this.onExit = options.onExit || (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;

    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.exited = false;
    this.disposed = false;
    this.trace = false;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => this.#read(chunk));
    this.proc.stderr.on('data', (chunk) => this.onStderr(String(chunk)));
    // A server that died before we wrote leaves stdin closed, and an
    // unhandled EPIPE on that stream takes the whole extension host down with
    // it. The exit handler is where a dead server is reported.
    this.proc.stdin.on('error', (err) => this.onStderr(`stdin: ${err.message}\n`));
    this.proc.on('error', (err) => {
      this.#fail(err);
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.#rejectAll(new Error(`hydra lsp exited (${code ?? signal})`));
      this.onExit(code, signal);
    });
  }

  /** Send a request and resolve with its `result`, or reject with the server's
   *  error. The timeout is not paranoia: a server that stopped reading stdin
   *  would otherwise leave a promise pending forever behind a silent editor. */
  request(method, params) {
    if (!this.proc || this.exited) return Promise.reject(new Error('hydra lsp is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hydra lsp did not answer ${method} in ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    if (!this.proc || this.exited) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** Polite shutdown: `shutdown`, then `exit`, then SIGTERM if it lingers.
   *  Killing first is how a language server leaves a stale cache or a half
   *  written file behind. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.proc || this.exited) {
      this.#kill();
      return;
    }
    try {
      await Promise.race([
        this.request('shutdown'),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      this.notify('exit');
    } catch {
      /* a server that cannot answer is still a server we must stop */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.#kill();
  }

  #kill() {
    const proc = this.proc;
    this.proc = null;
    this.#rejectAll(new Error('hydra lsp disposed'));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  #write(message) {
    if (this.trace) this.onStderr(`--> ${JSON.stringify(message)}\n`);
    try {
      this.proc.stdin.write(frame(message));
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err) {
    this.#rejectAll(err);
    this.onStderr(`${err && err.message ? err.message : err}\n`);
  }

  #rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  #read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      const start = headerEnd + 4;
      if (!match) {
        // Not ours to interpret; drop the header and keep reading rather than
        // wedging the stream on a malformed message.
        this.buffer = this.buffer.slice(start);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < start + length) return;
      const body = this.buffer.slice(start, start + length).toString('utf8');
      this.buffer = this.buffer.slice(start + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (this.trace) this.onStderr(`<-- ${JSON.stringify(message)}\n`);

    // A response to something we sent.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || 'hydra lsp error'));
      else entry.resolve(message.result);
      return;
    }

    // A request FROM the server. Answering `null` is correct for the handful an
    // editor may receive (progress tokens, capability registration) and is far
    // better than leaving the server waiting on a reply it will never get.
    if (message.id !== undefined && message.method) {
      this.#write({ jsonrpc: '2.0', id: message.id, result: null });
      this.onNotification(message.method, message.params);
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics') {
      this.onDiagnostics(message.params || {});
      return;
    }
    if (message.method) this.onNotification(message.method, message.params);
  }
}

module.exports = { LspClient, frame };
