const { host, connect } = window.moonshine;
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

/** An error's message without Electron's "Error invoking remote method" wrapper. */
function errorText(err) {
  return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } catch (err) {
    toast(errorText(err));
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Only a tick-box itself toggles it; clicking the text beside it does nothing.
document.addEventListener('click', (e) => {
  const label = e.target.closest('label.check');
  if (label && e.target.tagName !== 'INPUT') e.preventDefault();
});

// ---- Tabs -------------------------------------------------------------------

const tabLoaders = {
  connect: () => showHostList(),
  friends: () => loadFriends(true),
  host: () => loadHost(),
  settings: () => loadSettings(),
  apollo: () => showApollo(),
};

function selectTab(name) {
  hideWebUi();
  document.querySelectorAll('.tab, .page').forEach((n) => n.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active');
  $(`#tab-${name}`).classList.add('active');
  tabLoaders[name]();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

// ---- Host settings ------------------------------------------------------------------
// Pages for the host engine's settings, applications, commands and logs.

const { apollo } = window.moonshine;
let apolloSub = 'settings';

const apolloLoaders = {
  settings: () => loadApolloSettings(),
  apps: () => loadApolloApps(),
  commands: () => loadApolloCommands(),
  logs: () => loadApolloLogs(),
  tools: () => loadApolloTools(),
  webui: () => loadWebUi(),
};

function showApollo() {
  selectApolloSub(apolloSub);
}

function selectApolloSub(name) {
  hideWebUi();
  apolloSub = name;
  document.querySelectorAll('#apollo-subnav button').forEach((b) => b.classList.toggle('active', b.dataset.sub === name));
  document.querySelectorAll('.apollo-sub').forEach((n) => n.classList.toggle('hidden', n.id !== `apollo-sub-${name}`));
  $('#apollo-message').classList.add('hidden');
  apolloLoaders[name]();
}

document.querySelectorAll('#apollo-subnav button').forEach((b) => {
  b.addEventListener('click', () => selectApolloSub(b.dataset.sub));
});

function showApolloMessage(text, actionLabel, action) {
  $('#apollo-message').classList.remove('hidden');
  $('#apollo-message-text').textContent = text;
  const button = $('#apollo-message-action');
  button.textContent = actionLabel;
  button.onclick = action;
  document.querySelectorAll('.apollo-sub').forEach((n) => n.classList.add('hidden'));
}

/** Show why the host can't be reached. Returns true if the call worked. */
function apolloReachable(res) {
  if (res.ok) return true;
  const goHost = () => selectTab('host');
  if (res.reason === 'login') showApolloMessage('Sign in to the host on the Host tab first.', 'Go to Host', goHost);
  else if (res.reason === 'stopped') showApolloMessage('Hosting is off, so its settings aren’t available.', 'Go to Host', goHost);
  else showApolloMessage('The host isn’t installed on this PC. Run the Moonshine installer again to add it.', 'Go to Host', goHost);
  return false;
}

/** Run a host call from a button; returns the data, or undefined if it didn't work. */
async function apolloAction(button, label, call) {
  return busy(button, label, async () => {
    const res = await call();
    return apolloReachable(res) ? res.data : undefined;
  });
}

$('#apollo-restart').addEventListener('click', (e) => apolloAction(e.target, 'Restarting…', async () => {
  const res = await apollo.restart();
  if (res.ok) {
    toast('The host is restarting.');
    setTimeout(() => { if ($('#tab-apollo').classList.contains('active')) showApollo(); }, 4000);
  }
  return res;
}));

// ---- Host settings: tools -----------------------------------------------------------

async function loadApolloTools() {
  const res = await apollo.getConfig();
  if (!apolloReachable(res)) return;
  $('#host-version').textContent = `Host engine: Apollo ${res.data.version || ''} with Moonshine’s changes.`;
}

$('#pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apolloAction(e.submitter, 'Pairing…', async () => {
    const res = await apollo.pairWithPin($('#pin-code').value, $('#pin-name').value.trim());
    if (res.ok) {
      toast(`Paired with ${res.data}. It will ask before each stream.`);
      e.target.reset();
    }
    return res;
  });
});

$('#otp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apolloAction(e.submitter, 'Creating…', async () => {
    const res = await apollo.otp($('#otp-pass').value, $('#otp-name').value.trim());
    if (res.ok) {
      const out = $('#otp-result');
      out.replaceChildren('Code: ', el('strong', { textContent: res.data.otp }), ' · valid for 3 minutes, with your passphrase.');
      out.classList.remove('hidden');
    }
    return res;
  });
});

$('#tool-close-app').addEventListener('click', (e) => apolloAction(e.target, 'Closing…', async () => {
  const res = await apollo.closeApp();
  if (res.ok) toast('Closed the running app.');
  return res;
}));

$('#tool-reset-display').addEventListener('click', (e) => apolloAction(e.target, 'Resetting…', async () => {
  const res = await apollo.resetDisplay();
  if (res.ok) toast(res.data && res.data.status ? 'Display settings reset.' : 'There was nothing to reset.');
  return res;
}));

$('#tool-unpair-all').addEventListener('click', (e) => {
  if (!confirm('Remove every paired device? They will all have to pair again.')) return;
  apolloAction(e.target, 'Removing…', async () => {
    const res = await apollo.unpairAll();
    if (res.ok) toast('All devices removed.');
    return res;
  });
});

$('#weblogin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apolloAction(e.submitter, 'Saving…', async () => {
    const res = await apollo.setWebLogin($('#weblogin-user').value.trim(), $('#weblogin-pass').value);
    if (res.ok) {
      toast('Web page login saved.');
      e.target.reset();
    }
    return res;
  });
});

// ---- Host settings: the host engine's web page ---------------------------------------
// The page is a separate view the main process lays over #webui-frame (main.js), so it has to be
// told where the frame is, and hidden whenever anything else is on screen.

const { webui } = window.moonshine;
let webUiVisible = false;

function placeWebUi() {
  if (!webUiVisible) return;
  const r = $('#webui-frame').getBoundingClientRect();
  if (r.width > 0 && r.height > 0) webui.show({ x: r.x, y: r.y, width: r.width, height: r.height });
}

function hideWebUi() {
  if (!webUiVisible) return;
  webUiVisible = false;
  webui.hide();
}

async function loadWebUi() {
  const res = await apollo.getConfig();
  if (!apolloReachable(res) || apolloSub !== 'webui' || !$('#tab-apollo').classList.contains('active')) return;
  webUiVisible = true;
  placeWebUi();
}

new ResizeObserver(placeWebUi).observe($('#webui-frame'));
window.addEventListener('resize', placeWebUi);
$('#webui-reload').addEventListener('click', () => webui.reload());

// ---- Host settings: settings --------------------------------------------------------

const settingsFormEl = $('#apollo-settings-form');
let apolloConfig = null; // what Apollo has saved
let apolloEdits = {}; // key -> new value, not saved yet
let apolloSection = APOLLO_SCHEMA[0].id;
const allFields = APOLLO_SCHEMA.flatMap((s) => s.fields);

const ON_VALUES = ['enabled', 'true', 'yes', 'on', '1'];

/** Apollo's checkboxes store "enabled"/"disabled" or "true"/"false", matching their default. */
function checkboxValues(field) {
  return ['true', 'false'].includes(String(field.default)) ? ['true', 'false'] : ['enabled', 'disabled'];
}

function savedValue(field) {
  const v = apolloConfig[field.key];
  if (v !== undefined && v !== '') return String(v);
  if (field.default !== undefined) return String(field.default);
  return field.type === 'select' && field.options.length ? field.options[0].value : '';
}

function fieldValue(field) {
  return field.key in apolloEdits ? apolloEdits[field.key] : savedValue(field);
}

/** Every setting's current value, for the schema's show/hide conditions. */
function currentValues() {
  const c = {};
  for (const f of allFields) c[f.key] = fieldValue(f);
  return c;
}

function isChecked(field) {
  const on = ON_VALUES.includes(fieldValue(field).toLowerCase());
  return field.inverse ? !on : on;
}

function setEdit(field, value) {
  if (value === savedValue(field)) delete apolloEdits[field.key];
  else apolloEdits[field.key] = value;
  $('#apollo-save-bar').classList.toggle('hidden', !Object.keys(apolloEdits).length);
}

function fieldControl(field) {
  let input;
  if (field.type === 'checkbox') {
    input = el('input', { type: 'checkbox', className: 'switch', checked: isChecked(field) });
    input.addEventListener('change', () => {
      const [on, off] = checkboxValues(field);
      setEdit(field, input.checked !== Boolean(field.inverse) ? on : off);
      renderApolloSection();
    });
    return input;
  }
  if (field.type === 'select') {
    input = el('select', {}, ...field.options.map((o) => el('option', { value: o.value, textContent: o.label })));
    const value = fieldValue(field);
    // A value set by hand in the config file that isn't one of the choices.
    if (!field.options.some((o) => o.value === value)) input.append(el('option', { value, textContent: value }));
    input.value = value;
    input.addEventListener('change', () => { setEdit(field, input.value); renderApolloSection(); });
    return input;
  }
  input = el('input', {
    type: field.type === 'number' ? 'number' : 'text',
    value: fieldValue(field),
    placeholder: field.placeholder || (field.default !== undefined && field.default !== '' ? String(field.default) : ''),
  });
  for (const k of ['min', 'max', 'step']) if (field[k] !== undefined) input[k] = field[k];
  input.addEventListener('input', () => {
    // An empty box means "use Apollo's default".
    setEdit(field, input.value === '' && field.default !== undefined ? String(field.default) : input.value);
    input.closest('.field').classList.toggle('changed', field.key in apolloEdits);
  });
  input.addEventListener('change', () => renderApolloSection());
  return input;
}

function renderApolloSection() {
  const section = APOLLO_SCHEMA.find((s) => s.id === apolloSection);
  const c = currentValues();
  const visible = section.fields.filter((f) => !f.when || f.when(c));
  const scroll = settingsFormEl.scrollTop;
  settingsFormEl.replaceChildren(
    el('h2', { textContent: section.title }),
    ...visible.map((f) => el('div', { className: `field${f.key in apolloEdits ? ' changed' : ''}` },
      el('div', { className: 'name', textContent: f.label, title: f.key }),
      el('div', { className: 'control' }, fieldControl(f)),
      el('div', { className: 'desc', textContent: f.desc }))),
  );
  settingsFormEl.scrollTop = scroll;
  document.querySelectorAll('#apollo-sections button').forEach((b) => {
    b.classList.toggle('active', b.dataset.section === apolloSection);
  });
}

function renderApolloSectionList() {
  $('#apollo-sections').replaceChildren(...APOLLO_SCHEMA.map((s) => {
    const b = el('button', { type: 'button', textContent: s.title });
    b.dataset.section = s.id;
    b.addEventListener('click', () => {
      apolloSection = s.id;
      settingsFormEl.scrollTop = 0;
      renderApolloSection();
    });
    return b;
  }));
}

async function loadApolloSettings() {
  if (apolloConfig && Object.keys(apolloEdits).length) return renderApolloSection(); // keep unsaved edits
  settingsFormEl.replaceChildren(el('div', { className: 'empty', textContent: 'Loading settings…' }));
  const res = await apollo.getConfig();
  if (!apolloReachable(res)) return;
  apolloConfig = res.data;
  apolloEdits = {};
  $('#apollo-save-bar').classList.add('hidden');
  renderApolloSectionList();
  renderApolloSection();
}

$('#apollo-discard').addEventListener('click', () => {
  apolloEdits = {};
  $('#apollo-save-bar').classList.add('hidden');
  renderApolloSection();
});

$('#apollo-save').addEventListener('click', (e) => apolloAction(e.target, 'Saving…', async () => {
  // Values back at Apollo's default are removed from the file (null), like Apollo's own page does.
  const changes = {};
  for (const [key, value] of Object.entries(apolloEdits)) {
    const field = allFields.find((f) => f.key === key);
    changes[key] = field.default !== undefined && value === String(field.default) ? null : value;
  }
  const res = await apollo.saveConfig(changes);
  if (res.ok) {
    toast('Saved. The host is restarting…');
    apolloConfig = null;
    apolloEdits = {};
    $('#apollo-save-bar').classList.add('hidden');
    setTimeout(() => { if (apolloSub === 'settings' && $('#tab-apollo').classList.contains('active')) loadApolloSettings(); }, 4000);
  }
  return res;
}));

// ---- Command lists ------------------------------------------------------------------
// Editable rows of commands: an app's own, the host's global ones, and server commands.

const CMD_COLUMNS = {
  pair: [{ key: 'do', label: 'Do' }, { key: 'undo', label: 'Undo' }],
  server: [{ key: 'name', label: 'Name' }, { key: 'cmd', label: 'Command' }],
};
// Lists on the Commands page; changes there show the save bar. The rest belong to the app editor.
const GLOBAL_CMD_LISTS = ['global_prep_cmd', 'global_state_cmd', 'server_cmd'];

function cmdColumns(listId) {
  return listId === 'server_cmd' ? CMD_COLUMNS.server : CMD_COLUMNS.pair;
}

function cmdChanged(listId) {
  if (GLOBAL_CMD_LISTS.includes(listId)) updateCommandsSaveBar();
}

function cmdRow(listId, value = {}) {
  const row = el('div', { className: 'cmd-row' });
  for (const col of cmdColumns(listId)) {
    const input = el('input', { placeholder: col.label, value: value[col.key] || '' });
    input.dataset.key = col.key;
    input.setAttribute('aria-label', col.label);
    row.append(input);
  }
  const admin = el('input', { type: 'checkbox', checked: Boolean(value.elevated) });
  admin.dataset.key = 'elevated';
  const remove = el('button', { type: 'button', className: 'danger', textContent: 'Remove' });
  remove.addEventListener('click', () => { row.remove(); cmdChanged(listId); });
  row.append(el('label', { className: 'check', title: 'Run as administrator' }, admin, 'Admin'), remove);
  row.addEventListener('input', () => cmdChanged(listId));
  return row;
}

function renderCmdList(listId, values) {
  $(`#cmd-${listId}`).replaceChildren(...(values || []).map((v) => cmdRow(listId, v)));
}

/** The list's rows as objects; rows with nothing typed are left out. */
function readCmdList(listId) {
  const columns = cmdColumns(listId);
  return [...$(`#cmd-${listId}`).children].map((row) => {
    const entry = {};
    for (const col of columns) entry[col.key] = row.querySelector(`[data-key="${col.key}"]`).value.trim();
    entry.elevated = row.querySelector('[data-key="elevated"]').checked;
    return entry;
  }).filter((entry) => columns.some((col) => entry[col.key]));
}

document.querySelectorAll('[data-add-cmd]').forEach((b) => b.addEventListener('click', () => {
  const listId = b.dataset.addCmd;
  const row = cmdRow(listId);
  $(`#cmd-${listId}`).append(row);
  row.querySelector('input').focus();
}));

// ---- Host settings: applications ----------------------------------------------------

let apolloApps = { apps: [], current_app: '' };
let editingApp = null;
const appForm = $('#app-form');
const APP_CHECKS = ['virtual-display', 'elevated', 'auto-detach', 'wait-all', 'terminate-on-pause', 'allow-client-commands',
  'use-app-identity', 'per-client-app-identity', 'exclude-global-prep-cmd', 'exclude-global-state-cmd'];
const NEW_APP = {
  name: '', cmd: '', 'working-dir': '', 'image-path': '', detached: [], 'prep-cmd': [], 'state-cmd': [], 'exit-timeout': 5,
  'auto-detach': true, 'wait-all': true, elevated: false, 'exclude-global-prep-cmd': false,
};

async function loadApolloApps() {
  const res = await apollo.getApps();
  if (!apolloReachable(res)) return;
  apolloApps = res.data;
  renderApolloApps();
}

function renderApolloApps() {
  const list = $('#apollo-apps');
  if (!apolloApps.apps.length) {
    list.replaceChildren(el('div', { className: 'empty', textContent: 'No applications yet.' }));
    return;
  }
  list.replaceChildren(...apolloApps.apps.map((a) => {
    const running = a.uuid && a.uuid === apolloApps.current_app;
    const what = a.cmd || (a.detached && a.detached[0]) || 'Desktop';
    const edit = el('button', { className: 'secondary', textContent: 'Edit' });
    edit.addEventListener('click', () => openAppEditor(a));
    const launch = el('button', { className: 'secondary', textContent: running ? 'Close' : 'Launch' });
    launch.addEventListener('click', () => apolloAction(launch, running ? 'Closing…' : 'Launching…', async () => {
      const res = running ? await apollo.closeApp() : await apollo.launchApp(a.uuid);
      if (res.ok) setTimeout(loadApolloApps, 1500);
      return res;
    }));
    const remove = el('button', { className: 'danger', textContent: 'Delete' });
    remove.addEventListener('click', () => {
      if (!confirm(`Delete “${a.name}” from this PC’s applications?`)) return;
      apolloAction(remove, 'Deleting…', async () => {
        const res = await apollo.deleteApp(a.uuid);
        if (res.ok) loadApolloApps();
        return res;
      });
    });
    return el('div', { className: 'item' },
      el('div', { className: 'thumb', textContent: a.name.slice(0, 1).toUpperCase() }),
      el('div', { className: 'grow' },
        el('div', {}, a.name, running ? el('span', { className: 'running', textContent: '  ● Running' }) : ''),
        el('div', { className: 'meta hint', textContent: what, title: what })),
      edit, launch, remove);
  }));
}

function openAppEditor(entry) {
  editingApp = entry;
  const a = { ...NEW_APP, ...(entry || {}) };
  $('#app-dialog-title').textContent = entry ? `Edit ${entry.name}` : 'Add application';
  for (const name of ['name', 'cmd', 'working-dir', 'image-path', 'exit-timeout', 'gamepad', 'scale-factor']) {
    appForm.elements[name].value = a[name] ?? '';
  }
  appForm.elements.detached.value = (a.detached || []).join('\n');
  for (const name of APP_CHECKS) appForm.elements[name].checked = Boolean(a[name]);
  renderCmdList('prep-cmd', a['prep-cmd']);
  renderCmdList('state-cmd', a['state-cmd']);
  $('#app-dialog').classList.remove('hidden');
  appForm.elements.name.focus();
}

$('#app-add').addEventListener('click', () => openAppEditor(null));
$('#app-cancel').addEventListener('click', () => $('#app-dialog').classList.add('hidden'));

appForm.querySelectorAll('[data-browse]').forEach((b) => b.addEventListener('click', async () => {
  const target = b.dataset.browse;
  const kind = { 'working-dir': 'folder', 'image-path': 'image' }[target] || 'program';
  const picked = await apollo.browse(kind);
  if (!picked) return;
  appForm.elements[target].value = picked;
  // Picking a program fills in its folder and name when they're still empty.
  if (target === 'cmd') {
    const folder = picked.replace(/[\\/][^\\/]+$/, '');
    if (!appForm.elements['working-dir'].value) appForm.elements['working-dir'].value = folder;
    if (!appForm.elements.name.value) appForm.elements.name.value = picked.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '');
  }
}));

appForm.addEventListener('submit', (e) => {
  e.preventDefault();
  // Start from the saved entry so anything this form doesn't show is kept.
  const entry = { ...NEW_APP, ...(editingApp || {}), uuid: editingApp ? editingApp.uuid : '' };
  for (const name of ['name', 'cmd', 'working-dir', 'image-path', 'gamepad']) entry[name] = appForm.elements[name].value.trim();
  entry['exit-timeout'] = Number(appForm.elements['exit-timeout'].value || 5);
  const scale = appForm.elements['scale-factor'].value;
  if (scale) entry['scale-factor'] = Number(scale);
  else delete entry['scale-factor'];
  entry.detached = appForm.elements.detached.value.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const name of APP_CHECKS) entry[name] = appForm.elements[name].checked;
  entry['prep-cmd'] = readCmdList('prep-cmd');
  entry['state-cmd'] = readCmdList('state-cmd');
  apolloAction(e.submitter, 'Saving…', async () => {
    const res = await apollo.saveApp(entry);
    if (res.ok) {
      $('#app-dialog').classList.add('hidden');
      toast(`Saved ${entry.name}.`);
      loadApolloApps();
    }
    return res;
  });
});

// ---- Host settings: commands --------------------------------------------------------

let commandsSaved = null; // list id -> JSON of what the host has saved

function commandsDirty() {
  return Boolean(commandsSaved) && GLOBAL_CMD_LISTS.some((id) => JSON.stringify(readCmdList(id)) !== commandsSaved[id]);
}

function updateCommandsSaveBar() {
  $('#commands-save-bar').classList.toggle('hidden', !commandsDirty());
}

function renderCommands() {
  for (const id of GLOBAL_CMD_LISTS) renderCmdList(id, JSON.parse(commandsSaved[id]));
  updateCommandsSaveBar();
}

async function loadApolloCommands() {
  if (commandsDirty()) return; // keep unsaved edits
  const res = await apollo.getConfig();
  if (!apolloReachable(res)) return;
  commandsSaved = {};
  for (const id of GLOBAL_CMD_LISTS) {
    // The host stores each list as JSON text in its config file.
    let list = [];
    try { list = JSON.parse(res.data[id] || '[]'); } catch { /* unreadable: start empty */ }
    renderCmdList(id, Array.isArray(list) ? list : []);
    commandsSaved[id] = JSON.stringify(readCmdList(id));
  }
  updateCommandsSaveBar();
}

$('#commands-discard').addEventListener('click', renderCommands);

$('#commands-save').addEventListener('click', (e) => apolloAction(e.target, 'Saving…', async () => {
  const changes = {};
  for (const id of GLOBAL_CMD_LISTS) {
    const list = readCmdList(id);
    changes[id] = list.length ? JSON.stringify(list) : null; // an empty list is removed from the file
  }
  const res = await apollo.saveConfig(changes);
  if (res.ok) {
    toast('Saved. The host is restarting…');
    for (const id of GLOBAL_CMD_LISTS) commandsSaved[id] = JSON.stringify(readCmdList(id));
    updateCommandsSaveBar();
  }
  return res;
}));

// ---- Host settings: logs ------------------------------------------------------------

const LOG_LINES = 3000;
let apolloLogText = '';

async function loadApolloLogs() {
  const res = await apollo.getLogs();
  if (!apolloReachable(res)) return;
  apolloLogText = res.data || '';
  renderApolloLogs();
}

function renderApolloLogs() {
  const pre = $('#apollo-logs');
  const filter = $('#logs-filter').value.trim().toLowerCase();
  let lines = apolloLogText.split(/\r?\n/);
  if (filter) lines = lines.filter((l) => l.toLowerCase().includes(filter));
  lines = lines.slice(-LOG_LINES);
  pre.replaceChildren(...lines.map((l) => {
    const level = /\b(Error|Fatal):/.test(l) ? 'error' : /\bWarning:/.test(l) ? 'warning' : '';
    return el('span', { className: level, textContent: `${l}\n` });
  }));
  if (!lines.length) pre.textContent = filter ? 'No matching lines.' : 'The log is empty.';
  pre.scrollTop = pre.scrollHeight;
}

$('#logs-filter').addEventListener('input', renderApolloLogs);
$('#logs-refresh').addEventListener('click', (e) => busy(e.target, 'Refreshing…', loadApolloLogs));
$('#logs-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#apollo-logs').textContent);
  toast('Log copied.');
});

// ---- Connect: host list ----------------------------------------------------------

let hostsCache = [];
let currentHost = null;
let loadingHosts = null;

function showHostList() {
  currentHost = null;
  $('#host-view').classList.add('hidden');
  $('#host-list-view').classList.remove('hidden');
  if (!hostsCache.length) loadHosts();
}

async function loadHosts() {
  const container = $('#hosts');
  if (!hostsCache.length) {
    container.replaceChildren(el('div', { className: 'empty', textContent: 'Looking for PCs…' }));
  }
  loadingHosts ||= connect.hosts().finally(() => { loadingHosts = null; });
  const { tailscale, hosts } = await loadingHosts;
  hostsCache = hosts;
  if (!hosts.length) {
    const tip = tailscale
      ? 'No PCs found yet. Use Add PC, or ask a friend to share their PC with you on Tailscale.'
      : 'No PCs found yet. Use Add PC, or sign in to Tailscale to see friends’ PCs.';
    container.replaceChildren(el('div', { className: 'empty', textContent: tip }));
    return;
  }
  container.replaceChildren(...hosts.map(hostCard));
}

function hostStatus(h) {
  if (!h.online) return { dot: '', text: 'Offline' };
  if (h.busy) return { dot: 'busy', text: 'In a game' };
  return { dot: 'online', text: 'Online' };
}

/** Reached through a direct connection (lib/tunnels.js), not a real address on a network. */
const isDirect = (h) => Boolean(h.direct) || String(h.address || '').startsWith('127.77.');

function hostCard(h) {
  const status = hostStatus(h);
  const badges = [];
  if (h.moonshine) badges.push('Moonshine');
  if (isDirect(h)) badges.push('Direct');
  if (h.tailnetUser) badges.push(h.tailnetUser);
  if (!h.paired && h.online) badges.push('Not paired');

  const name = el('div', { className: 'name', textContent: h.name || h.address });
  if (h.ownName && h.ownName !== h.name) name.title = `Calls itself “${h.ownName}”`;
  const card = el('div', { className: 'card' },
    name,
    el('div', { className: 'status' }, el('span', { className: `dot ${status.dot}` }), status.text),
    el('div', { className: 'badges' }, ...badges.map((b) => el('span', { className: 'badge', textContent: b }))));

  let button;
  if (!h.online) {
    button = el('button', { className: 'secondary', textContent: 'Offline', disabled: true });
  } else if (h.paired) {
    button = el('button', { textContent: 'Open' });
    button.addEventListener('click', () => openHost(h));
  } else {
    button = el('button', { textContent: h.moonshine ? 'Request access' : 'Pair' });
    button.addEventListener('click', () => pairHost(h));
  }
  card.append(button);

  const rename = el('button', { className: 'link-button neutral', textContent: 'Rename' });
  rename.title = 'Give this PC your own name in Moonshine';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = el('input', { className: 'name-edit', value: h.name || '', maxLength: 60, placeholder: h.ownName || 'Name' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value !== h.name) {
        // Clearing the box goes back to the PC's own name
        await connect.rename(h.uuid, value === h.ownName ? '' : value);
        h.name = value || h.ownName;
        toast(value && value !== h.ownName ? `Renamed to ${value}.` : `Back to “${h.ownName}”.`);
      }
      name.textContent = h.name || h.address;
      input.replaceWith(name);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    name.replaceWith(input);
    input.focus();
    input.select();
  });
  const links = el('div', { className: 'card-links' }, rename);
  card.append(links);

  if (h.saved) {
    const remove = el('button', { className: 'link-button', textContent: 'Remove' });
    remove.title = 'Forget this PC and the pairing with it';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      const still = h.online ? ' It’s still reachable, so it stays in the list as “Not paired”.' : '';
      if (!confirm(`Remove ${h.name || h.address}? You’ll have to pair again to connect.${still}`)) return;
      busy(remove, 'Removing…', async () => {
        await connect.remove({ uuid: h.uuid, name: h.name, address: h.address });
        toast(`Removed ${h.name || h.address}.`);
        await loadHosts();
      });
    });
    links.append(remove);
  }
  return card;
}

$('#refresh-hosts').addEventListener('click', (e) => busy(e.target, 'Refreshing…', loadHosts));

// ---- Connect: pairing ------------------------------------------------------------

function showPairDialog(state) {
  if (!state) {
    $('#pair-dialog').classList.add('hidden');
    return;
  }
  $('#pair-dialog').classList.remove('hidden');
  const pin = $('#pair-pin');
  $('#pair-title').textContent = `Pair with ${state.host}`;
  pin.textContent = state.pin;
  pin.classList.remove('hidden');
  if (state.checking) {
    $('#pair-text').textContent = `Reaching ${state.host}…`;
  } else if (state.moonshine) {
    $('#pair-text').textContent = `Waiting for ${state.host} to accept. They get a popup in Moonshine; nobody has to type the PIN.`;
  } else {
    $('#pair-text').textContent = 'Enter this PIN on that PC. Apollo and Sunshine have a PIN page in their web UI.';
  }
}

async function pairHost(h) {
  showPairDialog({ pin: '····', host: h.name, checking: true });
  try {
    const res = await connect.pair(h);
    if (res.ok) {
      toast(`Paired with ${h.name}.`);
      h.paired = true;
      h.apps = await connect.apps(h);
      openHost(h);
      loadHosts();
    } else if (res.reason !== 'cancelled') {
      toast({
        declined: `${h.name} declined.`,
        timeout: `No answer from ${h.name}.`,
        closed: `Moonshine isn’t open on ${h.name}, so nobody saw the request. Ask them to open it and try again.`,
        disabled: `${h.name} has pairing turned off.`,
        busy: `${h.name} has too many pairing requests waiting. Try again in a few minutes.`,
      }[res.reason] || res.message || 'Pairing failed. Check the PIN and try again.');
    }
  } catch (err) {
    toast(errorText(err));
  } finally {
    $('#pair-dialog').classList.add('hidden');
  }
}

connect.onPairState(showPairDialog);
$('#pair-cancel').addEventListener('click', () => connect.cancelPair());

// ---- Connect: add a PC by address -----------------------------------------------

$('#add-host').addEventListener('click', () => {
  $('#add-dialog').classList.remove('hidden');
  $('#add-address').value = '';
  $('#add-address').focus();
});
$('#add-cancel').addEventListener('click', () => $('#add-dialog').classList.add('hidden'));
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, 'Looking…', async () => {
    const h = await connect.add($('#add-address').value);
    $('#add-dialog').classList.add('hidden');
    if (h.paired) openHost(h);
    else pairHost(h);
  });
});

// ---- Connect: one host's games ---------------------------------------------------

function renderApps(h) {
  const apps = $('#apps');
  if (!h.apps.length) {
    apps.replaceChildren(el('div', { className: 'empty', textContent: 'No games listed on this PC.' }));
    return;
  }
  apps.replaceChildren(...h.apps.map((a) => {
    const art = el('div', { className: 'art' });
    if (a.boxArt) art.style.backgroundImage = `url("${a.boxArt}")`;
    else art.textContent = a.name.slice(0, 1).toUpperCase();
    const tile = el('button', { className: 'game', title: `Play ${a.name}` }, art, el('div', { className: 'title', textContent: a.name }));
    tile.addEventListener('click', () => connect.stream({ name: h.name, address: h.address }, a.name));
    return tile;
  }));
}

function openHost(h) {
  currentHost = h;
  $('#host-list-view').classList.add('hidden');
  $('#host-view').classList.remove('hidden');
  $('#host-view-name').textContent = h.name;
  $('#host-view-meta').textContent = [isDirect(h) ? 'Connected directly' : h.address, h.tailnetUser || h.user, h.busy ? 'A game is running' : ''].filter(Boolean).join(' · ');
  $('#quit-app').classList.toggle('hidden', !h.busy);
  renderApps(h);
}

$('#back-to-hosts').addEventListener('click', showHostList);
$('#refresh-apps').addEventListener('click', (e) => busy(e.target, 'Refreshing…', async () => {
  const h = currentHost;
  h.apps = await connect.apps(h);
  if (currentHost === h) renderApps(h);
}));
$('#quit-app').addEventListener('click', (e) => busy(e.target, 'Closing…', async () => {
  if (await connect.quitApp(currentHost)) {
    currentHost.busy = false;
    $('#quit-app').classList.add('hidden');
    toast('Closed the running game.');
  } else {
    toast('Couldn’t close the game. Only the PC that started it can close it.');
  }
}));

// ---- Streaming -----------------------------------------------------------------

connect.onStreamState((state) => {
  $('#stream-overlay').classList.toggle('hidden', !state.active);
  if (state.active) $('#stream-title').textContent = `${state.app} on ${state.host}`;
  if (state.error) toast(state.error);
  if (!state.active) loadHosts();
});
$('#end-stream').addEventListener('click', () => connect.endStream());

// ---- Friends ---------------------------------------------------------------------

let friendsTimer = null;
let friendsFullAt = 0;

/** "dark@github" -> "dark" */
function personName(user) {
  return (user || '').replace(/@.*$/, '') || user;
}

function avatarFor(seed, text) {
  const hue = [...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const a = el('div', { className: 'avatar', textContent: (text.trim()[0] || '?').toUpperCase() });
  a.style.background = `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 75% 35%))`;
  return a;
}

/** "Desktop" reads better as what it is. */
function gameLabel(game) {
  return /^desktop$/i.test(game) ? 'the desktop' : game;
}

/** "0.10.0" vs "0.9.2"; '' (a Moonshine too old to say) is older than everything. */
function compareVersions(a, b) {
  const p = (v) => String(v || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** A badge when a friend's online PCs run an older or newer Moonshine than this one. */
function versionBadge(list, mine) {
  const versions = list.filter((p) => p.account && p.online).map((p) => p.version || '');
  if (!versions.length || !mine) return null;
  const oldest = versions.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
  if (compareVersions(oldest, mine) < 0) {
    const badge = el('span', { className: 'version-badge', textContent: 'Older Moonshine' });
    badge.title = `Their Moonshine is ${oldest || 'older than 0.3.0'} and yours is ${mine}. Messages, live updates and what they’re playing need the newest version on both PCs. Ask them to update: Moonshine updates itself from its sidebar.`;
    return badge;
  }
  if (versions.every((v) => compareVersions(v, mine) > 0)) {
    const newest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    const badge = el('span', { className: 'version-badge newer', textContent: 'Update yours' });
    badge.title = `They have Moonshine ${newest}; you have ${mine}. Click to check for the update.`;
    badge.addEventListener('click', () => $('#app-version').click());
    return badge;
  }
  return null;
}

function friendPcStatus(pc) {
  if (!pc.online) return { dot: '', text: 'Offline' };
  if (pc.account && !pc.reachable && !pc.canConnectDirectly) return { dot: 'busy', text: 'Online · can’t reach it from here yet', title: 'Their PC is on, but this PC has no way to reach it: no shared Tailscale or network, and their Moonshine can’t take direct connections right now (both PCs need the latest Moonshine, open and signed in).' };
  const game = pc.game ? ` · ${gameLabel(pc.game)}` : '';
  if (pc.guests > 0) return { dot: 'hosting', text: `Hosting · ${pc.guests} connected${game}` };
  if (pc.busy) return { dot: 'busy', text: `In a game${game}` };
  return { dot: 'online', text: 'Free' };
}

function friendPcRow(pc) {
  const status = friendPcStatus(pc);
  const row = el('div', { className: 'friend-pc' },
    el('span', { className: `dot ${status.dot}` }),
    el('div', { className: 'friend-pc-text' },
      el('div', { className: 'friend-pc-name', textContent: pc.name || pc.address }),
      el('div', { className: 'friend-pc-status', textContent: status.text, title: status.title || '' })));
  if (!pc.online || (pc.account && !pc.reachable && !pc.canConnectDirectly)) return row;
  // Use the full host from the Connect list, so pairing and the game list work as they do there
  const host = () => hostsCache.find((h) => h.uuid === pc.uuid) || { ...pc, apps: [], tailnetUser: pc.user };
  let button;
  if (pc.account && (pc.direct || !pc.reachable)) {
    // No shared network: connect straight through both routers (opens the connection if needed)
    button = el('button', { className: pc.paired ? '' : 'secondary', textContent: pc.paired || !pc.reachable ? 'Connect' : 'Request access' });
    button.title = 'Connects directly over the internet, no Tailscale or port forwarding needed';
    button.addEventListener('click', () => busy(button, 'Connecting…', async () => {
      const h = await window.moonshine.friends.connect(pc.uuid);
      friendsFullAt = 0;
      if (h.paired) {
        selectTab('connect');
        openHost(h);
      } else {
        pairHost(h);
      }
    }));
  } else if (pc.paired) {
    button = el('button', { textContent: 'Connect' });
    button.addEventListener('click', () => {
      selectTab('connect');
      openHost(host());
    });
  } else {
    button = el('button', { className: 'secondary', textContent: pc.moonshine ? 'Request access' : 'Pair' });
    button.addEventListener('click', () => pairHost(host()));
  }
  if (pc.moonshine && pc.mine === false && pc.reachable && !pc.direct) {
    const inviteButton = el('button', { className: 'secondary invite', textContent: 'Invite' });
    inviteButton.title = `Ask ${pc.name} to join a stream on this PC`;
    inviteButton.addEventListener('click', () => busy(inviteButton, 'Inviting…', async () => {
      const { app } = await window.moonshine.friends.invite({ name: pc.name, address: pc.address });
      toast(`Invited ${pc.name} to ${app}. They get a popup in Moonshine.`);
    }));
    row.append(inviteButton);
  }
  row.append(button);
  return row;
}

// The Friends tab refreshes every few seconds; parts are only rebuilt when what they show changed,
// so typing isn't wiped and cards don't replay their entrance animation.
let accountView = '';
let requestsView = '';
let friendsView = '';

/** Mark nodes that were already on screen last time, so only new ones animate in. */
function settle(node, wasShown) {
  if (wasShown) node.style.animation = 'none';
  return node;
}

function renderAccount(service) {
  const box = $('#friend-account');
  const requests = $('#friend-requests');
  box.classList.toggle('hidden', !service || !service.configured);
  if (!service || !service.configured) {
    requests.classList.add('hidden');
    accountView = requestsView = '';
    return;
  }
  const view = !service.signedIn ? 'out' : !service.username ? 'pick' : `in:${service.username}`;
  const hint = box.querySelector('.account-hint.live');
  if (view === accountView) {
    // Same view: only refresh the status line
    if (hint) hint.textContent = service.error ? `Can’t reach Moonshine’s friends service right now (${service.error}).` : 'Friends add you by this username.';
  } else {
    accountView = view;
    buildAccount(box, service, view);
  }
  renderRequests(requests, service);
}

function buildAccount(box, service, view) {
  if (view === 'out') {
    const signIn = el('button', { textContent: 'Sign in with Discord' });
    signIn.addEventListener('click', () => busy(signIn, 'Waiting for Discord…', async () => {
      const res = await window.moonshine.account.signIn();
      toast(res.username ? `Signed in as ${res.username}.` : 'Signed in. Now pick a username.');
      friendsFullAt = 0;
      await loadFriends();
    }));
    box.replaceChildren(
      el('div', { className: 'account-text' },
        el('div', { className: 'account-title', textContent: 'Add friends by username' }),
        el('div', { className: 'account-hint', textContent: 'Sign in with Discord to get a Moonshine username. Discord only tells Moonshine who you are, so you can get your username back on another PC.' })),
      signIn);
    return;
  }

  if (view === 'pick') {
    const input = el('input', { placeholder: 'Pick a username', maxLength: 20, className: 'account-input' });
    const save = el('button', { textContent: 'Save' });
    const submit = () => busy(save, 'Saving…', async () => {
      const name = await window.moonshine.account.setUsername(input.value.trim());
      toast(`You’re ${name} on Moonshine.`);
      await loadFriends();
    });
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.replaceChildren(
      el('div', { className: 'account-text' },
        el('div', { className: 'account-title', textContent: 'Pick your username' }),
        el('div', { className: 'account-hint', textContent: 'Friends add you with it. 3–20 letters, numbers, dots, dashes or underscores.' })),
      el('div', { className: 'account-row' }, input, save));
    return;
  }

  const input = el('input', { placeholder: 'Friend’s username', maxLength: 20, className: 'account-input' });
  const add = el('button', { textContent: 'Add friend' });
  const submit = () => busy(add, 'Sending…', async () => {
    const name = input.value.trim();
    if (!name) throw new Error('Type their username first.');
    const res = await window.moonshine.account.request(name);
    toast(res.status === 'accepted' ? `You and ${name} are now friends.` : `Friend request sent to ${name}.`);
    input.value = '';
    await loadFriends();
  });
  add.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const signOut = el('button', { className: 'link-button neutral', textContent: 'Sign out' });
  signOut.addEventListener('click', () => busy(signOut, 'Signing out…', async () => {
    await window.moonshine.account.signOut();
    await loadFriends();
  }));
  box.replaceChildren(
    el('div', { className: 'account-text' },
      el('div', { className: 'account-title' }, 'You’re ', el('span', { className: 'account-name', textContent: service.username })),
      el('div', { className: 'account-hint live', textContent: service.error ? `Can’t reach Moonshine’s friends service right now (${service.error}).` : 'Friends add you by this username.' })),
    el('div', { className: 'account-row' }, input, add, signOut));
}

function renderRequests(requests, service) {
  const list = (service.signedIn && service.username && service.requests) || [];
  const view = JSON.stringify(list.map((r) => [r.username, r.status]));
  if (view === requestsView) return;
  const shown = new Set(requestsView ? JSON.parse(requestsView).map((r) => r.join('|')) : []);
  requestsView = view;
  requests.classList.toggle('hidden', !list.length);
  if (list.length) {
    requests.replaceChildren(...list.map((r) => {
      const row = el('div', { className: 'friend-request' }, avatarFor(r.username, r.username),
        el('div', { className: 'friend-request-text' },
          el('div', { className: 'friend-name', textContent: r.username }),
          el('div', { className: 'friend-summary', textContent: r.status === 'incoming' ? 'Wants to be friends' : 'Waiting for them to accept' })));
      if (r.status === 'incoming') {
        const accept = el('button', { textContent: 'Accept' });
        const decline = el('button', { className: 'secondary', textContent: 'Decline' });
        accept.addEventListener('click', () => busy(accept, 'Accepting…', async () => {
          await window.moonshine.account.respond(r.username, true);
          toast(`You and ${r.username} are now friends.`);
          await loadFriends();
        }));
        decline.addEventListener('click', () => busy(decline, 'Declining…', async () => {
          await window.moonshine.account.respond(r.username, false);
          await loadFriends();
        }));
        row.append(accept, decline);
      } else {
        const cancel = el('button', { className: 'secondary', textContent: 'Cancel' });
        cancel.addEventListener('click', () => busy(cancel, 'Cancelling…', async () => {
          await window.moonshine.account.remove(r.username);
          await loadFriends();
        }));
        row.append(cancel);
      }
      return settle(row, shown.has(`${r.username}|${r.status}`));
    }));
  } else {
    requests.replaceChildren();
  }
}

function renderFriends({ me, tailscale, pcs, alerts, shareGame, version, service }) {
  renderAccount(service);
  $('#friend-alerts').checked = Boolean(alerts);
  $('#share-game').checked = shareGame !== false;
  lastFriendsService = service;
  for (const pc of pcs) pc.mine = Boolean(me) && pc.user === me; // friends' PCs and other PCs can be invited
  const box = $('#friends');
  // Nothing changed since the last refresh: leave the cards alone (no flicker, buttons keep their state)
  const view = JSON.stringify([me, tailscale, pcs, service && service.signedIn, service && service.username,
    ((service && service.friends) || []).map((f) => [f.username, f.online, f.nickname, f.unread]), version]);
  if (view === friendsView && box.children.length) return;
  friendsView = view;
  const shownBefore = new Set([...box.querySelectorAll('.friend[data-key]')].map((n) => n.dataset.key));
  if (!pcs.length && !(service && service.friends.length)) {
    box.replaceChildren(el('div', { className: 'empty', textContent: service && service.signedIn && service.username
      ? 'No friends yet. Add someone by their username above.'
      : tailscale
      ? 'No friends yet. Add one by username above, or a friend who shares their PC with you on Tailscale shows up here.'
      : 'Sign in to Tailscale to see your friends here.' }));
    return;
  }
  // One card per person: friends first (online ones on top), then your own PCs, then other PCs
  const groups = new Map();
  for (const f of (service && service.friends) || []) groups.set(f.username, []);
  for (const pc of pcs) {
    const key = !pc.user ? 'other' : pc.user === me ? 'me' : pc.user;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pc);
  }
  const rank = (key, list) => (key === 'me' ? 2 : key === 'other' ? 3 : list.some((p) => p.online) ? 0 : 1);
  const ordered = [...groups].sort(([a, la], [b, lb]) => (rank(a, la) - rank(b, lb)) || a.localeCompare(b));
  box.replaceChildren(...ordered.map(([key, list]) => {
    list.sort((a, b) => (b.online - a.online) || (a.name || '').localeCompare(b.name || ''));
    const account = (service && service.friends || []).find((f) => f.username === key);
    const isAccount = Boolean(account);
    const title = key === 'me' ? 'Your PCs' : key === 'other' ? 'Other PCs' : (account && account.nickname) || personName(key);
    const online = list.some((p) => p.online);
    const playing = list.find((p) => p.online && p.game);
    const summary = key === 'me' || key === 'other'
      ? `${list.filter((p) => p.online).length} of ${list.length} online`
      : !online ? 'Offline'
      : playing ? `Playing ${gameLabel(playing.game)}`
      : list.some((p) => p.guests > 0) ? 'Hosting' : list.some((p) => p.busy) ? 'In a game' : 'Online';
    const name = el('div', { className: 'friend-name', textContent: title });
    if (account && account.nickname) name.append(el('span', { className: 'friend-handle', textContent: key }));
    const badge = isAccount ? versionBadge(list, version) : null;
    if (badge) name.append(badge);
    const head = el('div', { className: 'friend-head' },
      avatarFor(key, title),
      el('div', { className: 'friend-head-text' },
        name,
        el('div', { className: 'friend-summary', textContent: list.length || !isAccount ? summary : (account.online ? 'Online' : 'Offline'), title: key.includes('@') ? key : '' })));
    const actions = el('div', { className: 'friend-actions' });
    if (isAccount) {
      const message = el('button', { className: 'secondary message-button', textContent: 'Message' });
      if (account.unread) message.append(el('span', { className: 'unread-count', textContent: String(account.unread) }));
      message.title = `Send ${title} a quick message`;
      message.addEventListener('click', () => openChat(key));
      const nick = el('button', { className: 'link-button neutral', textContent: 'Nickname' });
      nick.title = 'A name only you see for this friend';
      nick.addEventListener('click', () => openNickname(key, account.nickname || ''));
      actions.append(message, nick);
      const remove = el('button', { className: 'link-button', textContent: 'Remove' });
      remove.title = `Stop being friends with ${key}`;
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${key} from your friends?`)) return;
        busy(remove, 'Removing…', async () => {
          await window.moonshine.account.remove(key);
          await loadFriends();
        });
      });
      actions.append(remove);
    }
    const card = el('div', { className: `friend${online ? '' : ' away'}` },
      head,
      ...(actions.children.length ? [actions] : []),
      list.length
        ? el('div', { className: 'friend-pcs' }, ...list.map(friendPcRow))
        : el('div', { className: 'friend-summary', textContent: 'No PCs with Moonshine open yet.' }));
    card.dataset.key = key;
    return settle(card, shownBefore.has(key));
  }));
}

/** Show the Friends tab. A full search for PCs now and then; quick status checks every few seconds. */
async function loadFriends(first = false, manual = false) {
  clearTimeout(friendsTimer);
  if (!$('#tab-friends').classList.contains('active')) return;
  const box = $('#friends');
  if (first && !box.children.length) box.replaceChildren(el('div', { className: 'empty', textContent: 'Looking for friends…' }));
  const full = Date.now() - friendsFullAt > 60000;
  try {
    if (document.visibilityState === 'visible') {
      const res = await window.moonshine.friends.status(full, manual);
      if (full) friendsFullAt = Date.now();
      renderFriends(res);
      if (chatWith) showChatStatus();
    }
  } catch (err) {
    if (first) toast(errorText(err));
  }
  friendsTimer = setTimeout(loadFriends, 5000);
}

$('#friend-alerts').addEventListener('change', (e) => window.moonshine.friends.setAlerts(e.target.checked));
$('#share-game').addEventListener('change', (e) => window.moonshine.friends.setShareGame(e.target.checked));

// ---- Quick messages ------------------------------------------------------------------------

const QUICK_MESSAGES = ['Want to play?', 'Join me!', 'On my way', 'Give me 5 minutes', 'Can’t right now', 'GG!'];
let lastFriendsService = null;
let chatWith = '';

function chatFriend() {
  return ((lastFriendsService && lastFriendsService.friends) || []).find((f) => f.username === chatWith);
}

function chatTime(at) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function chatBubble(m) {
  return el('div', { className: `chat-msg${m.mine ? ' mine' : ''}` }, m.text, el('time', { textContent: chatTime(m.at) }));
}

function showChatStatus() {
  const f = chatFriend();
  const online = f && f.online;
  $('#chat-status').textContent = online ? 'Online · messages arrive at once' : 'Offline · messages only reach friends who are online';
  $('#chat-submit').disabled = !online;
  for (const b of $('#chat-quick').children) b.disabled = !online;
}

async function openChat(username) {
  chatWith = username;
  const f = chatFriend();
  $('#chat-title').textContent = (f && f.nickname) || username;
  const log = $('#chat-log');
  const history = await window.moonshine.friends.messages(username);
  log.replaceChildren(...(history.length ? history.map(chatBubble) : [el('div', { className: 'chat-empty', textContent: 'No messages yet. Say hi, or pick a quick message below.' })]));
  $('#chat-quick').replaceChildren(...QUICK_MESSAGES.map((text) => {
    const b = el('button', { type: 'button', className: 'secondary', textContent: text });
    b.addEventListener('click', () => sendChat(text, b));
    return b;
  }));
  showChatStatus();
  $('#chat-dialog').classList.remove('hidden');
  log.scrollTop = log.scrollHeight;
  $('#chat-input').focus();
  window.moonshine.friends.chatOpen(username);
  friendsView = ''; // its unread count is gone now
  loadFriends();
}

function closeChat() {
  $('#chat-dialog').classList.add('hidden');
  chatWith = '';
  window.moonshine.friends.chatOpen('');
}

function appendChat(entry) {
  const log = $('#chat-log');
  log.querySelector('.chat-empty')?.remove();
  log.append(chatBubble(entry));
  log.scrollTop = log.scrollHeight;
}

function sendChat(text, button) {
  return busy(button, 'Sending…', async () => {
    const entry = await window.moonshine.friends.sendMessage(chatWith, text);
    appendChat(entry);
    return true;
  }).finally(showChatStatus);
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !chatWith) return;
  sendChat(text, $('#chat-submit')).then((sent) => { if (sent) input.value = ''; input.focus(); });
});
$('#chat-close').addEventListener('click', closeChat);
$('#chat-dialog').addEventListener('click', (e) => { if (e.target.id === 'chat-dialog') closeChat(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && chatWith) closeChat(); });

window.moonshine.friends.onMessage(({ username, entry, looking }) => {
  if (username === chatWith && !$('#chat-dialog').classList.contains('hidden')) {
    appendChat(entry);
    if (!looking) window.moonshine.friends.messages(username); // read it: clears the unread count
  } else {
    const f = ((lastFriendsService && lastFriendsService.friends) || []).find((x) => x.username === username);
    toast(`${(f && f.nickname) || username}: ${entry.text}`);
  }
  friendsView = '';
  loadFriends();
});
window.moonshine.friends.onOpenChat((username) => { selectTab('friends'); openChat(username); });

// ---- Nicknames: a name only you see for a friend ---------------------------------------------

let nicknameFor = '';
function openNickname(username, current) {
  nicknameFor = username;
  $('#nick-hint').textContent = `Only you see it. Leave it empty to show ${username} again.`;
  $('#nick-input').value = current;
  $('#nick-dialog').classList.remove('hidden');
  $('#nick-input').focus();
  $('#nick-input').select();
}
$('#nick-cancel').addEventListener('click', () => $('#nick-dialog').classList.add('hidden'));
$('#nick-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('#nick-save'), 'Saving…', async () => {
    await window.moonshine.friends.setNickname(nicknameFor, $('#nick-input').value.trim());
    $('#nick-dialog').classList.add('hidden');
    friendsView = '';
    await loadFriends(false, true);
  });
});
// The service said something changed (a friend came online, started streaming, sent a request...)
window.moonshine.friends.onChanged(() => loadFriends());
window.moonshine.onSelectTab((name) => selectTab(name));

$('#refresh-friends').addEventListener('click', (e) => busy(e.target, 'Refreshing…', async () => {
  friendsFullAt = 0;
  await loadFriends(false, true);
}));

// ---- Stream settings -------------------------------------------------------------

const settingsForm = $('#settings-form');
let nativeResolution = '';

function updateBitrateLabel() {
  const mbps = Number(settingsForm.bitrateMbps.value);
  $('#bitrate-label').textContent = mbps ? `${mbps} Mbps` : 'Automatic';
  $('#opacity-label').textContent = `${settingsForm.overlayOpacity.value}%`;
}

async function loadSettings() {
  const { settings: s, nativeResolution: native } = await window.moonshine.settings.get();
  nativeResolution = native;
  $('#native-resolution').textContent = `This screen (${native})`;
  for (const [key, value] of Object.entries(s)) {
    const field = settingsForm.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = key === 'resolution' && value && value === native ? 'native' : String(value);
  }
  // A saved resolution that matches none of the presets (e.g. from another screen).
  if (settingsForm.resolution.value === '' && s.resolution) {
    settingsForm.resolution.append(el('option', { value: s.resolution, textContent: s.resolution }));
    settingsForm.resolution.value = s.resolution;
  }
  updateBitrateLabel();
}

settingsForm.addEventListener('input', updateBitrateLabel);
settingsForm.addEventListener('change', () => {
  const s = {};
  for (const field of settingsForm.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') s[field.name] = field.checked;
    else if (field.type === 'range') s[field.name] = Number(field.value);
    else s[field.name] = field.value === 'native' ? nativeResolution : field.value;
  }
  window.moonshine.settings.set(s);
});

// ---- Host -------------------------------------------------------------------

let serviceRunning = false;
let hostSnapshot = '';

/** Show the Host tab. With `statusOnly`, the rest of the tab is only redrawn when something changed. */
async function loadHost(statusOnly = false) {
  const s = await host.status();
  const snapshot = JSON.stringify([s.service, s.tailscale, s.tailscaleInstalled, s.loginNeeded, Boolean(s.audio)]);
  if (statusOnly && snapshot === hostSnapshot) return;
  hostSnapshot = snapshot;
  if (s.service === 'running') loadBandwidth();

  const stateText = {
    running: 'On',
    stopped: 'Off',
    'not-installed': 'Host not installed (run the Moonshine installer again)',
  }[s.service] || s.service;
  const state = $('#service-state');
  state.textContent = stateText;
  state.className = `value ${s.service === 'running' ? 'ok' : 'warn'}`;
  serviceRunning = s.service === 'running';
  const toggle = $('#toggle-service');
  toggle.textContent = serviceRunning ? 'Stop hosting' : 'Start hosting';
  toggle.disabled = s.service === 'not-installed';

  const ts = $('#tailscale-state');
  if (s.tailscale) {
    ts.textContent = `${s.tailscale.name} · ${s.tailscale.ip}`;
    ts.className = 'value ok';
  } else {
    ts.textContent = s.tailscaleInstalled ? 'Not signed in' : 'Not installed';
    ts.className = 'value warn';
  }

  $('#login-panel').classList.toggle('hidden', !s.loginNeeded);
  $('#audio-panel').classList.toggle('hidden', !s.audio);
  $('#open-webui').disabled = !serviceRunning || s.loginNeeded;
  $('#open-webui-page').disabled = !serviceRunning;
  $('#start-at-login').checked = s.startAtLogin;

  // Only when the saved setting changed, so the 3-second status refresh doesn't undo unsaved picks.
  const savedAudio = s.audio ? `${s.audio.mode}|${s.audio.app}` : '';
  if (s.audio && savedAudio !== audioSaved) {
    audioSaved = savedAudio;
    audioMode = s.audio.mode;
    audioApps = s.audio.app.split(/[,;|]/).map((a) => a.trim()).filter(Boolean);
    renderAudio();
    host.processes().then((names) => { runningApps = names; renderAudioSuggestions(); });
  }

  if (serviceRunning && !s.loginNeeded) loadClients();
  else {
    const why = serviceRunning ? 'Sign in above to see paired devices.' : 'Start hosting to see paired devices.';
    $('#clients').replaceChildren(el('div', { className: 'empty', textContent: why }));
  }
}

// What a paired device may do (the host's permission bits, src/crypto.h in upstream/apollo).
const PERMISSIONS = [
  { title: 'Streaming', items: [[1 << 24, 'See the app list'], [1 << 26, 'Start apps'], [1 << 25, 'Join a stream that’s already running']] },
  { title: 'Input', items: [[1 << 12, 'Keyboard'], [1 << 11, 'Mouse'], [1 << 8, 'Controller'], [1 << 9, 'Touch'], [1 << 10, 'Pen']] },
  { title: 'Clipboard and files', items: [[1 << 17, 'Read this PC’s clipboard'], [1 << 16, 'Change this PC’s clipboard'], [1 << 18, 'Send files to this PC'], [1 << 19, 'Take files from this PC']] },
  { title: 'Commands', items: [[1 << 20, 'Run server commands']] },
];
const openDevices = new Set(); // uuids whose details are expanded

/** Save a change to a device and keep the row's copy in step; on failure, reload the true state. */
async function updateDevice(c, changes, message) {
  try {
    await host.updateClient(c.uuid, changes);
    Object.assign(c, changes);
    if (message) toast(message);
    return true;
  } catch (err) {
    toast(errorText(err));
    loadClients();
    return false;
  }
}

function deviceDetails(c) {
  const name = el('input', { value: c.name, maxLength: 60 });
  const rename = el('button', { className: 'secondary', textContent: 'Rename' });
  rename.addEventListener('click', () => busy(rename, 'Saving…', async () => {
    const value = name.value.trim();
    if (!value) throw new Error('Type a name first.');
    if (await updateDevice(c, { name: value }, 'Renamed.')) loadClients();
  }));

  const groups = PERMISSIONS.map((group) => el('div', { className: 'perm-group' },
    el('h3', { textContent: group.title }),
    ...group.items.map(([bit, label]) => {
      const box = el('input', { type: 'checkbox', checked: Boolean(c.perm & bit) });
      box.addEventListener('change', async () => {
        const perm = (box.checked ? c.perm | bit : c.perm & ~bit) >>> 0;
        if (!(await updateDevice(c, { perm }))) box.checked = !box.checked;
      });
      return el('label', { className: 'check' }, box, label);
    })));

  const mode = el('input', { value: c.display_mode || '', placeholder: 'Automatic (or e.g. 1920x1080x60)' });
  const applyMode = el('button', { className: 'secondary', textContent: 'Apply' });
  applyMode.addEventListener('click', () => busy(applyMode, 'Saving…', async () => {
    const value = mode.value.trim();
    if (value && !/^\d+x\d+x\d+(\.\d+)?$/.test(value)) throw new Error('Use width x height x frame rate, like 1920x1080x60.');
    await updateDevice(c, { display_mode: value }, value ? `${c.name} will always stream at ${value}.` : `${c.name} picks its own resolution again.`);
  }));

  const option = (key, label) => {
    const box = el('input', { type: 'checkbox', checked: Boolean(c[key]) });
    box.addEventListener('change', async () => {
      if (!(await updateDevice(c, { [key]: box.checked }))) box.checked = !box.checked;
    });
    return el('label', { className: 'check' }, box, label);
  };

  return el('div', { className: 'device-details' },
    el('div', { className: 'detail-row' }, el('span', { className: 'detail-label', textContent: 'Name' }), name, rename),
    el('div', { className: 'perm-grid' }, ...groups),
    el('div', { className: 'detail-row' }, el('span', { className: 'detail-label', textContent: 'Resolution' }), mode, applyMode),
    el('div', { className: 'perm-group' },
      option('always_use_virtual_display', 'Always give this device its own virtual display'),
      option('allow_client_commands', 'Run this device’s own commands when it connects'),
      option('enable_legacy_ordering', 'Keep the app list in order for older clients')));
}

let clientsSnapshot = '';
const clientsKey = (clients) => JSON.stringify(clients.map((c) => [c.uuid, c.name, c.connected, c.require_approval]));

/** Redraw the Devices list if who is paired or streaming has changed (someone joined, left or paired). */
async function refreshClientsIfChanged() {
  const clients = await host.clients().catch(() => null);
  if (clients && clientsKey(clients) !== clientsSnapshot) loadClients(clients);
}

async function loadClients(known) {
  const clients = known || await host.clients().catch(() => []);
  clientsSnapshot = clientsKey(clients);
  if (!clients.length) {
    $('#clients').replaceChildren(el('div', { className: 'empty', textContent: 'No paired devices yet.' }));
    return;
  }
  $('#clients').replaceChildren(...clients.map((c) => {
    const ask = el('input', { type: 'checkbox', className: 'switch', checked: c.require_approval });
    ask.title = 'Show a popup on this PC to allow each stream from this device';
    ask.addEventListener('change', async () => {
      const on = ask.checked;
      const ok = await updateDevice(c, { require_approval: on },
        on ? `${c.name} will ask before each stream.` : `${c.name} can stream without asking.`);
      if (!ok) ask.checked = !on;
    });

    const details = deviceDetails(c);
    details.classList.toggle('hidden', !openDevices.has(c.uuid));
    const manage = el('button', { className: 'secondary', textContent: openDevices.has(c.uuid) ? 'Done' : 'Manage' });
    manage.addEventListener('click', () => {
      const open = details.classList.toggle('hidden') === false;
      if (open) openDevices.add(c.uuid);
      else openDevices.delete(c.uuid);
      manage.textContent = open ? 'Done' : 'Manage';
    });

    const buttons = [manage];
    if (c.connected) {
      const disconnect = el('button', { className: 'danger', textContent: 'Kick' });
      disconnect.title = 'End this device’s stream now';
      disconnect.addEventListener('click', () => busy(disconnect, 'Kicking…', async () => {
        await host.disconnectClient(c.uuid);
        toast(c.require_approval
          ? `Kicked ${c.name}. It has to ask before it can stream again.`
          : `Kicked ${c.name}. It can reconnect without asking; turn on “Ask before streaming” to stop that.`);
        setTimeout(loadClients, 1500);
      }));
      buttons.push(disconnect);
    }
    const remove = el('button', { className: 'danger', textContent: 'Remove' });
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${c.name}? It will have to pair again to connect.`)) return;
      busy(remove, 'Removing…', async () => {
        await host.unpair(c.uuid);
        openDevices.delete(c.uuid);
        loadClients();
      });
    });
    buttons.push(remove);

    const status = [c.user, c.connected ? 'Streaming now' : ''].filter(Boolean).join(' · ');
    return el('div', { className: 'device' },
      el('div', { className: 'item' },
        el('div', { className: 'grow' },
          el('div', { textContent: c.name || 'Unnamed device' }),
          el('div', { className: `meta hint${c.connected ? ' live' : ''}`, textContent: status || 'Not connected' })),
        el('span', { className: 'check small' }, ask, 'Ask before streaming'),
        ...buttons),
      details);
  }));
}

// ---- Host: which apps' audio is streamed ----------------------------------------

let audioSaved = null; // "mode|apps" as last loaded from the host
let audioMode = 'system';
let audioApps = [];
let runningApps = [];
// Windows' own background processes, never what anyone wants to pick.
const SYSTEM_PROCESSES = new Set(['svchost.exe', 'conhost.exe', 'csrss.exe', 'smss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'dwm.exe', 'fontdrvhost.exe', 'sihost.exe', 'taskhostw.exe', 'runtimebroker.exe',
  'dllhost.exe', 'ctfmon.exe', 'searchhost.exe', 'searchindexer.exe', 'searchprotocolhost.exe', 'searchfilterhost.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe', 'smartscreen.exe', 'wmiprvse.exe',
  'audiodg.exe', 'spoolsv.exe', 'registry', 'system', 'memory compression', 'secure system', 'msmpeng.exe',
  'nissrv.exe', 'securityhealthservice.exe', 'securityhealthsystray.exe', 'lsaiso.exe', 'wudfhost.exe', 'tasklist.exe',
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'openconsole.exe', 'applicationframehost.exe', 'systemsettings.exe',
  'useroobebroker.exe', 'backgroundtaskhost.exe', 'crossdeviceresume.exe', 'widgetservice.exe', 'sunshine.exe',
  'sunshinesvc.exe', 'moonshine.exe']);

const audioNotes = {
  system: 'Everything this PC plays is streamed.',
  exclude: 'Everything is streamed except these apps. With two or more, Windows system sounds are left out too, and an app that starts playing joins within a couple of seconds.',
  include: 'Only these apps are streamed. If none of them is running, the stream is silent.',
};

function renderAudio() {
  document.querySelectorAll('#audio-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === audioMode));
  $('#audio-apps').classList.toggle('hidden', audioMode === 'system');
  $('#audio-note').textContent = `${audioNotes[audioMode]} Applying restarts the host, which ends any active stream.`;
  $('#audio-chips').replaceChildren(...audioApps.map((name) => {
    const remove = el('button', { type: 'button', textContent: '×', title: `Remove ${name}` });
    remove.addEventListener('click', () => {
      audioApps = audioApps.filter((a) => a !== name);
      renderAudio();
      renderAudioSuggestions();
    });
    return el('span', { className: 'chip' }, name, remove);
  }));
}

function addAudioApp(name) {
  name = name.trim();
  if (!name) return;
  if (!/\.exe$/i.test(name)) name += '.exe';
  if (!audioApps.some((a) => a.toLowerCase() === name.toLowerCase())) audioApps.push(name);
  $('#audio-search').value = '';
  renderAudio();
  renderAudioSuggestions();
}

function renderAudioSuggestions() {
  const query = $('#audio-search').value.trim().toLowerCase();
  const picked = new Set(audioApps.map((a) => a.toLowerCase()));
  const matches = runningApps
    .filter((n) => !SYSTEM_PROCESSES.has(n.toLowerCase()) && !picked.has(n.toLowerCase()))
    .filter((n) => !query || n.toLowerCase().includes(query))
    .slice(0, 60);
  // Only list while searching, or before anything is picked, so the panel stays tidy.
  const show = query || !audioApps.length;
  $('#audio-suggest').replaceChildren(...(show ? matches : []).map((name) => {
    const b = el('button', { type: 'button' }, el('span', { textContent: name }), el('span', { className: 'add', textContent: '+' }));
    b.addEventListener('click', () => addAudioApp(name));
    return b;
  }));
}

document.querySelectorAll('#audio-mode button').forEach((b) => b.addEventListener('click', () => {
  audioMode = b.dataset.mode;
  renderAudio();
}));
$('#audio-search').addEventListener('input', renderAudioSuggestions);
$('#audio-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = $('#audio-suggest button span');
  addAudioApp(first && !/\.exe$/i.test(e.target.value.trim()) ? first.textContent : e.target.value);
});

$('#save-audio').addEventListener('click', (e) => busy(e.target, 'Applying…', async () => {
  if (audioMode !== 'system' && !audioApps.length) throw new Error('Pick at least one app first.');
  const apps = audioMode === 'system' ? '' : audioApps.join(', ');
  await host.setAudio(audioMode, apps);
  audioSaved = `${audioMode}|${apps}`;
  toast('Audio settings saved. Host restarting…');
  setTimeout(loadHost, 4000);
}));

$('#toggle-service').addEventListener('click', (e) => busy(e.target, 'Working…', async () => {
  await host.setService(!serviceRunning);
  await loadHost();
}));

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, 'Signing in…', async () => {
    await host.login($('#login-user').value, $('#login-pass').value);
    loadHost();
  });
});

$('#open-webui').addEventListener('click', () => selectTab('apollo'));
$('#open-webui-page').addEventListener('click', () => {
  apolloSub = 'webui';
  selectTab('apollo');
});
$('#start-at-login').addEventListener('change', (e) => window.moonshine.setStartAtLogin(e.target.checked));
// ---- Host: guests streaming right now, with live input and ping --------------------

const ACTIVE_INPUT_MS = 350; // an icon lights up for this long after the input is used
const svgNS = 'http://www.w3.org/2000/svg';
const INPUT_ICONS = {
  controller: 'M7 9h2M8 8v2M15.5 9h.01M17.5 10.5h.01M6.5 5h11A4.5 4.5 0 0 1 22 9.5v4a3.5 3.5 0 0 1-6.3 2.1L14.6 14H9.4l-1.1 1.6A3.5 3.5 0 0 1 2 13.5v-4A4.5 4.5 0 0 1 6.5 5z',
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  mouse: 'M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6zM12 7v4',
};
const guestNodes = new Map(); // uuid -> { root, icons, ping, name }

function inputIcon(kind) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', INPUT_ICONS[kind]);
  svg.append(path);
  const wrap = el('span', { className: 'input-icon', title: kind[0].toUpperCase() + kind.slice(1) });
  wrap.append(svg);
  return wrap;
}

function pingClass(ms) {
  return !ms ? '' : ms <= 40 ? 'good' : ms <= 100 ? 'fair' : 'bad';
}

const GUEST_INPUTS = [['controller', 1 << 8, 'Controller'], ['keyboard', 1 << 12, 'Keyboard'], ['mouse', 1 << 11, 'Mouse']];

function guestNode(g) {
  const hue = [...g.uuid].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const avatar = el('div', { className: 'avatar', textContent: ((g.name || '').trim()[0] || '?').toUpperCase() });
  avatar.style.background = `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 75% 35%))`;
  const icons = { controller: inputIcon('controller'), keyboard: inputIcon('keyboard'), mouse: inputIcon('mouse') };
  const name = el('span', { className: 'guest-name' });
  const ping = el('span', { className: 'guest-ping' });
  const kick = el('button', { className: 'danger', textContent: 'Kick' });
  kick.addEventListener('click', () => busy(kick, 'Kicking…', async () => {
    await host.disconnectClient(g.uuid);
    toast(`Kicked ${name.textContent}.`);
    pollGuests();
  }));
  // Switches for what this guest may use. Apollo applies them to the running stream at once.
  const node = { icons, ping, name, perm: null };
  const toggles = GUEST_INPUTS.map(([kind, bit, label]) => {
    const button = el('button', { className: 'perm-toggle', type: 'button' }, inputIcon(kind), el('span', { textContent: label }));
    button.addEventListener('click', async () => {
      if (node.perm === null) return;
      const perm = (node.perm ^ bit) >>> 0;
      button.disabled = true;
      try {
        await host.updateClient(g.uuid, { perm });
        node.perm = perm;
        const who = name.textContent;
        toast(perm & bit ? `${who} can use ${label.toLowerCase()} again.` : `${who} can’t use ${label.toLowerCase()} now.`);
      } catch (err) {
        toast(errorText(err));
      } finally {
        button.disabled = false;
        showPerm();
      }
    });
    return [bit, label, button];
  });
  const permRow = el('div', { className: 'guest-perms hidden' }, ...toggles.map(([, , b]) => b));
  const showPerm = () => {
    permRow.classList.toggle('hidden', node.perm === null);
    for (const [bit, label, b] of toggles) {
      const on = Boolean(node.perm & bit);
      b.classList.toggle('on', on);
      b.title = on ? `Allowed. Click to block their ${label.toLowerCase()}.` : `Blocked. Click to allow their ${label.toLowerCase()}.`;
    }
  };
  // Read the guest's permissions fresh each time the card opens (they can change in the Devices list too)
  const refreshPerm = async () => {
    const c = (await host.clients().catch(() => [])).find((x) => x.uuid === g.uuid);
    node.perm = c ? c.perm >>> 0 : null;
    showPerm();
  };
  // Player number(s) of this guest's controllers, and moving them earlier or later
  const player = el('span', { className: 'player-badge hidden' });
  const playerText = el('span', { className: 'player-text' });
  const earlier = el('button', { className: 'secondary player-move', type: 'button', textContent: '‹', title: 'Earlier player number' });
  const later = el('button', { className: 'secondary player-move', type: 'button', textContent: '›', title: 'Later player number' });
  earlier.addEventListener('click', () => movePlayer(g.uuid, -1));
  later.addEventListener('click', () => movePlayer(g.uuid, 1));
  const playerRow = el('div', { className: 'guest-player hidden' }, playerText, el('span', { className: 'player-moves' }, earlier, later));
  Object.assign(node, { player, playerText, playerRow, earlier, later });

  const card = el('div', { className: 'guest-card' },
    el('div', { className: 'guest-head' }, el('div', { className: 'guest-title' }, name, ping), kick), playerRow, permRow);
  const avatarWrap = el('div', { className: 'avatar-wrap' }, avatar, player);
  const root = el('div', { className: 'guest', tabIndex: 0 }, avatarWrap,
    el('div', { className: 'guest-inputs' }, icons.controller, icons.keyboard, icons.mouse), card);
  root.addEventListener('mouseenter', refreshPerm);
  root.addEventListener('focusin', (e) => { if (e.target === root) refreshPerm(); });
  refreshPerm();
  node.root = root;
  return node;
}

let playerOrder = []; // guest uuids with controllers, player 1 first
let lastGuests = [];

/** Swap a guest's controllers with the guest before or after them. Controllers reconnect for a moment. */
async function movePlayer(uuid, step) {
  const order = [...playerOrder];
  const i = order.indexOf(uuid);
  const j = i + step;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  try {
    await host.setPlayerOrder(order);
    toast('Swapped players. Their controllers reconnect for a moment.');
    setTimeout(pollGuests, 900);
  } catch (err) {
    toast(errorText(err));
  }
}

const PRESETS = {
  full: { on: (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12), text: 'Everyone has full control.' },
  controllers: { on: 1 << 8, text: 'Everyone has controllers only.' },
  watch: { on: 0, text: 'Everyone can only watch.' },
};
const INPUT_BITS = (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12);

document.querySelectorAll('#guest-presets [data-preset]').forEach((button) => {
  button.addEventListener('click', () => busy(button, 'Applying…', async () => {
    const preset = PRESETS[button.dataset.preset];
    const clients = await host.clients();
    for (const g of lastGuests) {
      const c = clients.find((x) => x.uuid === g.uuid);
      if (!c) continue;
      const perm = ((c.perm & ~INPUT_BITS) | preset.on) >>> 0;
      if (perm !== c.perm >>> 0) await host.updateClient(c.uuid, { perm });
    }
    toast(preset.text);
  }));
});

function renderGuests(list) {
  const box = $('#guests');
  const seen = new Set();
  lastGuests = list;
  // Player numbers: all controllers in the order they were plugged in (lowest number first)
  const allPads = list.flatMap((g) => g.pads || []).sort((a, b) => a - b);
  const playerOf = (pad) => allPads.indexOf(pad) + 1;
  playerOrder = list.filter((g) => (g.pads || []).length)
    .sort((a, b) => Math.min(...a.pads) - Math.min(...b.pads)).map((g) => g.uuid);
  $('#guest-presets').classList.toggle('hidden', !list.length);
  for (const g of list) {
    seen.add(g.uuid);
    let node = guestNodes.get(g.uuid);
    if (!node) {
      node = guestNode(g);
      guestNodes.set(g.uuid, node);
      box.append(node.root);
    }
    node.name.textContent = g.name || 'Unnamed device';
    const mbps = g.bitrate > 0 ? `${(g.bitrate / 1000).toFixed(g.bitrate < 10000 ? 1 : 0)} Mbps` : '';
    node.ping.textContent = [g.ping ? `${g.ping} ms` : '', mbps].filter(Boolean).join(' · ');
    node.ping.className = `guest-ping ${pingClass(g.ping)}`;
    const players = (g.pads || []).map(playerOf).sort((a, b) => a - b);
    node.player.textContent = players.map((p) => `P${p}`).join(' ');
    node.player.classList.toggle('hidden', !players.length);
    node.playerRow.classList.toggle('hidden', !players.length);
    node.playerText.textContent = players.length > 1 ? `Players ${players.join(' and ')}` : `Player ${players[0]}`;
    const at = playerOrder.indexOf(g.uuid);
    node.earlier.disabled = at <= 0;
    node.later.disabled = at < 0 || at >= playerOrder.length - 1;
    node.playerRow.classList.toggle('solo', playerOrder.length < 2);
    for (const kind of ['controller', 'keyboard', 'mouse']) {
      const idle = g[kind];
      node.icons[kind].classList.toggle('active', idle >= 0 && idle < ACTIVE_INPUT_MS);
      node.icons[kind].classList.toggle('used', idle >= 0);
    }
  }
  for (const [uuid, node] of guestNodes) {
    if (!seen.has(uuid)) {
      node.root.remove();
      guestNodes.delete(uuid);
    }
  }
  box.classList.toggle('empty-guests', !list.length);
  showBandwidthNote(list);
}

// ---- Host: upload limit shared by everyone watching --------------------------------------------

let bandwidthMbps = 0;

function showBandwidthNote(list = lastGuests || []) {
  const note = $('#bandwidth-note');
  if (!bandwidthMbps) {
    note.textContent = 'Shared by everyone watching. Empty means no limit.';
  } else if (list.length > 1) {
    note.textContent = `${bandwidthMbps} Mbps shared by ${list.length} watching: up to ${+(bandwidthMbps / list.length).toFixed(1)} Mbps each.`;
  } else {
    note.textContent = `Everyone watching shares ${bandwidthMbps} Mbps, split evenly.`;
  }
}

async function loadBandwidth() {
  if (document.activeElement === $('#bandwidth-limit')) return; // don't overwrite typing
  bandwidthMbps = await host.getBandwidth().catch(() => bandwidthMbps);
  $('#bandwidth-limit').value = bandwidthMbps ? String(bandwidthMbps) : '';
  showBandwidthNote();
}

$('#bandwidth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = Number($('#bandwidth-limit').value || 0);
  if (!Number.isFinite(value) || value < 0) {
    toast('Enter the limit in Mbps, or leave it empty for no limit.');
    return;
  }
  busy(e.submitter, 'Saving…', async () => {
    bandwidthMbps = await host.setBandwidth(value);
    $('#bandwidth-limit').value = bandwidthMbps ? String(bandwidthMbps) : '';
    $('#bandwidth-limit').blur();
    showBandwidthNote();
    toast(bandwidthMbps ? `Everyone watching now shares ${bandwidthMbps} Mbps.` : 'No upload limit now.');
  });
});

let guestTimer = null;
async function pollGuests() {
  clearTimeout(guestTimer);
  const onScreen = $('#tab-host').classList.contains('active') && document.visibilityState === 'visible';
  let list = [];
  if (onScreen && serviceRunning) {
    list = await host.guests().catch(() => []);
    renderGuests(list);
  }
  // Fast while someone is streaming, so the input icons feel live; slow otherwise.
  guestTimer = setTimeout(pollGuests, list.length ? 200 : 2000);
}
pollGuests();

// Keep the Host tab current while it's on screen: hosting and Tailscale can change outside Moonshine.
setInterval(() => {
  if ($('#tab-host').classList.contains('active') && document.visibilityState === 'visible') {
    loadHost(true).then(() => { if (serviceRunning) refreshClientsIfChanged(); }).catch(() => {});
  }
}, 3000);
host.onChanged(() => { if ($('#tab-host').classList.contains('active')) loadHost(); });
window.moonshine.onToast(toast);

// ---- Updates ----------------------------------------------------------------------------

const updates = window.moonshine.updates;
let checkingByHand = false;

function mb(bytes) { return `${(bytes / 1048576).toFixed(0)} MB`; }

function showUpdate(s) {
  if (!s) return;
  const box = $('#update-box');
  const show = ['available', 'downloading', 'ready', 'installing'].includes(s.status);
  box.classList.toggle('hidden', !show);
  const line = $('#app-version');
  line.disabled = s.status === 'checking' || s.status === 'downloading' || s.status === 'installing';
  line.textContent = s.status === 'checking' ? 'Checking for updates…' : `Moonshine ${s.current} · Check for updates`;
  if (show) {
    $('#update-title').textContent = s.status === 'installing' ? 'Installing the update…' : `Moonshine ${s.version} is available`;
    const bar = $('#update-bar');
    bar.classList.toggle('hidden', s.status !== 'downloading');
    if (s.status === 'downloading') {
      const pct = s.total ? Math.min(100, Math.round((s.received / s.total) * 100)) : 0;
      bar.firstElementChild.style.width = `${pct}%`;
      $('#update-detail').textContent = s.total ? `Downloading… ${mb(s.received)} of ${mb(s.total)}` : 'Downloading…';
    } else {
      $('#update-detail').textContent = s.error || (s.status === 'available' && s.size ? `${mb(s.size)} download` : '');
    }
    const button = $('#update-now');
    button.classList.toggle('hidden', s.status === 'installing');
    button.disabled = s.status === 'downloading';
    button.textContent = s.status === 'downloading' ? 'Downloading…' : s.status === 'ready' ? 'Install now' : 'Update now';
  }
  if (checkingByHand && s.status !== 'checking') {
    checkingByHand = false;
    if (s.status === 'current') toast(`You have the latest version (${s.current}).`);
    else if (s.status === 'error') toast(s.message);
  }
}

updates.onState(showUpdate);
updates.get().then(showUpdate);
$('#app-version').addEventListener('click', () => {
  checkingByHand = true;
  updates.check().then(showUpdate).catch((err) => { checkingByHand = false; toast(err.message); });
});
$('#update-now').addEventListener('click', () => {
  updates.install().catch((err) => toast(errorText(err)));
});

loadHosts();
host.status().then((s) => { $('#start-at-login').checked = s.startAtLogin; });
