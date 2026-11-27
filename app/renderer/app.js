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
  friends: () => { showHostList(); loadFriends(true); },
  host: () => loadHost(),
  beta: () => loadBeta(),
  settings: async () => { await loadSettings(); fillPcPicker().then(loadSettings); },
  apollo: () => showApollo(),
};

function selectTab(name) {
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
};

function showApollo() {
  selectApolloSub(apolloSub);
}

function selectApolloSub(name) {
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

// ---- Host settings: settings --------------------------------------------------------

const settingsFormEl = $('#apollo-settings-form');
let apolloConfig = null; // what Apollo has saved
let apolloEdits = {}; // key -> new value, not saved yet
const allFields = APOLLO_SCHEMA.flatMap((s) => s.fields);

// apollo-schema.js is generated from the host's own page, which lists each GPU's encoder as a section
// of its own. Here those go under Advanced, which is sorted into groups.
const ENCODER_SECTIONS = ['nv', 'amd', 'qsv', 'sw'];
const ADVANCED_GROUPS = [
  { title: 'Video formats', keys: ['hevc_mode', 'av1_mode'] },
  { title: 'Capture and encoding', keys: ['capture', 'encoder', 'limit_framerate', 'qp', 'min_threads', 'ignore_encoder_probe_failure'] },
  { title: 'Network', keys: ['fec_percentage'] },
  { title: 'Compatibility', keys: ['envvar_compatibility_mode', 'legacy_ordering'] },
];
const SETTINGS_PAGES = (() => {
  const pages = APOLLO_SCHEMA.filter((p) => !ENCODER_SECTIONS.includes(p.id) && p.id !== 'advanced');
  const advanced = APOLLO_SCHEMA.find((p) => p.id === 'advanced');
  const byKey = new Map(((advanced && advanced.fields) || []).map((f) => [f.key, f]));
  const groups = ADVANCED_GROUPS.map((g) => ({ title: g.title, fields: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
  const placed = new Set(ADVANCED_GROUPS.flatMap((g) => g.keys));
  const rest = [...byKey.values()].filter((f) => !placed.has(f.key)); // settings added by a newer host
  if (rest.length) groups.push({ title: 'Other', fields: rest });
  for (const id of ENCODER_SECTIONS) {
    const section = APOLLO_SCHEMA.find((p) => p.id === id);
    if (section) groups.push({ title: section.title, fields: section.fields });
  }
  pages.push({ id: 'advanced', title: 'Advanced', groups: groups.filter((g) => g.fields.length) });
  return pages;
})();
let apolloSection = SETTINGS_PAGES[0].id;

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
  const section = SETTINGS_PAGES.find((s) => s.id === apolloSection);
  const c = currentValues();
  const shown = (fields) => fields.filter((f) => !f.when || f.when(c));
  const fieldRow = (f) => el('div', { className: `field${f.key in apolloEdits ? ' changed' : ''}` },
    el('div', { className: 'name', textContent: f.label, title: f.key }),
    el('div', { className: 'control' }, fieldControl(f)),
    el('div', { className: 'desc', textContent: f.desc }));
  const scroll = settingsFormEl.scrollTop;
  const body = section.groups
    ? section.groups.flatMap((g) => {
      const fields = shown(g.fields);
      return fields.length ? [el('h3', { className: 'settings-group', textContent: g.title }), ...fields.map(fieldRow)] : [];
    })
    : shown(section.fields).map(fieldRow);
  settingsFormEl.replaceChildren(el('h2', { textContent: section.title }), ...body);
  settingsFormEl.scrollTop = scroll;
  document.querySelectorAll('#apollo-sections button').forEach((b) => {
    b.classList.toggle('active', b.dataset.section === apolloSection);
  });
}

function renderApolloSectionList() {
  $('#apollo-sections').replaceChildren(...SETTINGS_PAGES.map((s) => {
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

// ---- Connect: the PCs behind the list ----------------------------------------------

let hostsCache = []; // every PC found, with its games (main.js findHosts)
let currentHost = null;
let loadingHosts = null;

function showHostList() {
  currentHost = null;
  $('#host-view').classList.add('hidden');
  $('#host-list-view').classList.remove('hidden');
}

async function loadHosts() {
  loadingHosts ||= connect.hosts().finally(() => { loadingHosts = null; });
  hostsCache = (await loadingHosts).hosts;
}

/** Reached through a direct connection (lib/tunnels.js), not a real address on a network. */
const isDirect = (h) => Boolean(h.direct) || String(h.address || '').startsWith('127.77.');

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
      friendsFullAt = 0;
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

// ---- Connect: one host's games ---------------------------------------------------

function renderApps(h) {
  const apps = $('#apps');
  if (!h.online || !h.paired) {
    const text = !h.online ? 'This PC is offline.' : 'Not paired with this PC yet.';
    const box = el('div', { className: 'empty' }, el('div', { textContent: text }));
    if (h.online) {
      const pair = el('button', { textContent: 'Pair' });
      pair.addEventListener('click', () => pairHost(h));
      box.append(pair);
    }
    apps.replaceChildren(box);
    return;
  }
  if (!h.apps.length) {
    apps.replaceChildren(el('div', { className: 'empty', textContent: 'No games listed on this PC.' }));
    return;
  }
  apps.replaceChildren(...h.apps.map((a) => {
    const art = el('div', { className: 'art' });
    if (a.boxArt) art.style.backgroundImage = `url("${a.boxArt}")`;
    else art.textContent = a.name.slice(0, 1).toUpperCase();
    const tile = el('button', { className: 'game', title: `Play ${a.name}` }, art, el('div', { className: 'title', textContent: a.name }));
    tile.addEventListener('click', () => connect.stream({ uuid: h.uuid, name: h.name, address: h.address }, a.name));
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
  $('#remove-host').classList.toggle('hidden', !h.saved);
  $('#refresh-apps').classList.toggle('hidden', !h.online || !h.paired);
  $('#send-files').classList.toggle('hidden', !canSendTo(h));
  renderApps(h);
  // Opened from the list before its games were looked up
  if (h.online && h.paired && !h.apps.length) {
    connect.apps(h).then((apps) => {
      h.apps = apps;
      if (currentHost === h) renderApps(h);
    }).catch(() => {});
  }
  const key = h.uuid || h.address;
  connect.volume(key).then((v) => { if (currentHost === h) showVolume('#host-volume', v); });
}

// ---- Volume boost: a PC's stream played up to 10x louder ---------------------------

let streamVolumeKey = '';

function showVolume(sel, value) {
  $(sel).value = value;
  $(`${sel}-value`).textContent = value > 1 ? `${value}×` : 'Off';
}

function bindVolume(sel, keyOf) {
  $(sel).addEventListener('input', (e) => {
    const key = keyOf();
    if (!key) return;
    const value = Number(e.target.value);
    showVolume(sel, value);
    connect.setVolume(key, value);
    // the other slider shows the same PC's boost
    const other = sel === '#host-volume' ? '#stream-volume' : '#host-volume';
    const otherKey = other === '#host-volume' ? (currentHost && (currentHost.uuid || currentHost.address)) : streamVolumeKey;
    if (otherKey === key) showVolume(other, value);
  });
}
bindVolume('#host-volume', () => currentHost && (currentHost.uuid || currentHost.address));
bindVolume('#stream-volume', () => streamVolumeKey);
connect.onVolume(({ key, value }) => {
  if (key === streamVolumeKey) showVolume('#stream-volume', value);
  if (currentHost && (currentHost.uuid || currentHost.address) === key) showVolume('#host-volume', value);
});

$('#back-to-hosts').addEventListener('click', showHostList);

// Rename a PC: its name turns into a box (Enter saves, Esc cancels, empty goes back to its own name)
$('#rename-host').addEventListener('click', () => {
  const h = currentHost;
  if (!h) return;
  const title = $('#host-view-name');
  const input = el('input', { className: 'name-edit', value: h.name || '', maxLength: 60, placeholder: h.ownName || 'Name' });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value !== h.name) {
      await connect.rename(h.uuid, value === h.ownName ? '' : value);
      h.name = value || h.ownName || h.name;
      toast(value && value !== h.ownName ? `Renamed to ${value}.` : `Back to “${h.ownName}”.`);
      friendsFullAt = 0;
    }
    title.textContent = h.name || h.address;
    input.replaceWith(title);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  title.replaceWith(input);
  input.focus();
  input.select();
});

$('#remove-host').addEventListener('click', (e) => {
  const h = currentHost;
  if (!h) return;
  const still = h.online ? ' It’s still reachable, so it stays in the list as not paired.' : '';
  if (!confirm(`Remove ${h.name || h.address}? You’ll have to pair again to connect.${still}`)) return;
  busy(e.currentTarget, 'Removing…', async () => {
    await connect.remove({ uuid: h.uuid, name: h.name, address: h.address });
    toast(`Removed ${h.name || h.address}.`);
    showHostList();
    await loadHosts();
    friendsFullAt = 0;
    loadFriends();
  });
});
// ---- Sending files: the PC page's button, files dropped on the page or a PC row ------------

const canSendTo = (h) => Boolean(h && h.online && h.paired && h.uuid && h.address);
const sendTarget = (h) => ({ uuid: h.uuid, name: h.name, address: h.address });

$('#send-files').addEventListener('click', () => {
  if (canSendTo(currentHost)) window.moonshine.files.pick(sendTarget(currentHost)).catch((err) => toast(err.message));
});

/** Let files be dropped on `node` to send them to the PC `pcOf()` returns (null: not now). */
function acceptDrops(node, pcOf) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  node.addEventListener('dragover', (e) => {
    const pc = pcOf();
    if (!hasFiles(e) || !pc) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    $('#drop-hint-name').textContent = pc.name;
    $('#drop-hint').classList.remove('hidden');
    node.classList.add('dropping');
  });
  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget)) return;
    node.classList.remove('dropping');
    $('#drop-hint').classList.add('hidden');
  });
  node.addEventListener('drop', (e) => {
    node.classList.remove('dropping');
    $('#drop-hint').classList.add('hidden');
    const pc = pcOf();
    if (!hasFiles(e) || !pc) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = window.moonshine.files.pathsOf(e.dataTransfer.files);
    if (paths.length) window.moonshine.files.send(sendTarget(pc), paths).catch((err) => toast(err.message));
  });
}
acceptDrops($('#host-view'), () => (canSendTo(currentHost) && !$('#host-view').classList.contains('hidden') ? currentHost : null));
// Dropping a file anywhere else must not open it in the window
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

const TRANSFER_STATES = {
  asking: (t) => `Waiting for ${t.pc} to accept…`,
  sending: (t) => `Sending to ${t.pc}`,
  receiving: (t) => `Coming from ${t.pc}`,
  saving: (t) => `Saving from ${t.pc}…`,
  done: (t) => (t.dir === 'in' ? `From ${t.pc}` : `Sent to ${t.pc}`),
  failed: (t) => t.error || 'Didn’t work',
};

async function renderTransfers() {
  const list = await window.moonshine.files.list();
  $('#transfers').classList.toggle('hidden', !list.length);
  $('#transfers-list').replaceChildren(...list.map((t) => {
    const pct = percent(t.sent, t.size);
    const row = el('div', { className: `transfer ${t.state}` },
      el('div', { className: 'transfer-name', textContent: `${t.dir === 'in' ? '↓' : '↑'} ${t.name}`, title: t.name }),
      el('div', { className: 'transfer-state', textContent: TRANSFER_STATES[t.state](t) + (t.state === 'sending' ? ` · ${pct}%` : '') }));
    if (t.state === 'sending' || t.state === 'asking') {
      const bar = el('div', { className: 'transfer-bar' }, el('span'));
      bar.firstChild.style.width = `${pct}%`;
      row.append(bar);
      const cancel = el('button', { className: 'secondary small', textContent: 'Cancel' });
      cancel.addEventListener('click', () => window.moonshine.files.cancel(t.id));
      row.append(cancel);
    } else if (t.state === 'done' && t.path) {
      const show = el('button', { className: 'secondary small', textContent: 'Show' });
      show.addEventListener('click', () => window.moonshine.files.show(t.id));
      row.append(show);
    }
    return row;
  }));
}
let transfersQueued = false;
window.moonshine.files.onChanged(() => {
  // progress comes in fast: redraw at most every 200 ms
  if (transfersQueued) return;
  transfersQueued = true;
  setTimeout(() => { transfersQueued = false; renderTransfers(); }, 200);
});
$('#transfers-clear').addEventListener('click', () => window.moonshine.files.clear());

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
  $('#stream-label').textContent = state.reconnecting ? 'Reconnecting' : 'Streaming';
  $('#stream-hint').textContent = state.reconnecting
    ? `The connection dropped. Getting it back and picking up where you left off (try ${state.attempt} of ${state.attempts})…`
    : 'The stream is full screen. If that PC asks its owner first, it starts once they allow it. Press Ctrl+Alt+Shift+Q to end it.';
  $('#end-stream').textContent = state.reconnecting ? 'Stop reconnecting' : 'End stream';
  $('#stream-overlay').classList.toggle('reconnecting', Boolean(state.reconnecting));
  if (state.active) {
    $('#stream-title').textContent = `${state.app} on ${state.host}`;
    streamVolumeKey = state.volumeKey || '';
    showVolume('#stream-volume', state.volume || 1);
  }
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

/**
 * A round picture: the first letter on a colour from `seed`. `photo` ({ user, version }) swaps in that
 * person's profile picture (from their Discord sign-in) once it has loaded; without one, the letter stays.
 */
function avatarFor(seed, text, photo = null) {
  const hue = [...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const a = el('div', { className: 'avatar', textContent: (text.trim()[0] || '?').toUpperCase() });
  a.style.background = `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 75% 35%))`;
  if (photo) {
    const load = (triesLeft) => window.moonshine.friends.avatar(photo.user, photo.version).then((url) => {
      if (url) {
        a.textContent = '';
        a.style.background = `center / cover no-repeat url(${url})`;
      } else if (triesLeft > 0) {
        setTimeout(() => { if (a.isConnected) load(triesLeft - 1); }, 65000); // maybe the network wasn't up yet
      }
    }).catch(() => { /* the letter stays */ });
    load(3);
  }
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
    badge.addEventListener('click', () => { selectTab('settings'); checkForUpdates(); });
    return badge;
  }
  return null;
}

function friendPcStatus(pc) {
  if (pc.guest) return { dot: 'online', text: `Invited${pc.hostUser ? ` by ${pc.hostUser}` : ''} · you can play on this PC until you leave`, title: 'This PC was shared with you by an invite link. It ends when you leave or they end it.' };
  if (!pc.online) return pc.account && !pc.everPaired
    ? { dot: '', text: 'Offline · pairs by itself once it’s on', title: 'Moonshine pairs with a friend’s PC automatically the first time it sees it online. Nobody has to type a PIN.' }
    : { dot: '', text: 'Offline' };
  if (pc.account && !pc.reachable && !pc.canConnectDirectly) return { dot: 'busy', text: 'Online · can’t reach it from here yet', title: 'Their PC is on, but this PC has no way to reach it: no shared Tailscale or network, and their Moonshine can’t take direct connections right now (both PCs need the latest Moonshine, open and signed in).' };
  const game = pc.game ? ` · ${gameLabel(pc.game)}` : '';
  if (pc.guests > 0) return { dot: 'hosting', text: `Hosting · ${pc.guests} connected${game}` };
  if (pc.busy) return { dot: 'busy', text: `In a game${game}` };
  return { dot: 'online', text: 'Free' };
}

/** A PC's name in the list; clicking it opens the PC's page (games, rename, remove). */
function friendPcName(pc) {
  const name = el('button', { type: 'button', className: 'friend-pc-name', textContent: pc.name || pc.address });
  name.title = 'Open this PC’s page';
  name.addEventListener('click', () => {
    const h = hostsCache.find((x) => x.uuid === pc.uuid);
    openHost(h ? { ...h, name: pc.name || h.name } : { ...pc, apps: [], tailnetUser: pc.user });
  });
  return name;
}

const CONNECTION_KINDS = {
  lan: ['Same network', 'This PC and that one are on the same network: the fastest, most stable way.'],
  tailscale: ['Tailscale', 'Connected through Tailscale.'],
  direct: ['Direct', 'Connected straight over the internet. No Tailscale or port forwarding needed.'],
  internet: ['Over the internet', 'Connected to that PC’s public address, which its router lets through (port forwarding or UPnP). No Tailscale needed.'],
  relay: ['Relay', 'No direct path between the two networks, so a relay carries the stream. It works, with a little more delay.'],
};

/** How this PC reaches that one, with the delay to it, so you know what to expect before you connect. */
function connectionBadge(pc) {
  const kind = CONNECTION_KINDS[pc.kind];
  if (!kind || !pc.online) return null;
  const ms = pc.ms > 0 ? ` · ${pc.ms <= 10 ? '<20' : pc.ms} ms` : '';
  return el('span', { className: `conn-badge ${pc.kind}`, textContent: kind[0] + ms, title: `${kind[1]}${ms ? ' The time is how long the PC takes to answer.' : ''}` });
}

function friendPcRow(pc) {
  const status = friendPcStatus(pc);
  const row = el('div', { className: 'friend-pc' },
    el('span', { className: `dot ${status.dot}` }),
    el('div', { className: 'friend-pc-text' },
      friendPcName(pc),
      el('div', { className: 'friend-pc-status', textContent: status.text, title: status.title || '' })));
  const badge = connectionBadge(pc);
  if (badge) row.querySelector('.friend-pc-text').append(badge);
  if (!pc.online && pc.canWake) {
    // Seen on this PC's own network before: a wake-on-LAN signal can start it
    const wake = el('button', { className: 'secondary', textContent: 'Wake' });
    wake.title = `Send a wake signal to ${pc.name}. It has to be asleep or off on this network, with wake-on-LAN turned on.`;
    wake.addEventListener('click', () => busy(wake, 'Waking…', async () => {
      await window.moonshine.wakePc(pc.uuid);
      toast(`Wake signal sent to ${pc.name}. It can take a minute to start.`);
    }));
    row.append(wake);
  }
  if (!pc.online || (pc.account && !pc.reachable && !pc.canConnectDirectly)) return row;
  // Use the full host from the Connect list, so pairing and the game list work as they do there
  const host = () => hostsCache.find((h) => h.uuid === pc.uuid) || { ...pc, apps: [], tailnetUser: pc.user };
  acceptDrops(row, () => { const h = host(); return canSendTo(h) ? { ...h, name: pc.name || h.name } : null; });
  let button;
  if (pc.pairing) {
    // Pairing by itself in the background (main.js autoPairFriends)
    button = el('button', { className: 'secondary', textContent: 'Pairing…', disabled: true });
    button.title = 'Pairing with your friend’s PC. Nobody has to do anything.';
  } else if (pc.account && (pc.direct || !pc.reachable)) {
    // No shared network: connect straight through both routers (opens the connection if needed)
    const paired = pc.paired || (!pc.reachable && pc.everPaired);
    button = el('button', { className: paired ? '' : 'secondary', textContent: paired ? 'Connect' : 'Pair' });
    button.title = 'Connects directly over the internet, no Tailscale or port forwarding needed';
    button.addEventListener('click', () => busy(button, 'Connecting…', async () => {
      const h = await window.moonshine.friends.connect(pc.uuid);
      friendsFullAt = 0;
      if (h.paired) {
        openHost(h);
      } else {
        pairHost(h);
      }
    }));
  } else if (pc.paired) {
    button = el('button', { textContent: 'Connect' });
    button.addEventListener('click', () => openHost(host()));
  } else {
    button = el('button', { className: 'secondary', textContent: 'Pair' });
    if (pc.moonshine) button.title = pc.account ? 'Pairing by itself didn’t work. Try again now.' : 'Their Moonshine asks them to accept.';
    button.addEventListener('click', () => pairHost(host()));
  }
  // A friend's PC: invite through the friends service (any connection). Another PC: only by its address.
  const canInvite = pc.user && pc.account ? pc.online : pc.reachable && !pc.direct;
  if (pc.moonshine && pc.mine === false && !pc.guest && canInvite) {
    const inviteButton = el('button', { className: 'secondary invite', textContent: 'Invite' });
    inviteButton.title = `Ask ${pc.user || pc.name} to join a stream on this PC`;
    inviteButton.addEventListener('click', () => busy(inviteButton, 'Inviting…', async () => {
      const { app } = await window.moonshine.friends.invite({ name: pc.name, address: pc.address, user: pc.account ? pc.user : '', direct: pc.direct });
      toast(`Invited ${pc.name} to ${app}. They get a popup in Moonshine.`);
    }));
    row.append(inviteButton);
  }
  row.append(button);
  if (pc.guest) {
    const leave = el('button', { className: 'secondary', textContent: 'Leave' });
    leave.title = 'Give up this invite. The link can’t be used again.';
    leave.addEventListener('click', () => {
      if (!confirm(`Leave ${pc.name}? The invite link won’t work again.`)) return;
      busy(leave, 'Leaving…', async () => {
        await window.moonshine.invites.leave();
        friendsFullAt = 0;
        await loadFriends();
      });
    });
    row.append(leave);
  }
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
  const view = !service.signedIn ? 'out' : !service.username ? 'pick' : `in:${service.username}:${service.avatar || ''}`;
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
    avatarFor(service.username, service.username, service.avatar ? { user: service.username, version: service.avatar } : null),
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

/** What an invite link in the list says. */
function inviteRow(inv) {
  const mins = Math.max(1, Math.round((inv.expires - Date.now()) / 60000));
  const text = inv.status === 'open' ? `Link ready · unused · runs out in ${mins} min`
    : inv.streaming ? `${inv.guest || 'A guest'} is connected` : `${inv.guest || 'A guest'} joined · waiting for them to stream`;
  const row = el('div', { className: 'friend-pc invite-row' },
    el('span', { className: `dot ${inv.status === 'open' ? 'busy' : 'hosting'}` }),
    el('div', { className: 'friend-pc-text' },
      el('div', { className: 'friend-pc-name', textContent: inv.status === 'open' ? 'Invite link' : 'Invite link in use' }),
      el('div', { className: 'friend-pc-status', textContent: text })));
  if (inv.status === 'open') {
    const copy = el('button', { className: 'secondary', textContent: 'Copy' });
    copy.addEventListener('click', () => busy(copy, 'Copying…', async () => {
      await window.moonshine.invites.copy(inv.id);
      toast('Invite link copied.');
    }));
    row.append(copy);
  }
  const end = el('button', { className: 'secondary', textContent: inv.status === 'open' ? 'Revoke' : 'End' });
  end.title = inv.status === 'open' ? 'The link stops working' : 'Disconnect them and end the invite';
  end.addEventListener('click', () => busy(end, '…', () => window.moonshine.invites.revoke(inv.id)));
  row.append(end);
  return row;
}

/** The first card: this PC, with a button (shown when you point at it) that copies a one-time invite link. */
function selfCard(self, invites, photo) {
  const copy = el('button', { className: 'secondary reveal', textContent: 'Copy invite link' });
  copy.title = 'Copies a link that lets one person stream from this PC. It works once, and for an hour if nobody opens it.';
  copy.addEventListener('click', () => busy(copy, 'Copying…', async () => {
    await window.moonshine.invites.create();
    toast('Invite link copied. Send it to one person: it works once.');
  }));
  const row = el('div', { className: 'friend-pc self-pc' },
    el('span', { className: `dot ${self.hosting ? 'online' : ''}` }),
    el('div', { className: 'friend-pc-text' },
      el('div', { className: 'friend-pc-name', textContent: self.name }),
      el('div', { className: 'friend-pc-status', textContent: self.hosting ? 'Hosting · this PC' : 'Not hosting · turn it on in the Host tab' })),
    copy);
  const card = el('div', { className: 'friend self-card' },
    el('div', { className: 'friend-head' },
      avatarFor('this-pc', 'This PC', photo),
      el('div', { className: 'friend-head-text' },
        el('div', { className: 'friend-name', textContent: 'This PC' }),
        el('div', { className: 'friend-summary', textContent: 'Point at it to invite someone with a one-time link' }))),
    el('div', { className: 'friend-pcs' }, row, ...invites.map(inviteRow)));
  card.dataset.key = 'self';
  return card;
}

function renderFriends({ me, tailscale, pcs, alerts, shareGame, discordStatus, version, service, self, invites = [] }) {
  showGate(service, pcs.some((p) => p.guest));
  renderAccount(service);
  $('#friend-alerts').checked = Boolean(alerts);
  $('#share-game').checked = shareGame !== false;
  $('#discord-status').checked = discordStatus !== false;
  lastFriendsService = service;
  for (const pc of pcs) pc.mine = pc.own || (Boolean(me) && pc.user === me); // friends' PCs and other PCs can be invited
  const box = $('#friends');
  // Nothing changed since the last refresh: leave the cards alone (no flicker, buttons keep their state)
  const showSelf = Boolean(self && service && service.signedIn);
  const ownPhoto = showSelf && service.avatar ? { user: service.username, version: service.avatar } : null; // your Discord picture
  const view = JSON.stringify([me, tailscale, pcs, self, invites, service && service.signedIn, service && service.username, service && service.avatar,
    ((service && service.friends) || []).map((f) => [f.username, f.online, f.nickname, f.unread, f.avatar]), version]);
  if (view === friendsView && box.children.length) return;
  friendsView = view;
  const shownBefore = new Set([...box.querySelectorAll('.friend[data-key]')].map((n) => n.dataset.key));
  if (!pcs.length && !(service && service.friends.length)) {
    box.replaceChildren(...(showSelf ? [selfCard(self, invites, ownPhoto)] : []), el('div', { className: 'empty', textContent: service && service.signedIn && service.username
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
    const key = pc.guest ? 'invite' : pc.own ? 'me' : !pc.user ? 'other' : pc.user === me ? 'me' : pc.user;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pc);
  }
  const rank = (key, list) => (key === 'invite' ? -1 : key === 'me' ? 2 : key === 'other' ? 3 : list.some((p) => p.online) ? 0 : 1);
  const ordered = [...groups].sort(([a, la], [b, lb]) => (rank(a, la) - rank(b, lb)) || a.localeCompare(b));
  box.replaceChildren(...(showSelf ? [selfCard(self, invites, ownPhoto)] : []), ...ordered.map(([key, list]) => {
    list.sort((a, b) => (b.online - a.online) || (a.name || '').localeCompare(b.name || ''));
    const account = (service && service.friends || []).find((f) => f.username === key);
    const isAccount = Boolean(account);
    const title = key === 'invite' ? 'Invited' : key === 'me' ? 'Your PCs' : key === 'other' ? 'Other PCs' : (account && account.nickname) || personName(key);
    const online = list.some((p) => p.online);
    const playing = list.find((p) => p.online && p.game);
    const summary = key === 'invite' ? 'You’re a guest on this PC' : key === 'me' || key === 'other'
      ? `${list.filter((p) => p.online).length} of ${list.length} online`
      : !online ? 'Offline'
      : playing ? `Playing ${gameLabel(playing.game)}`
      : list.some((p) => p.guests > 0) ? 'Hosting' : list.some((p) => p.busy) ? 'In a game' : 'Online';
    const name = el('div', { className: 'friend-name', textContent: title });
    if (account && account.nickname) name.append(el('span', { className: 'friend-handle', textContent: key }));
    const badge = isAccount ? versionBadge(list, version) : null;
    if (badge) name.append(badge);
    const photo = isAccount && account.avatar ? { user: key, version: account.avatar }
      : key === 'me' && service && service.avatar ? { user: service.username, version: service.avatar } : null;
    const head = el('div', { className: 'friend-head' },
      avatarFor(key, title, photo),
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
    if (!gateKnown) $('#gate').classList.add('hidden'); // can't tell yet: don't lock the app
  }
  friendsTimer = setTimeout(loadFriends, 5000);
}

window.moonshine.invites.onChanged(() => { friendsView = ''; loadFriends(); });
$('#friend-alerts').addEventListener('change', (e) => window.moonshine.friends.setAlerts(e.target.checked));
$('#share-game').addEventListener('change', (e) => window.moonshine.friends.setShareGame(e.target.checked));
$('#discord-status').addEventListener('change', (e) => window.moonshine.friends.setDiscordStatus(e.target.checked));
$('#dnd').addEventListener('change', async (e) => {
  await window.moonshine.dnd.set(e.target.checked);
  toast(e.target.checked ? 'Do not disturb is on: no notifications, and invites get “not now”.' : 'Do not disturb is off.');
});
const showDnd = (d) => { $('#dnd').checked = Boolean(d && d.on); };
window.moonshine.dnd.onChange(showDnd);
window.moonshine.dnd.get().then(showDnd);

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

// ---- Beta features ----------------------------------------------------------------

async function loadBeta() {
  const features = await window.moonshine.beta.list();
  $('#beta-list').replaceChildren(...features.map((f) => {
    const box = el('input', { type: 'checkbox', checked: f.on });
    box.addEventListener('change', async () => {
      try {
        await window.moonshine.beta.set(f.id, box.checked);
        toast(box.checked ? `${f.name} is on. It applies to your next stream.` : `${f.name} is off.`);
      } catch (err) {
        box.checked = !box.checked;
        toast(err.message);
      }
    });
    return el('div', { className: 'beta-item' },
      el('label', { className: 'check beta-name' }, box, el('span', { textContent: f.name }), el('span', { className: 'beta-pill', textContent: 'Beta' })),
      el('p', { className: 'hint', textContent: f.description }));
  }));
}

// ---- Stream settings -------------------------------------------------------------

const settingsForm = $('#settings-form');
let nativeResolution = '';

function updateBitrateLabel() {
  const mbps = Number(settingsForm.bitrateMbps.value);
  $('#bitrate-label').textContent = mbps ? `${mbps} Mbps` : 'Automatic';
  $('#opacity-label').textContent = `${settingsForm.overlayOpacity.value}%`;
}

// Which PC the settings below are for: '' is the defaults, otherwise a PC's key (uuid or address)
const PER_PC_FIELDS = ['resolution', 'fps', 'bitrateMbps', 'displayMode', 'videoCodec', 'audioConfig', 'hdr', 'virtualDisplay'];
let settingsPc = '';
let settingsPcNames = {}; // key -> name

async function fillPcPicker() {
  try { await loadHosts(); } catch { /* the saved ones below still show */ }
  const names = {};
  for (const h of hostsCache) names[h.uuid || h.address] = h.name;
  for (const o of await window.moonshine.settings.hostsWithOverrides()) names[o.key] ||= o.name;
  settingsPcNames = names;
  const picker = $('#settings-pc');
  picker.replaceChildren(el('option', { value: '', textContent: 'Everything (the defaults)' }));
  for (const [key, name] of Object.entries(names)) picker.append(el('option', { value: key, textContent: name }));
  if (settingsPc && !(settingsPc in names)) settingsPc = '';
  picker.value = settingsPc;
}

async function loadSettings() {
  const native = (await window.moonshine.settings.get()).nativeResolution;
  const { settings: s, overridden } = settingsPc
    ? await window.moonshine.settings.getForHost(settingsPc)
    : { settings: (await window.moonshine.settings.get()).settings, overridden: [] };
  nativeResolution = native;
  // For one PC, only the settings that make sense per PC can change; the rest stay with the defaults
  for (const field of settingsForm.elements) {
    if (!field.name) continue;
    field.disabled = Boolean(settingsPc) && !PER_PC_FIELDS.includes(field.name);
    field.closest('label')?.classList.toggle('inherited', Boolean(settingsPc) && PER_PC_FIELDS.includes(field.name) && !overridden.includes(field.name));
  }
  $('#settings-pc-reset').classList.toggle('hidden', !overridden.length);
  $('#settings-pc-hint').textContent = !settingsPc
    ? 'Every PC uses these unless you give it its own. Pick a PC to remember a resolution, frame rate or bitrate just for it.'
    : overridden.length
      ? `${settingsPcNames[settingsPc] || 'This PC'} has its own ${overridden.length === 1 ? 'setting' : `${overridden.length} settings`}. The rest follow the defaults.`
      : `${settingsPcNames[settingsPc] || 'This PC'} follows the defaults. Change something here to give it its own.`;
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
settingsForm.addEventListener('change', async (e) => {
  const s = {};
  for (const field of settingsForm.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') s[field.name] = field.checked;
    else if (field.type === 'range') s[field.name] = Number(field.value);
    else s[field.name] = field.value === 'native' ? nativeResolution : field.value;
  }
  if (!settingsPc) { window.moonshine.settings.set(s); return; }
  // Only the setting just changed becomes this PC's own; the others keep following the defaults
  const name = e.target && e.target.name;
  if (!PER_PC_FIELDS.includes(name)) return;
  await window.moonshine.settings.setForHost(settingsPc, settingsPcNames[settingsPc] || '', { [name]: s[name] });
  await loadSettings();
});

$('#settings-pc').addEventListener('change', async (e) => {
  settingsPc = e.target.value;
  await loadSettings();
});
$('#settings-pc-reset').addEventListener('click', async () => {
  await window.moonshine.settings.resetForHost(settingsPc);
  await loadSettings();
  toast(`${settingsPcNames[settingsPc] || 'That PC'} now uses the defaults.`);
});

// ---- Host -------------------------------------------------------------------

let serviceRunning = false;
let hostSnapshot = '';

/** Show the Host tab. With `statusOnly`, the rest of the tab is only redrawn when something changed. */
async function loadHost(statusOnly = false) {
  const s = await host.status();
  const snapshot = JSON.stringify([s.service, s.tailscale, s.tailscaleInstalled, s.loginNeeded, Boolean(s.audio), s.paused, s.newDevicePerm]);
  if (statusOnly && snapshot === hostSnapshot) return;
  hostSnapshot = snapshot;
  if (s.service === 'running') loadBandwidth();

  const stateText = {
    running: 'On',
    stopped: 'Off',
    'not-installed': 'Host not installed (run the Moonshine installer again)',
  }[s.service] || s.service;
  const state = $('#service-state');
  const paused = s.service === 'running' && s.paused;
  state.textContent = paused
    ? `Paused${s.paused === -1 ? '' : ` until ${new Date(s.paused).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}: nobody can stream from this PC`
    : stateText;
  state.className = `value ${s.service === 'running' && !paused ? 'ok' : 'warn'}`;
  serviceRunning = s.service === 'running';
  const toggle = $('#toggle-service');
  toggle.textContent = serviceRunning ? 'Stop hosting' : 'Start hosting';
  toggle.disabled = s.service === 'not-installed';
  $('#pause-hosting').classList.toggle('hidden', !serviceRunning || Boolean(paused));
  $('#pause-hosting').value = '';
  $('#resume-hosting').classList.toggle('hidden', !paused);
  $('#new-device-perm').value = s.newDevicePerm || 'controller';

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

$('#pause-hosting').addEventListener('change', async (e) => {
  const minutes = Number(e.target.value);
  e.target.value = '';
  if (!minutes) return;
  try {
    await host.pause(minutes);
    await loadHost();
  } catch (err) {
    toast(errorText(err));
  }
});

$('#resume-hosting').addEventListener('click', (e) => busy(e.target, 'Resuming…', async () => {
  await host.resume();
  toast('Hosting resumed.');
  await loadHost();
}));

$('#new-device-perm').addEventListener('change', async (e) => {
  try {
    await host.setNewDevicePerm(e.target.value);
    toast({
      controller: 'Devices paired from now on can start apps and use a controller.',
      full: 'Devices paired from now on get full control.',
      watch: 'Devices paired from now on can only watch.',
    }[e.target.value]);
  } catch (err) {
    toast(errorText(err));
  }
});

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
$('#start-at-login').addEventListener('change', (e) => window.moonshine.setStartAtLogin(e.target.checked));
$('#network-check').addEventListener('click', (e) => busy(e.target, 'Checking…', async () => {
  const box = $('#network-check-result');
  box.textContent = 'Testing your network…';
  box.className = 'hint';
  const res = await window.moonshine.network.check();
  box.textContent = res.summary;
  box.className = `hint check-${res.verdict}`;
}));
$('#copy-diagnostics').addEventListener('click', (e) => busy(e.target, 'Copying…', async () => {
  await window.moonshine.copyDiagnostics();
  toast('Diagnostics copied. Safe to paste into a bug report.');
}));
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
  const playerRow = el('div', { className: 'guest-pads hidden' });
  Object.assign(node, { player, playerRow });

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

let playerOrder = []; // every controller of every guest, player 1 first: [{uuid, index, type}]
let lastGuests = [];

const PAD_TYPES = { 1: 'Xbox controller', 2: 'PlayStation controller', 3: 'Nintendo controller' };

/** Swap one controller with the one before or after it (they can belong to different guests). Controllers reconnect for a moment. */
async function movePad(uuid, index, step) {
  const order = [...playerOrder];
  const i = order.findIndex((p) => p.uuid === uuid && p.index === index);
  const j = i + step;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  try {
    await host.setPadOrder(order.map((p) => ({ uuid: p.uuid, index: p.index })));
    toast('Swapped players. The controllers reconnect for a moment.');
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
  playerOrder = list.flatMap((g) => (g.controllers || []).map((c) => ({ ...c, uuid: g.uuid })))
    .sort((a, b) => a.id - b.id);
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
    // One row per controller of this guest, with its player number and buttons to move it
    const mine = playerOrder.map((p, at) => ({ ...p, at })).filter((p) => p.uuid === g.uuid);
    const players = mine.map((p) => p.at + 1);
    node.player.textContent = players.map((p) => `P${p}`).join(' ');
    node.player.classList.toggle('hidden', !players.length);
    node.playerRow.classList.toggle('hidden', !players.length);
    const signature = JSON.stringify([mine.map((p) => [p.index, p.type, p.at]), playerOrder.length]);
    if (node.padSignature !== signature) {
      node.padSignature = signature;
      node.playerRow.replaceChildren(...mine.map((p) => {
        const earlier = el('button', { className: 'secondary player-move', type: 'button', textContent: '‹', title: 'Earlier player number', disabled: p.at <= 0 });
        const later = el('button', { className: 'secondary player-move', type: 'button', textContent: '›', title: 'Later player number', disabled: p.at >= playerOrder.length - 1 });
        earlier.addEventListener('click', () => movePad(g.uuid, p.index, -1));
        later.addEventListener('click', () => movePad(g.uuid, p.index, 1));
        return el('div', { className: 'guest-player' + (playerOrder.length < 2 ? ' solo' : '') },
          el('span', { className: 'player-text' }, `Player ${p.at + 1}`, el('span', { className: 'player-kind' }, ` · ${PAD_TYPES[p.type] || 'Controller'}`)),
          el('span', { className: 'player-moves' }, earlier, later));
      }));
    }
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

// ---- Speed test: suggests a bitrate (Settings) or an upload limit (Host), with Apply / Dismiss ----

const SPEED_TEXT = {
  download: {
    result: (mbps, rec) => `Download: ${mbps} Mbps. Recommended bitrate: ${rec} Mbps.`,
    note: 'The other PC’s upload matters too: a slow upload there limits what you get.',
  },
  upload: {
    result: (mbps, rec) => `Upload: ${mbps} Mbps. Recommended limit: ${rec} Mbps.`,
    note: 'Shared by everyone watching this PC.',
  },
};
const roundMbps = (mbps) => (mbps >= 100 ? Math.round(mbps) : Math.round(mbps * 10) / 10);

async function applySpeed(kind, recommended) {
  if (kind === 'upload') {
    await host.setBandwidth(recommended);
    bandwidthMbps = recommended;
    $('#bandwidth-limit').value = String(recommended);
    toast(`Upload limit set to ${recommended} Mbps.`);
  } else {
    settingsForm.bitrateMbps.value = String(recommended);
    settingsForm.dispatchEvent(new Event('input'));
    settingsForm.dispatchEvent(new Event('change')); // saves, as moving the slider does
    toast(`Bitrate set to ${recommended} Mbps.`);
  }
}

document.querySelectorAll('.speed-test').forEach((box) => {
  const { kind } = box.dataset;
  const run = box.querySelector('.speed-run');
  const result = box.querySelector('.speed-result');
  const label = run.textContent;
  run.addEventListener('click', async (e) => {
    e.preventDefault();
    run.disabled = true;
    run.textContent = 'Testing…';
    result.classList.add('hidden');
    try {
      const { mbps, recommended } = await window.moonshine.speed.test(kind);
      const apply = el('button', { type: 'button', className: 'small-button', textContent: 'Apply' });
      const dismiss = el('button', { type: 'button', className: 'link-button neutral', textContent: 'Dismiss' });
      apply.addEventListener('click', (ev) => {
        ev.preventDefault();
        busy(apply, 'Applying…', async () => {
          await applySpeed(kind, recommended);
          result.classList.add('hidden');
        });
      });
      dismiss.addEventListener('click', (ev) => {
        ev.preventDefault();
        result.classList.add('hidden');
      });
      result.replaceChildren(
        el('div', { className: 'speed-text' },
          el('strong', { textContent: SPEED_TEXT[kind].result(roundMbps(mbps), recommended) }),
          el('span', { className: 'hint', textContent: SPEED_TEXT[kind].note })),
        el('div', { className: 'speed-actions' }, apply, dismiss));
      result.classList.remove('hidden');
    } catch (err) {
      toast(errorText(err));
    } finally {
      run.disabled = false;
      run.textContent = label;
    }
  });
});
window.moonshine.speed.onProgress(({ kind, mbps }) => {
  const run = document.querySelector(`.speed-test[data-kind="${kind}"] .speed-run`);
  if (run && run.disabled && mbps > 0) run.textContent = `Testing… ${roundMbps(mbps)} Mbps`;
});

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
/** How far along, 0 to 100 (0 when the total isn't known yet). */
function percent(done, total) { return total ? Math.max(0, Math.min(100, Math.round((100 * (done || 0)) / total))) : 0; }

function showUpdate(s) {
  if (!s) return;
  $('#app-version').textContent = `Moonshine v${s.current}`;
  showUpdatesPanel(s);
  showUpdateBanner(s);
  if (checkingByHand && s.status !== 'checking') {
    checkingByHand = false;
    if (s.status === 'current') toast(`You have the latest version (${s.current}).`);
    else if (s.status === 'error') toast(s.message);
  }
}

// The banner: hidden with its ✕ until a newer version than the one dismissed comes out
let bannerState = null;
function bannerDismissed() {
  try { return localStorage.getItem('updateBannerDismissed') || ''; } catch { return ''; }
}
/** "Installing the host… 25%": the installer's real step (Moonshine stays open until it must restart). */
function installStepText(s) {
  return `${s.step || 'Installing'}… ${percent(s.percent, 100)}%`;
}

function showUpdateBanner(s) {
  bannerState = s;
  const banner = $('#update-banner');
  const active = ['available', 'downloading', 'ready', 'installing'].includes(s.status);
  // Once you've started updating, it stays up even if dismissed earlier
  const dismissed = s.status === 'available' && !s.error && bannerDismissed() === s.version;
  banner.classList.toggle('hidden', !active || dismissed);
  if (!active || dismissed) return;
  $('#update-banner-title').textContent = s.status === 'installing'
    ? `Installing Moonshine ${s.version}…`
    : `Moonshine ${s.version} is available`;
  let detail = `You have ${s.current}. Moonshine stays open while it updates, then restarts by itself.`;
  if (s.status === 'downloading') {
    detail = `Downloading… ${percent(s.received, s.total)}%`;
  } else if (s.status === 'installing') {
    detail = installStepText(s);
  } else if (s.error) detail = s.error;
  else if (s.status === 'ready') detail = 'Downloaded and checked. Install it when you’re ready.';
  $('#update-banner-detail').textContent = detail;
  const button = $('#update-banner-now');
  button.classList.toggle('hidden', s.status === 'installing');
  button.disabled = s.status === 'downloading';
  button.textContent = s.status === 'downloading' ? 'Downloading…' : s.status === 'ready' ? 'Install now' : 'Update now';
  $('#update-banner-close').classList.toggle('hidden', s.status !== 'available');
}
$('#update-banner-now').addEventListener('click', () => askToUpdate());
$('#update-banner-close').addEventListener('click', () => {
  if (bannerState && bannerState.version) {
    try { localStorage.setItem('updateBannerDismissed', bannerState.version); } catch { /* shown again next start */ }
  }
  $('#update-banner').classList.add('hidden');
});

updates.onState(showUpdate);
updates.get().then(showUpdate);
function checkForUpdates() {
  checkingByHand = true;
  updates.check().then(showUpdate).catch((err) => { checkingByHand = false; toast(err.message); });
}

// Settings > Updates: the version, what the last check found, a button to check now, and how often
let panelState = null;
function agoText(at) {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
function showUpdatesPanel(s = panelState) {
  if (!s) return;
  panelState = s;
  $('#upd-version').textContent = `Moonshine v${s.current}`;
  const busyNow = ['checking', 'downloading', 'installing'].includes(s.status);
  let text = 'Not checked yet.';
  if (s.status === 'checking') text = 'Checking…';
  else if (s.status === 'current') text = `You have the latest version. Checked ${s.checkedAt ? agoText(s.checkedAt) : 'just now'}.`;
  else if (s.status === 'available') text = s.error || `Moonshine ${s.version} is available${s.size ? ` (${mb(s.size)})` : ''}.`;
  else if (s.status === 'downloading') {
    text = `Downloading Moonshine ${s.version}… ${percent(s.received, s.total)}%`;
  } else if (s.status === 'ready') text = s.error || `Moonshine ${s.version} is downloaded and checked. Install it when you’re ready.`;
  else if (s.status === 'installing') text = `Installing Moonshine ${s.version}: ${installStepText(s)}`;
  else if (s.status === 'error') text = s.message;
  $('#upd-status').textContent = text;
  const bar = $('#upd-bar');
  bar.classList.toggle('hidden', s.status !== 'downloading' && s.status !== 'installing');
  if (s.status === 'downloading') bar.firstElementChild.style.width = `${percent(s.received, s.total)}%`;
  if (s.status === 'installing') bar.firstElementChild.style.width = `${percent(s.percent, 100)}%`;
  const check = $('#upd-check');
  check.disabled = busyNow;
  check.textContent = s.status === 'checking' ? 'Checking…' : 'Check for updates';
  const install = $('#upd-install');
  install.classList.toggle('hidden', !['available', 'downloading', 'ready'].includes(s.status));
  install.disabled = s.status === 'downloading';
  install.textContent = s.status === 'ready' ? 'Install now' : 'Update now';
}
// Join notifications: on/off, sound on/off, which sound
(() => {
  const sounds = window.MoonshineSounds.list;
  $('#join-sound').replaceChildren(...sounds.map((s) => el('option', { value: s.id, textContent: s.name })));
  const show = (n) => {
    $('#join-notice').checked = n.notice;
    $('#join-sound-on').checked = n.soundOn;
    $('#join-sound').value = n.sound;
    if ($('#join-sound').value !== n.sound) $('#join-sound').value = sounds[0].id;
    const off = !n.notice || !n.soundOn;
    $('#join-sound').disabled = $('#join-sound-play').disabled = !n.soundOn;
    $('#join-sound-on').disabled = !n.notice;
    $('#join-sound-desc').textContent = !n.notice ? 'No popup and no sound when someone joins.' : off ? 'A popup shows, with no sound.' : (sounds.find((s) => s.id === $('#join-sound').value) || {}).desc || '';
  };
  const load = () => window.moonshine.notifications.get().then(show);
  load();
  const save = (c) => window.moonshine.notifications.set(c).then(load);
  $('#join-notice').addEventListener('change', (e) => save({ notice: e.target.checked }));
  $('#join-sound-on').addEventListener('change', (e) => save({ soundOn: e.target.checked }));
  $('#join-sound').addEventListener('change', (e) => { save({ sound: e.target.value }); window.MoonshineSounds.play(e.target.value); });
  $('#join-sound-play').addEventListener('click', () => window.MoonshineSounds.play($('#join-sound').value));
})();
$('#upd-check').addEventListener('click', checkForUpdates);
$('#upd-install').addEventListener('click', () => askToUpdate());
$('#upd-every').addEventListener('change', (e) => updates.setEvery(e.target.value));
updates.getEvery().then((v) => { $('#upd-every').value = v; });
setInterval(() => showUpdatesPanel(), 30000); // "checked 5 minutes ago" keeps counting
// Update now: download and check it (progress shows in the sidebar), then ask in Moonshine's own dialog
let updateAsking = false;
async function askToUpdate() {
  if (updateAsking) return;
  updateAsking = true;
  try {
    const { version, warnings } = await updates.prepare();
    $('#update-dialog-title').textContent = `Install Moonshine ${version}?`;
    $('#update-dialog-warnings').replaceChildren(...warnings.map((w) => el('li', { textContent: w })));
    $('#update-dialog-warnings').classList.toggle('hidden', !warnings.length);
    $('#update-dialog').classList.remove('hidden');
    $('#update-install').focus();
  } catch (err) {
    toast(errorText(err));
  } finally {
    updateAsking = false;
  }
}
function closeUpdateDialog() {
  $('#update-dialog').classList.add('hidden');
}
updates.onAsk(askToUpdate);
$('#update-later').addEventListener('click', closeUpdateDialog);
$('#update-dialog').addEventListener('click', (e) => { if (e.target.id === 'update-dialog') closeUpdateDialog(); });
$('#update-install').addEventListener('click', (e) => busy(e.currentTarget, 'Closing Moonshine…', async () => {
  $('#update-later').disabled = true;
  try {
    await updates.install(); // Moonshine shows the progress and closes only for the last step
  } finally {
    $('#update-later').disabled = false;
  }
}));

loadHosts();
// ---- Sign-in gate: nothing but this shows until the person has signed in -------------------------

var gateKnown = false;
function showGate(service, hasGuest = false) {
  const gate = $('#gate');
  const needed = Boolean(service && service.configured && !service.signedIn && !hasGuest);
  gateKnown = true;
  gate.classList.toggle('hidden', !needed);
  $('#gate-actions').classList.toggle('hidden', !needed);
}

$('#gate-signin').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  button.textContent = 'Waiting for Discord…';
  $('#gate-note').textContent = 'Finish signing in in your browser, then come back here.';
  $('#gate-cancel').classList.remove('hidden');
  try {
    const res = await window.moonshine.account.signIn();
    toast(res.username ? `Signed in as ${res.username}.` : 'Signed in. Now pick a username.');
    friendsFullAt = 0;
    await loadFriends();
  } catch (err) {
    toast(errorText(err));
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in with Discord';
    $('#gate-note').textContent = 'Moonshine uses your Discord account only to know it’s you.';
    $('#gate-cancel').classList.add('hidden');
  }
});
$('#gate-cancel').addEventListener('click', () => window.moonshine.account.cancelSignIn());

loadFriends(true);
host.status().then((s) => { $('#start-at-login').checked = s.startAtLogin; });
