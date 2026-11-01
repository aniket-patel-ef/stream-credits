/*
 * Stream Credits — Twitch plumbing: OAuth (implicit grant), Helix REST, EventSub WebSocket.
 * Runs in the browser (OBS browser source / setup page). No server involved.
 */
(function (root) {
  'use strict';

  const SCOPES = ['user:read:chat', 'moderator:read:followers', 'moderator:read:chatters'];
  const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
  const HELIX = 'https://api.twitch.tv/helix';

  /* ------------------------------------------------------------------- OAuth */

  function authorizeUrl(clientId, redirectUri, state) {
    const p = new URLSearchParams({
      response_type: 'token',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
    });
    return 'https://id.twitch.tv/oauth2/authorize?' + p.toString();
  }

  function parseAuthHash(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    if (p.get('error')) return { error: p.get('error_description') || p.get('error') };
    if (!p.get('access_token')) return null;
    return { token: p.get('access_token'), state: p.get('state') || '', scope: (p.get('scope') || '').split(' ') };
  }

  /** Returns { client_id, login, user_id, scopes, expires_in } or null when the token is invalid. */
  async function validate(token) {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + token } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error('Twitch validate failed: ' + res.status);
    return res.json();
  }

  /* ------------------------------------------------------------------- Helix */

  class Helix {
    constructor(clientId, token) {
      this.clientId = clientId;
      this.token = token;
    }

    async req(method, path, params, body) {
      const url = new URL(HELIX + path);
      for (const [k, v] of Object.entries(params || {})) {
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
        else if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
      const headers = { 'Client-Id': this.clientId, Authorization: 'Bearer ' + this.token };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let json = null;
      try { json = await res.json(); } catch (_) { /* empty body */ }
      return { ok: res.ok, status: res.status, json };
    }

    get(path, params) { return this.req('GET', path, params); }
    post(path, body) { return this.req('POST', path, null, body); }

    async users(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        const r = await this.get('/users', { id: ids.slice(i, i + 100) });
        if (r.ok) out.push(...r.json.data);
      }
      return out;
    }
  }

  /* ---------------------------------------------------------------- EventSub */

  /**
   * Minimal EventSub WebSocket client: welcome → subscribe, keepalive watchdog,
   * session_reconnect hand-over, exponential back-off on drops, duplicate filtering.
   */
  class EventSub {
    constructor({ helix, subscriptions, onEvent, onStatus }) {
      this.helix = helix;
      this.subscriptions = subscriptions;
      this.onEvent = onEvent;
      this.onStatus = onStatus || function () {};
      this.ws = null;
      this.pending = null;
      this.attempts = 0;
      this.stopped = false;
      this.recent = [];
      this.keepaliveMs = 15000;
      this.failed = [];
    }

    start() { this.stopped = false; this._open(EVENTSUB_URL, false); }

    stop() {
      this.stopped = true;
      clearTimeout(this.watchdog);
      clearTimeout(this.retry);
      [this.ws, this.pending].forEach((ws) => ws && ws.close());
    }

    _open(url, handover) {
      const ws = new WebSocket(url);
      if (handover) this.pending = ws; else this.ws = ws;
      ws.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(m.data); } catch (_) { return; }
        this._message(ws, msg);
      };
      ws.onclose = () => {
        if (this.stopped) return;
        if (ws === this.pending) {
          // Hand-over failed before its welcome; fall back to a fresh connection if the old one is gone too.
          this.pending = null;
          if (this.ws && this.ws.readyState >= WebSocket.CLOSING) { this.onStatus('reconnecting'); this._backoff(); }
          return;
        }
        if (ws !== this.ws || this.pending) return;
        this.onStatus('reconnecting');
        this._backoff();
      };
      ws.onerror = () => {};
    }

    _backoff() {
      clearTimeout(this.retry);
      const delay = Math.min(30000, 1000 * Math.pow(2, this.attempts++)) + Math.random() * 500;
      this.retry = setTimeout(() => this._open(EVENTSUB_URL, false), delay);
    }

    _feed(ws) {
      if (ws !== this.ws) return;
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => ws.close(), this.keepaliveMs + 5000);
    }

    async _message(ws, msg) {
      const meta = msg.metadata || {};
      const payload = msg.payload || {};
      switch (meta.message_type) {
        case 'session_welcome': {
          const sess = payload.session;
          this.keepaliveMs = (sess.keepalive_timeout_seconds || 10) * 1000;
          if (ws === this.pending) {
            // Twitch moved us to a new edge server; subscriptions carry over.
            const old = this.ws;
            this.ws = ws;
            this.pending = null;
            if (old) old.close();
            this._feed(ws);
            return;
          }
          this._feed(ws);
          this.attempts = 0;
          await this._subscribe(sess.id);
          return;
        }
        case 'session_keepalive':
          this._feed(ws);
          return;
        case 'notification': {
          this._feed(ws);
          if (this.recent.indexOf(meta.message_id) !== -1) return;
          this.recent.push(meta.message_id);
          if (this.recent.length > 500) this.recent.shift();
          this.onEvent(payload.subscription.type, payload.event);
          return;
        }
        case 'session_reconnect':
          this._open(payload.session.reconnect_url, true);
          return;
        case 'revocation':
          this.onStatus('revoked', payload.subscription && payload.subscription.type);
          return;
        default:
      }
    }

    async _subscribe(sessionId) {
      const ok = [];
      const failed = [];
      for (const sub of this.subscriptions) {
        const r = await this.helix.post('/eventsub/subscriptions', {
          type: sub.type,
          version: sub.version,
          condition: sub.condition,
          transport: { method: 'websocket', session_id: sessionId },
        });
        if (r.ok || r.status === 409) ok.push(sub.type);
        else {
          failed.push({ type: sub.type, status: r.status, message: (r.json && r.json.message) || '' });
          if (r.status === 401) { this.onStatus('unauthorized'); this.stop(); return; }
        }
      }
      this.failed = failed;
      this.onStatus('connected', { ok, failed });
    }
  }

  function subscriptionsFor(broadcasterId, userId) {
    return [
      { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: userId } },
      { type: 'channel.chat.notification', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: userId } },
      { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: userId } },
      { type: 'stream.online', version: '1', condition: { broadcaster_user_id: broadcasterId } },
      { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    ];
  }

  root.SC = Object.assign(root.SC || {}, {
    twitch: { SCOPES, authorizeUrl, parseAuthHash, validate, Helix, EventSub, subscriptionsFor },
  });
})(typeof window !== 'undefined' ? window : globalThis);
