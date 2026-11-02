// [xihanzu-NR]
/**
 * Live reload for `hydra dev`, with no dependency.
 *
 * The dev server already rebuilds on every save (~1.2s on this box). What it
 * never did was tell the browser, so the loop was "save, wait, press F5". This
 * closes it: a websocket, a small client, and an overlay for a failed build.
 *
 * The websocket server is written here rather than pulled from npm because the
 * protocol is small and the alternative is a dependency in the toolchain for one
 * feature. Only what is used is implemented: the HTTP upgrade handshake, text
 * frames, and close. No fragmentation on send, no extensions, no binary.
 *
 * What this is NOT, stated plainly because the difference is real:
 *
 *   - It is not React Fast Refresh. A changed component reloads the PAGE, so
 *     component state is lost. Fast Refresh needs a babel transform and the
 *     react-refresh runtime wired into every component; that is a separate piece
 *     of work, and calling this "Fast Refresh" would be wrong.
 *   - A rebuild that FAILS does not reload the page: the last good build stays
 *     and an overlay says what broke, because reloading into a broken bundle
 *     loses the working page you were looking at.
 */

import crypto from 'node:crypto';

/** The websocket GUID from RFC 6455. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A minimal websocket server bound to an existing HTTP server.
 *
 * Returns `{ clients, broadcast, close }`. `broadcast(text)` sends to every open
 * client and silently drops the ones that have gone away, which is the only
 * error handling a dev server needs.
 */
export function attachSocketServer(httpServer, { path = '/__hydra/hmr' } = {}) {
  const clients = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const url = req.url || '';
    if (!url.startsWith(path)) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    clients.add(socket);
    const drop = () => clients.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
    // The client sends nothing this server needs, but an unread socket buffers.
    socket.on('data', (buf) => {
      // A close frame (opcode 0x8) means goodbye; anything else is ignored.
      if (buf.length > 0 && (buf[0] & 0x0f) === 0x8) {
        clients.delete(socket);
        socket.end();
      }
    });
  });

  return {
    get count() {
      return clients.size;
    },
    broadcast(text) {
      const payload = Buffer.from(text, 'utf8');
      // Server frames are unmasked, and the length goes in one of three shapes.
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const frame = Buffer.concat([header, payload]);
      for (const s of [...clients]) {
        try {
          s.write(frame);
        } catch {
          clients.delete(s);
        }
      }
    },
    close() {
      for (const s of [...clients]) {
        try {
          s.end();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
    },
  };
}

/**
 * The client, injected into `index.html` during `hydra dev`.
 *
 * A tiny websocket client and an overlay. The overlay is plain DOM so it works
 * before React has mounted — which is exactly when a build error happens.
 */
export const HMR_CLIENT = `// [xihanzu-NR]
(() => {
  var retry = 0;
  function overlay(msg) {
    var el = document.getElementById('__hydra_overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = '__hydra_overlay';
      el.style.cssText = 'position:fixed;inset:auto 0 0 0;max-height:45vh;overflow:auto;' +
        'background:#1a1a1a;color:#ff8080;font:12px/1.5 ui-monospace,Menlo,monospace;' +
        'padding:14px 16px;white-space:pre-wrap;z-index:2147483647;border-top:2px solid #ff5555';
      document.body.appendChild(el);
    }
    el.textContent = 'hydra: build failed\\n\\n' + msg;
  }
  function clearOverlay() {
    var el = document.getElementById('__hydra_overlay');
    if (el) el.remove();
  }
  function connect() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '__hydra/hmr');
    ws.onopen = () => { retry = 0; clearOverlay(); };
    ws.onmessage = (ev) => {
      var msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ok') { clearOverlay(); location.reload(); return; }
      if (msg.type === 'error') { overlay(msg.message || 'build failed'); return; }
      if (msg.type === 'building') { clearOverlay(); return; }
    };
    ws.onclose = () => {
      // Back off, then try again: the dev server restarts on a config change and
      // a client that gives up after one failure is worse than none.
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 250 * retry);
    };
  }
  connect();
})();
`;

/**
 * Put the client into an HTML string, once.
 *
 * Before `</body>` rather than `</head>` so the overlay's parent exists by the
 * time the script runs.
 */
export function injectHmrClient(html, path = '/__hydra/hmr') {
  if (html.includes('__hydra/hmr')) return html;
  const tag = `<script>${HMR_CLIENT.replace('/__hydra/hmr', path)}</script>`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `  ${tag}\n  </body>`);
  }
  return html + tag;
}
