// Tests for the GitHub access layer in update.mjs with a stubbed fetch: error classification, batch halving,
// partial-error safety, README name variants, discovery resilience. No network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepos, fetchReadmes, discover, tuning } from './update.mjs';

process.env.GH_TOKEN = 'test';
Object.assign(tuning, { retryBaseMs: 0, rateLimitWaitMs: 0, searchGapMs: 0 });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const repoNode = (name) => ({ nameWithOwner: name, stargazerCount: 1, forkCount: 0, isArchived: false, isFork: false, description: '',
  createdAt: '2025-01-01T00:00:00Z', parent: null, defaultBranchRef: null, issues: { totalCount: 0 }, object: null });

/** Installs a fake fetch; handler(url, body) returns a Response. Restores the real one afterwards. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init?.body ? String(init.body) : '');
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('NOT_FOUND sets gone, other alias errors are errors, partial data with an error is not trusted', async () => {
  const handler = () => json({
    data: { a0: repoNode('o/ok'), a1: null, a2: null, a3: repoNode('o/partial') },
    errors: [{ type: 'NOT_FOUND', path: ['a1'], message: 'x' }, { type: 'INTERNAL', path: ['a2'], message: 'x' },
      { type: 'TIMEOUT', path: ['a3', 'object'], message: 'x' }],
  });
  const out = await withFetch(handler, () => fetchRepos(['o/ok', 'o/gone', 'o/boom', 'o/partial']));
  assert.equal(out.get('o/ok').status, 'ok');
  assert.equal(out.get('o/gone').status, 'gone');
  assert.equal(out.get('o/boom').status, 'error');
  assert.equal(out.get('o/partial').status, 'error', 'a timeout on one field must not look like a repo without a manifest');
});

test('a failing batch is halved until single repos, and a persistent failure becomes error not gone', async () => {
  let calls = 0;
  const handler = (url, body) => {
    calls++;
    if (body.includes('"o/bad"') || body.includes('o\\/bad') || body.includes('name: \\"bad\\"')) return json({}, 502);
    return json({ data: { a0: repoNode('o/good'), a1: repoNode('o/good2') } });
  };
  const out = await withFetch(handler, () => fetchRepos(['o/good', 'o/bad']));
  assert.equal(out.get('o/bad').status, 'error');
  assert.equal(out.get('o/good').status, 'ok');
  assert.ok(calls > 2);
});

test('rate limit responses are retried', async () => {
  let n = 0;
  const handler = () => (++n < 3 ? json({}, 403) : json({ data: { a0: repoNode('o/r') } }));
  const out = await withFetch(handler, () => fetchRepos(['o/r']));
  assert.equal(out.get('o/r').status, 'ok');
});

test('README lookup tries several file names and keeps empty READMEs as empty text', async () => {
  const handler = () => json({ data: { a0: { f0: null, f1: null, f2: { text: 'Hello from README.MD' } }, a1: { f0: null } } });
  const out = await withFetch(handler, () => fetchReadmes(['o/upper', 'o/none']));
  assert.equal(out.get('o/upper'), 'Hello from README.MD');
  assert.equal(out.get('o/none'), '');
});

test('README batch with an alias error is skipped so it is retried next run', async () => {
  const handler = () => json({ data: { a0: { f0: { text: 'x' } } }, errors: [{ type: 'TIMEOUT', path: ['a0', 'f0'], message: 'x' }] });
  const out = await withFetch(handler, () => fetchReadmes(['o/r']));
  assert.equal(out.has('o/r'), false);
});

test('discovery skips gone repos and survives a 404 fork listing, but reports other failures', async () => {
  const known = { 'o/gone': { forks: 3, gone: true }, 'o/404': { forks: 2 }, 'o/ok': { forks: 1 }, 'o/err': { forks: 1 } };
  const handler = (url) => {
    if (url.includes('/search/repositories')) return json({ items: [{ full_name: 'n/new' }], total_count: 1 });
    if (url.includes('/repos/o/gone/')) throw new Error('must not be called for gone repos');
    if (url.includes('/repos/o/404/')) return json({}, 404);
    if (url.includes('/repos/o/err/')) return json({}, 401);
    return json([{ full_name: 'f/fork', stargazers_count: 9 }]);
  };
  const out = await withFetch(handler, () => discover(known));
  assert.ok(out.names.includes('n/new') && out.names.includes('f/fork'));
  assert.equal(out.failed, true, '401 on a fork listing must fail the run');
  const onlyGone = await withFetch(handler, () => discover({ 'o/404': { forks: 2 }, 'o/ok': { forks: 1 } }));
  assert.equal(onlyGone.failed, false, '404 is not a failure');
});
