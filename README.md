# remote-development-environment

A small Node.js web app (node-pty + xterm.js) that runs bash in a PTY and renders it in the browser. Optional passkey (WebAuthn) login and CLI token auth for exposing the service securely.

## Installation (Ubuntu server)

**Requirements:** Node.js (LTS 18+). On Ubuntu:

```bash
sudo apt update && sudo apt install nodejs npm
```

Or use [NodeSource](https://github.com/nodesource/distributions) / [nvm](https://github.com/nvm-sh/nvm) for a recent Node version.

**Install the app:**

```bash
cd /path/to/remote-development-environment
chmod +x install.sh   # if needed after clone
./install.sh
```

This runs `npm install` in the project directory.

**Run as a systemd user service** (so it keeps running under your user, survives reboots when you use linger):

```bash
./install.sh --systemd
# Or install in a specific directory and set up the service:
./install.sh /home/you/repos/remote-development-environment --systemd
```

Then enable and start the service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now remote-development-environment
```

To have the service run when the server is up but no one is logged in:

```bash
loginctl enable-linger $USER
```

Useful commands:

- `systemctl --user status remote-development-environment`
- `journalctl --user -u remote-development-environment -f`

By default the install script uses your home directory (`$HOME`) for auth and PTY cwd. Override with `DATA_DIR` to use another path:

```bash
DATA_DIR=/path/to/custom/data ./install.sh --systemd
```

---

## Authentication

The server can run **with or without** authentication.

### Without auth (development / local only)

```bash
node server.js --no-auth
```

No passkey or token is required. Anyone who can reach the server can use the terminal.

### With auth (exposed server)

When you run **without** `--no-auth`, the server expects either:

1. **Browser:** sign in with a **passkey** (WebAuthn). After login you get a session cookie and can use the web terminal.
2. **CLI / tunnel:** use a **token** (see “CLI token” below). The token is sent via `--token` or `TERMINAL_TOKEN`.

**First-time setup (create a passkey):**

1. Run the server in setup mode (web UI is only for registering a passkey):

   ```bash
   node server.js --setup-passkey --data-dir ./data --all
   ```

2. Open the app in the browser. You’ll see “Register passkey”. Click **Create passkey** and complete the flow (e.g. Touch ID, Windows Hello, or a security key).
3. After “Passkey created”, stop the server and run it **without** `--setup-passkey`:

   ```bash
   node server.js --data-dir ./data --all
   ```

**Normal use (browser):**

1. Open the app in the browser.
2. You’ll see “Sign in”. Click **Sign in with passkey** and authenticate.
3. You’re in the terminal. Sessions work as described below.

**CLI token (for `connect.js` and `tunnel.py`):**

The CLI cannot do passkey login. You use a **token** that the server issues after you’ve logged in in the browser:

1. Log in in the browser (passkey) as above.
2. Open the **toolbox** (⌘, top right) and click **Generate CLI token**.
3. The token is copied to the clipboard (or shown in the console). Use it with the CLI:

   ```bash
   node connect.js --token YOUR_TOKEN new
   # or
   TERMINAL_TOKEN=YOUR_TOKEN node connect.js new
   python tunnel.py --token YOUR_TOKEN 8080
   ```

Tokens are stored (as hashes) in the same data directory as the passkey (`auth-data.json`). They don’t expire unless you delete them from that file.

**Summary:**

| Mode              | Flag / behaviour      | Browser          | CLI / tunnel      |
|-------------------|------------------------|------------------|-------------------|
| No auth           | `--no-auth`            | No login         | No token          |
| Setup (first time)| `--setup-passkey`      | Register passkey only | N/A          |
| Normal (auth on)  | default                | Passkey login    | Token (`--token`) |

---

## Run (quick start)

```bash
npm install
npm start
```

Then open http://localhost:3847 in your browser (default port is **3847**). You get a full bash session; resize the window and the PTY dimensions follow.

**Server options** (see `node server.js --help`):

- `-p, --port` — port (default 3847)
- `-H, --host` / `--all` — bind address (`--all` = 0.0.0.0)
- `--no-auth` — no passkey or token
- `--setup-passkey` — web UI only for passkey registration
- `--data-dir <path>` — where auth data and PTY cwd live (default: current directory)

---

## Sessions (UUID)

Sessions are identified by a UUID and are shared between web and CLI.

- **Web:** Use `?session=<uuid>` to attach to a session, or `?session=new` to create a new one. If you omit `session`, you attach to the last used session (or a new one). The page URL updates to show the current session ID.
- **CLI:** `node connect.js <uuid>` to attach, or `node connect.js new` to create. With no argument, attaches to the last session. The script prints `Session: <uuid>` to stderr on connect.

Examples:

```bash
npm run connect              # last session, or new
npm run connect new          # new session
npm run connect abc-123      # attach to session abc-123
npm run connect --list       # list active session IDs (then exit)
npm run connect --resize new # new session and reset PTY size
npm run connect --token TOKEN new   # with auth token
```

Same session from the web: open `http://localhost:3847?session=abc-123`. Set `TERMINAL_URL=ws://host:port` if the server is not on localhost:3847.

---

## Web UI

- **Sessions (≡, top left):** Menu with “New session” and all active session IDs; click one to switch (page reloads into that session).
- **Toolbox (⌘, top right):** “Resize to screen”, modifier toggles (Ctrl, Alt, Meta), Esc/Tab/Enter/arrow keys, “Show keyboard” (bar of special keys below the terminal, handy on mobile). When auth is on, **Generate CLI token** appears here.

---

## Stack

- **Server:** Express, `node-pty` (spawns bash), `ws` (WebSocket), `@simplewebauthn/server` (passkeys)
- **Client:** xterm.js + xterm-addon-fit, WebSocket, `@simplewebauthn/browser` (passkeys)
