// Compare the keys of the translation files of each language.
// A key that one language has and a different language does not have fails the check, except the
// keys in tools/i18n-known-drift.json.
//
// Run: node tools/i18n-check.mjs <locales folder>              (check)
//      node tools/i18n-check.mjs <locales folder> --baseline   (write the current differences)
// Layout of the folder: <lng>/<file>.json (for example vi/translation.json) or <lng>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node tools/i18n-check.mjs <locales folder> [--baseline]');
  process.exit(2);
}
const driftFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n-known-drift.json');

const flat = (obj, prefix) =>
  Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const read = (file, prefix) => flat(JSON.parse(fs.readFileSync(file, 'utf8')), prefix);

/** @type {Record<string, Set<string>>} */
const keys = {};
for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
  if (ent.isDirectory()) {
    const files = fs.readdirSync(path.join(dir, ent.name)).filter(f => f.endsWith('.json')).sort();
    keys[ent.name] = new Set(files.flatMap(f => read(path.join(dir, ent.name, f), `${f.replace(/\.json$/, '')}:`)));
  } else if (ent.name.endsWith('.json')) {
    keys[ent.name.replace(/\.json$/, '')] = new Set(read(path.join(dir, ent.name), ''));
  }
}
const langs = Object.keys(keys).sort();
if (langs.length < 2) {
  console.log(`i18n check: OK (${langs.length} language, nothing to compare).`);
  process.exit(0);
}
const all = new Set(langs.flatMap(l => [...keys[l]]));
/** @type {Record<string, string[]>} */
const missing = Object.fromEntries(langs.map(l => [l, [...all].filter(k => !keys[l].has(k)).sort()]));

if (args.includes('--baseline')) {
  fs.writeFileSync(driftFile, `${JSON.stringify(missing, null, 2)}\n`);
  console.log(`Wrote ${driftFile}: ${langs.map(l => `${missing[l].length} keys missing in ${l}`).join(', ')}.`);
  process.exit(0);
}

const known = fs.existsSync(driftFile) ? JSON.parse(fs.readFileSync(driftFile, 'utf8')) : {};
let bad = 0;
let fixed = 0;
for (const l of langs) {
  const old = new Set(known[l] ?? []);
  for (const k of missing[l].filter(x => !old.has(x))) {
    console.log(`Missing in ${l}: ${k}`);
    bad += 1;
  }
  fixed += [...old].filter(k => !missing[l].includes(k)).length;
}
if (fixed) console.log(`${fixed} known keys are now in each language. Run with --baseline to remove them from the list.`);
if (bad) {
  console.log('i18n check: FAIL. Add each key above to the translation file of that language, at the same path.');
  process.exit(1);
}
const knownCount = langs.reduce((n, l) => n + (known[l]?.length ?? 0), 0);
console.log(`i18n check: OK (${langs.map(l => `${keys[l].size} keys in ${l}`).join(', ')}, ${knownCount} known differences).`);
