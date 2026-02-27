function getSessionParam() {
  const params = new URLSearchParams(location.search);
  return params.get('session') || '';
}

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
let currentSessionId = null;
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
          const url = new URL(location.href);
          url.searchParams.set('session', msg.id);
          history.replaceState(null, '', url.pathname + url.search);
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
      const url = new URL(location.href);
      url.searchParams.delete('session');
      history.replaceState(null, '', url.pathname + url.search);
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

async function refreshSessionsMenu() {
  const list = await fetch('/api/sessions').then((r) => r.json()).catch(() => []);
  const current = getSessionParam();
  sessionsMenu.innerHTML = '';
  const add = (label, sessionValue, isCurrent) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (isCurrent ? ' current' : '');
    b.textContent = label;
    if (sessionValue && sessionValue !== label) b.appendChild(document.createElement('small')).textContent = sessionValue;
    b.type = 'button';
    b.onclick = () => {
      const url = new URL(location.href);
      if (sessionValue === 'new') url.searchParams.set('session', 'new');
      else if (sessionValue) url.searchParams.set('session', sessionValue);
      else url.searchParams.delete('session');
      location.assign(url.pathname + url.search);
    };
    sessionsMenu.appendChild(b);
  };
  add('New session', 'new', false);
  if (list.length) {
    sessionsMenu.appendChild(document.createElement('hr')).className = 'menu-hr';
    list.forEach((s) => {
      const id = s.id || s;
      const label = (s.name && typeof s.name === 'string' ? s.name.trim() : null) || id;
      add(label, id, id === current || (!current && id === currentSessionId));
    });
  }
}

sessionsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = sessionsMenu.classList.toggle('open');
  if (open) refreshSessionsMenu();
});

document.addEventListener('click', () => sessionsMenu.classList.remove('open'));

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
