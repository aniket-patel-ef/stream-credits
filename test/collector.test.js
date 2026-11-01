'use strict';

// Session lifecycle of the collector, with localStorage and Twitch stubbed out.
const test = require('node:test');
const assert = require('node:assert/strict');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.SC = require('../js/core.js');
require('../js/collector.js');
const SC = globalThis.SC;

const B = { id: '100', login: 'shiari', name: 'Shiari' };

function collector() {
  const c = new SC.Collector({ token: 'x' });
  c.leader = true;
  c.broadcaster = B;
  c.key = 'sc:session:' + B.id;
  c.prevKey = 'sc:prev:' + B.id;
  c.session = SC.createSession(B, null);
  return c;
}

const msg = (id) => ({ broadcaster_user_id: B.id, chatter_user_id: '1', chatter_user_login: 'a', chatter_user_name: 'A', message_id: id, badges: [] });

test('chat before going live is adopted by the stream that starts shortly after', () => {
  const c = collector();
  c.onTwitch('channel.chat.message', msg('pre'));
  c.onTwitch('stream.online', { id: 'stream-1', started_at: new Date().toISOString() });
  assert.equal(c.session.stream.id, 'stream-1');
  assert.equal(c.session.totals.messages, 1);
});

test('a new broadcast archives the previous session and starts fresh', () => {
  const c = collector();
  c.goLive({ id: 'stream-1', startedAt: new Date(Date.now() - 7200000).toISOString() });
  c.onTwitch('channel.chat.message', msg('m1'));
  c.onTwitch('stream.offline', {});
  assert.ok(c.session.stream.endedAt);

  c.onTwitch('stream.online', { id: 'stream-2', started_at: new Date().toISOString() });
  assert.equal(c.session.stream.id, 'stream-2');
  assert.equal(c.session.totals.messages, 0);
  assert.equal(JSON.parse(store.get('sc:prev:100')).stream.id, 'stream-1');
});

test('chat keeps counting for a while after the stream ends, then stops', () => {
  const c = collector();
  c.goLive({ id: 'stream-1', startedAt: new Date().toISOString() });
  c.session.stream.endedAt = Date.now() - 5 * 60000;
  c.onTwitch('channel.chat.message', msg('o7'));
  assert.equal(c.session.totals.messages, 1);

  c.session.stream.endedAt = Date.now() - 45 * 60000;
  c.onTwitch('channel.chat.message', msg('days later'));
  assert.equal(c.session.totals.messages, 1);
});

test('the same stream id coming back online keeps the session', () => {
  const c = collector();
  c.goLive({ id: 'stream-1', startedAt: new Date().toISOString() });
  c.onTwitch('channel.chat.message', msg('m1'));
  c.session.stream.endedAt = Date.now();
  assert.equal(c.goLive({ id: 'stream-1', startedAt: new Date().toISOString(), title: 'back' }), false);
  assert.equal(c.session.stream.endedAt, null);
  assert.equal(c.session.stream.title, 'back');
  assert.equal(c.session.totals.messages, 1);
});

test('reset keeps the live stream but clears the counts', () => {
  const c = collector();
  c.goLive({ id: 'stream-1', startedAt: new Date().toISOString() });
  c.onTwitch('channel.chat.message', msg('m1'));
  c.reset();
  assert.equal(c.session.stream.id, 'stream-1');
  assert.equal(c.session.totals.messages, 0);
  assert.equal(JSON.parse(store.get('sc:session:100')).totals.messages, 0);
});
