// Everything the UI reports about a repository is derived here, from the city
// JSON the engine produced — per-file ownership and history, package and
// language breakdowns, eras of growth, hotspots. Nothing on screen is typed
// in by hand, so every number is true for whatever repo was loaded.

import { locAt } from './city.js';

const DAY = 86400;
const cache = new WeakMap();

/** Memoise a derivation per city object; they're pure and some are O(history). */
function memo(data, key, fn) {
  let m = cache.get(data);
  if (!m) cache.set(data, (m = {}));
  if (!(key in m)) m[key] = fn();
  return m[key];
}

export const last = (data) => Math.max(0, data.commits.length - 1);
export const headTs = (data) => (data.commits.at(-1)?.ts || 0);

/** Is this building standing at timeline step `t`? */
export const aliveAt = (b, t) => locAt(b.history, t).loc > 0;

// ---------- Formatting -------------------------------------------------------

export const fmt = (n) => Number(n || 0).toLocaleString();

/** 1,144,280 → "1.1M", 48213 → "48.2k". */
export function compact(n) {
  const v = Math.abs(n);
  if (v >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return fmt(n);
}

export function date(ts, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return isNaN(d) ? '—' : d.toLocaleDateString(undefined, opts);
}

export const year = (ts) => (ts ? new Date(ts * 1000).getFullYear() : '—');

/** Relative time from now (or from `from`), in the largest sensible unit. */
export function ago(ts, from = Date.now() / 1000) {
  if (!ts) return '—';
  const s = from - ts;
  const units = [[365 * DAY, 'year'], [30 * DAY, 'month'], [7 * DAY, 'week'], [DAY, 'day'], [3600, 'hour']];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

// ---------- Timeline series --------------------------------------------------

/**
 * Total lines and standing buildings at every timeline step. Built from each
 * file's change points as a delta array plus one prefix sum, so it's linear in
 * history size rather than files × commits.
 */
export function series(data) {
  return memo(data, 'series', () => {
    const F = data.commits.length;
    const dLoc = new Float64Array(F);
    const dFiles = new Int32Array(F);
    for (const b of data.buildings) {
      let prev = 0, wasAlive = false;
      for (const h of b.history) {
        if (h.c < 0 || h.c >= F) continue;
        dLoc[h.c] += h.loc - prev;
        const alive = h.loc > 0;
        if (alive !== wasAlive) dFiles[h.c] += alive ? 1 : -1;
        prev = h.loc;
        wasAlive = alive;
      }
    }
    const loc = new Float64Array(F);
    const files = new Int32Array(F);
    let a = 0, f = 0;
    for (let i = 0; i < F; i++) { a += dLoc[i]; f += dFiles[i]; loc[i] = a; files[i] = f; }
    return { loc, files, dLoc, dFiles };
  });
}

// ---------- Contributors -----------------------------------------------------

export function contributors(data) {
  return memo(data, 'contributors', () => {
    const counts = new Map();
    for (const c of data.commits) counts.set(c.author, (counts.get(c.author) || 0) + 1);
    return [...counts.entries()]
      .map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => b.commits - a.commits);
  });
}

// ---------- Per-file profile -------------------------------------------------

function sizeRanks(data) {
  return memo(data, 'sizeRanks', () => data.buildings.map((b) => b.maxLoc).sort((a, b) => a - b));
}

/**
 * Everything the inspector shows about one file at timeline step `t`. The
 * "what happened to this file" sentence is assembled from its real history —
 * who created it, who maintains it, how it grew — rather than guessed at.
 */
export function fileProfile(data, b, t) {
  const loc = locAt(b.history, t).loc;  // lines of code at this point in history

  // Find the file's initial size when it first had lines of code
  const initialLoc = b.history.find((h) => h.loc > 0)?.loc || 0; // initial lines of code when the file was created

  // Calculate growth percentage safely
  const growthPct = initialLoc > 0
    ? ((loc - initialLoc) / initialLoc) * 100 // Calculate growth percentage safely 
    : null;

  const ranks = sizeRanks(data);  // all files' peak sizes, sorted ascending

  // Upper-bound search: how many files are no bigger than this one at peak?
  let lo = 0, hi = ranks.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ranks[m] <= b.maxLoc) lo = m + 1; else hi = m; }
  const topPct = Math.max(1, Math.ceil((1 - lo / ranks.length) * 100) || 1);

  // Size at evenly spaced points across the whole history.
  const BARS = 16, L = last(data);
  const spark = Array.from({ length: BARS }, (_, i) => {
    const at = Math.round((i / (BARS - 1)) * L);
    return { v: b.maxLoc ? locAt(b.history, at).loc / b.maxLoc : 0, past: at <= t };
  });

  const hasOwnership = b.touches != null && b.topAuthor;
  const recent = b.lastTouchedAt && headTs(data) - b.lastTouchedAt < 60 * DAY;

  const parts = [];
  if (b.creator) parts.push(`Created by ${b.creator} on ${date(b.createdAt)}.`);
  if (hasOwnership) {
    const share = Math.round((b.topAuthorShare || 0) * 100);
    const others = (b.contributors || 1) - 1;
    parts.push(b.contributors <= 1
      ? `${b.topAuthor} is the only person who has changed it, across ${fmt(b.touches)} commit${b.touches === 1 ? '' : 's'}.`
      : `${b.topAuthor} made ${share}% of its ${fmt(b.touches)} changes, alongside ${others} other contributor${others === 1 ? '' : 's'}.`);
  }
  if (loc === 0) parts.push('It has been deleted at this point in the history.');
  else if (b.maxLoc > loc) parts.push(`It peaked at ${fmt(b.maxLoc)} lines and is ${fmt(loc)} now.`);
  else parts.push(`At ${fmt(loc)} lines, this is the largest it has ever been.`);

  return {
    loc,
    topPct,
    spark,
    story: parts.join(' '),
    maintainer: hasOwnership ? b.topAuthor : null,
    touches: b.touches,
    contributors: b.contributors,
    lastTouched: b.lastTouchedAt ? ago(b.lastTouchedAt) : null,
    recent,
  };
}

// ---------- Packages ---------------------------------------------------------

/**
 * The repo's top-level areas, sized at HEAD. Monorepo roots like `packages/`
 * or `src/` that hold most of the code are opened up one level, so the cards
 * describe `packages/react-dom`, not just `packages`.
 */
export function packages(data, max = 8) {
  return memo(data, 'packages', () => {
    const L = last(data);
    const live = data.buildings
      .map((b) => ({ b, loc: locAt(b.history, L).loc }))
      .filter((x) => x.loc > 0);
    const totalLoc = live.reduce((s, x) => s + x.loc, 0) || 1;

    const groupBy = (items, depth) => {
      const m = new Map();
      for (const x of items) {
        const segs = x.b.path.split('/');
        const key = segs.length > depth ? segs.slice(0, depth).join('/') : '(root files)';
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(x);
      }
      return m;
    };

    let groups = groupBy(live, 1);
    for (const [key, items] of groups) {
      const share = items.reduce((s, x) => s + x.loc, 0) / totalLoc;
      const children = new Set(items.map((x) => x.b.path.split('/')[1]).filter(Boolean));
      if (key !== '(root files)' && share > 0.6 && children.size >= 2) {
        groups.delete(key);
        for (const [k, v] of groupBy(items, 2)) groups.set(k, (groups.get(k) || []).concat(v));
      }
    }

    const cards = [...groups.entries()].map(([name, items]) => {
      const loc = items.reduce((s, x) => s + x.loc, 0);
      const langs = new Map();
      const owners = new Map();
      for (const x of items) {
        langs.set(x.b.lang, (langs.get(x.b.lang) || 0) + x.loc);
        if (x.b.topAuthor) owners.set(x.b.topAuthor, (owners.get(x.b.topAuthor) || 0) + (x.b.touches || 1));
      }
      const lang = [...langs.entries()].sort((a, b) => b[1] - a[1])[0];
      const owner = [...owners.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        name,
        loc,
        files: items.length,
        share: loc / totalLoc,
        lang: lang ? lang[0] : '—',
        color: lang ? items.find((x) => x.b.lang === lang[0]).b.color : '#71717a',
        owner: owner ? owner[0] : null,
        modules: items.sort((a, b) => b.loc - a.loc).slice(0, 3).map((x) => ({
          name: x.b.path.split('/').pop(), path: x.b.path,
        })),
      };
    }).sort((a, b) => b.loc - a.loc);

    return cards.slice(0, max);
  });
}

// ---------- Languages --------------------------------------------------------

export function languages(data) {
  return memo(data, 'languages', () => {
    const L = last(data);
    const m = new Map();
    for (const b of data.buildings) {
      const loc = locAt(b.history, L).loc;
      if (loc <= 0) continue;
      const cur = m.get(b.lang) || { lang: b.lang, color: b.color, loc: 0, files: 0 };
      cur.loc += loc;
      cur.files += 1;
      m.set(b.lang, cur);
    }
    const total = [...m.values()].reduce((s, x) => s + x.loc, 0) || 1;
    return [...m.values()]
      .map((x) => ({ ...x, share: x.loc / total }))
      .sort((a, b) => b.loc - a.loc);
  });
}

/** Languages ranked by how many buildings they own across the whole history. */
export function languagesByCount(data) {
  return memo(data, 'languagesByCount', () => {
    const m = new Map();
    for (const b of data.buildings) {
      const cur = m.get(b.lang) || { lang: b.lang, color: b.color, files: 0 };
      cur.files++;
      m.set(b.lang, cur);
    }
    return [...m.values()].sort((a, b) => b.files - a.files);
  });
}

// ---------- File tree --------------------------------------------------------

/** Folder tree of files standing at HEAD, folders ordered by size. */
export function tree(data) {
  return memo(data, 'tree', () => {
    const L = last(data);
    const root = { name: data.repo, path: '', folders: new Map(), files: [], loc: 0, count: 0 };
    for (const b of data.buildings) {
      const loc = locAt(b.history, L).loc;
      if (loc <= 0) continue;
      const segs = b.path.split('/');
      let node = root;
      node.loc += loc; node.count++;
      for (let i = 0; i < segs.length - 1; i++) {
        const path = segs.slice(0, i + 1).join('/');
        if (!node.folders.has(segs[i])) {
          node.folders.set(segs[i], { name: segs[i], path, folders: new Map(), files: [], loc: 0, count: 0 });
        }
        node = node.folders.get(segs[i]);
        node.loc += loc; node.count++;
      }
      node.files.push({ b, loc, name: segs.at(-1) });
    }
    return root;
  });
}

// ---------- Eras (milestones) ------------------------------------------------

/**
 * The history split into eras of equal commit count, each described by what
 * actually happened in it: how much the city grew, who drove it, and the
 * subject of its single largest commit.
 */
export function eras(data, n = 4) {
  return memo(data, 'eras' + n, () => {
    const F = data.commits.length;
    if (!F) return [];
    const { loc, files, dLoc } = series(data);
    const k = Math.min(n, F);
    const out = [];
    for (let i = 0; i < k; i++) {
      const from = Math.floor((i * F) / k);
      const to = Math.floor(((i + 1) * F) / k) - 1;
      if (to < from) continue;

      let big = from;
      const authors = new Map();
      for (let c = from; c <= to; c++) {
        if (dLoc[c] > dLoc[big]) big = c;
        const a = data.commits[c].author;
        authors.set(a, (authors.get(a) || 0) + 1);
      }
      const lead = [...authors.entries()].sort((a, b) => b[1] - a[1])[0];
      const before = from > 0 ? loc[from - 1] : 0;
      const filesBefore = from > 0 ? files[from - 1] : 0;
      const c = data.commits[big];

      out.push({
        index: i,
        from, to,
        start: data.commits[from].ts,
        end: data.commits[to].ts,
        title: c.subject || `Largest change by ${c.author}`,
        headline: big,
        lead: lead ? lead[0] : null,
        commits: to - from + 1,
        files: files[to],
        dFiles: files[to] - filesBefore,
        dLoc: loc[to] - before,
      });
    }
    return out;
  });
}

// ---------- Health -----------------------------------------------------------

/**
 * Signals worth acting on, all from history: where change concentrates, what
 * only one person understands, what nobody has touched in a year, and how
 * much of the city has been demolished along the way.
 */
export function health(data) {
  return memo(data, 'health', () => {
    const L = last(data);
    const H = headTs(data);
    const live = [];
    let demolished = 0;
    for (const b of data.buildings) {
      const loc = locAt(b.history, L).loc;
      if (loc > 0) live.push({ b, loc }); else demolished++;
    }
    const hasOwnership = live.some((x) => x.b.touches != null);

    const top = (arr, key, n = 8) => [...arr].sort((a, b) => key(b) - key(a)).slice(0, n);

    const solo = hasOwnership ? live.filter((x) => x.b.contributors === 1 && (x.b.touches || 0) >= 3) : [];
    const stale = hasOwnership ? live.filter((x) => x.b.lastTouchedAt && H - x.b.lastTouchedAt > 365 * DAY) : [];

    return {
      live: live.length,
      demolished,
      hasOwnership,
      churn: hasOwnership ? top(live, (x) => x.b.touches || 0) : [],
      largest: top(live, (x) => x.loc),
      soloOwned: top(solo, (x) => x.loc),
      soloCount: solo.length,
      stale: top(stale, (x) => H - x.b.lastTouchedAt),
      staleCount: stale.length,
    };
  });
}

// ---------- Guided tour ------------------------------------------------------

/** Three buildings worth visiting in any repo, each for a reason that's true. */
export function tourStops(data) {
  const L = last(data);
  const live = data.buildings.filter((b) => aliveAt(b, L));
  if (!live.length) return [];
  const by = (key) => [...live].sort((a, b) => key(b) - key(a))[0];

  const tallest = by((b) => locAt(b.history, L).loc);
  const busiest = live.some((b) => b.touches != null) ? by((b) => b.touches || 0) : null;
  const oldest = live.some((b) => b.createdAt) ? by((b) => -(b.createdAt || Infinity)) : null;

  const stops = [{
    b: tallest,
    title: 'The tallest tower',
    text: `${tallest.path.split('/').pop()} is the largest file standing today, at ${fmt(locAt(tallest.history, L).loc)} lines.`,
  }];
  if (busiest && busiest !== tallest) stops.push({
    b: busiest,
    title: 'The busiest building',
    text: `${busiest.path.split('/').pop()} has been changed in ${fmt(busiest.touches)} commits — more than any other file.`,
  });
  if (oldest && !stops.some((s) => s.b === oldest)) stops.push({
    b: oldest,
    title: 'The oldest foundation',
    text: `${oldest.path.split('/').pop()} was laid down on ${date(oldest.createdAt)} and is still standing.`,
  });
  return stops;
}
