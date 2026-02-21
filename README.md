# Web Terminal (node-pty + xterm.js)

A small Node.js web app that runs bash in a PTY via `node-pty` and renders it in the browser with xterm.js.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

Then open http://localhost:3000 in your browser. You get a full bash session in the browser; resize the window and the PTY dimensions follow.

**Sessions (UUID)**  
Sessions are identified by a UUID and are shared between web and CLI.

- **Web:** Use `?session=<uuid>` to attach to a session, or `?session=new` to create a new one. If you omit `session`, you attach to the last used session (or a new one if none exists). The page URL updates to show the current session ID.
- **CLI:** Pass the session as an argument: `node connect.js <uuid>` to attach, or `node connect.js new` to create a new session. With no argument, attaches to the last session (or creates one). The script prints `Session: <uuid>` to stderr on connect.

Examples:

```bash
npm run connect              # last session, or new
npm run connect new          # new session
npm run connect abc-123      # attach to session abc-123
npm run connect --list       # list active session IDs (then exit)
npm run connect --resize     # connect and reset PTY size to terminal dimensions
npm run connect --resize new # new session and reset PTY size
```

Same session from the web: open `http://localhost:3000?session=abc-123`. Set `TERMINAL_URL=ws://host:port` if the server is not on localhost:3000.

**Web UI**

- **Sessions (≡, top left):** Opens a menu with "New session" and all active session IDs; click one to switch (page reloads into that session).
- **Toolbox (⌘, top right):** "Resize to screen" (set PTY size to current xterm size), modifier toggles (Ctrl, Alt, Meta) so the next key you type is modified (e.g. toggle Ctrl then type `c` for Ctrl+C), Esc/Tab/Enter/arrow buttons, and "Show keyboard" to show a bar of special keys below the terminal (handy on mobile).

## Stack

- **Server:** Express, `node-pty` (spawns bash), `ws` (WebSocket)
- **Client:** xterm.js + xterm-addon-fit, WebSocket to server
