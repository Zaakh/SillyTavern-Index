// Tests for the pure rules in update.mjs (extension rule, fork rule, curation, failure safety, stable output).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, forkQualifies, merge, render, classifyKind, guessLangs } from './update.mjs';

const manifest = (o = {}) => JSON.stringify({ display_name: 'X', js: 'index.js', version: '1.0', author: 'a', ...o });
const node = (o = {}) => ({ nameWithOwner: 'o/r', stargazerCount: 10, forkCount: 1, isArchived: false, isFork: false,
  description: 'd', createdAt: '2025-01-01T00:00:00Z', parent: null, issues: { totalCount: 2 },
  defaultBranchRef: { name: 'main', target: { committedDate: '2026-01-01T00:00:00Z' } },
  object: { text: manifest() }, ...o });
const ok = (n, aheadBy = 0) => ({ status: 'ok', node: n, aheadBy });
const fetchedOf = (o) => new Map(Object.entries(o));

test('manifest rule', () => {
  assert.equal(parseManifest(manifest()).name, 'X');
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest(manifest({ js: undefined })), null);
  assert.equal(parseManifest(manifest({ display_name: undefined })), null);
  assert.equal(parseManifest('﻿' + manifest()).name, 'X');
  assert.equal(parseManifest('{not json'), null);
});

test('fork rule', () => {
  const base = { aheadBy: 35, stars: 37, lastCommit: '2026-02-01', createdAt: '2025-01-01' };
  assert.ok(forkQualifies(base));
  assert.ok(!forkQualifies({ ...base, aheadBy: 0 }), 'mirror');
  assert.ok(!forkQualifies({ ...base, stars: 4 }), 'low stars');
  assert.ok(!forkQualifies({ ...base, lastCommit: '2024-12-31' }), 'no commit after creation');
});

test('merge: fork qualifying, mirror, deleted parent, include, exclude', () => {
  const fork = (o) => node({ nameWithOwner: 'f/r', isFork: true, parent: { nameWithOwner: 'o/r' }, ...o });
  const run = (n, ahead, curated = {}) => merge({}, fetchedOf({ 'f/r': ok(n, ahead) }), curated, null).extensions;
  assert.equal(run(fork({ stargazerCount: 37 }), 35)['f/r'].forkOf, 'o/r');
  assert.deepEqual(run(fork({ stargazerCount: 37 }), 0), {});
  assert.equal(run(fork({ parent: null, stargazerCount: 0 }), 0)['f/r'].forkOf, undefined, 'null parent is a normal repo');
  assert.ok(run(fork({ stargazerCount: 2 }), 3, { include: ['F/R'] })['f/r']);
  assert.deepEqual(run(node({ nameWithOwner: 'f/r' }), 0, { exclude: ['f/r'] }), {});
  assert.deepEqual(run(node({ nameWithOwner: 'f/r', object: null }), 0), {}, 'no manifest');
});

test('failure safety: only NOT_FOUND sets gone; errors keep old entry and fail', () => {
  const { extensions: known } = merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null);
  const gone = merge(known, fetchedOf({ 'o/r': { status: 'gone' } }), {}, null);
  assert.equal(gone.extensions['o/r'].gone, true);
  assert.equal(gone.extensions['o/r'].stars, 10, 'keeps last data');
  assert.equal(gone.failed, false);
  for (const fetched of [fetchedOf({ 'o/r': { status: 'error' } }), fetchedOf({})]) {
    const r = merge(known, fetched, {}, null);
    assert.deepEqual(r.extensions, known, 'timeout/API error leaves data unchanged');
    assert.equal(r.failed, true);
  }
});

test('rename moves the key', () => {
  const { extensions: known } = merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null);
  const r = merge(known, fetchedOf({ 'o/r': ok(node({ nameWithOwner: 'o/new' })) }), {}, null).extensions;
  assert.deepEqual(Object.keys(r), ['o/new']);
});

test('catalog flag; unavailable catalog keeps old value', () => {
  const run = (known, cat) => merge(known, fetchedOf({ 'o/r': ok(node()) }), {}, cat).extensions['o/r'].inCatalog;
  assert.equal(run({}, new Set(['o/r'])), true);
  assert.equal(run({}, new Set()), false);
  const { extensions: known } = merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, new Set(['o/r']));
  assert.equal(run(known, null), true);
});

test('stable output: unchanged is byte-identical, change bumps timestamp', () => {
  const { extensions } = merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null);
  const first = render(null, extensions, '2026-01-01T00:00:00Z');
  assert.equal(render(JSON.parse(first), extensions, '2027-01-01T00:00:00Z'), first);
  const changed = { 'o/r': { ...extensions['o/r'], stars: 11 } };
  assert.equal(JSON.parse(render(JSON.parse(first), changed, '2027-01-01T00:00:00Z')).updated, '2027-01-01T00:00:00Z');
});

test('kind guess: theme, extension, unspecified when unclear', () => {
  const k = (o) => classifyKind({ repo: 'o/r', name: 'N', description: '', readme: '', ...o });
  assert.equal(k({ name: 'Moonlit Echoes Theme', description: 'A modern theme for SillyTavern.' }), 'theme');
  assert.equal(k({ name: 'X', description: 'A theme-aware extension for SillyTavern' }), 'unspecified', 'calls itself an extension');
  assert.equal(k({ name: 'Theme Search', description: 'search UI themes' }), 'unspecified', 'tool about themes');
  assert.equal(k({ description: 'Adds memory to chats', readme: 'Install it.' }), 'extension');
  assert.equal(k({ description: 'x', readme: 'theme theme theme colors' }), 'unspecified', 'theme-heavy readme');
  assert.equal(k({ readme: undefined }), 'extension');
});

test('kind is guessed once for new entries and then kept', () => {
  const readmes = new Map([['o/r', 'Hello']]);
  const first = merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null, readmes).extensions;
  assert.equal(first['o/r'].kind, 'extension');
  const again = merge({ 'o/r': { ...first['o/r'], kind: 'theme' } }, fetchedOf({ 'o/r': ok(node()) }), {}, null, readmes).extensions;
  assert.equal(again['o/r'].kind, 'theme', 'existing kind not re-guessed');
  assert.equal(merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null).extensions['o/r'].kind, undefined, 'no README fetched: retried later');
});

const para = (...p) => p.join('\n\n');
const EN = 'This extension adds a memory panel to the chat window and lets you edit entries by hand.';
const ZH = '这是一个用于酒馆的扩展，支持提示词模板和变量，可以在聊天窗口中直接使用。';

test('language guess from README prose only', () => {
  assert.deepEqual(guessLangs(para(EN, EN)), ['en']);
  assert.deepEqual(guessLangs(para(ZH, ZH)), ['zh']);
  assert.deepEqual(guessLangs(para(EN, ZH, ZH)), ['en', 'zh'], 'bilingual README');
  assert.deepEqual(guessLangs(para('```js\n' + EN + '\n```', 'https://example.com/' + 'a'.repeat(60))), [], 'code and URLs ignored');
  assert.deepEqual(guessLangs(para('# Title', 'Short.')), [], 'too little prose');
  assert.deepEqual(guessLangs(undefined), [], 'no README');
});

test('langs guessed once for new entries, then kept', () => {
  const readmes = new Map([['o/r', para(EN, EN)]]);
  const first = merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null, readmes).extensions;
  assert.deepEqual(first['o/r'].langs, ['en']);
  const kept = merge({ 'o/r': { ...first['o/r'], langs: ['zh'] } }, fetchedOf({ 'o/r': ok(node()) }), {}, null, readmes).extensions;
  assert.deepEqual(kept['o/r'].langs, ['zh']);
  assert.equal(merge({}, fetchedOf({ 'o/r': ok(node()) }), {}, null).extensions['o/r'].langs, undefined, 'retried when README missing');
});
