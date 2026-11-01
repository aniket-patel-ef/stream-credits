/*
 * Stream Credits — setup page: Twitch login, look & feel, OBS link, live preview.
 */
(function () {
  'use strict';

  const SC = window.SC;
  const STORE = 'sc:setup:v1';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const redirectUri = location.origin + location.pathname.replace(/index\.html$/, '');
  const defaultClient = (window.SC_CONFIG && window.SC_CONFIG.clientId) || '';

  let state = load();
  state.opts = Object.assign({}, SC.DEFAULTS, state.opts || {});

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) { /* private mode */ }
  }

  /* ------------------------------------------------------------- helpers */

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 2200);
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast((what || 'Copied') + ' ✓');
  }

  function showError(msg) {
    const el = $('#connect-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  /* --------------------------------------------------------------- OAuth */

  async function finishLogin() {
    const res = SC.twitch.parseAuthHash(location.hash);
    if (!res) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (res.error) { showError('Twitch said: ' + res.error); return; }
    const expected = sessionStorage.getItem('sc:oauth-state');
    sessionStorage.removeItem('sc:oauth-state');
    if (!expected || expected !== res.state) { showError('Login check failed (state mismatch). Please try again.'); return; }
    state.token = res.token;
    save();
  }

  async function refreshAccount() {
    if (!state.token) { renderAccount(); return; }
    try {
      const v = await SC.twitch.validate(state.token);
      if (!v) {
        state.token = '';
        state.user = null;
        save();
        showError('Your Twitch login is no longer valid (expired or revoked). Connect again to get a fresh OBS link.');
      } else {
        state.expiresAt = v.expires_in ? Date.now() + v.expires_in * 1000 : 0;
        state.client = v.client_id;
        const helix = new SC.twitch.Helix(v.client_id, state.token);
        const r = await helix.get('/users', { id: v.user_id });
        const u = r.ok && r.json.data[0];
        state.user = { id: v.user_id, login: v.login, name: u ? u.display_name : v.login, avatar: u ? u.profile_image_url : '' };
        save();
      }
    } catch (e) {
      showError('Could not reach Twitch: ' + e.message);
    }
    renderAccount();
    update();
  }

  function renderAccount() {
    const connected = !!(state.token && state.user);
    $('#account').hidden = !connected;
    $('#connect-form').hidden = connected;
    if (connected) {
      $('#account-avatar').src = state.user.avatar || '';
      $('#account-avatar').hidden = !state.user.avatar;
      $('#account-name').textContent = 'Connected as ' + state.user.name;
      $('#account-expiry').textContent = state.expiresAt
        ? 'Login valid until ' + new Date(state.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : 'Login doesn’t expire on its own';
    }
  }

  $('#connect').addEventListener('click', () => {
    const client = $('#client').value.trim() || defaultClient;
    if (!/^[a-z0-9]{20,40}$/i.test(client)) {
      showError('Paste your Twitch app Client ID first (see “Where do I get a Client ID?”).');
      $('#client-help').open = true;
      $('#client').focus();
      return;
    }
    showError('');
    state.client = client;
    save();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('sc:oauth-state', nonce);
    location.href = SC.twitch.authorizeUrl(client, redirectUri, nonce);
  });

  $('#disconnect').addEventListener('click', () => {
    state.token = '';
    state.user = null;
    state.expiresAt = 0;
    save();
    renderAccount();
    update();
  });

  /* -------------------------------------------------------------- options */

  function bindOptions() {
    const chips = $('#section-chips');
    chips.innerHTML = '';
    SC.ALL_SECTIONS.forEach((key) => {
      const label = document.createElement('label');
      label.className = 'chip';
      label.innerHTML = '<input type="checkbox"><span></span>';
      label.querySelector('input').value = key;
      label.querySelector('span').textContent = SC.SECTION_LABELS[key];
      chips.appendChild(label);
    });

    writeForm();
    $$('[data-opt]').forEach((el) => {
      el.addEventListener(el.type === 'range' || el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio' ? 'input' : 'change', readForm);
    });
    chips.addEventListener('change', readForm);

    $('#accent-picker').addEventListener('input', (e) => {
      $('#accent').value = e.target.value;
      readForm();
    });
    $('#accent-reset').addEventListener('click', () => {
      $('#accent').value = '';
      readForm();
    });
  }

  function writeForm() {
    const o = state.opts;
    $$('[data-opt]').forEach((el) => {
      const k = el.dataset.opt;
      if (el.type === 'radio') el.checked = o[k] === el.value;
      else if (el.type === 'checkbox') el.checked = !!o[k];
      else if (k === 'accent') el.value = o.accent ? '#' + o.accent : '';
      else el.value = o[k];
    });
    if (o.accent) $('#accent-picker').value = '#' + o.accent.padEnd(6, '0');
    const on = new Set(String(o.sections).split(','));
    $$('#section-chips input').forEach((cb) => { cb.checked = on.has(cb.value); });
    $('#speed-out').textContent = o.speed + ' px/s';
  }

  function readForm() {
    const o = state.opts;
    $$('[data-opt]').forEach((el) => {
      const k = el.dataset.opt;
      if (el.type === 'radio') { if (el.checked) o[k] = el.value; }
      else if (el.type === 'checkbox') o[k] = el.checked;
      else if (el.type === 'number' || el.type === 'range') o[k] = el.value === '' ? SC.DEFAULTS[k] : Number(el.value);
      else if (k === 'accent') o.accent = el.value.replace(/[^0-9a-f]/gi, '').slice(0, 6);
      else o[k] = el.value.trim();
    });
    o.sections = $$('#section-chips input').filter((cb) => cb.checked).map((cb) => cb.value).join(',');
    if (/^[0-9a-f]{6}$/i.test(o.accent)) $('#accent-picker').value = '#' + o.accent;
    $('#speed-out').textContent = o.speed + ' px/s';
    save();
    update();
  }

  /* ---------------------------------------------------------- URLs + preview */

  function creditsUrl(extra) {
    const base = new URL('credits.html', location.href);
    base.search = '';
    base.hash = SC.encodeOptions(Object.assign({}, state.opts, extra));
    return base.toString();
  }

  function obsUrl() {
    return state.token ? creditsUrl({ token: state.token }) : creditsUrl({ demo: true });
  }

  let previewTimer;
  function update() {
    const url = obsUrl();
    $('#obs-url').textContent = state.token ? url.replace(/token=[^&]+/, 'token=••••••••••••') : url;
    $('#open-url').href = state.token ? creditsUrl({ token: state.token, debug: true }) : url;
    $('#url-warn').hidden = !!state.token;
    $('#token-hint').hidden = !state.token;
    $('#urlbox').classList.toggle('is-demo', !state.token);

    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 350);
  }

  function previewHash() {
    const name = (state.user && state.user.name) || state.opts.channel || '';
    return SC.encodeOptions(Object.assign({}, state.opts, { demo: true, start: 'load', loop: true, channel: name, token: '' }));
  }

  function renderPreview() {
    const frame = $('#preview');
    const hash = previewHash();
    const target = new URL('credits.html', location.href).toString() + '#' + hash;
    if (!frame.src || !frame.contentWindow || frame.src.split('#')[0] !== target.split('#')[0]) frame.src = target;
    else frame.contentWindow.location.hash = hash;
    $('#preview-frame').dataset.bg = state.opts.bg;
  }

  function fitPreview() {
    const box = $('#preview-frame');
    const scale = box.clientWidth / 1920;
    $('#preview').style.transform = 'scale(' + scale + ')';
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    $('#redirect-uri').textContent = redirectUri;
    $('#client').value = state.client || defaultClient;
    if (defaultClient && !state.client) $('#client-field').hidden = true;
    if (defaultClient) $('#client-help').hidden = true;

    $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy($(b.dataset.copy).textContent, 'Copied')));
    $('#copy-url').addEventListener('click', () => copy(obsUrl(), state.token ? 'OBS link copied' : 'Demo link copied'));
    $('#copy-demo').addEventListener('click', () => copy(creditsUrl({ demo: true }), 'Demo link copied'));
    $('#replay').addEventListener('click', () => { $('#preview').src = 'about:blank'; renderPreview(); });

    bindOptions();
    new ResizeObserver(fitPreview).observe($('#preview-frame'));
    fitPreview();

    await finishLogin();
    renderAccount();
    update();
    refreshAccount();
  }

  boot();
})();
