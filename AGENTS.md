# Agent context (pty-test)

Node.js web terminal: bash in a PTY via **node-pty**, rendered in the browser with **xterm.js**, shared sessions between web and CLI.

## Layout

- **server.js** – Express server, WebSocket (ws), session map by UUID, `GET /api/sessions`. Spawns one PTY per session; multiple clients can attach to the same session.
- **connect.js** – CLI client: `node connect.js [options] [session]`. Connects with `?session=<id|new>&client=cli`. Use `--list` / `-l` to list sessions, `--resize` to send resize on connect, `-h` / `--help` for help.
- **public/** – Static assets. **index.html** loads xterm.js (and fit addon) and sets up the page. **app.js** drives the terminal: WebSocket to server, session from `?session=`, session/toolbox menus, modifier keys, floating keyboard, viewport/positioning (visualViewport for mobile), fullscreen, auto-resize.

## Run

```bash
npm install
npm start   # http://localhost:3000
node connect.js [session]   # attach from CLI
```

## Sessions

- Identified by UUID. `?session=new` or `session=new` creates a new one; no param uses last or creates. Web and CLI share the same session when using the same UUID.
- Server logs: new session, session closed (exitCode/signal), connection opened/closed with type `browser` or `cmd` (CLI sends `client=cli`).

## Stack

- **Server:** express, node-pty, ws
- **Client:** xterm.js, xterm-addon-fit (CDN), no build step
