const LAST_SESSION_KEY = 'terminalLastSession';
const LAST_FILE_VIEW_URL_KEY = 'fileViewLastUrl';
const LAST_DIFF_VIEW_URL_KEY = 'diffViewLastUrl';
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
  if (p === '/diff' || p === '/diff/') return { view: 'diff', path: '' };
  if (p.startsWith('/diff/')) return { view: 'diff', path: decodeURIComponent(p.slice(6).replace(/\/$/, '')) };
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
  try {
    fileViewBtn.onclick = () => location.assign(sessionStorage.getItem(LAST_FILE_VIEW_URL_KEY) || '/files');
  } catch (_) {
    fileViewBtn.onclick = () => location.assign('/files');
  }
  sm.appendChild(fileViewBtn);
  const diffViewBtn = document.createElement('button');
  diffViewBtn.className = 'menu-item';
  diffViewBtn.textContent = 'Diff view';
  diffViewBtn.type = 'button';
  try {
    diffViewBtn.onclick = () => location.assign(sessionStorage.getItem(LAST_DIFF_VIEW_URL_KEY) || '/diff');
  } catch (_) {
    diffViewBtn.onclick = () => location.assign('/diff');
  }
  sm.appendChild(diffViewBtn);
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
    try { sessionStorage.setItem(LAST_FILE_VIEW_URL_KEY, location.pathname + location.search); } catch (_) {}
    initFileViewer(route.path, route.mode);
    return;
  }
  if (route.view === 'diff') {
    try { sessionStorage.setItem(LAST_DIFF_VIEW_URL_KEY, location.pathname + location.search); } catch (_) {}
    const diffPath = new URLSearchParams(location.search).get('path') || route.path;
    initDiffViewer(diffPath);
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
  const dotsSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>';

  function getCurrentDirPath() {
    return mode === 'blob' ? path.split('/').slice(0, -1).join('/') : path;
  }

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
    breadcrumbEl.innerHTML = '<span class="file-viewer-breadcrumb-trail">' + trailHtml + '</span><div class="file-viewer-breadcrumb-actions"><button type="button" class="file-viewer-copy-btn" title="Copy path" aria-label="Copy path">' + copyPathSvg + '</button><button type="button" class="file-viewer-dots-btn" title="More actions" aria-label="More actions" aria-haspopup="true">' + dotsSvg + '</button></div>';
    const dotsBtn = breadcrumbEl.querySelector('.file-viewer-dots-btn');
    const dotsMenuId = 'file-viewer-dots-menu';
    let dotsMenu = document.getElementById(dotsMenuId);
    if (!dotsMenu) {
      dotsMenu = document.createElement('div');
      dotsMenu.id = dotsMenuId;
      dotsMenu.className = 'file-viewer-dots-menu';
      dotsMenu.setAttribute('role', 'menu');
      document.body.appendChild(dotsMenu);
    }
    dotsMenu.innerHTML = '';
    const addItem = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item';
      b.textContent = label;
      b.setAttribute('role', 'menuitem');
      b.onclick = () => { dotsMenu.classList.remove('open'); onClick(); };
      dotsMenu.appendChild(b);
    };
    addItem('Open terminal', () => {
      const dir = getCurrentDirPath();
      const cwd = dir ? '?cwd=' + encodeURIComponent(dir) : '';
      location.assign('/session/new' + cwd);
    });
    addItem('Diff view', () => {
      const dir = getCurrentDirPath();
      location.assign(dir ? '/diff?path=' + encodeURIComponent(dir) : '/diff');
    });
    if (dotsBtn) {
      dotsBtn.onclick = (e) => {
        e.stopPropagation();
        const open = dotsMenu.classList.toggle('open');
        if (open) {
          const rect = dotsBtn.getBoundingClientRect();
          const gap = 4;
          dotsMenu.style.left = rect.left + 'px';
          dotsMenu.style.top = (rect.bottom + gap) + 'px';
          dotsMenu.style.right = 'auto';
          dotsMenu.style.bottom = 'auto';
          var menuRect = dotsMenu.getBoundingClientRect();
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          if (menuRect.right > vw) dotsMenu.style.left = (vw - menuRect.width - gap) + 'px';
          if (menuRect.bottom > vh) dotsMenu.style.top = (rect.top - menuRect.height - gap) + 'px';
        }
      };
    }
    document.addEventListener('click', function closeDots() {
      dotsMenu.classList.remove('open');
    }, { once: true });
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

function initDiffViewer(pathFromRoute) {
  const termWrap = document.getElementById('terminal-wrap');
  const fileWrap = document.getElementById('file-viewer-wrap');
  const diffWrap = document.getElementById('diff-viewer-wrap');
  if (termWrap) termWrap.style.display = 'none';
  if (fileWrap) { fileWrap.classList.remove('visible'); fileWrap.style.display = 'none'; }
  if (diffWrap) {
    diffWrap.classList.add('visible');
    diffWrap.style.display = 'flex';
  }
  const params = new URLSearchParams(location.search);
  const pathParam = params.get('path');
  const path = (pathParam != null && pathParam !== '') ? pathParam : pathFromRoute;
  const breadcrumbEl = document.getElementById('diff-viewer-breadcrumb');
  const contentEl = document.getElementById('diff-viewer-content');
  const terminalHref = (function () {
    try {
      const last = localStorage.getItem(LAST_SESSION_KEY);
      return last ? '/session/' + encodeURIComponent(last) : '/';
    } catch (_) { return '/'; }
  })();
  var diffData = { files: [] };
  var comments = {};
  var viewedFiles = new Set();
  var ignoredFiles = new Set();
  var expandedBefore = {};
  var expandedAfter = {};
  var commentingOn = null;
  var editingComment = null;

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function getCommentsForReview() {
    var out = [];
    Object.keys(comments).forEach(function (filepath) {
      if (ignoredFiles.has(filepath)) return;
      (comments[filepath] || []).forEach(function (c) {
        var linePart = c.lineStart != null ? (c.lineEnd != null && c.lineEnd !== c.lineStart ? c.lineStart + '-' + c.lineEnd : '' + c.lineStart) : '';
        out.push('In @' + filepath + (linePart ? ':' + linePart : '') + ': ' + (c.text || '').trim());
      });
    });
    return out.join('\n');
  }

  function highlightLine(content, type, lang) {
    if (typeof Prism === 'undefined' || !content) return escapeHtml(content);
    try {
      if (Prism.languages[lang]) return Prism.highlight(content, Prism.languages[lang], lang);
    } catch (_) {}
    return escapeHtml(content);
  }

  function renderBreadcrumb() {
    var basePath = '/diff';
    var parts = [{ label: 'Terminal', href: terminalHref }, { label: 'Diff view', href: basePath }];
    if (path) parts.push({ label: path || '(root)', href: null });
    breadcrumbEl.innerHTML = parts.map(function (p) {
      return p.href ? '<a href="' + p.href + '">' + escapeHtml(p.label || '') + '</a>' : '<span>' + escapeHtml(p.label || '') + '</span>';
    }).join(' / ');
  }

  function renderDiff() {
    renderBreadcrumb();
    contentEl.innerHTML = '<div class="file-viewer-truncated">Loading diff…</div>';
    var q = path ? '?path=' + encodeURIComponent(path) : '';
    fetch('/api/diff' + q).then(function (r) {
      if (!r.ok) return r.json().then(function (e) {
        contentEl.innerHTML = '<div class="file-viewer-truncated">' + escapeHtml(e.error || 'Failed to load diff') + '</div>';
      });
      return r.json();
    }).then(function (data) {
      if (!data || !data.files || data.files.length === 0) {
        contentEl.innerHTML = '<div class="file-viewer-truncated">No changes.</div>';
        return;
      }
      diffData = data;
      var toolbar = '<div class="diff-toolbar"><button type="button" class="diff-review-btn">Review</button></div>';
      data.files.forEach(function (f, fileIndex) {
        var filepath = f.path || f.file || '';
        var ext = (filepath.split('/').pop() || '').split('.').pop() || '';
        var lang = extensionToPrismLang(ext);
        var fileComments = comments[filepath] || [];
        var viewed = viewedFiles.has(filepath);
        var ignored = ignoredFiles.has(filepath);
        toolbar += '<div class="diff-file" data-file="' + escapeHtml(filepath) + '">';
        toolbar += '<div class="diff-file-header">' + escapeHtml(filepath || '(unknown)');
        if (fileComments.length) toolbar += ' <span class="diff-comment-count">(' + fileComments.length + ' comment' + (fileComments.length !== 1 ? 's' : '') + ')</span>';
        toolbar += ' <label class="diff-checkbox-label"><input type="checkbox" class="diff-viewed-cb" ' + (viewed ? 'checked' : '') + '><span>Viewed</span></label>';
        toolbar += ' <label class="diff-checkbox-label"><input type="checkbox" class="diff-ignore-cb" ' + (ignored ? 'checked' : '') + '><span>Ignore</span></label>';
        toolbar += ' <button type="button" class="diff-file-comment-btn">Add file comment</button></div>';
        if (!viewed) {
          (comments[filepath] || []).forEach(function (c, cIndex) {
            if (c.lineStart != null) return;
            var isEditing = editingComment && editingComment.filepath === filepath && editingComment.index === cIndex;
            if (isEditing) {
              toolbar += '<div class="diff-comment-form diff-comment-form-edit" data-file="' + escapeHtml(filepath) + '" data-comment-index="' + cIndex + '"><textarea rows="3">' + escapeHtml(c.text || '') + '</textarea><div class="diff-comment-form-actions"><button type="button" class="diff-comment-cancel-edit-btn">Cancel</button><button type="button" class="diff-comment-save-btn">Save</button></div></div>';
            } else {
              toolbar += '<div class="diff-comment-inline" data-file="' + escapeHtml(filepath) + '" data-comment-index="' + cIndex + '"><span class="diff-comment-range">In @' + escapeHtml(filepath) + ': </span><span class="diff-comment-text">' + escapeHtml(c.text || '') + '</span><span class="diff-comment-actions"><button type="button" class="diff-comment-edit-btn">Edit</button><button type="button" class="diff-comment-remove-btn">Remove</button></span></div>';
            }
          });
        }
        if (!viewed && f.hunks && f.hunks.length) {
          f.hunks.forEach(function (hunk, hunkIndex) {
            var hunkKey = filepath + ':' + hunkIndex;
            var extraBefore = expandedBefore[hunkKey] || 0;
            var extraAfter = expandedAfter[hunkKey] || 0;
            var nonAddCount = (hunk.lines || []).filter(function (l) { return l.type !== 'add'; }).length;
            var lastOld = hunk.oldStart + Math.max(0, nonAddCount - 1);
            var canExpandAbove = hunk.oldStart > 1 && (hunk.oldStart - extraBefore) > 1;
            var expandAboveLines = Math.min(5, hunk.oldStart - extraBefore - 1);

            toolbar += '<div class="diff-hunk" data-hunk-key="' + escapeHtml(hunkKey) + '">';
            toolbar += '<div class="diff-hunk-header">' + escapeHtml(hunk.header || '') + '</div>';
            if (extraBefore > 0) {
              var start = Math.max(1, hunk.oldStart - extraBefore);
              var end = hunk.oldStart - 1;
              toolbar += '<div class="diff-context-above" data-file="' + escapeHtml(filepath) + '" data-start="' + start + '" data-end="' + end + '">Loading…</div>';
            }
            if (canExpandAbove) {
              toolbar += '<button type="button" class="diff-expand-row diff-expand-above" data-hunk-key="' + escapeHtml(hunkKey) + '" data-file="' + escapeHtml(filepath) + '" data-old-start="' + hunk.oldStart + '"><span class="diff-expand-icon">↑</span> Expand ' + expandAboveLines + ' line' + (expandAboveLines !== 1 ? 's' : '') + '</button>';
            }
            (hunk.lines || []).forEach(function (line) {
              var cls = 'diff-line diff-line-' + (line.type || 'context');
              var content = highlightLine(line.content || '', line.type, lang);
              var prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
              var oldLineStr = line.oldLine != null ? String(line.oldLine) : '';
              var newLineStr = line.newLine != null ? String(line.newLine) : '';
              var isCommenting = commentingOn && commentingOn.filepath === filepath && String(commentingOn.oldLine) === oldLineStr && String(commentingOn.newLine) === newLineStr;
              toolbar += '<div class="' + cls + '" data-file="' + escapeHtml(filepath) + '" data-old-line="' + oldLineStr + '" data-new-line="' + newLineStr + '">';
              toolbar += '<span class="diff-line-num ' + (line.oldLine == null ? 'empty' : '') + '">' + (line.oldLine != null ? line.oldLine : '') + '</span>';
              toolbar += '<span class="diff-line-num ' + (line.newLine == null ? 'empty' : '') + '">' + (line.newLine != null ? line.newLine : '') + '</span>';
              toolbar += '<span class="diff-line-prefix">' + prefix + '</span><span class="diff-line-content">' + content + '</span></div>';
              if (isCommenting) {
                toolbar += '<div class="diff-comment-form"><textarea placeholder="Add a comment..." rows="3"></textarea><div class="diff-comment-form-actions"><button type="button" class="diff-comment-cancel-btn">Cancel</button><button type="button" class="diff-comment-add-btn">Add comment</button></div></div>';
              }
              (comments[filepath] || []).forEach(function (c, cIndex) {
                var applies = false;
                if (c.lineStart == null) { applies = false; }
                else if (line.newLine != null) {
                  applies = line.newLine >= c.lineStart && line.newLine <= (c.lineEnd != null ? c.lineEnd : c.lineStart);
                } else {
                  applies = line.oldLine != null && line.oldLine === c.lineStart && (c.lineEnd == null || c.lineEnd === c.lineStart);
                }
                if (!applies) return;
                var range = 'In @' + filepath + (c.lineStart != null ? ':' + c.lineStart + (c.lineEnd != null && c.lineEnd !== c.lineStart ? '-' + c.lineEnd : '') : '') + ': ';
                var isEditing = editingComment && editingComment.filepath === filepath && editingComment.index === cIndex;
                if (isEditing) {
                  toolbar += '<div class="diff-comment-form diff-comment-form-edit" data-file="' + escapeHtml(filepath) + '" data-comment-index="' + cIndex + '"><textarea rows="3">' + escapeHtml(c.text || '') + '</textarea><div class="diff-comment-form-actions"><button type="button" class="diff-comment-cancel-edit-btn">Cancel</button><button type="button" class="diff-comment-save-btn">Save</button></div></div>';
                } else {
                  toolbar += '<div class="diff-comment-inline" data-file="' + escapeHtml(filepath) + '" data-comment-index="' + cIndex + '"><span class="diff-comment-range">' + escapeHtml(range) + '</span><span class="diff-comment-text">' + escapeHtml(c.text || '') + '</span><span class="diff-comment-actions"><button type="button" class="diff-comment-edit-btn">Edit</button><button type="button" class="diff-comment-remove-btn">Remove</button></span></div>';
                }
              });
            });
            if (extraAfter > 0) {
              toolbar += '<div class="diff-context-below" data-file="' + escapeHtml(filepath) + '" data-start="' + (lastOld + 1) + '" data-end="' + (lastOld + extraAfter) + '">Loading…</div>';
            }
            toolbar += '<button type="button" class="diff-expand-row diff-expand-below" data-hunk-key="' + escapeHtml(hunkKey) + '" data-file="' + escapeHtml(filepath) + '" data-last-old="' + lastOld + '"><span class="diff-expand-icon">↓</span> Expand 5 lines</button>';
            toolbar += '</div>';
          });
        }
        toolbar += '</div>';
      });
      contentEl.innerHTML = toolbar;

      contentEl.querySelectorAll('.diff-review-btn').forEach(function (btn) {
        btn.onclick = function () {
          var textarea = document.getElementById('diff-review-textarea');
          var modal = document.getElementById('diff-review-modal');
          if (textarea && modal) { textarea.value = getCommentsForReview(); modal.classList.add('visible'); modal.setAttribute('aria-hidden', 'false'); }
        };
      });
      contentEl.querySelectorAll('.diff-viewed-cb').forEach(function (cb) {
        var fileDiv = cb.closest('.diff-file');
        var filepath = fileDiv && fileDiv.getAttribute('data-file');
        if (filepath) cb.onchange = function () { if (cb.checked) viewedFiles.add(filepath); else viewedFiles.delete(filepath); renderDiff(); };
      });
      contentEl.querySelectorAll('.diff-ignore-cb').forEach(function (cb) {
        var fileDiv = cb.closest('.diff-file');
        var filepath = fileDiv && fileDiv.getAttribute('data-file');
        if (filepath) cb.onchange = function () { if (cb.checked) ignoredFiles.add(filepath); else ignoredFiles.delete(filepath); renderDiff(); };
      });
      contentEl.querySelectorAll('.diff-file-comment-btn').forEach(function (btn) {
        var fileDiv = btn.closest('.diff-file');
        var filepath = fileDiv && fileDiv.getAttribute('data-file');
        if (filepath) btn.onclick = function () {
          var text = prompt('File-level comment:');
          if (text == null || !text.trim()) return;
          if (!comments[filepath]) comments[filepath] = [];
          comments[filepath].push({ lineStart: null, lineEnd: null, text: text.trim() });
          renderDiff();
        };
      });
      contentEl.querySelectorAll('.diff-expand-row.diff-expand-above').forEach(function (btn) {
        var key = btn.getAttribute('data-hunk-key');
        if (key) btn.onclick = function () { expandedBefore[key] = (expandedBefore[key] || 0) + 5; renderDiff(); };
      });
      contentEl.querySelectorAll('.diff-expand-row.diff-expand-below').forEach(function (btn) {
        var key = btn.getAttribute('data-hunk-key');
        if (key) btn.onclick = function () { expandedAfter[key] = (expandedAfter[key] || 0) + 5; renderDiff(); };
      });
      contentEl.querySelectorAll('.diff-context-above, .diff-context-below').forEach(function (el) {
        var filepath = el.getAttribute('data-file');
        var start = parseInt(el.getAttribute('data-start'), 10);
        var end = parseInt(el.getAttribute('data-end'), 10);
        if (!filepath || !start || !end) return;
        fetch('/api/diff/context?path=' + encodeURIComponent(filepath) + '&start=' + start + '&end=' + end + '&revision=HEAD').then(function (r) {
          return r.json().then(function (d) {
            if (!r.ok) { el.textContent = (d && d.error) ? d.error : 'No context'; return; }
            if (d && Array.isArray(d.lines)) {
              var lang = extensionToPrismLang((filepath.split('/').pop() || '').split('.').pop() || '');
              el.innerHTML = d.lines.map(function (line, i) {
                var ln = start + i;
                return '<div class="diff-line diff-line-context" data-file="' + escapeHtml(filepath) + '" data-old-line="' + ln + '"><span class="diff-line-num">' + ln + '</span><span class="diff-line-num empty"></span><span class="diff-line-prefix"> </span><span class="diff-line-content">' + highlightLine(line, 'context', lang) + '</span></div>';
              }).join('');
            } else { el.textContent = 'No context'; }
          });
        }).catch(function () { el.textContent = 'Failed to load context'; });
      });
      contentEl.querySelectorAll('.diff-line[data-file]').forEach(function (lineEl) {
        if (!lineEl.hasAttribute('data-old-line') && !lineEl.hasAttribute('data-new-line')) return;
        lineEl.style.cursor = 'pointer';
        lineEl.addEventListener('click', function () {
          var filepath = lineEl.getAttribute('data-file');
          var oldLine = lineEl.getAttribute('data-old-line');
          var newLine = lineEl.getAttribute('data-new-line');
          if (!filepath) return;
          commentingOn = { filepath: filepath, oldLine: oldLine || '', newLine: newLine || '' };
          renderDiff();
        });
      });
      contentEl.querySelectorAll('.diff-comment-form:not(.diff-comment-form-edit)').forEach(function (form) {
        var ta = form.querySelector('textarea');
        var cancelBtn = form.querySelector('.diff-comment-cancel-btn');
        var addBtn = form.querySelector('.diff-comment-add-btn');
        var lineEl = form.previousElementSibling;
        if (!lineEl || !lineEl.classList.contains('diff-line')) return;
        var filepath = lineEl.getAttribute('data-file');
        var oldLine = lineEl.getAttribute('data-old-line');
        var newLine = lineEl.getAttribute('data-new-line');
        var lineStart = (newLine ? parseInt(newLine, 10) : null) || (oldLine ? parseInt(oldLine, 10) : null);
        if (cancelBtn) cancelBtn.onclick = function () { commentingOn = null; renderDiff(); };
        if (addBtn) addBtn.onclick = function () {
          var text = (ta && ta.value || '').trim();
          if (!filepath) return;
          if (!comments[filepath]) comments[filepath] = [];
          comments[filepath].push({ lineStart: lineStart, lineEnd: lineStart, text: text });
          commentingOn = null;
          renderDiff();
        };
        if (ta) setTimeout(function () { ta.focus(); }, 0);
      });
      contentEl.querySelectorAll('.diff-comment-edit-btn').forEach(function (btn) {
        var wrap = btn.closest('.diff-comment-inline');
        if (!wrap) return;
        var filepath = wrap.getAttribute('data-file');
        var index = parseInt(wrap.getAttribute('data-comment-index'), 10);
        if (filepath == null || isNaN(index)) return;
        btn.onclick = function () { editingComment = { filepath: filepath, index: index }; renderDiff(); };
      });
      contentEl.querySelectorAll('.diff-comment-remove-btn').forEach(function (btn) {
        var wrap = btn.closest('.diff-comment-inline');
        if (!wrap) return;
        var filepath = wrap.getAttribute('data-file');
        var index = parseInt(wrap.getAttribute('data-comment-index'), 10);
        if (filepath == null || isNaN(index)) return;
        btn.onclick = function () {
          if (comments[filepath]) {
            comments[filepath].splice(index, 1);
            if (comments[filepath].length === 0) delete comments[filepath];
          }
          if (editingComment && editingComment.filepath === filepath) {
            if (editingComment.index === index) editingComment = null;
            else if (editingComment.index > index) editingComment.index--;
          }
          renderDiff();
        };
      });
      contentEl.querySelectorAll('.diff-comment-form-edit').forEach(function (form) {
        var filepath = form.getAttribute('data-file');
        var index = parseInt(form.getAttribute('data-comment-index'), 10);
        if (filepath == null || isNaN(index) || !comments[filepath] || !comments[filepath][index]) return;
        var ta = form.querySelector('textarea');
        var cancelBtn = form.querySelector('.diff-comment-cancel-edit-btn');
        var saveBtn = form.querySelector('.diff-comment-save-btn');
        if (cancelBtn) cancelBtn.onclick = function () { editingComment = null; renderDiff(); };
        if (saveBtn) saveBtn.onclick = function () {
          comments[filepath][index].text = (ta && ta.value || '').trim();
          editingComment = null;
          renderDiff();
        };
        if (ta) setTimeout(function () { ta.focus(); }, 0);
      });
      var modal = document.getElementById('diff-review-modal');
      if (modal) {
        modal.querySelector('.diff-review-modal-backdrop').onclick = function () { modal.classList.remove('visible'); modal.setAttribute('aria-hidden', 'true'); };
        var cancelBtn = modal.querySelector('.diff-review-cancel-btn');
        if (cancelBtn) cancelBtn.onclick = function () { modal.classList.remove('visible'); modal.setAttribute('aria-hidden', 'true'); };
        var copyBtn = modal.querySelector('.diff-review-copy-btn');
        if (copyBtn) copyBtn.onclick = function () { var ta = document.getElementById('diff-review-textarea'); if (ta) navigator.clipboard.writeText(ta.value); };
        var confirmBtn = modal.querySelector('.diff-review-confirm-btn');
        if (confirmBtn) confirmBtn.onclick = function () {
          var pathsToStage = (diffData.files || []).map(function (f) { return f.path || f.file || ''; }).filter(function (p) { return p && !ignoredFiles.has(p); });
          if (pathsToStage.length === 0) { modal.classList.remove('visible'); modal.setAttribute('aria-hidden', 'true'); return; }
          fetch('/api/diff/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: pathsToStage }) }).then(function (r) {
            if (!r.ok) return r.json().then(function (e) { alert(e.error || 'Failed to stage'); });
            modal.classList.remove('visible'); modal.setAttribute('aria-hidden', 'true');
            renderDiff();
          }).catch(function () { alert('Failed to stage'); });
        };
      }
    }).catch(function () {
      contentEl.innerHTML = '<div class="file-viewer-truncated">Failed to load diff.</div>';
    });
  }

  window._diffViewerOnPopState = function () {
    var r = parseRoute();
    if (r.view === 'diff') initDiffViewer(new URLSearchParams(location.search).get('path') || r.path);
  };
  window.addEventListener('popstate', window._diffViewerOnPopState);
  renderDiff();
}

async function initTerminal() {
  document.getElementById('file-viewer-wrap').classList.remove('visible');
  document.getElementById('file-viewer-wrap').style.display = 'none';
  var diffWrap = document.getElementById('diff-viewer-wrap');
  if (diffWrap) { diffWrap.classList.remove('visible'); diffWrap.style.display = 'none'; }
  document.getElementById('terminal-wrap').style.display = '';
  if (window._fileViewerOnPopState) {
    window.removeEventListener('popstate', window._fileViewerOnPopState);
    window._fileViewerOnPopState = null;
  }
  if (window._diffViewerOnPopState) {
    window.removeEventListener('popstate', window._diffViewerOnPopState);
    window._diffViewerOnPopState = null;
  }
  const authState = await fetch('/api/auth-state').then((r) => r.json()).catch(() => ({}));
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let sessionParam = getSessionParam();
  let wsUrl = `${protocol}//${location.host}?session=${encodeURIComponent(sessionParam)}`;
  try {
    const urlParams = new URLSearchParams(location.search);
    const cwdParam = urlParams.get('cwd');
    if (sessionParam === 'new' && cwdParam) wsUrl += '&cwd=' + encodeURIComponent(cwdParam);
  } catch (_) {}

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
