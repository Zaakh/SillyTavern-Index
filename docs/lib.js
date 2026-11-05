// Pure page logic (no DOM) so it can be tested with node:test: health bands, safe links, filtering, sorting, hash state.
export const ACTIVE_MONTHS = 3;
export const SLOW_MONTHS = 12;

/** Health band from the last default-branch commit date; archived always wins. */
export function band(e, now = new Date()) {
  if (e.archived) return 'Archived';
  if (!e.lastCommit) return 'Stale';
  const months = (now - new Date(e.lastCommit)) / (30.44 * 864e5);
  return months <= ACTIVE_MONTHS ? 'Active' : months <= SLOW_MONTHS ? 'Slow' : 'Stale';
}

/** Returns the URL only if it is https://, else null (third-party text must never become a script link). */
export const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

export const DEFAULT_VIEW = { q: '', sort: 'stars', dir: 'desc', band: '', cat: '', tag: '', kind: '', gone: false, family: '', minStars: '5', lang: '' };

export function viewFromHash(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const v = { ...DEFAULT_VIEW };
  for (const k of Object.keys(v)) if (p.has(k)) v[k] = k === 'gone' ? p.get(k) === '1' : p.get(k);
  return v;
}

export function viewToHash(v) {
  const p = new URLSearchParams();
  for (const [k, d] of Object.entries(DEFAULT_VIEW)) if (v[k] !== d) p.set(k, v[k] === true ? '1' : v[k]);
  return p.toString();
}

/** Applies filters and sort. entries: [[repo, entry]]; curated: {tags:{repo:[...]}, kind:{repo:string}}. */
export function select(entries, curated, v, now = new Date()) {
  const tags = (r) => curated.tags?.[r] ?? [];
  const kind = (r, e) => curated.kind?.[r] ?? e.kind ?? 'unspecified'; // curated overrides the README guess
  const q = v.q.trim().toLowerCase();
  const fam = (r, e) => !v.family || r === v.family || e.forkOf === v.family;
  const rows = entries.filter(([r, e]) =>
    (v.gone || !e.gone) && fam(r, e) && e.stars >= Number(v.minStars) &&
    (!v.band || band(e, now) === v.band) &&
    (!v.cat || (v.cat === 'in') === !!e.inCatalog) &&
    (!v.tag || tags(r).includes(v.tag)) && (!v.kind || kind(r, e) === v.kind) &&
    (!v.lang || (e.langs?.length ? e.langs.includes(v.lang) : v.lang === 'unknown')) &&
    (!q || [e.name, r, e.description, ...tags(r)].some((s) => (s ?? '').toLowerCase().includes(q))));
  const sign = v.dir === 'asc' ? 1 : -1;
  const key = (r, e) => (v.sort === 'name' ? e.name.toLowerCase() : v.sort === 'lastCommit' ? e.lastCommit ?? '' : e[v.sort]);
  return rows.sort(([ra, a], [rb, b]) => {
    const x = key(ra, a), y = key(rb, b);
    return (x < y ? -1 : x > y ? 1 : ra < rb ? -1 : 1) * (x === y ? 1 : sign);
  });
}
