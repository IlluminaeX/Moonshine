const test = require('node:test');
const assert = require('node:assert/strict');
const { activity } = require('../lib/discord-activity');

const base = { on: true, share: true, since: 100, user: 'dayinfernal', hostUuid: 'abcd1234-ef', serviceUrl: 'https://svc.example', hostGuests: 0 };

test('off means no status', () => assert.equal(activity({ ...base, on: false, hostApp: 'Game' }), null));

test('hosting a game says Playing, with a Join and a Get Moonshine button', () => {
  const a = activity({ ...base, hostApp: 'Steam Big Picture', hostGame: 'Hades', hostGuests: 2 });
  assert.equal(a.details, 'Playing Hades');
  assert.equal(a.state, 'Streaming to 2 friends');
  assert.deepEqual(a.buttons.map((b) => b.label), ['Join', 'Get Moonshine']);
  const join = new URL(a.buttons[0].url);
  assert.equal(join.pathname, '/play');
  assert.equal(join.searchParams.get('h'), 'abcd1234-ef');
  assert.equal(join.searchParams.get('u'), 'dayinfernal');
  assert.match(a.buttons[1].url, /releases\/latest$/);
});

test('the Desktop is never "Playing Desktop"', () => {
  const a = activity({ ...base, hostApp: 'Desktop', hostGuests: 1 });
  assert.equal(a.details, 'Streaming on Moonshine');
  assert.equal(a.state, 'Streaming to 1 friend');
});

test('with game sharing off the name is hidden', () => {
  assert.equal(activity({ ...base, share: false, hostApp: 'Game', hostGame: 'Hades' }).details, 'Streaming on Moonshine');
});

test('no Join button without a signed-in user or host id', () => {
  const a = activity({ ...base, user: '', hostApp: 'Game' });
  assert.deepEqual(a.buttons.map((b) => b.label), ['Get Moonshine']);
});

test('streaming from a friend shows where, and no buttons', () => {
  const a = activity({ ...base, streamApp: 'Celeste', streamHost: 'Pat’s PC' });
  assert.equal(a.details, 'Playing Celeste');
  assert.equal(a.state, 'On Pat’s PC');
  assert.equal(a.buttons, undefined);
  assert.equal(activity({ ...base, streamApp: 'Desktop' }).details, 'Streaming on Moonshine');
});

test('nothing running means no status', () => assert.equal(activity(base), null));
