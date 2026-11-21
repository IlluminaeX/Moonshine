// Generates app/renderer/apollo-schema.js from Apollo's own settings page, so Moonshine's
// native Apollo settings use the same keys, choices, defaults, conditions and wording.
// Usage: node scripts/gen-apollo-schema.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'upstream', 'apollo', 'src_assets', 'common', 'assets', 'web');
const en = JSON.parse(fs.readFileSync(path.join(web, 'public', 'assets', 'locale', 'en.json'), 'utf8'));

// Sections Moonshine shows (Windows-relevant tabs and encoders).
const sections = [
  { id: 'general', title: 'General', file: 'configs/tabs/General.vue' },
  { id: 'input', title: 'Input', file: 'configs/tabs/Inputs.vue' },
  { id: 'av', title: 'Audio & video', file: 'configs/tabs/AudioVideo.vue' },
  // AudioVideo.vue pulls these in as child components.
  { id: 'display', title: 'Display', file: [
    'configs/tabs/audiovideo/AdapterNameSelector.vue',
    'configs/tabs/audiovideo/DisplayOutputSelector.vue',
    'configs/tabs/audiovideo/DisplayDeviceOptions.vue',
    'configs/tabs/audiovideo/DisplayModesSettings.vue',
  ] },
  { id: 'network', title: 'Network', file: 'configs/tabs/Network.vue' },
  { id: 'advanced', title: 'Advanced', file: 'configs/tabs/Advanced.vue' },
  { id: 'nv', title: 'NVIDIA encoder', file: 'configs/tabs/encoders/NvidiaNvencEncoder.vue' },
  { id: 'amd', title: 'AMD encoder', file: 'configs/tabs/encoders/AmdAmfEncoder.vue' },
  { id: 'qsv', title: 'Intel encoder', file: 'configs/tabs/encoders/IntelQuickSyncEncoder.vue' },
  { id: 'sw', title: 'Software encoder', file: 'configs/tabs/encoders/SoftwareEncoder.vue' },
];

// Defaults, straight from config.html's tab definitions.
const configHtml = fs.readFileSync(path.join(web, 'config.html'), 'utf8');
const defaults = {};
for (const m of configHtml.matchAll(/^\s*"([a-z0-9_]+)":\s*([^,\n]+?),?\s*(\/\/.*)?$/gm)) {
  try { defaults[m[1]] = JSON.parse(m[2]); } catch { /* objects/arrays: handled by Apollo's web UI */ }
}

function t(key) {
  return key.split('.').reduce((o, k) => (o ? o[k] : undefined), en);
}

function clean(text) {
  return typeof text === 'string' ? text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

/** Turn a Vue v-if expression into JS source for `(config) => ...` on Windows. */
function condition(expr) {
  return expr
    .replace(/platform\s*===\s*'windows'/g, 'true')
    .replace(/platform\s*!==\s*'windows'/g, 'false')
    .replace(/platform\s*===\s*'(linux|macos)'/g, 'false')
    .replace(/platform\s*!==\s*'(linux|macos)'/g, 'true')
    .replace(/\bconfig\.([a-z0-9_]+)/g, 'c.$1');
}

/** Evaluate a condition that only depends on the platform; config-dependent ones count as shown. */
function evalStatic(expr) {
  try {
    return Boolean(new Function('c', `return (${expr})`)({}));
  } catch {
    return true;
  }
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([:@#\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? true;
  // <PlatformLayout> slots: content for other platforms is never shown on Windows.
  if (out['#linux'] || out['#macos']) out['v-if'] = "platform === 'linux'";
  return out;
}

function extract(file) {
  const src = fs.readFileSync(path.join(web, file), 'utf8');
  const template = src.slice(src.indexOf('<template>'));
  const fields = [];
  const stack = []; // open elements with their v-if conditions
  let lastLabelKey = null;
  let current = null;

  const tokens = template.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:[^>"]|"[^"]*")*?)(\/?)>|\{\{\s*\$t\(["']([^"']+)["']\)\s*\}\}|([^<{]+)/g);
  for (const tok of tokens) {
    const [, closing, name, rawAttrs, selfClosing, tKey, text] = tok;
    // Option labels can mix plain text and translations, e.g. "P1 {{ $t('...fastest') }}".
    const appendToOption = (piece) => {
      current.pendingOption.label = `${current.pendingOption.label} ${piece}`.trim();
    };
    if (tKey) {
      if (current && current.pendingOption) appendToOption(clean(t(tKey)) || tKey);
      else lastLabelKey = tKey;
      continue;
    }
    if (text) {
      if (current && current.pendingOption && text.trim()) appendToOption(clean(text));
      continue;
    }
    if (closing) {
      const idx = stack.map((s) => s.name).lastIndexOf(name);
      if (idx >= 0) stack.splice(idx);
      if (name === 'select' && current) { fields.push(current.field); current = null; }
      if (name === 'option' && current) current.pendingOption = null;
      continue;
    }

    const a = attrs(rawAttrs);
    const conds = stack.map((s) => s.cond).filter(Boolean);
    if (a['v-if']) conds.push(a['v-if']);
    const when = conds.length ? conds.map((c) => `(${condition(c)})`).join(' && ') : null;
    const model = (a['v-model'] || '').match(/^config\.([a-z0-9_]+)$/);

    if (name === 'select' && model) {
      current = { depth: stack.length, field: { key: model[1], type: 'select', when, labelKey: lastLabelKey, options: [] } };
      lastLabelKey = null;
    } else if (name === 'option' && current) {
      const option = { value: a.value ?? (a[':value'] !== undefined ? JSON.parse(a[':value']) : ''), label: '' };
      // Options shown only on Linux/macOS (directly or via a <template v-if> inside the select) are left out.
      const optionConds = [...stack.slice(current.depth + 1).map((s) => s.cond), a['v-if']].filter(Boolean);
      if (optionConds.every((c) => evalStatic(condition(c)))) current.field.options.push(option);
      current.pendingOption = option;
    } else if (name === 'Checkbox' && model) {
      lastLabelKey = null;
      const inverse = a['inverse-values'] !== undefined;
      fields.push({
        key: model[1], type: 'checkbox', when, inverse,
        labelKey: a.label || `${a['locale-prefix'] || 'config'}.${a.id}`,
        descKey: a.desc || `${a['locale-prefix'] || 'config'}.${a.id}_desc`,
      });
    } else if ((name === 'input' || name === 'textarea') && model) {
      fields.push({ key: model[1], type: a.type === 'number' ? 'number' : 'text', when, labelKey: lastLabelKey,
        placeholder: a.placeholder || '', min: a.min, max: a.max, step: a.step });
      lastLabelKey = null;
    }

    if (!selfClosing && !['input', 'br', 'img', 'hr'].includes(name)) stack.push({ name, cond: a['v-if'] || null });
  }
  return fields;
}

// Settings that only matter to Apollo's own tray icon and web page, which Moonshine replaces.
const SKIP = new Set(['locale', 'hide_tray_controls', 'notify_pre_releases']);

// Fields whose label the page builds in a way the parser can't follow.
const LABEL_KEYS = {
  output_name: 'config.output_name_windows',
  dd_manual_resolution: 'config.dd_resolution_option_manual',
  dd_manual_refresh_rate: 'config.dd_refresh_rate_option_manual',
};
const DESC_KEYS = { output_name: 'config.output_name_desc_windows' };

const out = sections.map((s) => {
  const seen = new Set();
  const fields = [].concat(s.file).flatMap(extract).filter((f) => !SKIP.has(f.key) && !seen.has(f.key) && seen.add(f.key)).map((f) => {
    const labelKey = LABEL_KEYS[f.key]
      || (f.labelKey && t(f.labelKey) && !f.labelKey.endsWith('_desc') ? f.labelKey : `config.${f.key}`);
    const field = {
      key: f.key,
      type: f.type,
      label: clean(t(labelKey)) || f.key,
      desc: clean(t(DESC_KEYS[f.key] || f.descKey || `${labelKey}_desc`)),
      default: defaults[f.key],
    };
    if (f.options) field.options = f.options.map((o) => ({ value: String(o.value), label: o.label || String(o.value) }));
    if (f.inverse) field.inverse = true;
    for (const k of ['placeholder', 'min', 'max', 'step']) if (f[k]) field[k] = f[k];
    field.when = f.when;
    return field;
  });
  return { id: s.id, title: s.title, fields };
});

const lines = [
  '// Generated by scripts/gen-apollo-schema.js from Apollo\'s settings page. Do not edit by hand.',
  '// eslint-disable-next-line no-unused-vars',
  'const APOLLO_SCHEMA = [',
];
for (const s of out) {
  lines.push(`  { id: ${JSON.stringify(s.id)}, title: ${JSON.stringify(s.title)}, fields: [`);
  for (const f of s.fields) {
    const { when, ...rest } = f;
    const json = JSON.stringify(rest);
    lines.push(`    { ...${json}, when: ${when ? `(c) => ${when}` : 'null'} },`);
  }
  lines.push('  ] },');
}
lines.push('];', '');
const dest = path.join(root, 'app', 'renderer', 'apollo-schema.js');
fs.writeFileSync(dest, lines.join('\n'));
console.log(`Wrote ${dest}: ${out.map((s) => `${s.id}=${s.fields.length}`).join(', ')}`);
