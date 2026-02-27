# Agent context (remote-development-environment)

Node.js web terminal: bash in a PTY via **node-pty**, rendered in the browser with **xterm.js**. Sessions are shared between web and CLI. Optional port-forwarding over a separate WebSocket path.

## Layout

- **server.js** – Express server, WebSocket (ws). Path-based upgrade: `/tunnel` → tunnel handler (binary protocol, TCP bridge), else → terminal handler. Session map by UUID; one PTY per session; multiple clients can attach. `GET /api/sessions`. CLI: `-p/--port`, `-H/--host`, `--all` (bind 0.0.0.0), `-h/--help`.
- **connect.js** – CLI client: `node connect.js [host[:port]] [session]`. Uses `?session=<id|new>&client=cli`. Options: `--list`/`-l`, `--resize`, `-h/--help`. Ctrl+^ d detach; Ctrl+D sends to PTY (session can exit).
- **tunnel.py** – Port-forwarding client: WebSocket to `/tunnel`, binary protocol (open/data/close), reconnect. Usage: `[host:port] port1 [port2 ...]`.
- **public/** – **index.html**: xterm.css, viewport/overscroll (no pull-to-refresh), toast, fixed keyboard grid. **app.js**: WebSocket, session from `?session=`, reconnection (toast only; code 4001 = session closed, no reconnect), sessions/toolbox menus, modifiers (Ctrl/Alt/Shift/Meta), toolbox keys grid, fixed keyboard with key repeat and menu buttons in grid (row1: Left menu | Esc, Tab, Shift, ↑, Supr, PgUp, ⌫; row2: Right menu | Ctrl, Alt, ←, ↓, →, PgDn, Enter). Terminal scroll: `touch-action: pan-y` on xterm viewport; no `visualViewport.scroll` → resize to avoid breaking scroll. Fit + refresh on reconnect.

## Sessions

- UUID; `?session=new` or omit = last or new. Web and CLI share session by UUID.
- **Closing:** Only when PTY exits (e.g. Ctrl+D). Server closes client connections with **code 4001, reason 'session closed'**. Browser shows toast "Session closed." and clears session from URL (no reconnect). CLI exits on close.
- Server logs: new session, session closed (exitCode/signal), connection opened/closed (browser/cmd).

## Stack

- **Server:** express, node-pty, ws
- **Client:** xterm.js, xterm-addon-fit (CDN), no build step
