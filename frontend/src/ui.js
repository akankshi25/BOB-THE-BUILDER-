// City View chrome: hover tooltip, file inspector, status pill, language
// filter, file search and the toast. Plain DOM — every value comes from the
// loaded city via insights.js, and all repo-provided text goes in through
// textContent, never as markup.

import { fileProfile, languagesByCount, fmt, compact } from './insights.js';

const $ = (id) => document.getElementById(id);

/** Build an element: el('div', { class: 'x' }, 'text', child, …). */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

export const icon = (name, cls = '') => el('span', { class: `ms ${cls}`.trim() }, name);

/** Link to a file on its host, when the city came from a known one. */
export function fileUrl(data, path) {
  if (!data.webUrl) return null;
  const branch = encodeURIComponent(data.branch || 'HEAD');
  const p = path.split('/').map(encodeURIComponent).join('/');
  if (data.webUrl.includes('gitlab')) return `${data.webUrl}/-/blob/${branch}/${p}`;
  if (data.webUrl.includes('github.com')) return `${data.webUrl}/blob/${branch}/${p}`;
  return data.webUrl;
}

// ---------- Toast ------------------------------------------------------------

let toastTimer = null;
export function toast(msg, kind = 'loading', ms = 0) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.className = `toast${kind === 'error' ? ' error' : ''}`;
  t.replaceChildren(
    kind === 'loading' ? el('span', { class: 'spinner' }) : icon(kind === 'error' ? 'error' : 'info'),
    el('span', {}, msg),
  );
  t.hidden = false;
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
export function hideToast() { $('toast').hidden = true; }

// ---------- Tooltip ----------------------------------------------------------

export function tooltip(building, event, loc) {
  const t = $('tooltip');
  if (!building || !event) { t.hidden = true; return; }
  $('tip-dot').style.background = building.color;
  $('tip-name').textContent = building.path.split('/').pop();
  $('tip-loc').textContent = `${fmt(loc)} lines`;
  $('tip-author').textContent = building.topAuthor || building.lang;
  t.hidden = false;
  // Sit above the cursor; flip below it near the top of the screen.
  const w = t.offsetWidth, h = t.offsetHeight, pad = 14;
  let x = Math.min(Math.max(event.clientX - w / 2, 8), window.innerWidth - w - 8);
  let y = event.clientY - h - pad;
  if (y < 72) y = event.clientY + pad + 6;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

// ---------- Status pill ------------------------------------------------------

export function renderStatus(data, alive) {
  // A district is a top-level folder; files sitting in the repo root aren't one.
  const districts = new Set(
    data.buildings.filter((b) => b.path.includes('/')).map((b) => b.path.split('/')[0])
  ).size;
  $('city-status').textContent =
    `${fmt(alive)} files in ${fmt(districts)} district${districts === 1 ? '' : 's'}`;
}

// ---------- Language filter --------------------------------------------------

/**
 * "All" plus the languages with the most buildings. Choosing one greys out
 * every other language without removing it, so the city keeps its shape.
 */
export function renderLangs(data, onChange) {
  const box = $('langs');
  const top = languagesByCount(data).slice(0, 5);
  let current = null;
  const buttons = [];

  const pick = (lang) => {
    current = current === lang ? null : lang;
    for (const b of buttons) b.classList.toggle('active', (b.dataset.lang || null) === current);
    onChange(current ? new Set([current]) : null);
  };

  const all = el('button', { class: 'active', onclick: () => pick(null) }, 'All');
  buttons.push(all);
  for (const l of top) {
    const b = el('button', { dataset: { lang: l.lang }, title: `${fmt(l.files)} files`, onclick: () => pick(l.lang) },
      el('i', { style: { background: l.color } }), l.lang);
    buttons.push(b);
  }
  box.replaceChildren(...buttons);
}

// ---------- Inspector --------------------------------------------------------

export function showInspector(data, b, t, { onFocus } = {}) {
  const p = fileProfile(data, b, t);
  const name = b.path.split('/').pop();

  $('ins-kind').textContent = `Selected file · ${b.lang}`;
  $('ins-title').textContent = name;
  $('ins-title').title = name;
  $('ins-path').textContent = b.path;
  $('ins-loc').textContent = p.loc ? `${fmt(p.loc)} lines` : 'Demolished';
  $('ins-rank').textContent = `Top ${p.topPct}% by peak size`;
  $('ins-owner').textContent = p.maintainer || 'Unknown';
  const last = $('ins-last');
  last.textContent = p.lastTouched ? `last changed ${p.lastTouched}` : 'no ownership data';
  last.classList.toggle('good', !!p.recent);
  $('ins-story').textContent = p.story;
  $('ins-commits').textContent =
    p.touches != null ? `${fmt(p.touches)} commit${p.touches === 1 ? '' : 's'}` : `peak ${compact(b.maxLoc)}`;

  // Bars up to the playhead are "past"; the one it's on is "now".
  const nowBar = p.spark.reduce((acc, s, i) => (s.past ? i : acc), 0);
  $('ins-spark').replaceChildren(...p.spark.map((s, i) => el('span', {
    class: i === nowBar ? 'now' : s.past ? 'past' : '',
    style: { height: `${Math.max(6, s.v * 100)}%` },
  })));

  const gh = $('ins-github');
  const url = fileUrl(data, b.path);
  gh.hidden = !url;
  if (url) gh.href = url;

  $('ins-focus').onclick = () => onFocus && onFocus(b);
  $('inspector').hidden = false;
  $('ins-reopen').hidden = true;
}

export function hideInspector(canReopen) {
  $('inspector').hidden = true;
  $('ins-reopen').hidden = !canReopen;
}

// ---------- Search -----------------------------------------------------------

/**
 * File search in the top bar. Matches on file name first, then anywhere in
 * the path, and hands the chosen building back to the caller.
 */
export function initSearch(getData, onPick) {
  const input = $('search-input');
  const list = $('search-results');
  let hits = [];
  let cursor = 0;

  const close = () => { list.hidden = true; };
  const choose = (b) => { close(); input.value = ''; input.blur(); onPick(b); };

  const render = () => {
    if (!hits.length) {
      list.replaceChildren(el('div', { class: 'empty' }, 'No files match.'));
    } else {
      list.replaceChildren(...hits.map((b, i) => el('button', {
        class: i === cursor ? 'on' : '',
        onmousedown: (e) => { e.preventDefault(); choose(b); },
      }, el('i', { style: { background: b.color } }),
         el('span', { class: 'r-name' }, b.path.split('/').pop()),
         el('span', { class: 'r-path' }, b.path))));
    }
    list.hidden = false;
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const data = getData();
    if (!q || !data) { hits = []; close(); return; }
    const score = (b) => {
      const name = b.path.split('/').pop().toLowerCase();
      if (name.startsWith(q)) return 0;
      if (name.includes(q)) return 1;
      if (b.path.toLowerCase().includes(q)) return 2;
      return 9;
    };
    hits = data.buildings
      .map((b) => [score(b), b])
      .filter(([s]) => s < 9)
      .sort((a, b) => a[0] - b[0] || b[1].maxLoc - a[1].maxLoc)
      .slice(0, 12)
      .map(([, b]) => b);
    cursor = 0;
    render();
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, hits.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[cursor]) { choose(hits[cursor]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  // "/" focuses search from anywhere that isn't already a text field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.target.matches('input, textarea')) return;
    e.preventDefault();
    input.focus();
  });
}


// ---------- Clear Search Button ----------------------------------------------
// What it does:
// 1. Shows a clear (×) button when the user types in the search box.
// 2. Clears the search text when the button is clicked.
// 3. Closes the search results list.
// 4. Resets the search results and focuses the input again.
// 5. Keeps the existing search functionality unchanged.

export function initSearch(getData, onPick) {
  const input = $('search-input');
  const list = $('search-results');
  let hits = [];
  let cursor = 0;

  // Create the clear search button
  const clearBtn = el('button', {
    type: 'button',
    class: 'search-clear',
    title: 'Clear search',
    'aria-label': 'Clear search',
    hidden: true,

    onclick: () => {
      input.value = '';
      hits = [];
      close();
      clearBtn.hidden = true;
      input.focus();
    },
  }, '×');

  // Place the button immediately after the search input
  input.insertAdjacentElement('afterend', clearBtn);

  const close = () => {
    list.hidden = true;
  };

  const choose = (b) => {
    close();
    input.value = '';
    clearBtn.hidden = true;
    input.blur();
    onPick(b);
  };

  const render = () => {
    if (!hits.length) {
      list.replaceChildren(
        el('div', { class: 'empty' }, 'No files match.')
      );
    } else {
      list.replaceChildren(
        ...hits.map((b, i) =>
          el('button', {
            class: i === cursor ? 'on' : '',
            onmousedown: (e) => {
              e.preventDefault();
              choose(b);
            },
          },
            el('i', {
              style: { background: b.color },
            }),
            el('span', { class: 'r-name' },
              b.path.split('/').pop()
            ),
            el('span', { class: 'r-path' }, b.path)
          )
        )
      );
    }

    list.hidden = false;
  };

  // Search files and show/hide the clear button
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();

    // Show the clear button only when text is entered
    clearBtn.hidden = !q;

    const data = getData();

    if (!q || !data) {
      hits = [];
      close();
      return;
    }

    const score = (b) => {
      const name = b.path.split('/').pop().toLowerCase();

      if (name.startsWith(q)) return 0;
      if (name.includes(q)) return 1;
      if (b.path.toLowerCase().includes(q)) return 2;

      return 9;
    };

    hits = data.buildings
      .map((b) => [score(b), b])
      .filter(([s]) => s < 9)
      .sort((a, b) =>
        a[0] - b[0] || b[1].maxLoc - a[1].maxLoc
      )
      .slice(0, 12)
      .map(([, b]) => b);

    cursor = 0;
    render();
  });

  // Keyboard navigation for search results
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;

    if (e.key === 'ArrowDown') {
      cursor = Math.min(cursor + 1, hits.length - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      cursor = Math.max(cursor - 1, 0);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter' && hits[cursor]) {
      choose(hits[cursor]);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  // Press "/" to focus search from anywhere except text fields
  document.addEventListener('keydown', (e) => {
    if (
      e.key !== '/' ||
      e.target.matches('input, textarea')
    ) return;

    e.preventDefault();
    input.focus();
  });
}