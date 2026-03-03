const express = require('express');
const net = require('net');
const { spawn } = require('node-pty');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { parse } = require('url');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const AUTH_DATA_FILENAME = 'auth-data.json';

function parseArgs() {
  const args = process.argv.slice(2);
  let port = process.env.PORT || 3847;
  let host = '127.0.0.1';
  let noAuth = false;
  let setupPasskey = false;
  let dataDir = process.cwd();
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
    } else if (a === '--no-auth') {
      noAuth = true;
    } else if (a === '--setup-passkey') {
      setupPasskey = true;
    } else if (a === '--data-dir') {
      const v = args[++i];
      if (v) dataDir = path.resolve(v);
    } else if (a === '-h' || a === '--help') {
      console.log(`
Usage: node server.js [options]

Options:
  -p, --port <number>   Port to listen on (default: 3847 or PORT env)
  -H, --host <address>  Host to bind: 127.0.0.1 (local only), 0.0.0.0 (all interfaces), or an IP
  --all                 Shorthand for --host 0.0.0.0 (listen on all interfaces / local network)
  --no-auth             Run without authentication (no passkey or token required)
  --setup-passkey       Web UI only for passkey registration (no terminal access)
  --data-dir <path>     Directory for auth data and PTY cwd (default: current working directory)
  -h, --help            Show this help

Examples:
  node server.js --port 8080
  node server.js --all
  node server.js --data-dir ./data
  node server.js --setup-passkey --data-dir ./data
`);
      process.exit(0);
    }
  }
  return { port, host, noAuth, setupPasskey, dataDir };
}

const { port: PORT, host: HOST, noAuth: AUTH_DISABLED, setupPasskey: SETUP_PASSKEY, dataDir: DATA_DIR } = parseArgs();
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser());

const sessions = new Map();
let lastSessionId = null;

// --- Auth storage (JSON file in DATA_DIR) ---
function getAuthDataPath() {
  return path.join(DATA_DIR, AUTH_DATA_FILENAME);
}

function loadAuthData() {
  const filePath = getAuthDataPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.credentials)) data.credentials = [];
    if (!data.tokens || typeof data.tokens !== 'object') data.tokens = {};
    if (!data.sessionSecret || typeof data.sessionSecret !== 'string') {
      data.sessionSecret = crypto.randomBytes(32).toString('hex');
      saveAuthData(data);
    }
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') {
      const data = {
        credentials: [],
        tokens: {},
        sessionSecret: crypto.randomBytes(32).toString('hex'),
      };
      saveAuthData(data);
      return data;
    }
    throw e;
  }
}

function saveAuthData(data) {
  const filePath = getAuthDataPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_) {}
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let authData = null;
function getAuthData() {
  if (!authData) authData = loadAuthData();
  return authData;
}

function refreshAuthData() {
  authData = loadAuthData();
  return authData;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function addToken(token) {
  const data = getAuthData();
  data.tokens[tokenHash(token)] = { createdAt: new Date().toISOString() };
  saveAuthData(data);
}

function validateToken(token) {
  if (!token || typeof token !== 'string') return false;
  const data = getAuthData();
  return Object.prototype.hasOwnProperty.call(data.tokens, tokenHash(token));
}

const SESSION_COOKIE_NAME = 'terminal_session';
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function signSession(payload) {
  const data = getAuthData();
  const payloadStr = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', data.sessionSecret).update(payloadStr).digest('hex');
  return Buffer.from(payloadStr + '.' + sig).toString('base64url');
}

function verifySession(cookieValue) {
  if (!cookieValue) return null;
  try {
    const decoded = Buffer.from(cookieValue, 'base64url').toString('utf8');
    const dot = decoded.indexOf('.');
    if (dot === -1) return null;
    const payloadStr = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    const data = getAuthData();
    const expected = crypto.createHmac('sha256', data.sessionSecret).update(payloadStr).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(payloadStr);
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function getCookie(req, name) {
  if (req.cookies && req.cookies[name]) return req.cookies[name];
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const match = new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)').exec(raw);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function getClientAuth(req) {
  const cookie = getCookie(req, SESSION_COOKIE_NAME);
  if (cookie) {
    const session = verifySession(cookie);
    if (session) return { type: 'session', session };
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (validateToken(token)) return { type: 'token' };
  }
  const { query } = parse(req.url || '', true);
  const tokenFromQuery = query && query.token;
  if (tokenFromQuery && validateToken(tokenFromQuery)) return { type: 'token' };
  return null;
}

function requireAuth(req, res, next) {
  if (AUTH_DISABLED) return next();
  const auth = getClientAuth(req);
  if (auth) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function getRpId(req) {
  const host = req.headers.host || '';
  const rpId = host.split(':')[0] || 'localhost';
  return rpId;
}

function getOrigin(req) {
  // Prefer Origin/Referer from the client so we match what the browser sends in WebAuthn (e.g. with port)
  const originHeader = req.headers.origin;
  if (originHeader && /^https?:\/\//i.test(originHeader)) return originHeader;
  const referer = req.headers.referer;
  if (referer) {
    try {
      const u = new URL(referer);
      return u.origin;
    } catch (_) {}
  }
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const hostname = hostHeader.split(':')[0];
  const portFromHeader = req.headers['x-forwarded-port'] || (hostHeader.includes(':') ? hostHeader.split(':')[1] : null);
  const port = portFromHeader || (proto === 'https' ? '443' : '80');
  const defaultPort = proto === 'https' ? '443' : '80';
  if (port === defaultPort) return `${proto}://${hostname}`;
  return `${proto}://${hostname}:${port}`;
}

// Auth state for frontend
app.get('/api/auth-state', (req, res) => {
  const authRequired = !AUTH_DISABLED;
  const setupMode = SETUP_PASSKEY;
  const loggedIn = !!getClientAuth(req);
  const hasCredentials = (getAuthData().credentials || []).length > 0;
  res.json({ authRequired, setupMode, loggedIn, hasCredentials });
});

// In-memory challenge store (keyed by challenge so we can look up in verify)
const pendingChallenges = new Map();

// WebAuthn: registration options
app.post('/api/webauthn/register/options', async (req, res) => {
  if (AUTH_DISABLED) return res.status(400).json({ error: 'Auth disabled' });
  const rpId = getRpId(req);
  const origin = getOrigin(req);
  const options = await generateRegistrationOptions({
    rpName: 'Terminal',
    rpID: rpId === '0.0.0.0' ? 'localhost' : rpId,
    userID: crypto.randomBytes(32),
    userName: 'user',
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  pendingChallenges.set(options.challenge, { type: 'register' });
  setTimeout(() => pendingChallenges.delete(options.challenge), 5 * 60 * 1000);
  res.json(options);
});

// WebAuthn: verify registration and save credential
app.post('/api/webauthn/register/verify', async (req, res) => {
  if (AUTH_DISABLED) return res.status(400).json({ error: 'Auth disabled' });
  const { body } = req;
  const rpId = getRpId(req);
  const origin = getOrigin(req);
  let expectedChallenge = null;
  if (body.response && body.response.clientDataJSON) {
    try {
      const cd = JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url').toString());
      if (cd.challenge && pendingChallenges.has(cd.challenge)) expectedChallenge = cd.challenge;
    } catch (_) {}
  }
  if (!expectedChallenge) return res.status(400).json({ error: 'No challenge' });
  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId === '0.0.0.0' ? 'localhost' : rpId,
    });
    pendingChallenges.delete(expectedChallenge);
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }
    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    const data = getAuthData();
    data.credentials = data.credentials || [];
    data.credentials.push({
      id: Buffer.from(credentialID).toString('base64url'),
      publicKey: Buffer.from(credentialPublicKey).toString('base64'),
      counter: counter || 0,
    });
    saveAuthData(data);
    res.json({ ok: true });
  } catch (e) {
    if (expectedChallenge) pendingChallenges.delete(expectedChallenge);
    res.status(400).json({ error: e.message || 'Verification failed' });
  }
});

// WebAuthn: authentication options
app.post('/api/webauthn/login/options', async (req, res) => {
  if (AUTH_DISABLED) return res.status(400).json({ error: 'Auth disabled' });
  const data = getAuthData();
  const credentials = (data.credentials || []).map((c) => ({
    id: Buffer.from(c.id, 'base64url'),
    transports: c.transports,
  }));
  const rpId = getRpId(req);
  const options = await generateAuthenticationOptions({
    rpID: rpId === '0.0.0.0' ? 'localhost' : rpId,
    allowCredentials: credentials.length ? credentials : undefined,
  });
  pendingChallenges.set(options.challenge, { type: 'login' });
  setTimeout(() => pendingChallenges.delete(options.challenge), 5 * 60 * 1000);
  res.json(options);
});

// WebAuthn: verify authentication and set session cookie
app.post('/api/webauthn/login/verify', async (req, res) => {
  if (AUTH_DISABLED) return res.status(400).json({ error: 'Auth disabled' });
  const { body } = req;
  const rpId = getRpId(req);
  const origin = getOrigin(req);
  let expectedChallenge = null;
  if (body.response && body.response.clientDataJSON) {
    try {
      const cd = JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url').toString());
      if (cd.challenge && pendingChallenges.has(cd.challenge)) expectedChallenge = cd.challenge;
    } catch (_) {}
  }
  if (!expectedChallenge) return res.status(400).json({ error: 'No challenge' });
  const data = getAuthData();
  const storedCreds = data.credentials || [];
  const credentialIdStr = body.id || body.rawId;
  if (!credentialIdStr) {
    pendingChallenges.delete(expectedChallenge);
    return res.status(400).json({ error: 'Missing credential id' });
  }
  const stored = storedCreds.find((c) => c.id === credentialIdStr);
  if (!stored) {
    pendingChallenges.delete(expectedChallenge);
    return res.status(400).json({ error: 'Unknown credential' });
  }
  const credential = {
    id: stored.id,
    publicKey: Buffer.from(stored.publicKey, 'base64'),
    counter: stored.counter || 0,
  };
  try {
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId === '0.0.0.0' ? 'localhost' : rpId,
      credential,
    });
    pendingChallenges.delete(expectedChallenge);
    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
    const newCounter = verification.authenticationInfo?.newCounter ?? credential.counter;
    const idx = storedCreds.findIndex((c) => c.id === credentialIdStr);
    if (idx !== -1) {
      authData = getAuthData();
      authData.credentials[idx].counter = newCounter;
      saveAuthData(authData);
    }
    const payload = { id: crypto.randomUUID(), exp: Date.now() + SESSION_EXPIRY_MS };
    const cookieValue = signSession(payload);
    res.cookie(SESSION_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: SESSION_EXPIRY_MS,
      path: '/',
    });
    res.json({ ok: true });
  } catch (e) {
    pendingChallenges.delete(expectedChallenge);
    res.status(400).json({ error: e.message || 'Verification failed' });
  }
});

// Generate CLI token (requires auth; disabled when --no-auth)
app.post('/api/token', (req, res) => {
  if (AUTH_DISABLED) return res.status(400).json({ error: 'Auth disabled' });
  if (!getClientAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const token = crypto.randomBytes(32).toString('base64url');
  addToken(token);
  res.json({ token });
});

app.get('/api/sessions', requireAuth, (_req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, createdAt: new Date(s.createdAt).toISOString(), name: s.name || '' });
  }
  res.json(list);
});

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, HOST, () => {
  const network = HOST === '0.0.0.0' ? 'all interfaces (0.0.0.0)' : HOST;
  console.log(`Listening on port ${PORT} (${network})`);
  console.log(`Auth required: ${AUTH_DISABLED ? 'no' : 'yes'}`);
  console.log(`CWD (data dir): ${DATA_DIR}`);
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
  const auth = getClientAuth(req);
  const authRequired = !AUTH_DISABLED && (pathname === '/tunnel' || pathname === '/' || pathname === '');
  if (authRequired && !auth) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
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
    cwd: DATA_DIR,
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
