#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const baseUrl = process.env.TERMINAL_URL || 'ws://localhost:3000';
const args = process.argv.slice(2);
const doHelp = args.includes('--help') || args.includes('-h');
const doList = args.includes('--list') || args.includes('-l');
const doResize = args.includes('--resize');
const sessionArg = args.filter((a) => !['--list', '-l', '--resize', '--help', '-h'].includes(a))[0];
const sessionParam = sessionArg === undefined ? '' : sessionArg;

const help = `
Usage: connect [options] [session]

Attach to a terminal session (shared with the web UI). If session is omitted,
attaches to the last used session or creates a new one.

Arguments:
  session    Session UUID to attach to, or "new" to create a new session

Options:
  -l, --list     List active session IDs and exit (no TTY required)
  --resize       Reset PTY size to current terminal dimensions on connect
  -h, --help     Show this help

Environment:
  TERMINAL_URL   WebSocket URL of the server (default: ws://localhost:3000)

Examples:
  connect                 # last session, or new
  connect new             # new session
  connect <uuid>          # attach to session
  connect --list          # list sessions
  connect --resize new    # new session and reset PTY size
`;

if (doHelp) {
  process.stdout.write(help.trim() + '\n');
  process.exit(0);
}

if (doList) {
  const apiUrl = baseUrl.replace(/^ws/, 'http').replace(/^wss/, 'https');
  const u = new URL('/api/sessions', apiUrl);
  const client = u.protocol === 'https:' ? https : http;
  client.get(u.toString(), (res) => {
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
const url = `${baseUrl}${sep}session=${encodeURIComponent(sessionParam)}&client=cli`;

const ws = new WebSocket(url);

let raw = false;
let sessionReceived = false;

function restoreStdin() {
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

  if (doResize) {
    const { rows, columns } = process.stdout;
    if (rows != null && columns != null) {
      ws.send('\x01' + JSON.stringify({ type: 'resize', cols: columns, rows }));
    }
  }

  process.stdin.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
});

ws.on('message', (data) => {
  const str = data.toString();
  if (!sessionReceived && str.endsWith('\n')) {
    try {
      const msg = JSON.parse(str.trim());
      if (msg.type === 'session' && msg.id) {
        sessionReceived = true;
        process.stderr.write(`Session: ${msg.id}\n`);
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

process.on('SIGWINCH', () => {
  const { rows, columns } = process.stdout;
  if (ws.readyState === WebSocket.OPEN && rows != null && columns != null) {
    ws.send('\x01' + JSON.stringify({ type: 'resize', cols: columns, rows }));
  }
});

process.on('SIGINT', restoreStdin);
process.on('SIGTERM', restoreStdin);
