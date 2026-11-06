// Renders the extension index: loads the two JSON files, builds cards with textContent only, keeps view state in the URL hash and (with saved repos) in localStorage.
import { band, httpsUrl, select, viewFromHash, viewToHash, initialView, loadJson, saveJson, toSavedSet, SAVED_KEY, VIEW_KEY, DEFAULT_VIEW } from './lib.js';

const $ = (id) => document.getElementById(id);
const FIELDS = { q: 'q', sort: 'sort', dir: 'dir', band: 'band', cat: 'cat', tag: 'tag', kind: 'kind', minStars: 'minStars', lang: 'lang' };
const storedView = loadJson(VIEW_KEY, null);
let data, curated, view = initialView(location.hash, storedView);
/** Saving needs working storage; without it the Save controls are hidden. */
const canSave = (() => { try { localStorage.setItem('sti:probe', '1'); localStorage.removeItem('sti:probe'); return true; } catch { return false; } })();
const loadSaved = () => toSavedSet(loadJson(SAVED_KEY, []));

/** Remembers the view for the next bare-URL visit; family is never restored, so it is not stored. */
const persist = () => saveJson(VIEW_KEY, viewToHash({ ...view, family: '' }));

/** Element helper: text is always set via textContent. */
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

/** Link only for https:// targets; otherwise plain text. */
function link(text, url) {
  const safe = httpsUrl(url);
  if (!safe) return el('span', text);
  const a = el('a', text);
  a.href = safe; a.rel = 'noopener noreferrer';
  return a;
}

function card(repo, e, variants, saved) {
  const li = el('li', null, 'card');
  const img = el('img');
  img.src = `https://github.com/${repo.split('/')[0]}.png?size=96`;
  img.width = img.height = 48; img.loading = 'lazy'; img.alt = '';
  li.append(img);
  const body = el('div');
  body.append(el('h2', e.name));
  const b = band(e);
  const meta = el('div', null, 'meta');
  meta.append(el('span', `by ${e.author ?? repo.split('/')[0]}`), el('span', `★ ${e.stars}`), el('span', `${e.forks} forks`),
    el('span', `${e.issues} open issues`), el('span', `last commit ${e.lastCommit ? e.lastCommit.slice(0, 10) : 'unknown'}`));
  const badges = el('div', null, 'meta');
  badges.append(el('span', b, `badge ${b}`));
  if (e.inCatalog) badges.append(el('span', 'official catalog', 'badge catalog'));
  if (e.gone) badges.append(el('span', 'gone', 'badge gone'));
  body.append(badges, el('p', e.description), meta);
  const links = el('div', null, 'links');
  links.append(link('Repository', `https://github.com/${repo}`));
  if (e.homepage) links.append(link('Homepage', e.homepage));
  if (e.langs?.length) meta.append(el('span', e.langs.join(', ')));
  if (e.forkOf) {
    const parent = el('span', 'fork of ');
    parent.append(data.extensions[e.forkOf] ? familyButton(e.forkOf, e.forkOf) : link(e.forkOf, `https://github.com/${e.forkOf}`));
    links.append(parent);
  }
  if (variants) links.append(familyButton(`${variants} variant${variants > 1 ? 's' : ''}`, repo));
  if (canSave) {
    const star = el('button', saved ? '★ Saved' : '☆ Save', 'save');
    star.type = 'button'; star.dataset.repo = repo; star.setAttribute('aria-pressed', saved);
    star.setAttribute('aria-label', `Save ${e.name}`); // constant name; aria-pressed carries the state
    star.addEventListener('click', () => toggleSaved(repo));
    links.append(star);
  }
  body.append(links);
  li.append(body);
  return li;
}

function familyButton(text, repo) {
  const a = el('a', text);
  a.href = '#family=' + encodeURIComponent(repo);
  return a;
}

/** Re-reads storage first so saves made in another tab are not overwritten. */
function toggleSaved(repo) {
  const s = loadSaved();
  if (s.has(repo)) s.delete(repo); else s.add(repo);
  saveJson(SAVED_KEY, [...s]);
  render();
  [...$('list').querySelectorAll('.save')].find((b) => b.dataset.repo === repo)?.focus(); // render rebuilt the list
}

function render() {
  const now = new Date();
  const saved = loadSaved();
  const rows = select(Object.entries(data.extensions), curated, view, now, saved);
  const variants = {};
  for (const e of Object.values(data.extensions)) if (e.forkOf && !e.gone) variants[e.forkOf] = (variants[e.forkOf] ?? 0) + 1;
  $('list').replaceChildren(...rows.map(([r, e]) => card(r, e, variants[r], saved.has(r))));
  $('count').textContent = `${rows.length} of ${Object.keys(data.extensions).length} extensions`;
  $('empty').hidden = rows.length > 0;
  $('family').hidden = !view.family;
  if (view.family) {
    $('family').replaceChildren(document.createTextNode(`Showing ${view.family} and its forks. `), el('a', 'Show all'));
    $('family').lastChild.href = '#' + viewToHash({ ...view, family: '' });
  }
  for (const [k, id] of Object.entries(FIELDS)) $(id).value = view[k];
  $('gone').checked = view.gone;
  $('saved').checked = view.saved;
  const n = [...saved].filter((r) => data.extensions[r] && (view.gone || !data.extensions[r].gone)).length;
  $('savedLabel').textContent = ` Saved only (${n})`;
}

function fillOptions(id, values) {
  for (const v of [...values].sort()) { const o = el('option', v); o.value = v; $(id).append(o); }
}

function setView(patch) { view = { ...view, ...patch }; persist(); history.replaceState(null, '', '#' + viewToHash(view)); render(); }

async function load() {
  try {
    const [d, c] = await Promise.all(['data/extensions.json', 'data/curated.json'].map(async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
      return r.json();
    }));
    data = d; curated = c;
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = `Could not load the extension data (${err.message}). Please try again later.`;
    $('controls').hidden = true;
    return;
  }
  $('updated').textContent = data.updated ? `Data last updated ${data.updated.slice(0, 10)}` : 'Data not yet updated';
  fillOptions('tag', new Set(Object.values(curated.tags ?? {}).flat()));
  fillOptions('lang', new Set(['unknown', ...Object.values(data.extensions).flatMap((e) => e.langs ?? [])]));
  fillOptions('kind', new Set(['extension', 'theme', 'unspecified', ...Object.values(curated.kind ?? {}), ...Object.values(data.extensions).map((e) => e.kind).filter(Boolean)]));
  for (const k of ['tag', 'lang', 'kind']) if (view[k] && ![...$(k).options].some((o) => o.value === view[k])) view[k] = ''; // stale option: reset to All
  $('saved').parentElement.hidden = !canSave;
  history.replaceState(null, '', '#' + viewToHash(view)); // mirror a restored or cleaned view into the URL
  persist();
  for (const [k, id] of Object.entries(FIELDS)) $(id).addEventListener(id === 'q' ? 'input' : 'change', (ev) => setView({ [k]: ev.target.value }));
  $('gone').addEventListener('change', (ev) => setView({ gone: ev.target.checked }));
  $('saved').addEventListener('change', (ev) => setView({ saved: ev.target.checked }));
  for (const id of ['clear', 'clear2']) $(id).addEventListener('click', () => setView({ ...DEFAULT_VIEW }));
  addEventListener('hashchange', () => { view = viewFromHash(location.hash); persist(); render(); });
  render();
}

load();
