// Updates docs/data/extensions.json: finds SillyTavern extensions on GitHub, verifies them by their
// root manifest.json and keeps their metadata current. Usage: node scripts/update.mjs refresh|discover
// Needs GH_TOKEN (or GITHUB_TOKEN). Pure rules are exported for tests; I/O lives in the functions below them.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { detectAll } from 'tinyld';

const DATA = new URL('../docs/data/extensions.json', import.meta.url);
const CURATED = new URL('../docs/data/curated.json', import.meta.url);
const CATALOG = 'https://raw.githubusercontent.com/SillyTavern/SillyTavern-Content/main/index.json';

export const MIN_FORK_STARS = 5;
const BATCH = 25;
// Waits in ms; tests set them to 0. Rate-limited responses (403/429) get a long wait because GitHub's
// secondary limits ask for about a minute; Retry-After is honoured when sent.
export const tuning = { retryBaseMs: 1000, rateLimitWaitMs: 60000, searchGapMs: 2100 /* search API: 30/minute */ };
const README_NAMES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README', 'README.rst', 'README.org', 'README.txt'];
const TOPICS = ['sillytavern-extension', 'sillytavern-extensions'];
const KEYWORDS = ['sillytavern extension', 'silly tavern extension', 'SillyTavern-Extension', 'st-extension'];

// ---------- pure rules ----------

/** Removes email addresses (and the empty brackets they leave) from third-party text; null if nothing is left. */
export function stripEmails(s) {
  const out = s.replace(/<[^<>]*@[^<>]*>/g, ' ').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return out || null;
}

/** Reads manifest text; returns the fields we keep, or null if it is not an extension manifest. */
export function parseManifest(text) {
  if (!text) return null;
  let m;
  try { m = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
  if (!m || typeof m !== 'object' || !m.display_name || !m.js) return null;
  return { name: String(m.display_name), version: m.version ? String(m.version) : null,
    author: m.author ? stripEmails(String(m.author)) : null, homepage: m.homepage_url ? String(m.homepage_url) : null };
}

const MIN_PARAGRAPH_LETTERS = 60; // shorter paragraphs are too noisy to detect
const MIN_ACCURACY = 0.5; // tinyld confidence needed for a paragraph to count
const MIN_SHARE = 0.25; // share of detected letters a language needs to be listed

/**
 * Guesses the languages the README is written in, as short codes, using tinyld on each paragraph.
 * Code blocks, URLs, images and markup are removed first. Each confident paragraph votes with its letter
 * count; a language is listed when it holds MIN_SHARE of the votes. [] means unknown (no README or too little prose).
 */
export function guessLangs(readme) {
  const prose = (readme ?? '').replace(/```[\s\S]*?```|<[^>]*>|!?\[([^\]]*)\]\([^)]*\)|https?:\/\/\S+|[#*_`>|~-]/g, ' $1 ');
  const letters = {};
  let total = 0;
  for (const p of prose.split(/\n\s*\n/)) {
    const text = p.replace(/\s+/g, ' ').trim();
    const n = (text.match(/\p{L}/gu) ?? []).length + 2 * (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length; // CJK carries more per character
    if (n < MIN_PARAGRAPH_LETTERS) continue;
    const top = detectAll(text)[0];
    if (!top || top.accuracy < MIN_ACCURACY) continue;
    letters[top.lang] = (letters[top.lang] ?? 0) + n;
    total += n;
  }
  return Object.keys(letters).filter((l) => letters[l] / total >= MIN_SHARE).sort();
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
 * readmes: Map<repo, text>; kind is guessed once and then kept; langs likewise unless the guess was empty.
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
    const description = stripEmails(node.description ?? '') ?? '';
    const kind = old?.kind ?? (readmes.has(key) ? classifyKind({ repo: key, name: manifest.name, description, readme: readmes.get(key) }) : undefined);
    // an empty guess means "unknown" and is retried on later runs (a README may have been added)
    const langs = old?.langs?.length ? old.langs : readmes.has(key) ? guessLangs(readmes.get(key)) : old?.langs;
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
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true, status: res.status });
      return res.json();
    } catch (e) {
      if (e.fatal || attempt >= 3) throw e;
      const limited = e.status === 403 || e.status === 429;
      await sleep(e.retryAfter ? Math.min(e.retryAfter, 120) * 1000 : limited ? tuning.rateLimitWaitMs : tuning.retryBaseMs * 2 ** attempt);
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
      // any error on the alias (even with partial data, e.g. a field timeout) makes the result untrusted
      if (row.data && !row.error) { out.set(names[i], { status: 'ok', node: row.data, aheadBy: 0 }); if (row.data.isFork && row.data.parent) forks.push(names[i]); }
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
        if (typeof ahead === 'number' && !row.error) out.get(forks[i]).aheadBy = ahead;
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

export async function fetchRepos(names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += BATCH) await fetchBatch(names.slice(i, i + BATCH), out);
  return out;
}

/** README text (first 8000 chars) per repo; batches that fail are skipped, so those repos are retried next run. */
export async function fetchReadmes(names) {
  const out = new Map();
  const fields = README_NAMES.map((f, k) => `f${k}: object(expression: "HEAD:${f}") { ... on Blob { text } }`).join(' ');
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    try {
      const rows = await aliased(chunk, (n) => `repository(owner: ${JSON.stringify(split(n)[0])}, name: ${JSON.stringify(split(n)[1])}) { ${fields} }`);
      rows.forEach((row, j) => {
        if (!row.data || row.error) return;
        const text = README_NAMES.map((_, k) => row.data[`f${k}`]?.text).find(Boolean) ?? '';
        out.set(chunk[j], text.slice(0, 8000));
      });
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
    await sleep(tuning.searchGapMs);
    const r = await http(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    found.push(...r.items.map((i) => i.full_name));
    if (r.items.length < 100) break;
    if (page === 10 && r.total_count > found.length) console.warn(`search "${q}" has ${r.total_count} results but GitHub serves only the first ${found.length}`);
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

/** Candidate names from searches and fork listings. failed is true if a fork listing broke (the run must then fail). */
export async function discover(known) {
  const names = new Set();
  let failed = false;
  for (const t of TOPICS) (await searchAll(`topic:${t}`)).forEach((n) => names.add(n));
  for (const k of KEYWORDS) (await searchAll(`${k} in:name,description`)).forEach((n) => names.add(n));
  for (const repo of Object.keys(known)) {
    if (!(known[repo].forks > 0) || known[repo].gone) continue;
    try { (await listForks(repo)).forEach((n) => names.add(n)); } catch (e) {
      if (e.status !== 404) { failed = true; console.error(`fork listing failed for ${repo}: ${e.message}`); } // 404: gone since the last refresh, flagged by that
    }
  }
  return { names: [...names], failed };
}

// ---------- main ----------

async function readJson(url, fallback) {
  try { return JSON.parse((await readFile(url, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

export async function run(mode) {
  if (!token()) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const prevText = await readFile(DATA, 'utf8').catch(() => '');
  const prev = prevText ? JSON.parse(prevText) : null;
  const known = prev?.extensions ?? {};
  const curated = await readJson(CURATED, {});
  const names = new Set([...Object.keys(known), ...(curated.include ?? [])]);
  let discoveryFailed = false;
  if (mode === 'discover') {
    const found = await discover(known);
    found.names.forEach((n) => names.add(n));
    discoveryFailed = found.failed;
  }
  const [catalog, fetched] = await Promise.all([fetchCatalog(), fetchRepos([...names])]);
  let { extensions, failed } = merge(known, fetched, curated, catalog);
  const unclassified = Object.keys(extensions).filter((n) => (!extensions[n].kind || !extensions[n].langs?.length) && !extensions[n].gone);
  if (unclassified.length) ({ extensions, failed } = merge(known, fetched, curated, catalog, await fetchReadmes(unclassified)));
  if (failed || discoveryFailed) throw new Error('some repos or fork lists could not be read; data file left unchanged');
  const text = render(prev, extensions);
  if (text !== prevText) await writeFile(DATA, text);
  console.log(`${mode}: ${Object.keys(extensions).length} extensions, ${text === prevText ? 'unchanged' : 'written'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== 'refresh' && mode !== 'discover') { console.error('usage: update.mjs refresh|discover'); process.exit(2); }
  run(mode).catch((e) => { console.error(e.message); process.exit(1); });
}
