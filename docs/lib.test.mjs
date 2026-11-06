// Tests for the page logic in lib.js: health bands, safe URLs, filters, sorting, hash round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { band, httpsUrl, select, viewFromHash, viewToHash, DEFAULT_VIEW, loadJson, saveJson, toSavedSet, initialView } from './lib.js';

const now = new Date('2026-11-05T00:00:00Z');
const ago = (days) => new Date(now - days * 864e5).toISOString();

test('bands', () => {
  assert.equal(band({ lastCommit: ago(10) }, now), 'Active');
  assert.equal(band({ lastCommit: ago(150) }, now), 'Slow');
  assert.equal(band({ lastCommit: ago(14 * 30.44) }, now), 'Stale');
  assert.equal(band({ lastCommit: ago(1), archived: true }, now), 'Archived');
  assert.equal(band({ lastCommit: ago(10) }, new Date(now.getTime() + 300 * 864e5)), 'Slow', 'follows viewing date');
});

test('only https URLs become links', () => {
  assert.equal(httpsUrl('https://x.io'), 'https://x.io');
  assert.equal(httpsUrl('javascript:alert(1)'), null);
  assert.equal(httpsUrl('http://x.io'), null);
  assert.equal(httpsUrl(undefined), null);
});

const entries = [
  ['a/one', { name: 'One', description: 'memory tool', stars: 5, forks: 1, issues: 0, lastCommit: ago(5), inCatalog: true }],
  ['b/two', { name: 'Two', description: 'ui', stars: 50, forks: 0, issues: 3, lastCommit: ago(400), inCatalog: false }],
  ['c/three', { name: 'Three', description: 'x', stars: 20, forks: 2, issues: 1, lastCommit: ago(30), gone: true, forkOf: 'b/two' }],
];
const curated = { tags: { 'a/one': ['lore'] }, kind: { 'b/two': 'theme' } };
const names = (v) => select(entries, curated, { ...DEFAULT_VIEW, ...v }, now).map(([r]) => r);

test('select: default sort, gone hidden, filters combine, search, family', () => {
  assert.deepEqual(names({}), ['b/two', 'a/one']);
  assert.deepEqual(names({ gone: true }), ['b/two', 'c/three', 'a/one']);
  assert.deepEqual(names({ sort: 'lastCommit' }), ['a/one', 'b/two']);
  assert.deepEqual(names({ sort: 'name', dir: 'asc' }), ['a/one', 'b/two']);
  assert.deepEqual(names({ band: 'Active', cat: 'out' }), []);
  assert.deepEqual(names({ q: 'MEMORY' }), ['a/one']);
  assert.deepEqual(names({ q: 'lore' }), ['a/one']);
  assert.deepEqual(names({ kind: 'theme' }), ['b/two']);
  assert.deepEqual(names({ kind: 'unspecified' }), ['a/one']);
  assert.deepEqual(select([['x/y', { ...entries[0][1], kind: 'extension' }]], {}, { ...DEFAULT_VIEW, kind: 'extension' }, now).length, 1, 'data kind used');
  assert.deepEqual(select([['x/y', { ...entries[0][1], kind: 'extension' }]], { kind: { 'x/y': 'theme' } }, { ...DEFAULT_VIEW, kind: 'theme' }, now).length, 1, 'curated overrides');
  assert.deepEqual(names({ family: 'b/two', gone: true }), ['b/two', 'c/three']);
});

test('min stars defaults to 5 and is adjustable', () => {
  const low = [...entries, ['d/low', { name: 'Low', description: '', stars: 4, forks: 0, issues: 0, lastCommit: ago(1) }]];
  const n = (v) => select(low, curated, { ...DEFAULT_VIEW, ...v }, now).map(([r]) => r);
  assert.ok(!n({}).includes('d/low'));
  assert.ok(n({ minStars: '0' }).includes('d/low'));
  assert.deepEqual(n({ minStars: '20' }), ['b/two']);
});

test('language filter: data langs, empty means unknown', () => {
  const e = (langs) => ['x/' + langs, { name: 'N', description: '', stars: 9, forks: 0, issues: 0, lastCommit: ago(1), langs }];
  const rows = [e(['en']), e(['en', 'zh']), e(['zh']), ['x/none', { ...e([])[1] }], ['x/missing', { ...e([])[1], langs: undefined }]];
  const n = (lang) => select(rows, {}, { ...DEFAULT_VIEW, lang }, now).map(([r]) => r).sort();
  assert.deepEqual(n('zh'), ['x/en,zh', 'x/zh']);
  assert.deepEqual(n('en'), ['x/en', 'x/en,zh']);
  assert.deepEqual(n('unknown'), ['x/missing', 'x/none']);
});

test('family view ignores the star floor so low-star parents and forks stay visible', () => {
  const fam = [['p/parent', { ...entries[0][1], stars: 1 }], ['f/fork', { ...entries[0][1], stars: 2, forkOf: 'p/parent' }], ['x/other', { ...entries[0][1], stars: 1 }]];
  const n = (v) => select(fam, {}, { ...DEFAULT_VIEW, ...v }, now).map(([r]) => r).sort();
  assert.deepEqual(n({}), []);
  assert.deepEqual(n({ family: 'p/parent' }), ['f/fork', 'p/parent']);
});

test('hash round trip', () => {
  const v = { ...DEFAULT_VIEW, q: 'a b', band: 'Active', gone: true, saved: true };
  assert.deepEqual(viewFromHash('#' + viewToHash(v)), v);
  assert.equal(viewToHash(DEFAULT_VIEW), '');
});

test('saved filter: members only, ignores star floor, off = unchanged', () => {
  const rows = [...entries, ['d/low', { name: 'Low', description: '', stars: 1, forks: 0, issues: 0, lastCommit: ago(1) }]];
  const n = (v, saved) => select(rows, curated, { ...DEFAULT_VIEW, ...v }, now, new Set(saved)).map(([r]) => r);
  assert.deepEqual(n({ saved: true }, ['d/low', 'a/one', 'x/gone-from-data']), ['a/one', 'd/low']);
  assert.deepEqual(n({}, ['d/low']), ['b/two', 'a/one']);
});

test('storage helpers swallow errors and validate', () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadJson('k', 7, bad), 7);
  saveJson('k', 1, bad);
  const m = new Map(), ok = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  saveJson('k', ['a/b'], ok);
  assert.deepEqual(loadJson('k', null, ok), ['a/b']);
  m.set('k', '{oops');
  assert.equal(loadJson('k', 7, ok), 7);
  assert.deepEqual([...toSavedSet(['a/b'])], ['a/b']);
  for (const x of [null, 'a', {}, [1], ['a', null]]) assert.equal(toSavedSet(x).size, 0);
});

test('initialView: hash wins, else stored without family, else defaults', () => {
  assert.equal(initialView('#q=x', 'q=y').q, 'x');
  assert.deepEqual(initialView('', 'q=y&family=a%2Fb'), { ...DEFAULT_VIEW, q: 'y' });
  assert.deepEqual(initialView('#', null), DEFAULT_VIEW);
  assert.deepEqual(initialView('', ''), DEFAULT_VIEW);
});
