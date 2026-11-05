// Updates docs/data/extensions.json: finds SillyTavern extensions on GitHub, verifies them by their
// root manifest.json and keeps their metadata current. Usage: node scripts/update.mjs refresh|discover
// Needs GH_TOKEN (or GITHUB_TOKEN). Pure rules are exported for tests; I/O lives in the functions below them.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DATA = new URL('../docs/data/extensions.json', import.meta.url);
const CURATED = new URL('../docs/data/curated.json', import.meta.url);
const CATALOG = 'https://raw.githubusercontent.com/SillyTavern/SillyTavern-Content/main/index.json';

export const MIN_FORK_STARS = 5;
const BATCH = 25;
const SEARCH_GAP_MS = 2100; // search API: 30 requests/minute
const TOPICS = ['sillytavern-extension', 'sillytavern-extensions'];
const KEYWORDS = ['sillytavern extension', 'silly tavern extension', 'SillyTavern-Extension', 'st-extension'];

// ---------- pure rules ----------

/** Reads manifest text; returns the fields we keep, or null if it is not an extension manifest. */
export function parseManifest(text) {
  if (!text) return null;
  let m;
  try { m = JSON.parse(text.replace(/^﻿/, '')); } catch { return null; }
  if (!m || typeof m !== 'object' || !m.display_name || !m.js) return null;
  return { name: String(m.display_name), version: m.version ? String(m.version) : null,
    author: m.author ? String(m.author) : null, homepage: m.homepage_url ? String(m.homepage_url) : null,
    i18n: m.i18n && typeof m.i18n === 'object' ? Object.keys(m.i18n) : [] };
}

const count = (s, re) => (s.match(re) ?? []).length;

/**
 * Guesses supported languages as short codes: the manifest's i18n keys plus the language of the name,
 * description and README head (script detection; English needs common English words). [] means unknown.
 */
export function guessLangs({ name, description, readme, i18n = [] }) {
  const text = `${name} ${description} ${readme ?? ''}`.replace(/```[\s\S]*?```|https?:\/\/\S+/g, ' ');
  const langs = new Set(i18n.map((c) => c.toLowerCase().split(/[-_]/)[0]));
  if (count(text, /[぀-ヿ]/g) >= 10) langs.add('ja');
  else if (count(text, /[一-鿿]/g) >= 10) langs.add('zh');
  if (count(text, /[가-힯]/g) >= 10) langs.add('ko');
  if (count(text, /[Ѐ-ӿ]/g) >= 10) langs.add('ru');
  if (count(text, /\b(the|and|for|with|to|is|of)\b/gi) >= 3) langs.add('en');
  return [...langs].sort();
}

/** A fork is its own entry only if ahead of its parent, starred enough, and committed to after it was created. */
export function forkQualifies({ aheadBy, stars, lastCommit, createdAt }) {
  return aheadBy > 0 && stars >= MIN_FORK_STARS && !!lastCommit && lastCommit > createdAt;
}

const TOOL_WORDS = /\b(assist(ant)?|manage(r|ment)|picker|search|bind(er|ing)?|switcher|selector|editor|helper|generator|tools?|toolkit|customi[sz]er)\b/i;

/**
 * Guesses 'theme' | 'extension' | 'unspecified' from repo name, display name, description and README head.
 * Theme only when the name or description says "theme" and no tool-like word does; any other theme hint is unclear.
 */
export function classifyKind({ repo, name, description, readme }) {
  const head = `${repo} ${name} ${description}`;
  if (/\bthemes?\b/i.test(head)) return TOOL_WORDS.test(head) || /\bextension\b/i.test(`${name} ${description}`) ? 'unspecified' : 'theme';
  return ((readme ?? '').slice(0, 3000).match(/theme/gi)?.length ?? 0) >= 3 ? 'unspecified' : 'extension';
}

/** Fixed key order keeps the file stable. */
export function orderedEntry(e) {
  const out = { name: e.name, author: e.author, version: e.version, homepage: e.homepage, description: e.description,
    stars: e.stars, forks: e.forks, issues: e.issues, lastCommit: e.lastCommit, archived: e.archived };
  if (e.kind) out.kind = e.kind;
  if (e.langs) out.langs = e.langs;
  if (e.forkOf) out.forkOf = e.forkOf;
  out.inCatalog = !!e.inCatalog;
  if (e.gone) out.gone = true;
  return out;
}

const low = (s) => s.toLowerCase();

/**
 * Applies fetch results to the known entries.
 * fetched: Map<requestedName, {status:'ok', node, aheadBy} | {status:'gone'} | {status:'error'}>.
 * Names missing from the map count as errors. catalog: Set of lowercase repos, or null if unavailable.
 * readmes: Map<repo, text>; kind and langs are guessed once (when the entry has none) and then kept.
 * Returns {extensions, failed}; failed is true if any KNOWN repo could not be read (its old entry is kept).
 */
export function merge(known, fetched, curated, catalog, readmes = new Map()) {
  const exclude = new Set((curated.exclude ?? []).map(low));
  const include = new Set((curated.include ?? []).map(low));
  const next = {};
  let failed = false;
  const names = new Set([...Object.keys(known), ...fetched.keys()]);
  for (const req of names) {
    const old = known[req];
    const r = fetched.get(req) ?? { status: 'error' };
    if (r.status === 'gone') { if (old) next[req] = { ...old, gone: true }; continue; }
    if (r.status !== 'ok') { if (old) { next[req] = old; failed = true; } continue; }
    const { node, aheadBy } = r;
    const key = node.nameWithOwner;
    if (exclude.has(low(key))) continue;
    const manifest = parseManifest(node.object?.text);
    if (!manifest) continue;
    const commit = node.defaultBranchRef?.target?.committedDate ?? null;
    const forkOf = node.isFork && node.parent ? node.parent.nameWithOwner : null;
    if (forkOf && !include.has(low(key)) &&
      !forkQualifies({ aheadBy, stars: node.stargazerCount, lastCommit: commit, createdAt: node.createdAt })) continue;
    const description = node.description ?? '';
    const kind = old?.kind ?? (readmes.has(key) ? classifyKind({ repo: key, name: manifest.name, description, readme: readmes.get(key) }) : undefined);
    const langs = old?.langs ?? (readmes.has(key) ? guessLangs({ name: manifest.name, description, readme: readmes.get(key), i18n: manifest.i18n }) : undefined);
    next[key] = orderedEntry({ ...manifest, description, kind, langs, stars: node.stargazerCount,
      forks: node.forkCount, issues: node.issues.totalCount, lastCommit: commit, archived: node.isArchived, forkOf,
      inCatalog: catalog ? catalog.has(low(key)) : (old?.inCatalog ?? false) });
    if (key !== req && old) delete next[req]; // rename: key moves to the new name
  }
  return { extensions: Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), failed };
}

/** Renders the data file; the timestamp changes only when the extensions changed, so unchanged input is byte-identical. */
export function render(prev, extensions, now = new Date().toISOString()) {
  const same = prev && JSON.stringify(prev.extensions) === JSON.stringify(extensions);
  return JSON.stringify({ updated: same ? prev.updated : now, extensions }, null, 2) + '\n';
}

// ---------- GitHub access ----------

const token = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO_FIELDS = `nameWithOwner stargazerCount forkCount isArchived isFork description createdAt
  parent { nameWithOwner } defaultBranchRef { name target { ... on Commit { committedDate } } }
  issues(states: OPEN) { totalCount } object(expression: "HEAD:manifest.json") { ... on Blob { text } }`;

async function http(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${token()}`, 'User-Agent': 'sillytavern-index', ...init.headers } });
      if (res.status === 403 || res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      return res.json();
    } catch (e) {
      if (e.fatal || attempt >= 3) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const gql = (query) => http('https://api.github.com/graphql', { method: 'POST', body: JSON.stringify({ query }) });
const split = (name) => name.split('/');

/** Runs one aliased query; returns per-alias {data, error} where error is the GraphQL error type. */
async function aliased(items, build) {
  const q = 'query {' + items.map((it, i) => `a${i}: ${build(it)}`).join('\n') + '}';
  const res = await gql(q);
  if (!res.data && !res.errors?.length) throw new Error('empty GraphQL response');
  const errs = new Map();
  for (const e of res.errors ?? []) {
    if (!e.path) throw new Error(`GraphQL: ${e.message}`);
    errs.set(e.path[0], e.type ?? 'ERROR');
  }
  return items.map((_, i) => ({ data: res.data?.[`a${i}`] ?? null, error: errs.get(`a${i}`) }));
}

/** Fetches a batch; on persistent failure halves it, and a single failing repo becomes status 'error'. */
async function fetchBatch(names, out) {
  try {
    const rows = await aliased(names, (n) => `repository(owner: ${JSON.stringify(split(n)[0])}, name: ${JSON.stringify(split(n)[1])}) { ${REPO_FIELDS} }`);
    const forks = [];
    rows.forEach((row, i) => {
      if (row.data) { out.set(names[i], { status: 'ok', node: row.data, aheadBy: 0 }); if (row.data.isFork && row.data.parent) forks.push(names[i]); }
      else out.set(names[i], { status: row.error === 'NOT_FOUND' ? 'gone' : 'error' });
    });
    if (forks.length) {
      const cmp = await aliased(forks, (n) => {
        const node = out.get(n).node;
        return `repository(owner: ${JSON.stringify(split(node.nameWithOwner)[0])}, name: ${JSON.stringify(split(node.nameWithOwner)[1])}) {
          parent { defaultBranchRef { compare(headRef: ${JSON.stringify(split(node.nameWithOwner)[0] + ':' + (node.defaultBranchRef?.name ?? ''))}) { aheadBy } } } }`;
      });
      cmp.forEach((row, i) => {
        const ahead = row.data?.parent?.defaultBranchRef?.compare?.aheadBy;
        if (typeof ahead === 'number') out.get(forks[i]).aheadBy = ahead;
        else out.set(forks[i], { status: 'error' });
      });
    }
  } catch (e) {
    if (names.length === 1) { out.set(names[0], { status: 'error' }); return; }
    const mid = names.length >> 1;
    await fetchBatch(names.slice(0, mid), out);
    await fetchBatch(names.slice(mid), out);
  }
}

async function fetchRepos(names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += BATCH) await fetchBatch(names.slice(i, i + BATCH), out);
  return out;
}

/** README text (first 3000 chars) per repo; batches that fail are skipped, so those repos are retried next run. */
async function fetchReadmes(names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    try {
      const rows = await aliased(chunk, (n) => `repository(owner: ${JSON.stringify(split(n)[0])}, name: ${JSON.stringify(split(n)[1])}) {
        a: object(expression: "HEAD:README.md") { ... on Blob { text } } b: object(expression: "HEAD:readme.md") { ... on Blob { text } } }`);
      rows.forEach((row, j) => { if (row.data) out.set(chunk[j], (row.data.a?.text ?? row.data.b?.text ?? '').slice(0, 3000)); });
    } catch { /* retried on the next run */ }
  }
  return out;
}

/** Official catalog as a Set of lowercase owner/repo, or null when unavailable. */
async function fetchCatalog() {
  try {
    const res = await fetch(CATALOG, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    return new Set((await res.json()).filter((x) => x.type === 'extension')
      .map((x) => low(new URL(x.url).pathname.replace(/^\/|\/$/g, ''))));
  } catch { return null; }
}

// ---------- discovery ----------

async function searchAll(q) {
  const found = [];
  for (let page = 1; page <= 10; page++) {
    await sleep(SEARCH_GAP_MS);
    const r = await http(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    found.push(...r.items.map((i) => i.full_name));
    if (r.items.length < 100) break;
  }
  return found;
}

/** Forks of a known extension in descending star order; stops at the first fork below the star floor. */
async function listForks(repo) {
  const found = [];
  for (let page = 1; ; page++) {
    const forks = await http(`https://api.github.com/repos/${repo}/forks?sort=stargazers&per_page=100&page=${page}`);
    for (const f of forks) { if (f.stargazers_count < MIN_FORK_STARS) return found; found.push(f.full_name); }
    if (forks.length < 100) return found;
  }
}

async function discover(known) {
  const names = new Set();
  for (const t of TOPICS) (await searchAll(`topic:${t}`)).forEach((n) => names.add(n));
  for (const k of KEYWORDS) (await searchAll(`${k} in:name,description`)).forEach((n) => names.add(n));
  for (const repo of Object.keys(known)) if (known[repo].forks > 0) (await listForks(repo)).forEach((n) => names.add(n));
  return [...names];
}

// ---------- main ----------

async function readJson(url, fallback) {
  try { return JSON.parse((await readFile(url, 'utf8')).replace(/^﻿/, '')); } catch { return fallback; }
}

export async function run(mode) {
  if (!token()) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const prevText = await readFile(DATA, 'utf8').catch(() => '');
  const prev = prevText ? JSON.parse(prevText) : null;
  const known = prev?.extensions ?? {};
  const curated = await readJson(CURATED, {});
  const names = new Set([...Object.keys(known), ...(curated.include ?? [])]);
  if (mode === 'discover') (await discover(known)).forEach((n) => names.add(n));
  const [catalog, fetched] = await Promise.all([fetchCatalog(), fetchRepos([...names])]);
  let { extensions, failed } = merge(known, fetched, curated, catalog);
  const unclassified = Object.keys(extensions).filter((n) => (!extensions[n].kind || !extensions[n].langs) && !extensions[n].gone);
  if (unclassified.length) ({ extensions, failed } = merge(known, fetched, curated, catalog, await fetchReadmes(unclassified)));
  if (failed) throw new Error('some known repos could not be read; data file left unchanged');
  const text = render(prev, extensions);
  if (text !== prevText) await writeFile(DATA, text);
  console.log(`${mode}: ${Object.keys(extensions).length} extensions, ${text === prevText ? 'unchanged' : 'written'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== 'refresh' && mode !== 'discover') { console.error('usage: update.mjs refresh|discover'); process.exit(2); }
  run(mode).catch((e) => { console.error(e.message); process.exit(1); });
}
