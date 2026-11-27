const test = require('node:test');
const assert = require('node:assert/strict');
const { pick } = require('../lib/game-detect');

const none = { steamGameName: () => '', steamGameByFolder: () => '', steamShortcuts: () => [], epicGames: () => [] };

test('nothing found gives no name', () => assert.equal(pick(null, none), ''));

test('a game added to Steam by hand is matched by its program', () => {
  const deps = { ...none, steamShortcuts: () => [{ name: 'My Mod', exe: 'D:\\Games\\mod\\mod.exe' }] };
  assert.equal(pick({ path: 'd:\\games\\mod\\MOD.EXE', process: 'mod' }, deps), 'My Mod');
});

test('Steam’s own name wins', () => {
  assert.equal(pick({ steamAppId: 1145360, path: 'C:\\x\\Hades.exe', process: 'Hades' }, { ...none, steamGameName: (id) => (id === 1145360 ? 'Hades' : '') }), 'Hades');
});

test('Epic games are named from the launcher’s list', () => {
  const deps = { ...none, epicGames: () => [{ name: 'Fortnite', dir: 'C:\\Epic\\Fortnite' }] };
  assert.equal(pick({ path: 'C:\\Epic\\Fortnite\\Bin\\fn.exe', process: 'fn' }, deps), 'Fortnite');
});

test('launchers, browsers and the desktop are not games', () => {
  for (const proc of ['explorer', 'chrome', 'steam', 'Discord', 'launcher']) {
    assert.equal(pick({ path: `C:\\Program Files\\${proc}\\${proc}.exe`, process: proc }, none), '', proc);
  }
});

test('a fullscreen window alone is never guessed to be a game', () => {
  assert.equal(pick({ process: 'randomthing', fullscreen: true }, none), '');
});
