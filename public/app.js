const LAST_SESSION_KEY = 'terminalLastSession';
let currentSessionId = null;

function getSessionParam() {
  const p = location.pathname;
  const match = p.match(/^\/session\/([^/]+)/);
  return match ? match[1] : '';
}

function parseRoute() {
  const p = location.pathname;
  if (p === '/' || p === '') return { view: 'default' };
  if (p === '/files' || p === '/files/') return { view: 'files', path: '', mode: 'tree' };
  if (p.startsWith('/files/tree/')) return { view: 'files', path: decodeURIComponent(p.slice(12).replace(/\/$/, '')), mode: 'tree' };
  if (p.startsWith('/files/blob/')) return { view: 'files', path: decodeURIComponent(p.slice(11)), mode: 'blob' };
  const sessionMatch = p.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
  if (!sessionMatch) return { view: 'default' };
  const sessionId = sessionMatch[1];
  const rest = sessionMatch[2] || '';
  if (rest === '' || rest === '/') return { view: 'terminal', sessionId };
  return { view: 'terminal', sessionId };
}

function showAuthScreen(title, bodyHtml, primaryLabel, onPrimary) {
  const screen = document.getElementById('auth-screen');
  const content = document.getElementById('auth-content');
  if (!screen || !content) return;
  content.innerHTML = '<h1>' + title + '</h1><p>' + bodyHtml + '</p><button type="button" class="auth-btn" id="auth-primary">' + primaryLabel + '</button><div class="error" id="auth-error"></div>';
  screen.classList.add('visible');
  const btn = document.getElementById('auth-primary');
  const errEl = document.getElementById('auth-error');
  if (btn) btn.onclick = () => { errEl.textContent = ''; onPrimary(btn, errEl); };
}

function showSetupScreen() {
  showAuthScreen(
    'Register passkey',
    'Create a passkey to secure this terminal. You will use it to sign in.',
    'Create passkey',
    async (btn, errEl) => {
      btn.disabled = true;
      try {
        const optRes = await fetch('/api/webauthn/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (!optRes.ok) throw new Error('Failed to get options');
        const options = await optRes.json();
        const { startRegistration } = SimpleWebAuthnBrowser;
        const cred = await startRegistration(options);
        const verifyRes = await fetch('/api/webauthn/register/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cred),
        });
        if (!verifyRes.ok) {
          const e = await verifyRes.json().catch(() => ({}));
          throw new Error(e.error || 'Verification failed');
        }
        errEl.textContent = '';
        errEl.style.color = '#3fb950';
        errEl.textContent = 'Passkey created. You can now run the server without --setup-passkey and sign in.';
      } catch (e) {
        errEl.textContent = e.message || 'Failed';
      } finally {
        btn.disabled = false;
      }
    }
  );
}

function showLoginScreen() {
  showAuthScreen(
    'Sign in',
    'Use your passkey to sign in.',
    'Sign in with passkey',
    async (btn, errEl) => {
      btn.disabled = true;
      try {
        const optRes = await fetch('/api/webauthn/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (!optRes.ok) throw new Error('Failed to get options');
        const options = await optRes.json();
        const { startAuthentication } = SimpleWebAuthnBrowser;
        const cred = await startAuthentication(options);
        const verifyRes = await fetch('/api/webauthn/login/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cred),
          credentials: 'include',
        });
        if (!verifyRes.ok) {
          const e = await verifyRes.json().catch(() => ({}));
          throw new Error(e.error || 'Verification failed');
        }
        location.reload();
      } catch (e) {
        errEl.textContent = e.message || 'Failed';
        btn.disabled = false;
      }
    }
  );
}

async function refreshSessionsMenu() {
  const sm = document.getElementById('sessions-menu');
  if (!sm) return;
  const list = await fetch('/api/sessions').then((r) => r.json()).catch(() => []);
  const current = getSessionParam();
  const route = parseRoute();
  sm.innerHTML = '';
  const add = (label, sessionValue, isCurrent) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (isCurrent ? ' current' : '');
    b.textContent = label;
    if (sessionValue && sessionValue !== label) b.appendChild(document.createElement('small')).textContent = sessionValue;
    b.type = 'button';
    b.onclick = () => {
      location.assign(sessionValue ? '/session/' + encodeURIComponent(sessionValue) : '/');
    };
    sm.appendChild(b);
  };
  add('New session', 'new', false);
  const fileViewBtn = document.createElement('button');
  fileViewBtn.className = 'menu-item';
  fileViewBtn.textContent = 'File view';
  fileViewBtn.type = 'button';
  fileViewBtn.onclick = () => location.assign('/files');
  sm.appendChild(fileViewBtn);
  sm.appendChild(document.createElement('hr')).className = 'menu-hr';
  if (list.length) {
    list.forEach((s) => {
      const id = s.id || s;
      const label = (s.name && typeof s.name === 'string' ? s.name.trim() : null) || id;
      add(label, id, id === current || (!current && id === currentSessionId));
    });
  }
}

function initSessionMenu() {
  const sb = document.getElementById('sessions-btn');
  const sm = document.getElementById('sessions-menu');
  if (!sb || !sm) return;
  sb.onclick = (e) => {
    e.stopPropagation();
    const open = sm.classList.toggle('open');
    if (open) refreshSessionsMenu();
  };
  document.addEventListener('click', () => sm.classList.remove('open'));
}

async function initApp() {
  let authState = {};
  try {
    authState = await fetch('/api/auth-state').then((r) => r.json());
  } catch (_) {}
  if (authState.setupMode) {
    showSetupScreen();
    return;
  }
  if (authState.authRequired && !authState.loggedIn) {
    showLoginScreen();
    return;
  }
  const route = parseRoute();
  if (route.view === 'default') {
    const last = localStorage.getItem(LAST_SESSION_KEY);
    location.replace(last ? '/session/' + encodeURIComponent(last) : '/session/new');
    return;
  }
  initSessionMenu();
  if (route.view === 'files') {
    initFileViewer(route.path, route.mode);
    return;
  }
  initTerminal();
}

function extensionToPrismLang(ext) {
  const map = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'javascript', jsx: 'javascript', tsx: 'javascript', json: 'json', py: 'python', sh: 'bash', bash: 'bash', css: 'css', md: 'markdown', yml: 'yaml', yaml: 'yaml', html: 'html' };
  return map[ext.toLowerCase()] || 'plaintext';
}

function initFileViewer(path, mode) {
  const termWrap = document.getElementById('terminal-wrap');
  const fileWrap = document.getElementById('file-viewer-wrap');
  if (termWrap) termWrap.style.display = 'none';
  if (fileWrap) {
    fileWrap.classList.add('visible');
    fileWrap.style.display = 'flex';
  }

  const basePath = '/files';
  const breadcrumbEl = document.getElementById('file-viewer-breadcrumb');
  const contentEl = document.getElementById('file-viewer-content');
  const terminalHref = (function () {
    try {
      const last = localStorage.getItem(LAST_SESSION_KEY);
      return last ? '/session/' + encodeURIComponent(last) : '/';
    } catch (_) { return '/'; }
  })();

  const copyPathSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11H8.75a1.75 1.75 0 0 1-1.75-1.75V1.75Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h5.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';

  function renderBreadcrumb() {
    const parts = [{ label: 'Terminal', href: terminalHref }, { label: 'files', href: basePath }];
    if (path) {
      const segs = path.split('/').filter(Boolean);
      let acc = '';
      segs.forEach((s, i) => {
        acc += (acc ? '/' : '') + s;
        const isLast = i === segs.length - 1;
        parts.push({ label: s, href: mode === 'blob' && isLast ? null : basePath + '/tree/' + encodeURIComponent(acc).replace(/%2F/g, '/') });
      });
    }
    const trailHtml = parts.map((p) => p.href ? '<a href="' + p.href + '">' + escapeHtml(p.label) + '</a>' : '<span>' + escapeHtml(p.label) + '</span>').join(' / ');
    breadcrumbEl.innerHTML = '<span class="file-viewer-breadcrumb-trail">' + trailHtml + '</span><button type="button" class="file-viewer-copy-btn" title="Copy path" aria-label="Copy path">' + copyPathSvg + '</button>';
    const copyBtn = breadcrumbEl.querySelector('.file-viewer-copy-btn');
    if (copyBtn) {
      copyBtn.onclick = function () {
        function toast(m) {
          var el = document.getElementById('toast');
          if (el) { el.textContent = m; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 3000); }
        }
        fetch('/api/fs/copy-path?path=' + encodeURIComponent(path)).then(function (r) {
          if (!r.ok) return r.json().then(function (e) { toast(e.error || 'Failed to copy'); });
          return r.json();
        }).then(function (data) {
          if (data && data.copyText != null) {
            navigator.clipboard.writeText(data.copyText).then(function () { toast('Path copied to clipboard'); }, function () { toast('Failed to copy'); });
          }
        }).catch(function () { toast('Failed to copy'); });
      };
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function renderTree() {
    renderBreadcrumb();
    contentEl.innerHTML = '<div id="file-viewer-list">Loading…</div>';
    const listEl = document.getElementById('file-viewer-list');
    fetch('/api/fs/list?path=' + encodeURIComponent(path)).then((r) => {
      if (!r.ok) return r.json().then((e) => { listEl.innerHTML = '<div class="file-viewer-truncated">' + escapeHtml(e.error || 'Failed') + '</div>'; });
      return r.json();
    }).then((data) => {
      if (!data || !data.entries) return;
      let html = '';
      if (path) {
        const parentPath = path.split('/').slice(0, -1).join('/');
        html += '<div class="file-viewer-row">📁 <a href="' + basePath + '/tree/' + encodeURIComponent(parentPath).replace(/%2F/g, '/') + '">..</a></div>';
      }
      (data.entries || []).forEach((e) => {
        const name = escapeHtml(e.name);
        const fullPath = path ? path + '/' + e.name : e.name;
        if (e.type === 'dir') {
          html += '<div class="file-viewer-row">📁 <a href="' + basePath + '/tree/' + encodeURIComponent(fullPath).replace(/%2F/g, '/') + '">' + name + '</a></div>';
        } else {
          const size = e.size != null ? (e.size < 1024 ? e.size + ' B' : (e.size < 1024 * 1024 ? (e.size / 1024).toFixed(1) + ' KB' : (e.size / (1024 * 1024)).toFixed(1) + ' MB') ) : '';
          html += '<div class="file-viewer-row">📄 <a href="' + basePath + '/blob/' + encodeURIComponent(fullPath).replace(/%2F/g, '/') + '">' + name + '</a><span class="size">' + size + '</span></div>';
        }
      });
      listEl.innerHTML = html || '<div class="file-viewer-row">(empty)</div>';
    }).catch(() => { listEl.innerHTML = '<div class="file-viewer-truncated">Failed to load directory.</div>'; });
  }

  function renderBlob() {
    renderBreadcrumb();
    contentEl.innerHTML = '<div class="file-viewer-blob">Loading…</div>';
    fetch('/api/fs/content?path=' + encodeURIComponent(path)).then((r) => {
      if (!r.ok) return r.json().then((e) => { contentEl.innerHTML = '<div class="file-viewer-truncated">' + escapeHtml(e.error || 'Failed') + '</div>'; });
      return r.json();
    }).then((data) => {
      if (!data) return;
      if (data.binary) {
        contentEl.innerHTML = '<div class="file-viewer-truncated">Binary file. <a href="/api/fs/download?path=' + encodeURIComponent(path) + '" download>Download</a></div>';
        return;
      }
      let notice = '';
      if (data.truncated) {
        notice = '<div class="file-viewer-truncated">' + escapeHtml(data.message || 'File truncated.') + ' <a href="/api/fs/download?path=' + encodeURIComponent(path) + '">Download</a></div>';
      }
      const ext = path.split('/').pop().split('.').pop() || '';
      const lang = extensionToPrismLang(ext);
      const rawLines = (data.content || '').split(/\r?\n/);
      const codeByLine = rawLines.map((line) => {
        if (typeof Prism !== 'undefined' && Prism.languages[lang]) {
          try {
            return Prism.highlight(line, Prism.languages[lang], lang);
          } catch (_) {}
        }
        return escapeHtml(line);
      });
      const tableRows = codeByLine.map((line, i) => '<tr><td class="line-num">' + (i + 1) + '</td><td class="line-content">' + line + '</td></tr>').join('');
      contentEl.innerHTML = notice + '<div class="file-viewer-blob"><table class="line-table"><tbody>' + tableRows + '</tbody></table></div>';
    }).catch(() => { contentEl.innerHTML = '<div class="file-viewer-truncated">Failed to load file.</div>'; });
  }

  if (mode === 'blob') renderBlob();
  else renderTree();

  window._fileViewerOnPopState = function () {
    const r = parseRoute();
    if (r.view === 'files') initFileViewer(r.path, r.mode);
  };
  window.addEventListener('popstate', window._fileViewerOnPopState);
}

async function initTerminal() {
  document.getElementById('file-viewer-wrap').classList.remove('visible');
  document.getElementById('file-viewer-wrap').style.display = 'none';
  document.getElementById('terminal-wrap').style.display = '';
  if (window._fileViewerOnPopState) {
    window.removeEventListener('popstate', window._fileViewerOnPopState);
    window._fileViewerOnPopState = null;
  }
  const authState = await fetch('/api/auth-state').then((r) => r.json()).catch(() => ({}));
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let sessionParam = getSessionParam();
  let wsUrl = `${protocol}//${location.host}?session=${encodeURIComponent(sessionParam)}`;

  const term = new Terminal({
  fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
  cursorBlink: true,
  theme: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selection: 'rgba(56, 139, 253, 0.3)',
  },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

term.open(document.getElementById('terminal-container'));
fitAddon.fit();

let ws = new WebSocket(wsUrl);
currentSessionId = null;
let closingForReplace = false;
let reconnectTimeout = null;

const modifiers = { ctrl: false, alt: false, meta: false, shift: false };
const modifierSticky = { ctrl: false, alt: false, meta: false, shift: false };
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 400;
const SINGLE_DELAY_MS = 300;
const KEY_REPEAT_DELAY_MS = 500;
const KEY_REPEAT_INTERVAL_MS = 80;

function sendToPty(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

var FLOAT_BTN_SIZE = 40;
var FLOAT_BTN_MARGIN = 16;
var TOP_PADDING = 10;

function updateWrapToViewableArea() {
  const wrap = document.getElementById('terminal-wrap');
  const sk = document.getElementById('special-keyboard');
  if (!wrap || !sk) return;
  var vv = window.visualViewport;
  if (!vv) {
    wrap.style.top = '0';
    wrap.style.left = '0';
    wrap.style.width = '100%';
    wrap.style.height = window.innerHeight + 'px';
    wrap.style.paddingBottom = '';
    return;
  }
  var ourKbHeight = sk.classList.contains('open') ? sk.offsetHeight : 0;
  var h = vv.height - TOP_PADDING - ourKbHeight;
  if (h < 50) h = 50;
  wrap.style.position = 'fixed';
  wrap.style.top = (vv.offsetTop + TOP_PADDING) + 'px';
  wrap.style.left = vv.offsetLeft + 'px';
  wrap.style.width = vv.width + 'px';
  wrap.style.height = h + 'px';
  wrap.style.paddingBottom = '';
}

function positionFloatingUI() {
  var vv = window.visualViewport;
  if (!vv) return;
  var sk = document.getElementById('special-keyboard');
  var sessionsBtn = document.getElementById('sessions-btn');
  var toolboxBtn = document.getElementById('toolbox-btn');
  var sessionsMenu = document.getElementById('sessions-menu');
  var toolboxMenu = document.getElementById('toolbox-menu');
  var ourKbOpen = sk && sk.classList.contains('open');
  var ourKbHeight = ourKbOpen ? sk.offsetHeight : 0;

  var btnTop;
  var btnLeftMargin = FLOAT_BTN_MARGIN;
  var btnRightMargin = FLOAT_BTN_MARGIN;
  if (ourKbOpen && ourKbHeight > 0) {
    var kbTop = vv.offsetTop + vv.height - ourKbHeight;
    btnTop = kbTop + Math.max(0, (ourKbHeight - FLOAT_BTN_SIZE) / 2);
    btnLeftMargin = 6;
    btnRightMargin = 6;
  } else {
    btnTop = vv.offsetTop + FLOAT_BTN_MARGIN;
  }
  var menuTop = btnTop + FLOAT_BTN_SIZE + 8;
  var menuAbove = ourKbOpen && ourKbHeight > 0;
  var menuBottom = menuAbove ? (vv.offsetTop + vv.height - btnTop + 8) : '';

  if (sessionsBtn && !sk.contains(sessionsBtn)) {
    sessionsBtn.style.top = btnTop + 'px';
    sessionsBtn.style.left = (vv.offsetLeft + btnLeftMargin) + 'px';
    sessionsBtn.style.right = '';
  }
  if (toolboxBtn && !sk.contains(toolboxBtn)) {
    toolboxBtn.style.top = btnTop + 'px';
    toolboxBtn.style.left = '';
    toolboxBtn.style.right = (window.innerWidth - vv.offsetLeft - vv.width + btnRightMargin) + 'px';
  }
  if (sessionsMenu) {
    if (menuAbove) {
      sessionsMenu.style.top = '';
      sessionsMenu.style.bottom = menuBottom + 'px';
    } else {
      sessionsMenu.style.bottom = '';
      sessionsMenu.style.top = menuTop + 'px';
    }
    sessionsMenu.style.left = (vv.offsetLeft + btnLeftMargin) + 'px';
  }
  if (toolboxMenu) {
    if (menuAbove) {
      toolboxMenu.style.top = '';
      toolboxMenu.style.bottom = menuBottom + 'px';
    } else {
      toolboxMenu.style.bottom = '';
      toolboxMenu.style.top = menuTop + 'px';
    }
    toolboxMenu.style.left = ourKbOpen ? (vv.offsetLeft + btnLeftMargin) + 'px' : '';
    toolboxMenu.style.right = ourKbOpen ? '' : (window.innerWidth - vv.offsetLeft - vv.width + btnRightMargin) + 'px';
  }
  if (sk && ourKbOpen) {
    sk.style.top = (vv.offsetTop + vv.height - ourKbHeight) + 'px';
    sk.style.left = vv.offsetLeft + 'px';
    sk.style.width = vv.width + 'px';
    sk.style.height = ourKbHeight + 'px';
    sk.style.bottom = '';
  } else if (sk) {
    sk.style.top = '';
    sk.style.left = '';
    sk.style.width = '';
    sk.style.height = '';
    sk.style.bottom = '';
  }
}

function sendResize() {
  updateWrapToViewableArea();
  fitAddon.fit();
  var cols = term.cols, rows = term.rows;
  sendToPty('\x01' + JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
}

let toastTimeout = null;
function showToast(message, durationMs) {
  const el = document.getElementById('toast');
  if (!el) return;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = null;
  el.textContent = message;
  el.classList.add('show');
  if (durationMs > 0) {
    toastTimeout = setTimeout(() => {
      toastTimeout = null;
      el.classList.remove('show');
    }, durationMs);
  }
}
function hideToast() {
  const el = document.getElementById('toast');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = null;
  if (el) el.classList.remove('show');
}

function applyModifiers(data) {
  if (!modifiers.ctrl && !modifiers.alt && !modifiers.meta && !modifiers.shift) return data;
  if (data.length !== 1) return data;
  const c = data.charCodeAt(0);
  if (modifiers.ctrl) {
    if (c >= 97 && c <= 122) {
      if (!modifierSticky.ctrl) modifiers.ctrl = false;
      return String.fromCharCode(c - 96);
    }
    if (c >= 64 && c <= 95) {
      if (!modifierSticky.ctrl) modifiers.ctrl = false;
      return String.fromCharCode(c - 64);
    }
  }
  if (modifiers.shift && c >= 97 && c <= 122) {
    if (!modifierSticky.shift) modifiers.shift = false;
    return String.fromCharCode(c - 32);
  }
  if (modifiers.alt || modifiers.meta) {
    if (!modifierSticky.alt) modifiers.alt = false;
    if (!modifierSticky.meta) modifiers.meta = false;
    return '\x1b' + data;
  }
  return data;
}

function connect() {
  clearTimeout(reconnectTimeout);
  reconnectTimeout = null;
  closingForReplace = true;
  if (ws) ws.close();
  sessionParam = getSessionParam();
  wsUrl = `${protocol}//${location.host}?session=${encodeURIComponent(sessionParam)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    closingForReplace = false;
    showToast('Connected. Type to start.', 3000);
    sendResize();
    fitAddon.fit();
    if (typeof term.refresh === 'function') term.refresh(0, term.rows - 1);
    term.focus();
  };

  ws.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === 'string' && data.endsWith('\n')) {
      try {
        const msg = JSON.parse(data.trim());
        if (msg.type === 'session' && msg.id) {
          currentSessionId = msg.id;
          term.reset();
          const path = '/session/' + encodeURIComponent(msg.id);
          history.replaceState(null, '', path);
          try { localStorage.setItem(LAST_SESSION_KEY, msg.id); } catch (_) {}
          return;
        }
        if (msg.type === 'replay' && msg.data) {
          try {
            const binary = atob(msg.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const str = new TextDecoder('utf-8').decode(bytes);
            term.write(str);
          } catch (_) {}
          return;
        }
      } catch (_) {}
    }
    term.write(data);
  };

  ws.onclose = (ev) => {
    if (ev.target !== ws) return;
    if (closingForReplace) {
      closingForReplace = false;
    }
    if (ev.code === 4001 || ev.reason === 'session closed') {
      showToast('Session closed.', 8000);
      currentSessionId = null;
      history.replaceState(null, '', '/');
      return;
    }
    if (currentSessionId || getSessionParam()) {
      showToast('Connection lost. Reconnecting…', 0);
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connect();
      }, 2000);
    } else {
      showToast('Disconnected.', 4000);
    }
  };

  ws.onerror = () => {
    showToast('Connection error.', 4000);
  };
}

connect();

positionFloatingUI();

term.onData((data) => {
  const out = applyModifiers(data);
  sendToPty(out);
  updateModifierButtons();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const termEl = document.getElementById('terminal-container');
  if (!termEl || !termEl.contains(document.activeElement)) return;
  e.preventDefault();
  sendToPty(e.shiftKey ? '\x1b[Z' : '\x09');
  if (e.shiftKey && modifiers.shift && !modifierSticky.shift) {
    modifiers.shift = false;
    updateModifierButtons();
  }
});

term.onResize(({ cols, rows }) => {
  sendToPty('\x01' + JSON.stringify({ type: 'resize', cols, rows }));
});


// --- Session menu ---
const sessionsBtn = document.getElementById('sessions-btn');
const sessionsMenu = document.getElementById('sessions-menu');

// --- Toolbox ---
const toolboxBtn = document.getElementById('toolbox-btn');
const toolboxMenu = document.getElementById('toolbox-menu');
const specialKeyboard = document.getElementById('special-keyboard');

const specialKeysRow1 = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\x09' },
  { label: 'Shift', mod: 'shift' },
  { label: '↑', data: '\x1b[A' },
  { label: 'Supr', data: '\x1b[3~', title: 'Delete' },
  { label: 'PgUp', data: '\x1b[5~' },
  { label: '⌫', data: '\x7f', title: 'Backspace' },
];
const specialKeysRow2 = [
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: '←', data: '\x1b[D' },
  { label: '↓', data: '\x1b[B' },
  { label: '→', data: '\x1b[C' },
  { label: 'PgDn', data: '\x1b[6~' },
  { label: '⏎', data: '\r', title: 'Enter' },
];
const specialKeys = [...specialKeysRow1, ...specialKeysRow2];
const toolboxKeysGrid = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\x09' },
  { label: 'PgUp', data: '\x1b[5~' },
  { label: '↑', data: '\x1b[A' },
  { label: '⏎', data: '\r', title: 'Enter' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: '←', data: '\x1b[D' },
  { label: 'PgDn', data: '\x1b[6~' },
  { label: '↓', data: '\x1b[B' },
  { label: '→', data: '\x1b[C' },
  { label: 'Alt', mod: 'alt' },
  { label: 'Shift', mod: 'shift' },
  { label: 'Meta', mod: 'meta' },
  { label: '⌫', data: '\x7f', title: 'Backspace' },
  { label: 'Del', data: '\x1b[3~', title: 'Delete' },
  { label: 'Ins', data: '\x1b[2~', title: 'Insert' },
];

function getSpecialKeyData(k) {
  if (k.data === '\x09' && modifiers.shift) return '\x1b[Z';
  return k.data;
}

function clearShiftIfUsedForKey(k) {
  if (k.data === '\x09' && modifiers.shift && !modifierSticky.shift) {
    modifiers.shift = false;
    updateModifierButtons();
  }
}

function updateModifierButtons() {
  toolboxMenu.querySelectorAll('.key-btn[data-mod]').forEach((btn) => {
    const m = btn.getAttribute('data-mod');
    btn.classList.toggle('active', modifiers[m]);
  });
  specialKeyboard.querySelectorAll('.key-btn[data-mod]').forEach((btn) => {
    const m = btn.getAttribute('data-mod');
    btn.classList.toggle('active', modifiers[m]);
  });
}

toolboxMenu.innerHTML = '';
const resizeRow = document.createElement('div');
resizeRow.className = 'toolbox-row';
resizeRow.innerHTML = '<label>PTY</label>';
const resizeBtn = document.createElement('button');
resizeBtn.className = 'key-btn';
resizeBtn.textContent = 'Resize to screen';
resizeBtn.type = 'button';
resizeBtn.onclick = () => { sendResize(); };
resizeRow.appendChild(resizeBtn);
toolboxMenu.appendChild(resizeRow);

const tokenRow = document.createElement('div');
tokenRow.className = 'toolbox-row';
tokenRow.innerHTML = '<label>CLI</label>';
const tokenBtn = document.createElement('button');
tokenBtn.className = 'key-btn';
tokenBtn.textContent = 'Generate CLI token';
tokenBtn.type = 'button';
tokenBtn.onclick = async () => {
  try {
    const res = await fetch('/api/token', { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error('Failed');
    const { token } = await res.json();
    showToast('Token copied to clipboard', 4000);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(token);
    } else {
      showToast('Token: ' + token.slice(0, 16) + '… (copy from console)', 8000);
      console.log('CLI token (use with --token):', token);
    }
  } catch (_) {
    showToast('Failed to generate token', 4000);
  }
};
tokenRow.appendChild(tokenBtn);
  if (authState.authRequired) toolboxMenu.appendChild(tokenRow);

let autoResize = true;
let viewportRaf = null;
function onViewportChange() {
  if (!autoResize) return;
  if (viewportRaf) cancelAnimationFrame(viewportRaf);
  viewportRaf = requestAnimationFrame(() => {
    viewportRaf = null;
    positionFloatingUI();
    sendResize();
  });
}
const autoResizeRow = document.createElement('div');
autoResizeRow.className = 'toolbox-row';
const autoResizeBtn = document.createElement('button');
autoResizeBtn.className = 'key-btn';
autoResizeBtn.textContent = autoResize ? 'Auto Resize: on' : 'Auto Resize: off';
autoResizeBtn.classList.toggle('active', autoResize);
autoResizeBtn.type = 'button';
autoResizeBtn.onclick = () => {
  autoResize = !autoResize;
  autoResizeBtn.classList.toggle('active', autoResize);
  autoResizeBtn.textContent = autoResize ? 'Auto Resize: on' : 'Auto Resize: off';
  if (autoResize) sendResize();
};
autoResizeRow.appendChild(autoResizeBtn);
toolboxMenu.appendChild(autoResizeRow);

window.addEventListener('resize', onViewportChange);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onViewportChange);
}

const fullscreenRow = document.createElement('div');
fullscreenRow.className = 'toolbox-row';
fullscreenRow.innerHTML = '<label>View</label>';
const fullscreenBtn = document.createElement('button');
fullscreenBtn.className = 'key-btn';
fullscreenBtn.textContent = 'Toggle fullscreen';
fullscreenBtn.type = 'button';
fullscreenBtn.onclick = () => {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.();
  }
};
fullscreenRow.appendChild(fullscreenBtn);
toolboxMenu.appendChild(fullscreenRow);

const modRow = document.createElement('div');
modRow.className = 'toolbox-row';
modRow.innerHTML = '<label>Modifiers</label>';
['ctrl', 'alt', 'shift', 'meta'].forEach((m) => {
  const b = document.createElement('button');
  b.className = 'key-btn';
  b.textContent = m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : m === 'shift' ? 'Shift' : 'Meta';
  b.setAttribute('data-mod', m);
  b.type = 'button';
  b.onclick = () => { modifiers[m] = !modifiers[m]; updateModifierButtons(); };
  modRow.appendChild(b);
});
toolboxMenu.appendChild(modRow);

const keysGrid = document.createElement('div');
keysGrid.className = 'toolbox-row toolbox-keys-grid';
keysGrid.innerHTML = '<label style="grid-column: 1 / -1;">Keys</label>';
toolboxKeysGrid.forEach((k) => {
  const b = document.createElement('button');
  b.className = 'key-btn';
  b.textContent = k.label;
  if (k.title) b.title = k.title;
  b.type = 'button';
  if (k.mod) {
    b.setAttribute('data-mod', k.mod);
    b.onclick = () => { modifiers[k.mod] = !modifiers[k.mod]; updateModifierButtons(); };
  } else {
    b.onclick = () => sendToPty(getSpecialKeyData(k));
  }
  keysGrid.appendChild(b);
});
toolboxMenu.appendChild(keysGrid);

const kbRow = document.createElement('div');
kbRow.className = 'toolbox-row';
const kbToggle = document.createElement('button');
kbToggle.className = 'key-btn';
kbToggle.textContent = 'Show keyboard';
kbToggle.type = 'button';
// On mobile: float our keyboard above the browser's virtual keyboard when open (visualViewport API).
// If it doesn't work: try focusing the terminal after opening our keyboard so the native keyboard stays closed,
// or keep "Show keyboard" on and use only our keys to avoid opening the native keyboard.
function moveMenuButtonsIntoKeyboard() {
  if (!specialKeyboard.classList.contains('open')) return;
  if (!specialKeyboard.contains(sessionsBtn)) {
    sessionsBtn.classList.add('key-btn');
    toolboxBtn.classList.add('key-btn');
    kbRow1.insertBefore(sessionsBtn, kbRow1.firstChild);
    kbRow2.insertBefore(toolboxBtn, kbRow2.firstChild);
  }
}

function moveMenuButtonsOutOfKeyboard() {
  if (specialKeyboard.contains(sessionsBtn)) {
    sessionsBtn.classList.remove('key-btn');
    toolboxBtn.classList.remove('key-btn');
    document.body.insertBefore(sessionsBtn, sessionsMenu);
    document.body.insertBefore(toolboxBtn, toolboxMenu);
  }
}

kbToggle.onclick = () => {
  const opening = !specialKeyboard.classList.contains('open');
  specialKeyboard.classList.toggle('open');
  if (opening) {
    moveMenuButtonsIntoKeyboard();
  } else {
    moveMenuButtonsOutOfKeyboard();
  }
  kbToggle.textContent = specialKeyboard.classList.contains('open') ? 'Hide keyboard' : 'Show keyboard';
  requestAnimationFrame(() => {
    positionFloatingUI();
    sendResize();
  });
};
kbRow.appendChild(kbToggle);
toolboxMenu.appendChild(kbRow);

function handleModifierRelease(btn, mod, duration) {
  if (modifiers[mod]) {
    modifiers[mod] = false;
    updateModifierButtons();
    return false;
  }
  if (btn._modPendingTimeout) {
    clearTimeout(btn._modPendingTimeout);
    btn._modPendingTimeout = null;
  }
  if (duration >= LONG_PRESS_MS) {
    modifiers[mod] = true;
    modifierSticky[mod] = true;
    updateModifierButtons();
    return false;
  }
  var now = Date.now();
  if ((btn._modLastTap || 0) && now - btn._modLastTap < DOUBLE_TAP_MS) {
    btn._modLastTap = 0;
    modifiers[mod] = true;
    modifierSticky[mod] = true;
    updateModifierButtons();
    return false;
  }
  btn._modLastTap = now;
  btn._modPendingTimeout = setTimeout(function () {
    btn._modPendingTimeout = null;
    modifiers[mod] = true;
    modifierSticky[mod] = false;
    updateModifierButtons();
    btn.classList.remove('pressed');
  }, SINGLE_DELAY_MS);
  return true;
}

function stopKeyRepeat(b) {
  if (b._repeatTimeout != null) {
    clearTimeout(b._repeatTimeout);
    b._repeatTimeout = null;
  }
  if (b._repeatInterval != null) {
    clearInterval(b._repeatInterval);
    b._repeatInterval = null;
  }
  b._didRepeat = true;
}

function startKeyRepeat(b, data) {
  stopKeyRepeat(b);
  b._didRepeat = false;
  sendToPty(data);
  b._repeatTimeout = setTimeout(() => {
    b._repeatTimeout = null;
    b._repeatInterval = setInterval(() => sendToPty(data), KEY_REPEAT_INTERVAL_MS);
  }, KEY_REPEAT_DELAY_MS);
}

function setKeyPressed(btn, pressed) {
  if (pressed) {
    btn.classList.add('pressed');
    if (navigator.vibrate) navigator.vibrate(10);
  } else {
    btn.classList.remove('pressed');
  }
}

function addKeyButton(container, k) {
  const b = document.createElement('button');
  b.className = 'key-btn';
  b.textContent = k.label;
  if (k.title) b.title = k.title;
  b.type = 'button';
  b.setAttribute('tabindex', '-1');
  if (k.mod) b.setAttribute('data-mod', k.mod);
  const isNonMod = !k.mod && k.data;
  b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setKeyPressed(b, true);
    b._modStartTime = Date.now();
    if (isNonMod) {
      startKeyRepeat(b, getSpecialKeyData(k));
      clearShiftIfUsedForKey(k);
    }
  });
  b.addEventListener('mouseup', (e) => {
    e.stopPropagation();
    if (k.mod) {
      var duration = Date.now() - (b._modStartTime || 0);
      var pending = handleModifierRelease(b, k.mod, duration);
      if (!pending) setKeyPressed(b, false);
    } else {
      setKeyPressed(b, false);
      if (isNonMod) stopKeyRepeat(b);
    }
  });
  b.addEventListener('mouseleave', () => {
    if (k.mod && b._modPendingTimeout) return;
    setKeyPressed(b, false);
    if (isNonMod) stopKeyRepeat(b);
  });
  b.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setKeyPressed(b, true);
    b._modStartTime = Date.now();
    if (isNonMod) {
      startKeyRepeat(b, getSpecialKeyData(k));
      clearShiftIfUsedForKey(k);
    }
  }, { passive: false });
  let touchHandled = false;
  b.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (k.mod) {
      var duration = Date.now() - (b._modStartTime || 0);
      var pending = handleModifierRelease(b, k.mod, duration);
      if (!pending) setKeyPressed(b, false);
      touchHandled = true;
      setTimeout(() => { touchHandled = false; }, 300);
    } else {
      setKeyPressed(b, false);
      if (isNonMod) stopKeyRepeat(b);
      if (!b._didRepeat) {
        sendToPty(getSpecialKeyData(k));
        clearShiftIfUsedForKey(k);
      }
      touchHandled = true;
      setTimeout(() => { touchHandled = false; b._didRepeat = false; }, 300);
    }
  }, { passive: false });
  b.addEventListener('touchcancel', () => {
    if (k.mod && b._modPendingTimeout) return;
    setKeyPressed(b, false);
    if (isNonMod) stopKeyRepeat(b);
  }, { passive: false });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (touchHandled) return;
    if (isNonMod && b._didRepeat) return;
    if (k.mod) {
      var duration = Date.now() - (b._modStartTime || 0);
      handleModifierRelease(b, k.mod, duration);
    } else {
      sendToPty(getSpecialKeyData(k));
      clearShiftIfUsedForKey(k);
    }
  });
  container.appendChild(b);
}

const kbRow1 = document.createElement('div');
kbRow1.className = 'keyboard-row';
specialKeysRow1.forEach((k) => addKeyButton(kbRow1, k));
specialKeyboard.appendChild(kbRow1);
const kbRow2 = document.createElement('div');
kbRow2.className = 'keyboard-row';
specialKeysRow2.forEach((k) => addKeyButton(kbRow2, k));
specialKeyboard.appendChild(kbRow2);

specialKeyboard.classList.add('open');
moveMenuButtonsIntoKeyboard();
kbToggle.textContent = 'Hide keyboard';
requestAnimationFrame(() => { positionFloatingUI(); sendResize(); });

toolboxBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toolboxMenu.classList.toggle('open');
  if (toolboxMenu.classList.contains('open')) updateModifierButtons();
});

document.addEventListener('click', () => toolboxMenu.classList.remove('open'));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ws && ws.readyState !== WebSocket.OPEN && (currentSessionId || getSessionParam())) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    connect();
  }
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', positionFloatingUI);
  window.visualViewport.addEventListener('scroll', positionFloatingUI);
}
window.addEventListener('resize', positionFloatingUI);
}

initApp();
