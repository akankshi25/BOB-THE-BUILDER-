// App shell: one 3D scene, one timeline, four views. The City View is the
// renderer itself; the other three are pages built from the same city data,
// and all of them share the playhead.

import { Scene } from './scene.js';
import { City } from './city.js';
import { Timeline } from './timeline.js';
import {
  toast, hideToast, tooltip, renderStatus, renderLangs, showInspector, hideInspector, initSearch,
} from './ui.js';
import { tourStops } from './insights.js';
import { analyzeRepo, loadStaticCity } from './api.js';
import { renderFiles } from './views/files.js';
import { renderHistory } from './views/history.js';
import { renderHealth } from './views/health.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['city', 'files', 'history', 'health'];

const scene = new Scene($('app'));

let data = null;
let city = null;
let timeline = null;
let selected = null;   // building record shown in the inspector
let history = null;    // { update, dispose } while the history page is built
const built = new Set(); // page views rendered for the current data

// ---------- Views ------------------------------------------------------------

function currentView() {
  const v = location.hash.slice(1);
  return VIEWS.includes(v) ? v : 'city';
}

function showView(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.view === view);
  // Keep the city's clock running off-screen, but don't draw it.
  scene.paused = view !== 'city';
  tooltip(null);
  if (data) buildView(view);
}

function buildView(view) {
  if (view === 'city' || built.has(view)) return;
  built.add(view);
  const root = $(`view-${view}`);
  const ctx = { data, timeline, showInCity };
  if (view === 'files') renderFiles(root, ctx);
  if (view === 'health') renderHealth(root, ctx);
  if (view === 'history') history = renderHistory(root, ctx);
}

window.addEventListener('hashchange', () => showView(currentView()));

/** Switch to the City View, optionally selecting and flying to a building. */
function showInCity(b) {
  if (currentView() !== 'city') location.hash = 'city';
  if (b) requestAnimationFrame(() => select(b, true));
}

// ---------- Selection --------------------------------------------------------

function select(b, fly = false) {
  if (!city) return;
  selected = b ? city.select(b) && b : null;
  if (!selected) { city.select(null); hideInspector(false); return; }
  showInspector(data, selected, timeline.commit, { onFocus: (x) => focus(x) });
  if (fly) focus(selected);
}

function focus(b) {
  // A building that hasn't been built yet at the playhead: move the playhead
  // to the moment it's at its biggest, so there's something to look at.
  if (city.locOf(b) <= 0) {
    const peak = b.history.reduce((a, h) => (h.loc > a.loc ? h : a), b.history[0]);
    if (peak && peak.c >= 0) timeline.seek(peak.c);
  }
  const a = city.anchorOf(b);
  if (!a) return;
  scene.flyTo({ x: a.x, y: a.y * 0.6, z: a.z }, Math.max(26, a.y * 2.4 + a.size * 3));
}

scene.onSelect = (b) => {
  if (b) select(b);
  else if (selected) { city.select(null); hideInspector(true); }
};

$('ins-close').addEventListener('click', () => { city && city.select(null); hideInspector(true); });
$('ins-reopen').addEventListener('click', () => { if (selected) select(selected); });

// ---------- Hover ------------------------------------------------------------

scene.onHover = (b, event) => tooltip(b, event, b && city ? city.locOf(b) : 0);
scene.onHoverIndex = (item) => { if (city) city.setHover(item); };

// ---------- Camera -----------------------------------------------------------

const DIR_DEFAULT = { x: 0.62, y: 0.78, z: 0.62 };

function camera(preset) {
  if (!city) return;
  const r = city.radius;
  for (const b of $('cam-presets').children) b.classList.toggle('active', b.dataset.cam === preset);
  if (preset === 'bird') scene.flyTo({ x: 0, y: 0, z: 0 }, Math.max(r * 2.3, 90), { x: 0.04, y: 1, z: 0.12 });
  else if (preset === 'wide') scene.flyTo({ x: 0, y: 0, z: 0 }, Math.max(r * 2.6, 110), { x: 0.75, y: 0.45, z: 0.75 });
  else if (preset === 'core') {
    const c = city.core();
    scene.flyTo({ x: c.x, y: 0, z: c.z }, Math.max(c.size * 1.25, 60), DIR_DEFAULT);
  } else {
    // Reset: the same framing as when the city first loads.
    scene.flyTo({ x: 0, y: 0, z: 0 }, Math.max(r * 1.75, 70) * 1.17, DIR_DEFAULT);
  }
}

$('cam-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cam]');
  if (b) camera(b.dataset.cam);
});
$('cam-reset').addEventListener('click', () => {
  for (const b of $('cam-presets').children) b.classList.remove('active');
  camera('reset');
});
$('zoom-in').addEventListener('click', () => scene.zoom(0.8));
$('zoom-out').addEventListener('click', () => scene.zoom(1.25));

// ---------- Keyboard ---------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' && timeline && currentView() !== 'files') { e.preventDefault(); timeline.toggle(); }
  else if (currentView() !== 'city') return;
  else if (e.key === '+' || e.key === '=') scene.zoom(0.8);
  else if (e.key === '-') scene.zoom(1.25);
  else if (e.key === 'Escape') {
    if (!$('tour-card').hidden) endTour();
    else if (selected) { city.select(null); hideInspector(true); }
  }
});

// ---------- Popovers ---------------------------------------------------------

function popover(btn, pop, onOpen) {
  const set = (open) => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && onOpen) onOpen();
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); set(pop.hidden); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  return set;
}

const setRepoOpen = popover($('repo-pill'), $('repo-form'), () => $('repo-input').focus());
popover($('settings-btn'), $('settings'));

$('opt-labels').addEventListener('change', (e) => {
  scene.labels.domElement.classList.toggle('off', !e.target.checked);
});
$('opt-heat').addEventListener('change', (e) => { if (city) city.setHeat(e.target.checked); });

// ---------- Build a repo -----------------------------------------------------

$('repo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const repo = $('repo-input').value.trim();
  if (!repo) return;
  const btn = $('repo-btn');
  btn.disabled = true;
  setRepoOpen(false);
  toast(`Cloning ${repo}…`);
  try {
    const next = await analyzeRepo(repo, (job) => job.message && toast(job.message));
    load(next);
    if (currentView() === 'city') timeline.play();
    toast(`Built ${next.repo} — ${next.buildings.length.toLocaleString()} buildings`, 'info', 3500);
    $('repo-input').value = '';
  } catch (err) {
    toast(err.message || 'Something went wrong', 'error', 7000);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Guided tour ------------------------------------------------------

let tour = null; // { stops, i }

function showStop() {
  const { stops, i } = tour;
  const s = stops[i];
  $('tour-step').textContent = `STOP ${i + 1} OF ${stops.length}`;
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-prev').disabled = i === 0;
  $('tour-next').textContent = i === stops.length - 1 ? 'Finish' : 'Next';
  select(s.b, true);
}

function endTour() {
  tour = null;
  $('tour-card').hidden = true;
  $('tour-btn').hidden = false;
}

$('tour-btn').addEventListener('click', () => {
  const stops = tourStops(data);
  if (!stops.length) return;
  // The tour is about the city as it stands today.
  timeline.seek(timeline.last);
  tour = { stops, i: 0 };
  $('tour-btn').hidden = true;
  $('tour-card').hidden = false;
  showStop();
});
$('tour-next').addEventListener('click', () => {
  if (tour.i >= tour.stops.length - 1) return endTour();
  tour.i++;
  showStop();
});
$('tour-prev').addEventListener('click', () => { if (tour.i > 0) { tour.i--; showStop(); } });
$('tour-close').addEventListener('click', endTour);
$('tour-exit').addEventListener('click', endTour);

// ---------- Load a city ------------------------------------------------------

function load(next) {
  if (history) history.dispose();
  history = null;
  built.clear();
  for (const v of VIEWS) if (v !== 'city') $(`view-${v}`).replaceChildren();
  if (timeline) timeline.dispose();
  if (city) city.dispose();
  endTour();
  selected = null;
  hideInspector(false);

  data = next;
  city = new City(scene, data);
  city.setHeat($('opt-heat').checked);
  timeline = new Timeline(city, scene, data);
  scene.frameCamera(city.radius);
  scene.setLabels(city.districtLabels());

  $('repo-name').textContent = data.repo || 'repository';
  $('branch-name').textContent = data.branch || 'HEAD';
  document.title = `${data.repo} — CodeCity`;
  const stops = tourStops(data).length;
  $('tour-count').textContent = `${stops} stop${stops === 1 ? '' : 's'}`;
  $('tour-btn').hidden = !stops;
  for (const b of $('cam-presets').children) b.classList.remove('active');

  renderLangs(data, (langs) => city.setLanguageFilter(langs));

  // Status pill, inspector and the history page all follow the playhead. The
  // inspector is rebuilt at most a few times a second while playing.
  let lastInspect = 0;
  timeline.onChange((idx, alive, playing) => {
    renderStatus(data, alive);
    if (history) history.update(idx, playing);
    const now = performance.now();
    if (selected && !$('inspector').hidden && (!playing || now - lastInspect > 250)) {
      lastInspect = now;
      showInspector(data, selected, idx, { onFocus: (x) => focus(x) });
    }
  });
  renderStatus(data, timeline.alive);

  window.__cc = { scene, city, timeline, data };
  showView(currentView());
}

initSearch(() => data, (b) => showInCity(b));
// App information for debugging
console.log("CodeCity initialized successfully 🚀");
console.log("Available views:", VIEWS);

// First load: the bundled demo city.
(async () => {
  showView(currentView());
  toast('Loading city…');
  try {
    load(await loadStaticCity());
    hideToast();
    // Start the city building itself, the way it's meant to be seen.
    if (currentView() === 'city') timeline.play();
  } catch {
    toast('Enter a repository in the top bar to build its city.', 'info', 6000);
    setRepoOpen(true);
  }
})();
