#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const flags = ['--list', '-l', '--resize', '--help', '-h'];
let tokenValue = process.env.TERMINAL_TOKEN || '';
const rawArgs = process.argv.slice(2);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--token') {
    if (i + 1 < rawArgs.length) tokenValue = rawArgs[++i];
    continue;
  }
  if (a.startsWith('--token=')) {
    tokenValue = a.slice(7);
    continue;
  }
  if (flags.includes(a)) continue;
  positional.push(a);
}
const doHelp = process.argv.includes('--help') || process.argv.includes('-h');
const doList = process.argv.includes('--list') || process.argv.includes('-l');
const doResize = process.argv.includes('--resize');

function looksLikeServer(s) {
  if (!s || s === 'new') return false;
  if (s.includes(':')) return true;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(s)) return false;
  return true;
}

let serverSpec = null;
let sessionParam = '';
if (positional.length >= 2) {
  serverSpec = positional[0];
  sessionParam = positional[1];
} else if (positional.length === 1) {
  if (looksLikeServer(positional[0])) {
    serverSpec = positional[0];
  } else {
    sessionParam = positional[0];
  }
}

const DEFAULT_PORT = '3847';
let baseUrl = process.env.TERMINAL_URL || 'ws://localhost:' + DEFAULT_PORT;
if (serverSpec) {
  const host = serverSpec.includes(':') ? serverSpec.slice(0, serverSpec.indexOf(':')) : serverSpec;
  const port = serverSpec.includes(':') ? serverSpec.slice(serverSpec.indexOf(':') + 1) : DEFAULT_PORT;
  baseUrl = `ws://${host}:${port}`;
}

const help = `
Usage: connect [options] [host[:port]] [session]

Attach to a terminal session (shared with the web UI). If session is omitted,
attaches to the last used session or creates a new one.

Arguments:
  host[:port]   Server host and optional port (default port 3847)
  session       Session UUID to attach to, or "new" to create a new session

Options:
  -l, --list     List active session IDs and exit (no TTY required)
  --resize       Reset PTY size to current terminal dimensions on connect
  --token <t>    Auth token; use --token=VAL or TERMINAL_TOKEN; required if server uses auth
  -h, --help     Show this help

Key bindings (while attached):
  Ctrl+^ d     Detach (disconnect, session stays open)
  Ctrl+^ r     Resize (send current terminal size to PTY)

Environment:
  TERMINAL_URL   WebSocket URL of the server (default: ws://localhost:3847)
  TERMINAL_TOKEN Auth token when server uses passkey/token auth

Examples:
  connect                        # last session, or new
  connect new                    # new session
  connect 192.168.1.1:3847 new  # server and new session
  connect localhost  <uuid>      # server and session
  connect --list                 # list sessions
  connect --resize new           # new session and reset PTY size
  connect --token <token> new    # connect with auth token
`;

if (doHelp) {
  process.stdout.write(help.trim() + '\n');
  process.exit(0);
}

if (doList) {
  const apiUrl = baseUrl.replace(/^ws/, 'http').replace(/^wss/, 'https');
  const u = new URL('/api/sessions', apiUrl);
  if (tokenValue) u.searchParams.set('token', tokenValue);
  const opts = { headers: {} };
  if (tokenValue) opts.headers.Authorization = 'Bearer ' + tokenValue;
  const client = u.protocol === 'https:' ? https : http;
  client.get(u.toString(), opts, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const list = JSON.parse(body);
        if (list.length === 0) {
          process.stdout.write('No sessions.\n');
        } else {
          list.forEach((s) => {
            const name = (s.name || '').replace(/\t/g, ' ').trim() || '-';
            process.stdout.write(`${s.id}\t${s.createdAt}\t${name}\n`);
          });
        }
      } catch (_) {
        process.stderr.write('Failed to parse sessions.\n');
        process.exit(1);
      }
    });
  }).on('error', (err) => {
    process.stderr.write('Error: ' + err.message + '\n');
    process.exit(1);
  });
  return;
}

if (!process.stdin.isTTY) {
  console.error('Stdin is not a TTY. Run from a terminal.');
  process.exit(1);
}

const sep = baseUrl.includes('?') ? '&' : '?';
let url = `${baseUrl}${sep}session=${encodeURIComponent(sessionParam)}&client=cli`;
if (tokenValue) url += '&token=' + encodeURIComponent(tokenValue);

const ws = new WebSocket(url);

let raw = false;
let sessionReceived = false;

const PREFIX_BYTE = 0x1e;
const PREFIX_TIMEOUT_MS = 400;
let prefixPending = false;
let prefixTimeout = null;

function sendResize() {
  const { rows, columns } = process.stdout;
  if (ws.readyState === WebSocket.OPEN && rows != null && columns != null) {
    ws.send('\x01' + JSON.stringify({ type: 'resize', cols: columns, rows }));
  }
}

function clearPrefix() {
  prefixPending = false;
  if (prefixTimeout) {
    clearTimeout(prefixTimeout);
    prefixTimeout = null;
  }
}

function restoreStdin() {
  clearPrefix();
  if (raw && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  process.exit(0);
}

ws.on('open', () => {
  raw = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  if (doResize) sendResize();

  process.stdin.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let i = 0;
    while (i < buf.length) {
      if (prefixPending) {
        const b = buf[i++];
        clearPrefix();
        if (b === 0x64 || b === 0x44) {
          ws.close();
          return;
        }
        if (b === 0x72 || b === 0x52) {
          sendResize();
          if (i < buf.length) ws.send(buf.slice(i));
          return;
        }
        ws.send(Buffer.from([PREFIX_BYTE, b]));
        if (i < buf.length) ws.send(buf.slice(i));
        return;
      }
      if (buf[i] === PREFIX_BYTE) {
        i++;
        if (i >= buf.length) {
          prefixPending = true;
          prefixTimeout = setTimeout(() => {
            if (prefixPending) {
              prefixPending = false;
              if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([PREFIX_BYTE]));
            }
            prefixTimeout = null;
          }, PREFIX_TIMEOUT_MS);
          return;
        }
        const b = buf[i++];
        if (b === 0x64 || b === 0x44) {
          ws.close();
          return;
        }
        if (b === 0x72 || b === 0x52) {
          sendResize();
          if (i < buf.length) ws.send(buf.slice(i));
          return;
        }
        ws.send(Buffer.from([PREFIX_BYTE, b]));
        continue;
      }
      const next = buf.indexOf(PREFIX_BYTE, i);
      const end = next === -1 ? buf.length : next;
      if (end > i) ws.send(buf.slice(i, end));
      i = end;
    }
  });
});

ws.on('message', (data) => {
  const str = data.toString();
  if (str.endsWith('\n')) {
    try {
      const msg = JSON.parse(str.trim());
      if (msg.type === 'session' && msg.id) {
        sessionReceived = true;
        process.stderr.write(`Session: ${msg.id}\n`);
        return;
      }
      if (msg.type === 'replay' && msg.data) {
        try {
          process.stdout.write(Buffer.from(msg.data, 'base64'));
        } catch (_) {}
        return;
      }
    } catch (_) {}
  }
  sessionReceived = true;
  process.stdout.write(data);
});

ws.on('close', () => {
  restoreStdin();
});

ws.on('error', (err) => {
  console.error('Connection error:', err.message);
  restoreStdin();
});

process.on('SIGWINCH', sendResize);

process.on('SIGINT', restoreStdin);
process.on('SIGTERM', restoreStdin);
