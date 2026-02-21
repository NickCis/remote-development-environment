const express = require('express');
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

const wss = new WebSocketServer({ server });

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
    const data = msg.toString();
    if (data.startsWith('\x01')) {
      const payload = JSON.parse(data.slice(1));
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
