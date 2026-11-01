/*
 * Stream Credits — core logic (no DOM, no network).
 * Shared by the overlay, the setup page and the Node tests.
 *
 * Flow: Twitch EventSub payload → normalize() → applyEvent(session) → buildCredits(session) → roller
 */
(function (root) {
  'use strict';

  // Rough "bits equivalent" of a sub so bits, subs and gift subs can be ranked together.
  // 100 bits ≈ $1, a Tier 1 sub ≈ $5.
  const SUB_POINTS = { '1000': 500, '2000': 1000, '3000': 2500 };

  const DEFAULT_BOTS = [
    'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'sery_bot',
    'soundalerts', 'kofistreambot', 'botrixoficial', 'pokemoncommunitygame', 'commanderroot',
    'streamstickers', 'frostytoolsdotcom', 'blerp', 'own3d', 'lumiastream', 'tangiabot',
    'creatisbot', 'songlistbot', 'streamlootsbot', 'streamjar', 'pretzelrocks', 'mixitupbot',
    'deepbot', 'phantombot', 'coebot', 'ankhbot', 'botisimo', 'vivbot', 'dixperbro', 'kikettebot',
    'playwithviewersbot', 'buttsbot', 'regressz', 'drapsnatt', 'anotherttvviewer',
  ];

  const ALL_SECTIONS = [
    'starring', 'chatters', 'supporters', 'gifters', 'subs', 'cheers', 'raids',
    'followers', 'mods', 'cast', 'lurkers', 'stats',
  ];

  const SECTION_LABELS = {
    starring: 'Starring',
    chatters: 'Top Chatters',
    supporters: 'Top Supporters',
    gifters: 'Gift Subs',
    subs: 'Subscribers',
    cheers: 'Bits',
    raids: 'Raided By',
    followers: 'New Followers',
    mods: 'Moderators',
    cast: 'Chat',
    lurkers: 'Lurkers',
    stats: 'By the Numbers',
  };

  const DEFAULTS = {
    theme: 'glass',          // glass | kawaii | cinema
    accent: '',              // hex without '#', empty = theme default
    title: 'Stream Credits',
    tagline: 'Thank you for watching',
    outro: 'See you next stream',
    outro2: 'Stay safe & have a great week',
    speed: 90,               // px per second at 1080p
    duration: 0,             // seconds; when > 0 it overrides speed
    hold: 8,                 // seconds the final card stays on screen
    loop: false,
    start: 'active',         // active (OBS scene goes live) | load | manual
    bg: 'none',              // none | dim | solid
    top: 10,
    sections: ALL_SECTIONS.join(','),
    ignore: '',              // extra logins to leave out (comma separated)
    showbots: false,
    scale: 1,
    debug: false,
    demo: false,
    token: '',
    channel: '',             // broadcaster login, when the token belongs to a moderator
  };

  const BOOL_KEYS = ['loop', 'debug', 'demo', 'showbots'];
  const NUM_KEYS = ['speed', 'duration', 'hold', 'top', 'scale'];

  const MAX_SEEN = 4000;
  const MAX_NAMES = 400;

  /* ----------------------------------------------------------------- options */

  function parseOptions(search, hash) {
    const out = Object.assign({}, DEFAULTS);
    const merge = (str) => {
      const p = new URLSearchParams(String(str || '').replace(/^[?#]/, ''));
      for (const [k, v] of p) {
        if (k === 'access_token') continue;
        if (!(k in DEFAULTS)) continue;
        if (BOOL_KEYS.includes(k)) out[k] = v === '' || v === '1' || v === 'true';
        else if (NUM_KEYS.includes(k)) { const n = parseFloat(v); if (Number.isFinite(n)) out[k] = n; }
        else out[k] = v;
      }
    };
    merge(search);
    merge(hash);
    out.top = clamp(Math.round(out.top), 1, 50);
    out.speed = clamp(out.speed, 10, 1000);
    out.hold = clamp(out.hold, 0, 600);
    out.scale = clamp(out.scale, 0.4, 3);
    if (!['glass', 'kawaii', 'cinema'].includes(out.theme)) out.theme = 'glass';
    if (!['none', 'dim', 'solid'].includes(out.bg)) out.bg = 'none';
    if (!['active', 'load', 'manual'].includes(out.start)) out.start = 'active';
    out.accent = String(out.accent || '').replace(/[^0-9a-f]/gi, '').slice(0, 6);
    return out;
  }

  /** Serialise only the options that differ from the defaults (keeps OBS URLs short). */
  function encodeOptions(opts) {
    const p = new URLSearchParams();
    for (const k of Object.keys(DEFAULTS)) {
      const v = opts[k];
      if (v === undefined || v === null) continue;
      if (BOOL_KEYS.includes(k)) { if (v && !DEFAULTS[k]) p.set(k, '1'); continue; }
      if (String(v) === String(DEFAULTS[k])) continue;
      if (v === '' && DEFAULTS[k] !== '') { p.set(k, ''); continue; }
      if (v === '') continue;
      p.set(k, String(v));
    }
    return p.toString();
  }

  /* ----------------------------------------------------------------- session */

  function createSession(broadcaster, stream, now) {
    now = now || Date.now();
    return {
      v: 1,
      broadcaster: broadcaster ? { id: String(broadcaster.id), login: broadcaster.login || '', name: broadcaster.name || broadcaster.login || '' } : null,
      stream: stream ? Object.assign({ id: '', title: '', game: '', startedAt: null, endedAt: null }, stream) : null,
      createdAt: now,
      updatedAt: now,
      users: {},
      order: { follows: [], subs: [], raids: [] },
      totals: { messages: 0, bits: 0, subs: 0, giftedSubs: 0, follows: 0, raids: 0, raidViewers: 0 },
      peakViewers: 0,
      avatars: {},
      seen: [],
    };
  }

  const ANON = { id: 'anon', login: 'anonymous', name: 'Anonymous', color: '' };

  function user(id, login, name, color) {
    if (!id && !login) return null;
    return { id: String(id || login), login: String(login || name || '').toLowerCase(), name: name || login || 'Unknown', color: color || '' };
  }

  function upsert(s, u, now) {
    let rec = s.users[u.id];
    if (!rec) {
      rec = s.users[u.id] = {
        id: u.id, login: u.login, name: u.name, color: u.color || '',
        messages: 0, bits: 0, gifted: 0, giftPoints: 0, raidViewers: 0, firstAt: now,
      };
    } else {
      if (u.name) rec.name = u.name;
      if (u.login) rec.login = u.login;
      if (u.color) rec.color = u.color;
    }
    return rec;
  }

  /* --------------------------------------------------------------- normalize */

  /**
   * Turn a Twitch EventSub notification into zero or more internal events.
   * Internal events: chat, follow, sub, gift, raid, online, offline.
   */
  function normalize(type, e) {
    if (!e) return [];
    const fromOtherChannel = e.source_broadcaster_user_id && e.source_broadcaster_user_id !== e.broadcaster_user_id;

    switch (type) {
      case 'channel.chat.message': {
        if (fromOtherChannel) return []; // shared chat: message belongs to another channel
        return [{
          type: 'chat',
          id: e.message_id,
          user: user(e.chatter_user_id, e.chatter_user_login, e.chatter_user_name, e.color),
          badges: (e.badges || []).map((b) => b.set_id),
          bits: (e.cheer && e.cheer.bits) || 0,
        }];
      }

      case 'channel.chat.notification': {
        if (fromOtherChannel || String(e.notice_type || '').startsWith('shared_chat')) return [];
        const id = e.message_id;
        const chatter = e.chatter_is_anonymous ? null : user(e.chatter_user_id, e.chatter_user_login, e.chatter_user_name, e.color);
        switch (e.notice_type) {
          case 'sub':
            return chatter && e.sub ? [{ type: 'sub', kind: 'new', id, user: chatter, tier: e.sub.sub_tier, prime: !!e.sub.is_prime, months: 1 }] : [];
          case 'resub':
            return chatter && e.resub ? [{
              type: 'sub', kind: 'resub', id, user: chatter, tier: e.resub.sub_tier, prime: !!e.resub.is_prime,
              months: e.resub.cumulative_months || 1,
            }] : [];
          case 'sub_gift': {
            const g = e.sub_gift;
            if (!g) return [];
            const out = [];
            const recipient = user(g.recipient_user_id, g.recipient_user_login, g.recipient_user_name);
            if (recipient) {
              out.push({ type: 'sub', kind: 'gift', id: id + ':to', user: recipient, tier: g.sub_tier, months: 1, gifter: chatter ? chatter.name : ANON.name });
            }
            // Gifts that are part of a community gift are counted once via community_sub_gift.
            if (!g.community_gift_id) out.push({ type: 'gift', id, gifter: chatter, count: 1, tier: g.sub_tier });
            return out;
          }
          case 'community_sub_gift': {
            const g = e.community_sub_gift;
            return g ? [{ type: 'gift', id, gifter: chatter, count: g.total || 1, tier: g.sub_tier }] : [];
          }
          case 'gift_paid_upgrade':
            return chatter ? [{ type: 'sub', kind: 'upgrade', id, user: chatter, tier: '1000', months: 1 }] : [];
          case 'prime_paid_upgrade':
            return chatter ? [{ type: 'sub', kind: 'upgrade', id, user: chatter, tier: (e.prime_paid_upgrade && e.prime_paid_upgrade.sub_tier) || '1000', months: 1 }] : [];
          case 'raid': {
            const r = e.raid;
            const u = r && user(r.user_id, r.user_login, r.user_name);
            return u ? [{ type: 'raid', id, user: u, viewers: r.viewer_count || 0, avatar: r.profile_image_url || '' }] : [];
          }
          default:
            return [];
        }
      }

      case 'channel.follow': {
        const u = user(e.user_id, e.user_login, e.user_name);
        return u ? [{ type: 'follow', id: 'follow:' + u.id, user: u, at: Date.parse(e.followed_at) || null }] : [];
      }

      case 'stream.online':
        return [{ type: 'online', streamId: e.id, startedAt: e.started_at }];

      case 'stream.offline':
        return [{ type: 'offline' }];

      default:
        return [];
    }
  }

  /* ------------------------------------------------------------------ reduce */

  function subPoints(tier) { return SUB_POINTS[String(tier)] || SUB_POINTS['1000']; }

  /** Apply one internal event to the session. Returns false when it was a duplicate. */
  function applyEvent(s, ev, now) {
    now = now || Date.now();
    if (ev.id) {
      if (s.seen.indexOf(ev.id) !== -1) return false;
      s.seen.push(ev.id);
      if (s.seen.length > MAX_SEEN) s.seen.splice(0, s.seen.length - MAX_SEEN);
    }
    const T = s.totals;

    switch (ev.type) {
      case 'chat': {
        if (!ev.user) return false;
        const u = upsert(s, ev.user, now);
        u.messages++;
        T.messages++;
        if (ev.badges && ev.badges.indexOf('moderator') !== -1) u.mod = true;
        if (ev.badges && ev.badges.indexOf('vip') !== -1) u.vip = true;
        if (ev.bits > 0) { u.bits += ev.bits; T.bits += ev.bits; }
        break;
      }
      case 'follow': {
        const u = upsert(s, ev.user, now);
        if (u.followedAt) return false;
        u.followedAt = ev.at || now;
        T.follows++;
        s.order.follows.push(u.id);
        break;
      }
      case 'sub': {
        if (!ev.user) return false;
        const u = upsert(s, ev.user, now);
        if (!u.sub) s.order.subs.push(u.id);
        u.sub = { kind: ev.kind || 'new', tier: String(ev.tier || '1000'), prime: !!ev.prime, months: ev.months || 1 };
        if (ev.gifter) u.sub.gifter = ev.gifter;
        T.subs++;
        break;
      }
      case 'gift': {
        const u = upsert(s, ev.gifter || ANON, now);
        const n = Math.max(1, ev.count | 0);
        u.gifted += n;
        u.giftPoints += n * subPoints(ev.tier);
        T.giftedSubs += n;
        break;
      }
      case 'raid': {
        const u = upsert(s, ev.user, now);
        u.raidViewers += ev.viewers | 0;
        if (ev.avatar) s.avatars[u.id] = ev.avatar;
        T.raids++;
        T.raidViewers += ev.viewers | 0;
        if (s.order.raids.indexOf(u.id) === -1) s.order.raids.push(u.id);
        break;
      }
      case 'viewers':
        s.peakViewers = Math.max(s.peakViewers, ev.count | 0);
        break;
      case 'present': // periodic snapshot of everyone in chat, used to spot lurkers
        for (const p of ev.users || []) {
          if (Object.keys(s.users).length > 6000 && !s.users[p.id]) break;
          upsert(s, p, now).present = true;
        }
        break;
      default:
        return false;
    }
    s.updatedAt = now;
    return true;
  }

  /* ------------------------------------------------------------------- build */

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const plural = (n, word) => fmt(n) + ' ' + word + (n === 1 ? '' : 's');

  function supportScore(u) {
    const ownSub = u.sub && u.sub.kind !== 'gift' ? subPoints(u.sub.tier) : 0;
    return (u.bits || 0) + (u.giftPoints || 0) + ownSub;
  }

  function supportDetail(u) {
    const parts = [];
    if (u.gifted) parts.push(plural(u.gifted, 'gift sub'));
    if (u.bits) parts.push(fmt(u.bits) + ' bits');
    if (u.sub && u.sub.kind !== 'gift') {
      if (u.sub.kind === 'resub') parts.push('resub · ' + u.sub.months + ' mo');
      else if (u.sub.prime) parts.push('prime sub');
      else parts.push((u.sub.tier !== '1000' ? 'tier ' + (+u.sub.tier / 1000) + ' ' : '') + 'sub');
    }
    return parts.join(' · ');
  }

  function subBadge(sub) {
    if (sub.kind === 'gift') return 'gifted';
    if (sub.kind === 'resub') return sub.months + ' mo';
    if (sub.prime) return 'prime';
    if (sub.tier !== '1000') return 'tier ' + (+sub.tier / 1000);
    return sub.kind === 'upgrade' ? 'upgraded' : 'new';
  }

  function durationText(ms) {
    if (!ms || ms < 60000) return '';
    const m = Math.round(ms / 60000);
    const h = Math.floor(m / 60);
    return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm';
  }

  function splitList(str) {
    return String(str || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  }

  function capNames(list) {
    if (list.length <= MAX_NAMES) return list;
    const rest = list.length - MAX_NAMES;
    return list.slice(0, MAX_NAMES).concat([{ id: '_more', name: '+ ' + fmt(rest) + ' more', more: true }]);
  }

  /** Turn a session into an ordered list of renderable sections. Empty sections are dropped. */
  function buildCredits(s, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    const B = s.broadcaster || { id: '', name: '' };
    const ignore = new Set(splitList(opts.ignore).concat(opts.showbots ? [] : DEFAULT_BOTS));
    const people = Object.values(s.users).filter((u) => u.id !== B.id && !ignore.has(u.login));
    const avatar = (u) => (s.avatars && s.avatars[u.id]) || '';
    const card = (u, i, stat) => ({ id: u.id, name: u.name, color: u.color, avatar: avatar(u), stat, rank: i + 1 });
    const pill = (u, badge) => ({ id: u.id, name: u.name, color: u.color, badge: badge || '' });
    const byId = (id) => s.users[id];
    const kept = (u) => u && u.id !== B.id && !ignore.has(u.login);
    const top = opts.top;

    const sections = [];
    const add = (key, kind, items, extra) => {
      if (items && items.length) sections.push(Object.assign({ key, kind, title: SECTION_LABELS[key], items }, extra || {}));
    };

    for (const key of splitList(opts.sections)) {
      switch (key) {
        case 'starring':
          if (B.name) add(key, 'star', [{ id: B.id, name: B.name, avatar: (s.avatars && s.avatars[B.id]) || '' }]);
          break;
        case 'chatters':
          add(key, 'cards', people.filter((u) => u.messages > 0)
            .sort((a, b) => b.messages - a.messages || a.firstAt - b.firstAt)
            .slice(0, top)
            .map((u, i) => card(u, i, plural(u.messages, 'message'))));
          break;
        case 'supporters':
          add(key, 'cards', people.filter((u) => supportScore(u) > 0)
            .sort((a, b) => supportScore(b) - supportScore(a) || a.firstAt - b.firstAt)
            .slice(0, top)
            .map((u, i) => card(u, i, supportDetail(u))));
          break;
        case 'gifters':
          add(key, 'pills', people.filter((u) => u.gifted > 0)
            .sort((a, b) => b.gifted - a.gifted)
            .map((u) => pill(u, plural(u.gifted, 'gift'))));
          break;
        case 'subs':
          add(key, 'pills', s.order.subs.map(byId).filter(kept).map((u) => pill(u, subBadge(u.sub))));
          break;
        case 'cheers':
          add(key, 'pills', people.filter((u) => u.bits > 0)
            .sort((a, b) => b.bits - a.bits)
            .map((u) => pill(u, fmt(u.bits) + ' bits')));
          break;
        case 'raids':
          add(key, 'cards', s.order.raids.map(byId).filter(kept)
            .map((u, i) => card(u, i, plural(u.raidViewers, 'raider'))), { ranked: false });
          break;
        case 'followers':
          add(key, 'pills', s.order.follows.map(byId).filter(kept)
            .sort((a, b) => (a.followedAt || 0) - (b.followedAt || 0))
            .map((u) => pill(u)));
          break;
        case 'mods':
          add(key, 'pills', people.filter((u) => u.mod)
            .sort((a, b) => b.messages - a.messages)
            .map((u) => pill(u)));
          break;
        case 'cast':
          add(key, 'names', capNames(people.filter((u) => u.messages > 0)
            .sort((a, b) => a.firstAt - b.firstAt)
            .map((u) => ({ id: u.id, name: u.name, color: u.color }))), { subtitle: 'in order of appearance' });
          break;
        case 'lurkers':
          add(key, 'names', capNames(people.filter((u) => u.present && !u.messages)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((u) => ({ id: u.id, name: u.name }))), { subtitle: 'watching from the shadows' });
          break;
        case 'stats': {
          const T = s.totals;
          const chatters = people.filter((u) => u.messages > 0).length;
          const tiles = [
            ['Messages', T.messages],
            ['Chatters', chatters],
            ['New followers', T.follows],
            ['Subs', T.subs],
            ['Gifted subs', T.giftedSubs],
            ['Bits', T.bits],
            ['Raiders', T.raidViewers],
            ['Peak viewers', s.peakViewers],
          ].filter(([, v]) => v > 0).map(([label, v]) => ({ label, value: fmt(v) }));
          const dur = streamDuration(s);
          if (dur) tiles.push({ label: 'Stream time', value: dur });
          add(key, 'stats', tiles);
          break;
        }
        default:
          break;
      }
    }

    const startedAt = (s.stream && s.stream.startedAt) || s.createdAt;
    return {
      title: opts.title,
      tagline: opts.tagline,
      meta: {
        channel: B.name,
        streamTitle: (s.stream && s.stream.title) || '',
        game: (s.stream && s.stream.game) || '',
        date: startedAt ? new Date(startedAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '',
        duration: streamDuration(s),
      },
      sections,
      outro: { title: opts.outro, sub: opts.outro2 },
    };
  }

  function streamDuration(s) {
    if (!s.stream || !s.stream.startedAt) return '';
    const start = Date.parse(s.stream.startedAt) || s.stream.startedAt;
    const end = s.stream.endedAt || s.updatedAt || Date.now();
    return durationText(end - start);
  }

  /** Ids worth fetching profile pictures for (cards + broadcaster). */
  function avatarIds(credits) {
    const ids = new Set();
    for (const sec of credits.sections) {
      if (sec.kind === 'cards' || sec.kind === 'star') sec.items.forEach((it) => { if (!it.avatar && /^\d+$/.test(it.id)) ids.add(it.id); });
    }
    return [...ids];
  }

  /* -------------------------------------------------------------------- demo */

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEMO_NAMES = [
    'ValkyrieAce', 'PixelKnight', 'CosmicDolphin', 'mochi_muffin', 'SuperFan99', 'GoldenGamer',
    'sleepy_sakura', 'NeonNomad', 'BubbleTeaBandit', 'KittyKernel', 'StarlightSoba', 'lofi_lynx',
    'ChaosCroissant', 'DinoDadJokes', 'Tw1stedTeacup', 'RamenRiot', 'HoneyBadger42', 'pixel_skull', 'QuasarQuill',
    'TacticalTurnip', 'MapleMeow', 'retro_rabbit', 'GlitchGoblin', 'MoonPieMage', 'boba_bard',
    'CaptainCozy', 'pastel_panda', 'ShadowSnek', 'NightOwlNoodle', 'TofuTitan', 'WaffleWizard',
    'cherry_chan', 'PlushPirate', 'DizzyDuck', 'yuzu_yeti', 'SnackSorcerer', 'AuroraAxolotl',
    'BeanieBear', 'QuietQuokka', 'SushiSamurai', 'PocketPeach', 'LunarLatte', 'FrostFox',
    'MarshMellow', 'ToastyTanuki', 'hime_hime', 'CrispyCrow', 'NoodleNinja', 'VelvetVoid',
  ];
  const DEMO_COLORS = ['#FF7AB6', '#7AD7FF', '#FFD166', '#9B8CFF', '#5EF0C0', '#FF8C69', '#C0A4FF', '#8BE9FD'];

  function demoSession(opts) {
    opts = opts || {};
    const r = rng(20261101);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const now = Date.now();
    const name = opts.channel || 'Shiari';
    const s = createSession(
      { id: 'b0', login: name.toLowerCase(), name },
      { id: 'demo', title: opts.demoTitle || 'cozy chats & chaotic games ♡', game: 'Just Chatting', startedAt: new Date(now - (3 * 60 + 12) * 60000).toISOString(), endedAt: now },
      now - 3 * 3600000,
    );
    const users = DEMO_NAMES.map((n, i) => ({ id: 'd' + i, login: n.toLowerCase(), name: n, color: pick(DEMO_COLORS) }));
    let t = now - 3 * 3600000;
    const at = () => (t += 1000 + Math.floor(r() * 4000));

    // Chat: a few very active chatters, a long tail of quieter ones.
    users.slice(0, 34).forEach((u, i) => {
      const count = Math.max(1, Math.round(160 / Math.pow(i + 1, 0.9) + r() * 6));
      for (let m = 0; m < count; m++) {
        applyEvent(s, { type: 'chat', id: u.id + ':' + m, user: u, badges: i === 1 || i === 4 ? ['moderator'] : i === 6 ? ['vip'] : [], bits: 0 }, at());
      }
    });
    [[users[5], 2500], [users[2], 1000], [users[9], 500], [users[14], 300], [users[0], 100]].forEach(([u, bits], i) => {
      applyEvent(s, { type: 'chat', id: 'cheer' + i, user: u, badges: [], bits }, at());
    });
    applyEvent(s, { type: 'gift', id: 'g1', gifter: users[5], count: 5, tier: '1000' }, at());
    applyEvent(s, { type: 'gift', id: 'g2', gifter: users[11], count: 3, tier: '1000' }, at());
    applyEvent(s, { type: 'gift', id: 'g3', gifter: null, count: 1, tier: '1000' }, at());
    [20, 21, 22, 23, 24].forEach((i, k) => applyEvent(s, { type: 'sub', kind: 'gift', id: 'gs' + k, user: users[i], tier: '1000', gifter: users[5].name }, at()));
    applyEvent(s, { type: 'sub', kind: 'resub', id: 's1', user: users[0], tier: '1000', months: 14 }, at());
    applyEvent(s, { type: 'sub', kind: 'new', id: 's2', user: users[3], tier: '2000' }, at());
    applyEvent(s, { type: 'sub', kind: 'new', id: 's3', user: users[7], tier: '1000', prime: true }, at());
    applyEvent(s, { type: 'sub', kind: 'resub', id: 's4', user: users[10], tier: '1000', months: 6 }, at());
    applyEvent(s, { type: 'raid', id: 'r1', user: { id: 'rx1', login: 'cozycapy', name: 'CozyCapy' }, viewers: 42 }, at());
    applyEvent(s, { type: 'raid', id: 'r2', user: { id: 'rx2', login: 'starrystella', name: 'StarryStella' }, viewers: 17 }, at());
    users.slice(12, 25).forEach((u, i) => applyEvent(s, { type: 'follow', id: 'f' + i, user: u }, at()));
    applyEvent(s, { type: 'present', users: users.slice(34) }, at());
    applyEvent(s, { type: 'viewers', count: 87 }, at());
    s.updatedAt = now;
    return s;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  const api = {
    SUB_POINTS, DEFAULT_BOTS, ALL_SECTIONS, SECTION_LABELS, DEFAULTS,
    parseOptions, encodeOptions, createSession, normalize, applyEvent, buildCredits,
    avatarIds, demoSession, supportScore, durationText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SC = Object.assign(root.SC || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
