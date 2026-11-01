/*
 * Stream Credits — collector.
 * Listens to Twitch while OBS is running, keeps one session per stream in localStorage.
 * If several overlay copies are open, a Web Lock makes sure only one of them collects.
 */
(function (root) {
  'use strict';

  const SC = root.SC;
  const GRACE_MS = 30 * 60000;      // keep counting chat for 30 min after the stream ends (raid-out, "o7")
  const ADOPT_MS = 3 * 3600000;     // an offline session started < 3h before going live becomes that stream's session
  const SAVE_DEBOUNCE_MS = 1000;

  class Collector {
    constructor(opts, hooks) {
      hooks = hooks || {};
      this.opts = opts;
      this.onStatus = hooks.onStatus || function () {};
      this.onChange = hooks.onChange || function () {};
      this.state = 'starting';
      this.detail = '';
      this.leader = false;
      this.session = null;
      this.scopes = [];
      this.failed = [];
      this.offlinePolls = 0;
    }

    status(state, detail) {
      this.state = state;
      this.detail = detail || '';
      this.onStatus(state, this.detail);
    }

    /* ------------------------------------------------------------- startup */

    async start() {
      let v;
      try {
        v = await SC.twitch.validate(this.opts.token);
      } catch (e) {
        this.status('error', 'Could not reach Twitch (' + e.message + '). Retrying in 30s…');
        setTimeout(() => this.start(), 30000);
        return false;
      }
      if (!v) {
        this.status('unauthorized', 'Twitch token expired or revoked. Reconnect on the setup page and update the OBS URL.');
        return false;
      }
      this.me = { id: v.user_id, login: v.login };
      this.scopes = v.scopes || [];
      this.expiresAt = v.expires_in ? Date.now() + v.expires_in * 1000 : 0;
      this.helix = new SC.twitch.Helix(v.client_id, this.opts.token);

      const login = (this.opts.channel || v.login).toLowerCase();
      const r = await this.helix.get('/users', { login });
      const u = r.ok && r.json.data[0];
      if (!u) {
        this.status('error', 'Twitch channel "' + login + '" not found.');
        return false;
      }
      this.broadcaster = { id: u.id, login: u.login, name: u.display_name };
      this.broadcasterAvatar = u.profile_image_url;
      this.key = 'sc:session:' + u.id;
      this.prevKey = 'sc:prev:' + u.id;
      this.session = this.load();

      // Followers of other copies: reload whenever the collecting copy saves.
      root.addEventListener('storage', (e) => {
        if (!this.leader && e.key === this.key) {
          this.session = this.load();
          this.onChange(this.session);
        }
      });
      this.channel = 'BroadcastChannel' in root ? new BroadcastChannel('stream-credits:' + u.id) : null;
      if (this.channel) this.channel.onmessage = (m) => { if (this.leader && m.data === 'reset') this.reset(); };

      if (root.navigator && navigator.locks && navigator.locks.request) {
        const waiting = setTimeout(() => {
          if (!this.leader) this.status('standby', 'Another copy of this overlay is collecting — this one just displays.');
        }, 1500);
        navigator.locks.request('stream-credits:' + u.id, () => {
          clearTimeout(waiting);
          return new Promise(() => this.lead()); // hold the lock for the lifetime of the page
        });
      } else {
        this.lead();
      }
      return true;
    }

    async lead() {
      this.leader = true;
      this.session = this.load() || this.session;
      this.status('connecting', 'Connecting to Twitch…');
      await this.syncStream(true);
      this.es = new SC.twitch.EventSub({
        helix: this.helix,
        subscriptions: SC.twitch.subscriptionsFor(this.broadcaster.id, this.me.id),
        onEvent: (type, event) => this.onTwitch(type, event),
        onStatus: (state, detail) => this.onSocket(state, detail),
      });
      this.es.start();
      setInterval(() => this.syncStream(false), 60000);
      setInterval(() => this.pollChatters(), 5 * 60000);
      this.pollChatters();
    }

    onSocket(state, detail) {
      if (state === 'connected') {
        this.failed = (detail && detail.failed) || [];
        const missing = this.failed.map((f) => f.type.replace('channel.', '')).join(', ');
        this.status('collecting', missing ? 'Connected, but Twitch refused: ' + missing : 'Connected — counting chat, follows, subs, bits and raids.');
      } else if (state === 'unauthorized') {
        this.status('unauthorized', 'Twitch token expired or revoked. Reconnect on the setup page and update the OBS URL.');
      } else if (state === 'reconnecting') {
        this.status('reconnecting', 'Lost connection to Twitch, reconnecting…');
      } else if (state === 'revoked') {
        this.status('error', 'Twitch revoked the ' + detail + ' subscription.');
      }
    }

    /* ----------------------------------------------------------- lifecycle */

    isLive() {
      const st = this.session && this.session.stream;
      return !!(st && !st.endedAt);
    }

    recording() {
      const st = this.session && this.session.stream;
      if (!st || !st.endedAt) return true;
      return Date.now() - st.endedAt < GRACE_MS;
    }

    /** Make sure the current session belongs to this stream. Returns true when a new session started. */
    goLive(info) {
      const s = this.session;
      if (s && s.stream && s.stream.id === info.id) {
        s.stream.endedAt = null;
        if (info.title) s.stream.title = info.title;
        if (info.game) s.stream.game = info.game;
        return false;
      }
      if (s && !s.stream && s.createdAt > (Date.parse(info.startedAt) || Date.now()) - ADOPT_MS) {
        s.stream = Object.assign({ title: '', game: '', endedAt: null }, info);
        return true;
      }
      this.archive();
      this.session = SC.createSession(this.broadcaster, Object.assign({ title: '', game: '', endedAt: null }, info));
      return true;
    }

    async syncStream(initial) {
      let r;
      try { r = await this.helix.get('/streams', { user_id: this.broadcaster.id }); } catch (_) { return; }
      if (!r.ok) return;
      if (!this.session) this.session = SC.createSession(this.broadcaster, null);
      const live = r.json.data[0];
      if (live) {
        this.offlinePolls = 0;
        const fresh = this.goLive({ id: live.id, title: live.title, game: live.game_name, startedAt: live.started_at });
        SC.applyEvent(this.session, { type: 'viewers', count: live.viewer_count });
        if (fresh || initial) await this.backfillFollowers(Date.parse(live.started_at));
      } else if (this.isLive()) {
        // /streams lags a minute or two behind stream.online, so don't end a stream on a single empty poll.
        if (initial) this.session.stream.endedAt = this.session.updatedAt;
        else if (++this.offlinePolls >= 3) this.session.stream.endedAt = Date.now();
      }
      this.session.broadcaster = Object.assign({}, this.broadcaster);
      if (this.broadcasterAvatar) this.session.avatars[this.broadcaster.id] = this.broadcasterAvatar;
      this.save();
    }

    /** Followers who followed after the stream started but before this overlay was running. */
    async backfillFollowers(since) {
      if (!since || this.scopes.indexOf('moderator:read:followers') === -1) return;
      let after;
      let pages = 0;
      outer: do {
        const r = await this.helix.get('/channels/followers', { broadcaster_id: this.broadcaster.id, first: 100, after });
        if (!r.ok || !r.json.data) return;
        for (const f of r.json.data) {
          const at = Date.parse(f.followed_at);
          if (at < since) break outer;
          SC.applyEvent(this.session, { type: 'follow', id: 'follow:' + f.user_id, user: { id: f.user_id, login: f.user_login, name: f.user_name }, at });
        }
        after = r.json.pagination && r.json.pagination.cursor;
      } while (after && ++pages < 10);
    }

    async pollChatters() {
      if (!this.leader || !this.session || this.scopes.indexOf('moderator:read:chatters') === -1) return;
      const st = this.session.stream;
      if (st && st.endedAt) return;
      const users = [];
      let after;
      let pages = 0;
      do {
        let r;
        try {
          r = await this.helix.get('/chat/chatters', { broadcaster_id: this.broadcaster.id, moderator_id: this.me.id, first: 1000, after });
        } catch (_) { return; }
        if (!r.ok) return;
        r.json.data.forEach((c) => users.push({ id: c.user_id, login: c.user_login, name: c.user_name }));
        after = r.json.pagination && r.json.pagination.cursor;
      } while (after && ++pages < 5);
      if (users.length) {
        SC.applyEvent(this.session, { type: 'present', users });
        this.save();
      }
    }

    /* -------------------------------------------------------------- events */

    onTwitch(type, event) {
      let changed = false;
      for (const ev of SC.normalize(type, event)) {
        if (ev.type === 'online') {
          this.offlinePolls = 0;
          if (this.goLive({ id: ev.streamId, startedAt: ev.startedAt })) this.backfillFollowers(Date.parse(ev.startedAt));
          changed = true;
          if (this.helix) setTimeout(() => this.syncStream(false), 90000); // pick up title + game once /streams catches up
        } else if (ev.type === 'offline') {
          if (this.isLive()) { this.session.stream.endedAt = Date.now(); changed = true; }
        } else if (this.recording() && SC.applyEvent(this.session, ev)) {
          changed = true;
        }
      }
      if (changed) this.save();
    }

    /* ------------------------------------------------------------- storage */

    load() {
      try {
        const s = JSON.parse(localStorage.getItem(this.key));
        return s && s.v === 1 ? s : null;
      } catch (_) {
        return null;
      }
    }

    save(now) {
      if (!this.leader || !this.session) return;
      clearTimeout(this.saveTimer);
      const write = () => {
        try {
          localStorage.setItem(this.key, JSON.stringify(this.session));
        } catch (_) {
          this.session.seen = this.session.seen.slice(-300);
          try { localStorage.setItem(this.key, JSON.stringify(this.session)); } catch (e) { /* storage full; keep in memory */ }
        }
        this.onChange(this.session);
      };
      if (now) write(); else this.saveTimer = setTimeout(write, SAVE_DEBOUNCE_MS);
    }

    archive() {
      const s = this.session;
      if (!s || !Object.keys(s.users).length) return;
      try { localStorage.setItem(this.prevKey, JSON.stringify(s)); } catch (_) { /* ignore */ }
    }

    /** Start a fresh session (keeps the current stream info if live). */
    reset() {
      if (!this.leader) {
        if (this.channel) this.channel.postMessage('reset');
        return;
      }
      const stream = this.isLive() ? Object.assign({}, this.session.stream) : null;
      this.archive();
      this.session = SC.createSession(this.broadcaster, stream);
      if (this.broadcasterAvatar) this.session.avatars[this.broadcaster.id] = this.broadcasterAvatar;
      this.save(true);
    }

    getSession() {
      if (this.leader) return this.session;
      return this.load() || this.session;
    }

    /** Fill s.avatars with profile pictures for the given user ids (mutates s). */
    async fetchAvatars(s, ids) {
      if (!s || !this.helix) return;
      const missing = ids.filter((id) => !s.avatars[id]);
      if (!missing.length) return;
      const users = await this.helix.users(missing);
      users.forEach((u) => { s.avatars[u.id] = u.profile_image_url; });
      if (this.leader) this.save();
    }
  }

  root.SC = Object.assign(root.SC || {}, { Collector });
})(typeof window !== 'undefined' ? window : globalThis);
