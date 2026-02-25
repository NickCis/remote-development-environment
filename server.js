const express = require('express');
const net = require('net');
const { spawn } = require('node-pty');
const { WebSocketServer } = require('ws');
const path = require('path');
const { parse } = require('url');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

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

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });
const tunnelWss = new WebSocketServer({ noServer: true });

const MAX_TUNNEL_CHANNELS = 256;

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
    const session = { pty, clients, createdAt, name: '', titleBuffer: '' };
    sessions.set(id, session);
    lastSessionId = id;
    log(`New session created: ${id}`);

    pty.onData((data) => {
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
      clients.forEach((ws) => ws.close());
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
    const session = { pty, clients, createdAt, name: '', titleBuffer: '' };
    sessions.set(id, session);
    lastSessionId = id;
    log(`New session created: ${id}`);

    pty.onData((data) => {
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
      clients.forEach((ws) => ws.close());
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

  log(`Connection opened: ${clientType}, session: ${id}`);

  ws.send(JSON.stringify({ type: 'session', id }) + '\n');

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
    log(`Connection closed: ${clientType}, session: ${id}`);
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

tunnelWss.on('connection', (ws) => {
  const channels = new Map();
  log('Tunnel connection opened');

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
    log('Tunnel connection closed');
  });
});
