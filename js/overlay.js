/*
 * Stream Credits — OBS browser source controller (credits.html).
 *
 * Collects during the stream, rolls the credits when the scene goes live.
 * Keys (OBS: right-click source → Interact): R roll · S stop · D debug panel · Shift+X twice = new session
 */
(function () {
  'use strict';

  const SC = window.SC;
  const stage = document.getElementById('stage');
  const pill = document.getElementById('status');
  const panel = document.getElementById('debug');
  const roller = new SC.Roller(stage);
  const inOBS = !!window.obsstudio;
  const embedded = window.top !== window; // setup-page preview

  let opts = SC.parseOptions(location.search, location.hash);
  let collector = null;
  let demo = null;

  /* ------------------------------------------------------------------ look */

  function hexToRgb(hex) {
    const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',');
  }

  function applyLook() {
    const html = document.documentElement;
    html.className = 'theme-' + opts.theme + ' bg-' + opts.bg + (inOBS ? ' in-obs' : '');
    html.style.setProperty('--scale', opts.scale);
    if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(opts.accent)) {
      html.style.setProperty('--accent', '#' + opts.accent);
      html.style.setProperty('--accent-rgb', hexToRgb(opts.accent));
    } else {
      html.style.removeProperty('--accent');
      html.style.removeProperty('--accent-rgb');
    }
  }

  /* ------------------------------------------------------------------ roll */

  async function roll() {
    let session;
    if (opts.demo) session = demo || (demo = SC.demoSession(opts));
    else if (collector) session = collector.getSession();
    if (!session) {
      setStatus('warn', opts.token ? 'Nothing collected yet.' : 'Not connected — open the setup page to get your OBS link.');
      return;
    }
    let credits = SC.buildCredits(session, opts);
    if (collector) {
      try {
        await Promise.race([collector.fetchAvatars(session, SC.avatarIds(credits)), new Promise((r) => setTimeout(r, 2500))]);
        credits = SC.buildCredits(session, opts);
      } catch (_) { /* avatars are optional */ }
    }
    roller.play(credits, opts);
  }

  roller.onLoop = roll;

  /* ---------------------------------------------------------------- status */

  // The pill stays out of the way in OBS and the setup preview, except when something is broken.
  function pillHidden() {
    return (inOBS || embedded) && !opts.debug && panel.hidden && pill.dataset.level !== 'error';
  }

  function setStatus(level, text) {
    pill.dataset.level = level;
    pill.textContent = text;
    pill.hidden = pillHidden();
    renderDebug();
  }

  function renderDebug() {
    if (!panel.hidden) {
      const s = opts.demo ? demo : collector && collector.getSession();
      const t = (s && s.totals) || {};
      const rows = [
        ['Mode', opts.demo ? 'demo' : collector ? collector.state : 'not connected'],
        ['Detail', collector ? collector.detail : ''],
        ['Collecting here', collector ? (collector.leader ? 'yes' : 'no (another copy is)') : '—'],
        ['Channel', s && s.broadcaster ? s.broadcaster.name : '—'],
        ['Stream', s && s.stream ? (s.stream.endedAt ? 'ended ' + new Date(s.stream.endedAt).toLocaleTimeString() : 'live') + (s.stream.title ? ' · ' + s.stream.title : '') : 'offline session'],
        ['Messages / chatters', (t.messages || 0) + ' / ' + (s ? Object.values(s.users).filter((u) => u.messages).length : 0)],
        ['Follows / subs / gifts', (t.follows || 0) + ' / ' + (t.subs || 0) + ' / ' + (t.giftedSubs || 0)],
        ['Bits / raids', (t.bits || 0) + ' / ' + (t.raids || 0)],
        ['Token expires', collector && collector.expiresAt ? new Date(collector.expiresAt).toLocaleDateString() : '—'],
      ];
      panel.innerHTML = '<b>Stream Credits</b>' + rows.map(([k, v]) => '<div><span>' + k + '</span><em></em></div>').join('') +
        '<small>R roll · S stop · D hide · Shift+X twice = new session</small>';
      panel.querySelectorAll('em').forEach((em, i) => { em.textContent = rows[i][1]; });
    }
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    applyLook();
    panel.hidden = !opts.debug;
    pill.hidden = pillHidden();

    if (opts.demo) {
      setStatus('ok', 'Demo data');
    } else if (opts.token) {
      collector = new SC.Collector(opts, {
        onStatus: (state, detail) => setStatus(state === 'collecting' ? 'ok' : state === 'standby' ? 'idle' : ['error', 'unauthorized'].includes(state) ? 'error' : 'warn', detail || state),
        onChange: () => renderDebug(),
      });
      collector.start();
    } else {
      setStatus('warn', 'Not connected — open the setup page to get your OBS link.');
    }

    if (opts.start === 'load' || (opts.start === 'active' && !inOBS)) roll();
  }

  // OBS: roll when the scene holding this source goes to Program, stop when it leaves.
  window.addEventListener('obsSourceActiveChanged', (e) => {
    if (opts.start !== 'active') return;
    if (e.detail && e.detail.active) roll(); else roller.stop();
  });

  // The setup page live-updates its preview by changing the hash.
  window.addEventListener('hashchange', () => {
    const next = SC.parseOptions(location.search, location.hash);
    if (next.token !== opts.token || next.channel !== opts.channel) { location.reload(); return; }
    opts = next;
    demo = null;
    applyLook();
    if (opts.start !== 'manual') roll(); else roller.stop();
  });

  let resetArmed = 0;
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') roll();
    else if (k === 's') roller.stop();
    else if (k === 'd') { panel.hidden = !panel.hidden; pill.hidden = pillHidden(); renderDebug(); }
    else if (k === 'x' && e.shiftKey && collector) {
      if (Date.now() - resetArmed < 3000) {
        collector.reset();
        resetArmed = 0;
        setStatus('ok', 'Started a fresh session.');
      } else {
        resetArmed = Date.now();
        setStatus('warn', 'Press Shift+X again to wipe this session and start fresh.');
      }
    }
  });

  boot();
})();
