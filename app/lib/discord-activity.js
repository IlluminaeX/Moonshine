// What the Discord status says, built from plain values so it can be tested without the app running.
const isDesktop = (name) => /^desktop$/i.test(String(name || '').trim());
const RELEASES_URL = 'https://github.com/IlluminaeX/Moonshine/releases/latest';

/** Buttons under the status, for friends: Join (on top), then Get Moonshine. Discord needs web links,
 *  so Join opens a page on the friends service that hands over to the Moonshine app. */
function buttons({ user, hostUuid, app, serviceUrl }) {
  const list = [];
  if (user && hostUuid) {
    const q = new URLSearchParams({ h: hostUuid, u: user, a: app || '' });
    list.push({ label: 'Join', url: `${serviceUrl}/play?${q}`.slice(0, 512) });
  }
  list.push({ label: 'Get Moonshine', url: RELEASES_URL });
  return list;
}

/** s: { on, share, hostApp, hostGame, hostGuests, streamApp, streamHost, since, user, hostUuid, serviceUrl } */
function activity(s) {
  if (!s.on) return null;
  if (s.hostApp) {
    // "Playing Desktop" reads wrong: only a real game or app name gets "Playing"
    const shown = s.share ? (s.hostGame || s.hostApp) : '';
    const name = isDesktop(shown) ? '' : shown;
    return {
      details: name ? `Playing ${name}` : 'Streaming on Moonshine',
      state: s.hostGuests > 0 ? `Streaming to ${s.hostGuests} friend${s.hostGuests === 1 ? '' : 's'}` : 'Hosting on Moonshine',
      timestamps: { start: s.since },
      buttons: buttons({ user: s.user, hostUuid: s.hostUuid, app: s.hostApp, serviceUrl: s.serviceUrl }),
    };
  }
  if (s.streamApp) {
    const name = s.share && !isDesktop(s.streamApp) ? s.streamApp : '';
    return {
      details: name ? `Playing ${name}` : 'Streaming on Moonshine',
      state: s.streamHost ? `On ${s.streamHost}` : 'On a friend’s PC',
      timestamps: { start: s.since },
    };
  }
  return null;
}

module.exports = { activity, buttons, isDesktop };
