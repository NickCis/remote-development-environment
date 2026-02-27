const express = require('express');
const net = require('net');
const { spawn } = require('node-pty');
const { WebSocketServer } = require('ws');
const path = require('path');
const { parse } = require('url');
const crypto = require('crypto');

function parseArgs() {
  const args = process.argv.slice(2);
  let port = process.env.PORT || 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--port') {
      const v = args[++i];
      if (v != null) port = parseInt(v, 10) || port;
    } else if (a === '-H' || a === '--host') {
      const v = args[++i];
      if (v === 'all' || v === '0' || v === '0.0.0.0') host = '0.0.0.0';
      else if (v) host = v;
    } else if (a === '--all') {
      host = '0.0.0.0';
    } else if (a === '-h' || a === '--help') {
      console.log(`
Usage: node server.js [options]

Options:
  -p, --port <number>   Port to listen on (default: 3000 or PORT env)
  -H, --host <address>  Host to bind: 127.0.0.1 (local only), 0.0.0.0 (all interfaces), or an IP
  --all                 Shorthand for --host 0.0.0.0 (listen on all interfaces / local network)
  -h, --help            Show this help

Examples:
  node server.js --port 8080
  node server.js --all
  node server.js --host 0.0.0.0 -p 3000
`);
      process.exit(0);
    }
  }
  return { port, host };
}

const { port: PORT, host: HOST } = parseArgs();
const app = express();
app.set('trust proxy', true);

const sessions = new Map();
let lastSessionId = null;

app.get('/api/sessions', (_req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, createdAt: new Date(s.createdAt).toISOString(), name: s.name || '' });
  }
  res.json(list);
});

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, HOST, () => {
  const addr = HOST === '0.0.0.0' ? `http://0.0.0.0:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server running at ${addr}`);
});

const wss = new WebSocketServer({ noServer: true });
const tunnelWss = new WebSocketServer({ noServer: true });

const MAX_TUNNEL_CHANNELS = 256;
const MAX_SCROLLBACK_BYTES = 200 * 1024;

function appendToScrollback(session, data) {
  const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  session.outputBuffer = Buffer.concat([session.outputBuffer, chunk]);
  if (session.outputBuffer.length > MAX_SCROLLBACK_BYTES) {
    session.outputBuffer = session.outputBuffer.subarray(session.outputBuffer.length - MAX_SCROLLBACK_BYTES);
  }
}

server.on('upgrade', (req, socket, head) => {
  const pathname = parse(req.url || '').pathname;
  if (pathname === '/tunnel') {
    tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      tunnelWss.emit('connection', ws, req);
    });
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getClientIp(req, socket) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'].trim();
  if (req.headers['cf-connecting-ip']) return req.headers['cf-connecting-ip'].trim();
  return socket && socket.remoteAddress ? socket.remoteAddress : '?';
}

function createPty(cols, rows) {
  return spawn(process.env.SHELL || 'bash', [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.cwd(),
    env: process.env,
  });
}

function getOrCreateSession(sessionParam) {
  let id;

  if (sessionParam === 'new') {
    id = crypto.randomUUID();
    const pty = createPty(80, 24);
    const clients = new Set();
    const createdAt = Date.now();
    const session = { pty, clients, createdAt, name: '', titleBuffer: '', outputBuffer: Buffer.alloc(0) };
    sessions.set(id, session);
    lastSessionId = id;
    log(`New session created: ${id}`);

    pty.onData((data) => {
      appendToScrollback(session, data);
      clients.forEach((ws) => {
        if (ws.readyState === 1) ws.send(data);
      });
      session.titleBuffer += data;
      const oscTitleRe = /\x1b\](?:0|2);([^\x07]*)\x07/g;
      let m;
      while ((m = oscTitleRe.exec(session.titleBuffer)) !== null) session.name = m[1];
      const lastBel = session.titleBuffer.lastIndexOf('\x07');
      if (lastBel >= 0) session.titleBuffer = session.titleBuffer.slice(lastBel + 1);
      else {
        const lastOsc = session.titleBuffer.lastIndexOf('\x1b]');
        if (lastOsc >= 0) session.titleBuffer = session.titleBuffer.slice(lastOsc);
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      const reason = signal ? `signal ${signal}` : `exitCode ${exitCode}`;
      log(`Session closed: ${id}, reason: ${reason}`);
      clients.forEach((ws) => ws.close(4001, 'session closed'));
      clients.clear();
      sessions.delete(id);
      if (lastSessionId === id) lastSessionId = null;
    });

    return { id, session };
  }

  if (sessionParam && sessions.has(sessionParam)) {
    id = sessionParam;
    lastSessionId = id;
    return { id, session: sessions.get(id) };
  }

  if (sessionParam && !sessions.has(sessionParam)) {
    id = sessionParam;
  } else if (lastSessionId && sessions.has(lastSessionId)) {
    id = lastSessionId;
  } else {
    id = crypto.randomUUID();
  }

  if (!sessions.has(id)) {
    const pty = createPty(80, 24);
    const clients = new Set();
    const createdAt = Date.now();
    const session = { pty, clients, createdAt, name: '', titleBuffer: '', outputBuffer: Buffer.alloc(0) };
    sessions.set(id, session);
    lastSessionId = id;
    log(`New session created: ${id}`);

    pty.onData((data) => {
      appendToScrollback(session, data);
      clients.forEach((ws) => {
        if (ws.readyState === 1) ws.send(data);
      });
      session.titleBuffer += data;
      const oscTitleRe = /\x1b\](?:0|2);([^\x07]*)\x07/g;
      let m;
      while ((m = oscTitleRe.exec(session.titleBuffer)) !== null) session.name = m[1];
      const lastBel = session.titleBuffer.lastIndexOf('\x07');
      if (lastBel >= 0) session.titleBuffer = session.titleBuffer.slice(lastBel + 1);
      else {
        const lastOsc = session.titleBuffer.lastIndexOf('\x1b]');
        if (lastOsc >= 0) session.titleBuffer = session.titleBuffer.slice(lastOsc);
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      const reason = signal ? `signal ${signal}` : `exitCode ${exitCode}`;
      log(`Session closed: ${id}, reason: ${reason}`);
      clients.forEach((ws) => ws.close(4001, 'session closed'));
      clients.clear();
      sessions.delete(id);
      if (lastSessionId === id) lastSessionId = null;
    });
  } else {
    lastSessionId = id;
  }

  return { id, session: sessions.get(id) };
}

wss.on('connection', (ws, req) => {
  const { query } = parse(req.url || '', true);
  const sessionParam = query && query.session;
  const clientType = query && query.client === 'cli' ? 'cmd' : 'browser';

  const { id, session } = getOrCreateSession(sessionParam);
  session.clients.add(ws);

  const clientIp = getClientIp(req, req.socket);
  log(`Connection opened: ${clientType}, session: ${id}, ip: ${clientIp}`);

  ws.send(JSON.stringify({ type: 'session', id }) + '\n');
  if (session.outputBuffer && session.outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'replay', data: session.outputBuffer.toString('base64') }) + '\n');
  }

  ws.on('message', (msg) => {
    if (!session.pty) return;
    if (Buffer.isBuffer(msg) && msg.length >= 1 && msg[0] === 0) {
      log('Terminal received tunnel protocol data; client may be using wrong path (use /tunnel for port forwarding)');
      ws.close();
      return;
    }
    const data = msg.toString();
    if (data.startsWith('\x01')) {
      let payload;
      try {
        payload = JSON.parse(data.slice(1));
      } catch (_) {
        return;
      }
      if (payload.type === 'resize' && payload.cols != null && payload.rows != null) {
        session.pty.resize(payload.cols, payload.rows);
      }
    } else {
      session.pty.write(data);
    }
  });

  ws.on('close', () => {
    log(`Connection closed: ${clientType}, session: ${id}, ip: ${clientIp}`);
    session.clients.delete(ws);
  });
});

function sendTunnelClose(ws, channelId) {
  if (ws.readyState !== 1) return;
  const buf = Buffer.allocUnsafe(5);
  buf[0] = 2;
  buf.writeUInt32BE(channelId, 1);
  ws.send(buf);
}

function sendTunnelData(ws, channelId, data) {
  if (ws.readyState !== 1) return;
  const len = data.length;
  if (len > 65535) return;
  const buf = Buffer.allocUnsafe(7 + len);
  buf[0] = 1;
  buf.writeUInt32BE(channelId, 1);
  buf.writeUInt16BE(len, 5);
  data.copy(buf, 7);
  ws.send(buf);
}

tunnelWss.on('connection', (ws, req) => {
  const channels = new Map();
  const clientIp = getClientIp(req, req.socket);
  log(`Tunnel connection opened, ip: ${clientIp}`);

  ws.on('message', (msg) => {
    if (!Buffer.isBuffer(msg)) return;
    const buf = msg;
    if (buf.length < 5) return;
    const type = buf[0];
    const channelId = buf.readUInt32BE(1);
    if (type === 0) {
      if (channels.size >= MAX_TUNNEL_CHANNELS) return;
      if (buf.length < 7) return;
      const port = buf.readUInt16BE(5);
      const sock = net.connect(port, '127.0.0.1');
      channels.set(channelId, sock);
      sock.on('data', (data) => sendTunnelData(ws, channelId, data));
      sock.on('end', () => {
        channels.delete(channelId);
        sendTunnelClose(ws, channelId);
      });
      sock.on('error', () => {
        channels.delete(channelId);
        sendTunnelClose(ws, channelId);
      });
      sock.on('close', () => channels.delete(channelId));
    } else if (type === 1) {
      if (buf.length < 7) return;
      const len = buf.readUInt16BE(5);
      if (buf.length < 7 + len) return;
      const sock = channels.get(channelId);
      if (sock && sock.writable) sock.write(buf.subarray(7, 7 + len));
    } else if (type === 2) {
      const sock = channels.get(channelId);
      if (sock) sock.destroy();
      channels.delete(channelId);
    }
  });

  ws.on('close', () => {
    channels.forEach((sock) => sock.destroy());
    channels.clear();
    log(`Tunnel connection closed, ip: ${clientIp}`);
  });
});
