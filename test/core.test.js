'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../js/core.js');

const B = { id: '100', login: 'shiari', name: 'Shiari' };

function chat(id, userId, name, extra) {
  return Object.assign({
    broadcaster_user_id: B.id,
    chatter_user_id: userId,
    chatter_user_login: name.toLowerCase(),
    chatter_user_name: name,
    message_id: id,
    message: { text: 'hi', fragments: [] },
    color: '#FF0000',
    badges: [],
    cheer: null,
    source_broadcaster_user_id: null,
  }, extra || {});
}

function notice(id, type, payload, chatter) {
  const e = {
    broadcaster_user_id: B.id,
    chatter_user_id: chatter ? chatter.id : null,
    chatter_user_login: chatter ? chatter.name.toLowerCase() : null,
    chatter_user_name: chatter ? chatter.name : null,
    chatter_is_anonymous: !chatter,
    message_id: id,
    notice_type: type,
    source_broadcaster_user_id: null,
  };
  e[type] = payload;
  return e;
}

function feed(s, type, event) {
  for (const ev of SC.normalize(type, event)) SC.applyEvent(s, ev);
}

function fresh() {
  return SC.createSession(B, { id: 's1', title: 'test', startedAt: new Date(Date.now() - 3600000).toISOString() });
}

test('chat messages are counted per chatter; bots and the broadcaster are left out of the top list', () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) feed(s, 'channel.chat.message', chat('a' + i, '1', 'Alice'));
  for (let i = 0; i < 3; i++) feed(s, 'channel.chat.message', chat('b' + i, '2', 'Bob'));
  for (let i = 0; i < 9; i++) feed(s, 'channel.chat.message', chat('n' + i, '3', 'Nightbot'));
  for (let i = 0; i < 9; i++) feed(s, 'channel.chat.message', chat('s' + i, B.id, 'Shiari'));

  const c = SC.buildCredits(s, {});
  const top = c.sections.find((x) => x.key === 'chatters');
  assert.deepEqual(top.items.map((i) => i.name), ['Alice', 'Bob']);
  assert.equal(top.items[0].stat, '5 messages');
  assert.equal(s.totals.messages, 26);
});

test('duplicate message ids are ignored', () => {
  const s = fresh();
  feed(s, 'channel.chat.message', chat('dup', '1', 'Alice'));
  feed(s, 'channel.chat.message', chat('dup', '1', 'Alice'));
  assert.equal(s.users['1'].messages, 1);
});

test('shared-chat messages from other channels are ignored', () => {
  const s = fresh();
  feed(s, 'channel.chat.message', chat('x', '1', 'Alice', { source_broadcaster_user_id: '999' }));
  feed(s, 'channel.chat.notification', Object.assign(notice('y', 'shared_chat_sub', {}, { id: '1', name: 'Alice' })));
  assert.equal(s.totals.messages, 0);
  assert.equal(s.totals.subs, 0);
});

test('cheers in chat add bits; moderators are flagged from badges', () => {
  const s = fresh();
  feed(s, 'channel.chat.message', chat('c1', '1', 'Alice', { cheer: { bits: 500 }, badges: [{ set_id: 'moderator', id: '1', info: '' }] }));
  assert.equal(s.users['1'].bits, 500);
  assert.equal(s.users['1'].mod, true);
  const c = SC.buildCredits(s, {});
  assert.equal(c.sections.find((x) => x.key === 'cheers').items[0].badge, '500 bits');
  assert.equal(c.sections.find((x) => x.key === 'mods').items[0].name, 'Alice');
});

test('a community gift counts once for the gifter and lists every recipient', () => {
  const s = fresh();
  const gifter = { id: '7', name: 'GoldenGamer' };
  feed(s, 'channel.chat.notification', notice('cg', 'community_sub_gift', { id: 'G1', total: 3, sub_tier: '1000' }, gifter));
  ['r1', 'r2', 'r3'].forEach((rid, i) => feed(s, 'channel.chat.notification', notice('sg' + i, 'sub_gift', {
    duration_months: 1, recipient_user_id: rid, recipient_user_login: rid, recipient_user_name: 'Recipient' + i,
    sub_tier: '1000', community_gift_id: 'G1',
  }, gifter)));

  assert.equal(s.users['7'].gifted, 3);
  assert.equal(s.totals.giftedSubs, 3);
  assert.equal(s.totals.subs, 3);
  const c = SC.buildCredits(s, {});
  assert.deepEqual(c.sections.find((x) => x.key === 'gifters').items.map((i) => i.badge), ['3 gifts']);
  assert.deepEqual(c.sections.find((x) => x.key === 'subs').items.map((i) => i.badge), ['gifted', 'gifted', 'gifted']);
});

test('a direct gift sub counts for the gifter; anonymous gifts go to "Anonymous"', () => {
  const s = fresh();
  feed(s, 'channel.chat.notification', notice('d1', 'sub_gift', {
    recipient_user_id: 'r9', recipient_user_login: 'r9', recipient_user_name: 'Lucky', sub_tier: '2000', community_gift_id: null,
  }, { id: '8', name: 'Generous' }));
  feed(s, 'channel.chat.notification', notice('d2', 'community_sub_gift', { id: 'G2', total: 2, sub_tier: '1000' }, null));
  assert.equal(s.users['8'].gifted, 1);
  assert.equal(s.users['8'].giftPoints, SC.SUB_POINTS['2000']);
  assert.equal(s.users.anon.gifted, 2);
});

test('subs and resubs show tier / months badges and rank supporters by value', () => {
  const s = fresh();
  feed(s, 'channel.chat.notification', notice('s1', 'sub', { sub_tier: '1000', is_prime: true, duration_months: 1 }, { id: '1', name: 'Prime' }));
  feed(s, 'channel.chat.notification', notice('s2', 'resub', { sub_tier: '1000', is_prime: false, cumulative_months: 14 }, { id: '2', name: 'Loyal' }));
  feed(s, 'channel.chat.notification', notice('s3', 'sub', { sub_tier: '3000', is_prime: false }, { id: '3', name: 'BigSpender' }));
  feed(s, 'channel.chat.message', chat('c', '4', 'Cheerer', { cheer: { bits: 1000 } }));

  const c = SC.buildCredits(s, {});
  assert.deepEqual(c.sections.find((x) => x.key === 'subs').items.map((i) => i.badge), ['prime', '14 mo', 'tier 3']);
  const sup = c.sections.find((x) => x.key === 'supporters').items;
  assert.deepEqual(sup.map((i) => i.name), ['BigSpender', 'Cheerer', 'Prime', 'Loyal']);
  assert.equal(sup[0].stat, 'tier 3 sub');
});

test('follows are deduplicated and listed in follow order', () => {
  const s = fresh();
  const f = (id, name, at) => ({ user_id: id, user_login: name.toLowerCase(), user_name: name, broadcaster_user_id: B.id, followed_at: at });
  feed(s, 'channel.follow', f('2', 'Second', '2026-11-01T10:05:00Z'));
  feed(s, 'channel.follow', f('1', 'First', '2026-11-01T10:00:00Z'));
  feed(s, 'channel.follow', f('1', 'First', '2026-11-01T10:00:00Z'));
  assert.equal(s.totals.follows, 2);
  const c = SC.buildCredits(s, {});
  assert.deepEqual(c.sections.find((x) => x.key === 'followers').items.map((i) => i.name), ['First', 'Second']);
});

test('raids are listed with viewer counts', () => {
  const s = fresh();
  feed(s, 'channel.chat.notification', notice('r', 'raid', { user_id: '50', user_login: 'cozycapy', user_name: 'CozyCapy', viewer_count: 42, profile_image_url: 'https://x/y.png' }, { id: '50', name: 'CozyCapy' }));
  const c = SC.buildCredits(s, {});
  const raids = c.sections.find((x) => x.key === 'raids');
  assert.equal(raids.items[0].stat, '42 raiders');
  assert.equal(raids.items[0].avatar, 'https://x/y.png');
  assert.equal(raids.ranked, false);
});

test('lurkers are people seen in chat who never typed', () => {
  const s = fresh();
  feed(s, 'channel.chat.message', chat('m', '1', 'Talker'));
  SC.applyEvent(s, { type: 'present', users: [{ id: '1', login: 'talker', name: 'Talker' }, { id: '2', login: 'quiet', name: 'Quiet' }, { id: '3', login: 'streamelements', name: 'StreamElements' }] });
  const c = SC.buildCredits(s, {});
  assert.deepEqual(c.sections.find((x) => x.key === 'lurkers').items.map((i) => i.name), ['Quiet']);
});

test('empty sections are dropped and the section order follows the options', () => {
  const s = fresh();
  feed(s, 'channel.chat.message', chat('m', '1', 'Talker'));
  const c = SC.buildCredits(s, { sections: 'stats,chatters,raids,starring' });
  assert.deepEqual(c.sections.map((x) => x.key), ['stats', 'chatters', 'starring']);
});

test('options round-trip through the URL and ignore unknown / out-of-range values', () => {
  const opts = SC.parseOptions('', '#theme=kawaii&speed=5000&loop=1&top=3&title=Hello%20World&evil=1&bg=neon');
  assert.equal(opts.theme, 'kawaii');
  assert.equal(opts.speed, 1000);
  assert.equal(opts.loop, true);
  assert.equal(opts.top, 3);
  assert.equal(opts.title, 'Hello World');
  assert.equal(opts.bg, 'none');
  assert.equal(opts.evil, undefined);

  const encoded = SC.encodeOptions(opts);
  assert.deepEqual(SC.parseOptions('', '#' + encoded), opts);
  assert.equal(SC.encodeOptions(SC.DEFAULTS), '');
});

test('demo session fills every section', () => {
  const c = SC.buildCredits(SC.demoSession({ channel: 'Shiari' }), {});
  assert.deepEqual(c.sections.map((x) => x.key), SC.ALL_SECTIONS);
  assert.equal(c.meta.channel, 'Shiari');
  assert.ok(c.meta.duration);
});
