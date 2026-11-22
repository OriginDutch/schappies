// App: login, huishouden, lijsten per winkel, items, undo.
import {
  auth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from './firebase.js';
import {
  SHARED,
  SCHEMA_VERSION,
  UNDOABLE,
  productIdFor,
  getUserProfile,
  createHousehold,
  watchHousehold,
  watchLists,
  watchSections,
  watchStores,
  watchItems,
  watchProducts,
  watchActivity,
  addStore,
  updateStore,
  setStoreOrder,
  addItem,
  setItemChecked,
  updateItem,
  deleteItem,
  undoAction,
  applyChanges,
  addSection,
  addChain,
  setSectionOrder,
  watchChains,
  migrateToChains,
  importLayout,
  DEFAULT_SECTIONS,
} from './data.js';
import {
  UNITS,
  parseQuickAdd,
  productKey,
  guessSectionKey,
  guessParentKey,
  formatQty,
  capitalize,
  parseLayoutText,
  nameSimilarity,
} from './parse.js';
import { initTheme, getThemePref, setThemePref } from './theme.js';

const APP_VERSION = self.APP_VERSION || 'dev';
const $app = document.getElementById('app');

const state = {
  user: null,
  hid: null,
  household: null,
  lists: [],
  sections: [],
  stores: [],
  items: [],
  products: new Map(),
  activity: [],
  activityReady: false,
  loaded: new Set(),
  view: 'lijst',
  activeListId: null,
  activeStoreByList: {},
  cartOpen: false,
  renamingStoreId: null,
  layoutStoreId: null,
  layoutNewSection: null,
  importDraft: null,
  optSub: null,
  allSections: [],
  chains: [],
  chainView: null,
  migrating: false,
  sheet: null,
  mounted: false,
  unsubs: [],
};

// ---------- helpers ----------

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="M4 12.5 9.5 18 20 6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
};
const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function stopWatching() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
}

function friendlyError(err) {
  const code = err?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
  if (code === 'auth/popup-blocked') return 'De pop-up werd geblokkeerd. Sta pop-ups toe voor deze site en probeer opnieuw.';
  if (code === 'auth/unauthorized-domain')
    return `Dit domein (${location.hostname}) mag nog niet inloggen. Voeg het toe in Firebase → Authentication → Settings → Authorized domains.`;
  if (code === 'auth/network-request-failed' || code === 'unavailable') return 'Geen verbinding. Check je internet en probeer opnieuw.';
  if (code === 'permission-denied') return 'Geen toegang. Zijn de nieuwste security rules gedeployed?';
  return `Er ging iets mis (${code || err?.message || 'onbekend'}).`;
}

const activeList = () => state.lists.find((l) => l.id === state.activeListId) || state.lists[0] || null;
const storeById = (id) => state.stores.find((s) => s.id === id) || null;
const STANDARD_KEYS = new Set(DEFAULT_SECTIONS.map((s) => s.key));
const isStandard = (s) => !!s && !s.custom && STANDARD_KEYS.has(s.key);
const isOverig = (s) => !!s && !s.custom && s.key === 'overig';
const sectionById = (id) => state.sections.find((s) => s.id === id) || null;
const sectionByKey = (key) => state.sections.find((s) => !s.custom && s.key === key) || null;
const fallbackSection = () => sectionByKey('overig') || state.sections[state.sections.length - 1] || null;

const chainById = (id) => state.chains.find((c) => c.id === id) || null;
const chainOf = (store) => chainById(store?.chainId);
const storesOfChain = (chainId) => state.stores.filter((s) => s.chainId === chainId);
const isChainSection = (s) => !!s?.custom && !!s.chainId;
const parentKeyOf = (s) => (s ? (s.custom ? s.parentKey || 'overig' : s.key) : null);

// Volgorde: standaardsecties op hun plek, eigen secties direct onder hun "valt onder".
function sectionSort(s) {
  const parent = s?.custom ? sectionByKey(s.parentKey) : s;
  return (parent?.order ?? 999) * 1000 + (s?.custom ? 1 + ((s.order ?? 0) % 1000) : 0);
}
const bySectionSort = (a, b) => sectionSort(a) - sectionSort(b) || a.name.localeCompare(b.name, 'nl');

// Alle secties van een winkel (vóór aan/uit): standaard, tenzij de keten er eigen
// secties onder heeft (die vervangen hem dan), plus algemene eigen secties en de ketensecties.
function sectionsForStoreAll(store) {
  const chainSecs = state.sections.filter((s) => isChainSection(s) && s.chainId === store?.chainId);
  const replaced = new Set(chainSecs.map((s) => s.parentKey).filter((k) => k && k !== 'overig'));
  const legacyOwn = state.sections.filter((s) => s.custom && !s.chainId && s.storeId && s.storeId === store?.id);
  const general = state.sections.filter((s) => !s.chainId && !s.storeId && !(isStandard(s) && replaced.has(s.key)));
  return [...general, ...chainSecs, ...legacyOwn].sort(bySectionSort);
}

// Wat de winkel nu heeft: zonder de secties die hier uit staan. Overig is er altijd.
function sectionsForStore(store) {
  const off = new Set(store?.disabledSectionIds || []);
  return sectionsForStoreAll(store).filter((s) => isOverig(s) || !off.has(s.id));
}
const sectionAvailable = (store, id) => !!id && sectionsForStore(store).some((s) => s.id === id);

// Een sectie die hier niet bestaat, tonen onder wat er hier voor die categorie is.
function displaySection(store, sid) {
  const sec = sectionById(sid);
  if (sec && sectionAvailable(store, sid)) return sec;
  const key = parentKeyOf(sec);
  const avail = sectionsForStore(store);
  return (key && (avail.find((s) => !s.custom && s.key === key) || avail.find((s) => s.custom && s.parentKey === key))) || fallbackSection();
}

// Waar ligt dit product in deze winkel? Eerst wat we voor deze keten weten,
// dan de algemene sectie, dan op categorie (standaard of de ketensectie eronder).
function resolveSection(product, store, name) {
  const avail = sectionsForStore(store);
  const ok = (id) => !!id && avail.some((s) => s.id === id);
  for (const c of [product?.sectionByChain?.[store?.chainId], product?.sectionByStore?.[store?.id], product?.sectionId]) {
    if (ok(c)) return c;
  }
  const key = parentKeyOf(sectionById(product?.sectionId)) || guessSectionKey(name || product?.name || '');
  const std = sectionByKey(key);
  if (std && ok(std.id)) return std.id;
  const sub = avail.find((s) => s.custom && s.parentKey === key);
  if (sub) return sub.id;
  return fallbackSection()?.id || null;
}

// Algemene sectie voor het geheugen: een keten-sectie telt als zijn "valt onder".
function generalSectionFor(sectionId, name) {
  const sec = sectionById(sectionId);
  if (sec && !sec.chainId && !sec.storeId) return sec.id;
  const key = sec ? parentKeyOf(sec) : guessSectionKey(name);
  return sectionByKey(key)?.id || sectionByKey(guessSectionKey(name))?.id || fallbackSection()?.id;
}

const nextSectionOrder = () => state.allSections.reduce((m, s) => Math.max(m, s.order ?? 0), -1) + 1;
const liveItems = () => state.items.filter((i) => !i.deleted && !i.archived);

// ---------- toast ----------

let toastTimer = null;
function toast(message, actionId = null) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  clearTimeout(toastTimer);
  root.innerHTML = `
    <div class="toast" role="status">
      <span class="toast-text">${esc(message)}</span>
      ${actionId ? `<button class="toast-btn" data-action="undo-one" data-id="${esc(actionId)}">Ongedaan maken</button>` : ''}
    </div>`;
  toastTimer = setTimeout(() => (root.innerHTML = ''), actionId ? 6000 : 3500);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err) || 'Er ging iets mis.');
    return null;
  }
}

// ---------- schermen buiten de app ----------

function renderBoot(text = 'Laden…') {
  state.mounted = false;
  $app.innerHTML = `<div class="center-screen"><p class="muted">${esc(text)}</p></div>`;
}

function renderLogin(message = '') {
  state.mounted = false;
  $app.innerHTML = `
    <div class="center-screen">
      <div class="auth-card">
        <h1 class="auth-title">Boodschappen</h1>
        <p class="muted">Log in om je lijsten te openen en te synchroniseren.</p>
        <button class="btn btn-primary btn-block" data-action="login">Inloggen met Google</button>
        ${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
      </div>
    </div>`;
}

function renderSetup(message = '') {
  state.mounted = false;
  const first = (state.user?.displayName || '').split(' ')[0];
  $app.innerHTML = `
    <div class="center-screen">
      <form class="auth-card" data-form="setup">
        <h1 class="auth-title">Welkom${first ? `, ${esc(first)}` : ''}</h1>
        <p class="muted">Maak je huishouden aan. Later kun je hier anderen voor uitnodigen.</p>
        <label class="field">
          <span class="field-label">Naam van het huishouden</span>
          <input class="input" name="name" required maxlength="60" autocomplete="off" value="Thuis">
        </label>
        <button class="btn btn-primary btn-block" type="submit">Huishouden aanmaken</button>
        <button class="btn btn-ghost btn-block" type="button" data-action="logout">Ander account gebruiken</button>
        ${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
      </form>
    </div>`;
  $app.querySelector('input[name="name"]').select();
}

function renderError(err) {
  state.mounted = false;
  const msg = friendlyError(err) || 'Er ging iets mis.';
  $app.innerHTML = `
    <div class="center-screen">
      <div class="auth-card">
        <h1 class="auth-title">Oeps</h1>
        <p class="error" role="alert">${esc(msg)}</p>
        <button class="btn btn-primary btn-block" data-action="reload">Opnieuw proberen</button>
        <button class="btn btn-ghost btn-block" data-action="logout">Uitloggen</button>
      </div>
    </div>`;
}

// ---------- de app-schil ----------

const NAV = [
  { id: 'lijst', label: 'Lijst' },
  { id: 'historie', label: 'Historie' },
  { id: 'winkels', label: 'Winkels' },
  { id: 'opties', label: 'Opties' },
];

function mountShell() {
  $app.innerHTML = `
    <div class="shell">
      <nav class="nav" id="nav" aria-label="Hoofdmenu"></nav>
      <main class="main" id="main">
        <div id="view" class="view"></div>
        <form class="addbar" id="addbar" data-form="quick-add" autocomplete="off" hidden>
          <label class="sr-only" for="add-input">Product toevoegen</label>
          <input id="add-input" class="input addbar-input" name="q" list="product-names"
            placeholder="Product toevoegen…" enterkeyhint="done" autocomplete="off" maxlength="80">
          <button class="btn btn-primary addbar-btn" type="submit" aria-label="Toevoegen">${icon('plus', 22)}</button>
          <datalist id="product-names"></datalist>
        </form>
      </main>
    </div>
    <div id="sheet-root"></div>
    <div id="toast-root" class="toast-root" aria-live="polite"></div>`;
  state.mounted = true;
}

// Alles pas tekenen als de basisdata binnen is, anders flikkert het.
const REQUIRED = ['household', 'lists', 'sections', 'stores', 'chains', 'items', 'products'];
const ready = () => REQUIRED.every((k) => state.loaded.has(k));

function needsMigration() {
  return (
    state.stores.some((s) => !s.chainId) ||
    state.allSections.some((s) => s.custom && (!s.parentKey || (s.storeId && !s.chainId)))
  );
}

function render() {
  if (!ready()) return;
  if (!state.migrating && needsMigration()) {
    state.migrating = true;
    run(() =>
      migrateToChains(state.hid, state.user, { stores: state.stores, sections: state.allSections, guessParent: guessParentKey }),
    ).then((n) => {
      if (n) toast('Secties omgezet naar ketens. Check "valt onder" bij Winkels → keten.');
    });
  }
  if (!state.mounted) mountShell();
  renderNav();
  renderView();
  renderAddbar();
}

function renderNav() {
  document.getElementById('nav').innerHTML = `
    <div class="nav-household">${esc(state.household?.name || '')}</div>
    ${NAV.map(
      (n) => `<button class="nav-item${state.view === n.id ? ' is-active' : ''}" data-nav="${n.id}"
        ${state.view === n.id ? 'aria-current="page"' : ''}>${n.label}</button>`,
    ).join('')}`;
}

function renderView() {
  const el = document.getElementById('view');
  if (state.view === 'lijst') el.innerHTML = viewLijst();
  else if (state.view === 'winkels') el.innerHTML = viewWinkels();
  else if (state.view === 'opties') el.innerHTML = state.optSub === 'secties' ? viewSecties() : viewOpties();
  else el.innerHTML = viewPlaceholder('Historie', 'Rondes en producten verschijnen hier zodra rondes afronden er is.');
  document.getElementById('main').classList.toggle('has-addbar', showAddbar());
}

function showAddbar() {
  return state.view === 'lijst' && state.stores.length > 0 && !!activeList();
}

function renderAddbar() {
  const bar = document.getElementById('addbar');
  bar.hidden = !showAddbar();
  const store = storeById(currentStoreId());
  document.getElementById('add-input').placeholder = store ? `Toevoegen aan ${store.name}…` : 'Product toevoegen…';
}

let datalistSig = '';
function renderDatalist() {
  const dl = document.getElementById('product-names');
  if (!dl) return;
  const list = activeList();
  const names = [...state.products.values()]
    .filter((p) => !list || p.ownerUid === SHARED || p.ownerUid === list.ownerUid)
    .map((p) => p.name)
    .filter(Boolean);
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b, 'nl'));
  const sig = unique.join('|');
  if (sig === datalistSig) return;
  datalistSig = sig;
  dl.innerHTML = unique.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

// ---------- lijst ----------

function listItems(list) {
  return liveItems().filter((i) => i.listId === list.id);
}

function storeCounts(items) {
  const counts = {};
  for (const i of items) {
    const c = (counts[i.storeId] ||= { open: 0, total: 0 });
    c.total += 1;
    if (!i.checked) c.open += 1;
  }
  return counts;
}

function currentStoreId() {
  const list = activeList();
  if (!list || !state.stores.length) return null;
  const chosen = state.activeStoreByList[list.id];
  if (chosen && storeById(chosen)) return chosen;
  const counts = storeCounts(listItems(list));
  const withOpen = state.stores.find((s) => counts[s.id]?.open > 0);
  return (withOpen || state.stores[0]).id;
}

function latestUndoable() {
  const undone = new Set(state.activity.filter((a) => a.type === 'undo').map((a) => a.undoOf));
  return state.activity.find((a) => a.by === state.user.uid && UNDOABLE.has(a.type) && !undone.has(a.id)) || null;
}

function itemRow(item) {
  const qty = formatQty(item.qty, item.unit);
  return `
    <div class="item${item.checked ? ' is-checked' : ''}">
      <button class="item-main" data-action="toggle" data-id="${item.id}"
        aria-label="${esc(item.name)} ${item.checked ? 'terugzetten' : 'afvinken'}">
        <span class="check" aria-hidden="true">${item.checked ? icon('check', 13) : ''}</span>
        <span class="item-name">${esc(item.name)}</span>
        ${qty ? `<span class="item-qty">${esc(qty)}</span>` : ''}
      </button>
      <button class="icon-btn icon-btn-quiet" data-action="edit-item" data-id="${item.id}" aria-label="${esc(item.name)} bewerken">${icon('edit', 18)}</button>
    </div>`;
}

// Indeling van een winkel, opgeschoond: secties die niet meer bestaan vallen weg.
function storeLayout(store) {
  return (store?.layout || []).map((g) => ({ ...g, sectionIds: (g.sectionIds || []).filter((id) => sectionAvailable(store, id)) }));
}

// Items groeperen in looproute-volgorde. Met indeling: per gangpad/blok,
// daarna de secties die nog geen plek hebben. Zonder indeling: per sectie.
function groupForStore(store, items) {
  const layout = storeLayout(store);
  const where = new Map();
  layout.forEach((g, gi) => g.sectionIds.forEach((sid, si) => where.set(sid, { gi, si })));
  const fallback = fallbackSection();
  const groups = new Map();

  for (const item of items) {
    const sec = displaySection(store, item.sectionId) || fallback;
    const loc = sec ? where.get(sec.id) : null;
    const key = loc ? `g${loc.gi}` : `s${sec?.id || 'none'}`;
    if (!groups.has(key)) {
      groups.set(
        key,
        loc
          ? { aisle: true, title: layout[loc.gi].name, sort: loc.gi, sections: new Set(), items: [] }
          : { aisle: false, title: sec?.name || 'Overig', sort: 1000 + (sec ? sectionSort(sec) : 999999), unplaced: layout.length > 0, items: [] },
      );
    }
    const g = groups.get(key);
    g.items.push({ item, si: loc?.si ?? 0 });
    if (loc) g.sections.add(sec.id);
  }

  return [...groups.values()]
    .sort((a, b) => a.sort - b.sort)
    .map((g) => {
      const sorted = g.items.sort((a, b) => a.si - b.si || a.item.name.localeCompare(b.item.name, 'nl'));
      const sub = g.aisle
        ? layout[g.sort].sectionIds.filter((id) => g.sections.has(id)).map((id) => sectionById(id).name.toLocaleLowerCase('nl')).join(' · ')
        : '';
      return { ...g, sub, items: sorted.map((x) => x.item) };
    });
}

function viewLijst() {
  const list = activeList();
  if (!list) return viewPlaceholder('Lijst', 'Geen lijsten gevonden.');

  const undoable = latestUndoable();
  const listSwitch = `
    <div class="list-switch" role="tablist" aria-label="Lijsten">
      ${state.lists
        .map(
          (l) => `<button class="list-tab${l.id === list.id ? ' is-active' : ''}" role="tab"
            aria-selected="${l.id === list.id}" data-list="${l.id}">${esc(l.name)}</button>`,
        )
        .join('')}
    </div>`;
  const undoBtn = `
    <button class="icon-btn" data-action="undo" ${undoable ? '' : 'disabled'}
      aria-label="${undoable ? esc(`Ongedaan maken: ${undoable.label}`) : 'Niets om ongedaan te maken'}"
      title="${undoable ? esc(`Ongedaan maken: ${undoable.label}`) : state.activityReady ? 'Niets om ongedaan te maken' : 'Undo nog niet beschikbaar'}">${icon('undo')}</button>`;

  if (!state.stores.length) {
    return `
      <header class="list-head">
        <div class="list-head-top">${listSwitch}${undoBtn}</div>
        <h1 class="page-title">Eerste winkel</h1>
      </header>
      <form class="card" data-form="add-store">
        <h2 class="card-title">Waar doe je boodschappen?</h2>
        <p class="muted">Voeg je eerste winkel toe. Meer winkels kun je altijd later toevoegen.</p>
        <div class="inline-form">
          <label class="sr-only" for="first-store">Naam van de winkel</label>
          <input id="first-store" class="input" name="name" placeholder="Bijv. Lidl" maxlength="40" required>
          <button class="btn btn-primary" type="submit">Toevoegen</button>
        </div>
      </form>`;
  }

  const items = listItems(list);
  const counts = storeCounts(items);
  const storeId = currentStoreId();
  const store = storeById(storeId);
  const inStore = items.filter((i) => i.storeId === storeId);
  const open = inStore.filter((i) => !i.checked);
  const cart = inStore.filter((i) => i.checked).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  const total = inStore.length;
  const pct = total ? Math.round((cart.length / total) * 100) : 0;

  const barStores = state.stores.filter((s) => counts[s.id]?.open > 0 || s.id === storeId);
  const hidden = state.stores.length - barStores.length;

  const ordered = groupForStore(store, open);
  return `
    <header class="list-head">
      <div class="list-head-top">${listSwitch}${undoBtn}</div>
      <div class="list-head-main">
        <h1 class="page-title">${esc(store?.name || '')}</h1>
        ${
          total
            ? `<div class="progress" aria-label="${cart.length} van ${total} gehaald">
                <span class="progress-num">${cart.length} / ${total}</span>
                <span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span>
              </div>`
            : ''
        }
      </div>
      <div class="storebar">
        <div class="storebar-scroll" role="tablist" aria-label="Winkels">
          ${barStores
            .map((s) => {
              const n = counts[s.id]?.open || 0;
              return `<button class="store-chip${s.id === storeId ? ' is-active' : ''}" role="tab"
                aria-selected="${s.id === storeId}" data-store="${s.id}">${esc(s.name)}${
                  n ? ` <span class="store-count">${n}</span>` : ''
                }</button>`;
            })
            .join('')}
        </div>
        <button class="icon-btn" data-action="stores-sheet" aria-label="Alle winkels${hidden ? ` (${hidden} zonder items)` : ''}">${icon('more')}</button>
      </div>
    </header>

    ${
      total && !open.length
        ? `<section class="card done-card">
            <h2 class="card-title">Alles gehaald bij ${esc(store?.name || '')}</h2>
            <p class="muted">Ronde afronden en de historie komen in een volgende bouwstap.</p>
          </section>`
        : ''
    }

    ${
      !total
        ? `<section class="card empty">
            <h2 class="card-title">Nog niks voor ${esc(store?.name || '')}</h2>
            <p class="muted">Typ hieronder wat je nodig hebt. Tip: "500 g wortels" of "2 melk" werkt ook.</p>
          </section>`
        : ''
    }

    ${ordered
      .map(
        (g) => `
      <section class="group">
        <h2 class="group-title">${
          g.aisle
            ? `<span class="group-aisle">${esc(g.title)}</span><span class="group-sub">${esc(g.sub)}</span>`
            : `<span class="group-sub">${esc(g.title)}${g.unplaced ? ' · niet ingedeeld' : ''}</span>`
        }</h2>
        ${g.items.map(itemRow).join('')}
      </section>`,
      )
      .join('')}

    ${
      cart.length
        ? `<section class="cart">
            <button class="cart-toggle" data-action="toggle-cart" aria-expanded="${state.cartOpen}">
              <span>In de kar <span class="mono">${cart.length}</span></span>
              <span class="cart-chevron">${icon(state.cartOpen ? 'up' : 'down', 18)}</span>
            </button>
            ${state.cartOpen ? `<div class="cart-items">${cart.map(itemRow).join('')}</div>` : ''}
          </section>`
        : ''
    }`;
}

// ---------- winkels ----------

function viewWinkels() {
  const chain = chainById(state.chainView);
  if (chain) return viewChain(chain);
  const layoutStore = storeById(state.layoutStoreId);
  if (layoutStore) return viewLayout(layoutStore);
  const counts = storeCounts(liveItems().filter((i) => !i.checked));
  return `
    <header class="page-head"><h1 class="page-title">Winkels</h1></header>

    <form class="card" data-form="add-store">
      <h2 class="card-title">Winkel toevoegen</h2>
      <div class="add-section">
        <label class="sr-only" for="new-store">Naam van de winkel</label>
        <input id="new-store" class="input" name="name" placeholder="Bijv. Kruidvat of Lidl Leeuwarden" maxlength="40" required>
        <label class="sr-only" for="new-store-chain">Keten</label>
        <select id="new-store-chain" class="input" name="chain">
          <option value="">Nieuwe keten</option>
          ${state.chains.map((c) => `<option value="${c.id}">Filiaal van ${esc(c.name)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" type="submit">Toevoegen</button>
      </div>
      <p class="muted small">Een nieuw filiaal krijgt de secties van de keten en de looproute van een bestaand filiaal.</p>
    </form>

    ${
      state.stores.length
        ? `<section class="card">
            <h2 class="card-title">Volgorde in de winkelbalk</h2>
            <div class="store-list">
              ${state.stores
                .map((s, idx) => {
                  if (state.renamingStoreId === s.id) {
                    return `
                      <form class="store-row" data-form="rename-store" data-id="${s.id}">
                        <label class="sr-only" for="rename-${s.id}">Nieuwe naam</label>
                        <input id="rename-${s.id}" class="input" name="name" value="${esc(s.name)}" maxlength="40" required>
                        <button class="btn btn-primary btn-sm" type="submit">Opslaan</button>
                        <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-rename">Annuleren</button>
                      </form>`;
                  }
                  const n = counts[s.id]?.open || 0;
                  return `
                    <div class="store-row">
                      <button class="store-row-name" data-action="layout-open" data-id="${s.id}" aria-label="Indeling van ${esc(s.name)}">
                        <span>${esc(s.name)}</span>
                        <span class="store-row-meta">${chainOf(s) && chainOf(s).name !== s.name ? `${esc(chainOf(s).name)} · ` : ''}${esc(layoutSummary(s))}${n ? ` · ${n} open` : ''} ${icon('next', 14)}</span>
                      </button>
                      <div class="store-row-actions">
                        <button class="icon-btn icon-btn-quiet" data-action="store-up" data-id="${s.id}" ${idx === 0 ? 'disabled' : ''} aria-label="${esc(s.name)} omhoog">${icon('up', 18)}</button>
                        <button class="icon-btn icon-btn-quiet" data-action="store-down" data-id="${s.id}" ${idx === state.stores.length - 1 ? 'disabled' : ''} aria-label="${esc(s.name)} omlaag">${icon('down', 18)}</button>
                        <button class="icon-btn icon-btn-quiet" data-action="store-rename" data-id="${s.id}" aria-label="${esc(s.name)} hernoemen">${icon('edit', 18)}</button>
                        <button class="icon-btn icon-btn-quiet" data-action="store-delete" data-id="${s.id}" aria-label="${esc(s.name)} verwijderen">${icon('trash', 18)}</button>
                      </div>
                    </div>`;
                })
                .join('')}
            </div>
            <p class="muted small">Tik op een winkel om de gangpaden in te delen.</p>
          </section>`
        : ''
    }`;
}

function layoutSummary(store) {
  const layout = storeLayout(store);
  if (!layout.length) return 'niet ingedeeld';
  return `${layout.length} ${layout.length === 1 ? 'blok' : 'blokken'}`;
}

function viewLayout(store) {
  const layout = storeLayout(store);
  const used = new Set(layout.flatMap((g) => g.sectionIds));
  const free = sectionsForStore(store).filter((s) => !used.has(s.id));
  const off = new Set(store.disabledSectionIds || []);
  const toggleable = sectionsForStoreAll(store).filter((s) => !isOverig(s));
  const chain = chainOf(store);
  const ownCount = state.sections.filter((s) => isChainSection(s) && s.chainId === store.chainId).length;

  return `
    <header class="page-head">
      <div>
        <button class="back-link" data-action="layout-back">${icon('back', 16)} Winkels</button>
        <h1 class="page-title">${esc(store.name)}</h1>
      </div>
    </header>

    <section class="card">
      <h2 class="card-title">Keten</h2>
      <label class="sr-only" for="store-chain">Keten van ${esc(store.name)}</label>
      <select id="store-chain" class="input" data-store-chain="${store.id}">
        ${state.chains.map((c) => `<option value="${c.id}"${c.id === store.chainId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
        <option value="__new__">+ Nieuwe keten…</option>
      </select>
      ${
        chain
          ? `<button class="row-link" data-action="chain-open" data-id="${chain.id}">
              <span>Secties van ${esc(chain.name)} · ${ownCount} eigen</span>${icon('next', 18)}
            </button>`
          : ''
      }
    </section>

    <details class="card">
      <summary class="card-title summary">Secties aan/uit bij ${esc(store.name)} <span class="muted mono small">${toggleable.filter((s) => !off.has(s.id)).length}/${toggleable.length}</span></summary>
      <p class="muted small">Uit = dit filiaal heeft het niet. Tik om aan of uit te zetten.</p>
      <div class="layout-secs">
        ${toggleable
          .map((s) => {
            const on = !off.has(s.id);
            return `<button class="sec-toggle${on ? ' is-on' : ''}" data-action="sec-toggle" data-id="${s.id}" aria-pressed="${on}">${on ? icon('check', 14) : ''}${esc(s.name)}</button>`;
          })
          .join('')}
      </div>
    </details>

    <div class="card-head">
      <h2 class="section-heading">Looproute</h2>
      ${state.importDraft?.storeId === store.id ? '' : `<button class="btn btn-ghost btn-sm" data-action="import-open">Indeling plakken</button>`}
    </div>
    <p class="muted">Zet de blokken in de volgorde waarin je door de winkel loopt. Een blok kan een gangpad zijn, maar ook "Koeling" of "Bij de kassa".</p>
    ${state.importDraft?.storeId === store.id ? importCard(store) : ''}

    ${layout
      .map(
        (g, gi) => `
      <section class="card layout-group">
        <div class="layout-head">
          <span class="layout-num mono">${gi + 1}</span>
          <label class="sr-only" for="lg-${g.id}">Naam van blok ${gi + 1}</label>
          <input id="lg-${g.id}" class="input layout-name" data-layout-name="${g.id}" value="${esc(g.name)}" maxlength="40">
          <button class="icon-btn icon-btn-quiet" data-action="layout-up" data-id="${g.id}" ${gi === 0 ? 'disabled' : ''} aria-label="${esc(g.name)} omhoog">${icon('up', 18)}</button>
          <button class="icon-btn icon-btn-quiet" data-action="layout-down" data-id="${g.id}" ${gi === layout.length - 1 ? 'disabled' : ''} aria-label="${esc(g.name)} omlaag">${icon('down', 18)}</button>
          <button class="icon-btn icon-btn-quiet" data-action="layout-delete" data-id="${g.id}" aria-label="${esc(g.name)} verwijderen">${icon('trash', 18)}</button>
        </div>
        <div class="layout-secs">
          ${
            g.sectionIds.length
              ? g.sectionIds
                  .map(
                    (sid, si) => `<span class="sec-chip">
                      ${si > 0 ? `<button class="sec-chip-btn" data-action="layout-sec-left" data-group="${g.id}" data-id="${sid}" aria-label="${esc(sectionById(sid).name)} eerder">${icon('back', 14)}</button>` : ''}
                      <span>${esc(sectionById(sid).name)}</span>
                      <button class="sec-chip-btn" data-action="layout-sec-remove" data-group="${g.id}" data-id="${sid}" aria-label="${esc(sectionById(sid).name)} uit ${esc(g.name)} halen">${icon('x', 14)}</button>
                    </span>`,
                  )
                  .join('')
              : '<span class="muted small">Nog geen secties</span>'
          }
        </div>
        ${
          state.layoutNewSection === g.id
            ? `<form class="new-section" data-form="layout-new-section" data-group="${g.id}">
                <div class="inline-form">
                  <label class="sr-only" for="lns-${g.id}">Naam nieuwe sectie</label>
                  <input id="lns-${g.id}" class="input" name="name" placeholder="Bijv. Kaas (koeling)" maxlength="40" required>
                  <button class="btn btn-primary" type="submit">Toevoegen</button>
                </div>
                ${chain ? `<label class="check-row"><input type="checkbox" name="onlyStore" checked> Alleen voor ${esc(chain.name)}</label>` : ''}
                <button class="btn btn-ghost btn-sm" type="button" data-action="layout-new-section-cancel">Annuleren</button>
              </form>`
            : `<label class="sr-only" for="la-${g.id}">Sectie toevoegen aan ${esc(g.name)}</label>
              <select id="la-${g.id}" class="input" data-layout-add="${g.id}">
                <option value="">+ Sectie toevoegen…</option>
                ${free.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
                <option value="__new__">+ Nieuwe sectie…</option>
              </select>`
        }
      </section>`,
      )
      .join('')}

    <button class="btn btn-ghost btn-block" data-action="layout-add-group">+ ${layout.length ? 'Blok toevoegen' : 'Eerste gangpad toevoegen'}</button>

    ${
      free.length
        ? `<section class="card">
            <h2 class="card-title">Nog niet in de looproute</h2>
            <p class="muted small">Items uit deze secties staan in de lijst onderaan, op sectie.</p>
            <div class="layout-secs">${free.map((s) => `<span class="sec-chip sec-chip-free">${esc(s.name)}</span>`).join('')}</div>
          </section>`
        : `<p class="muted small center">Alle secties hebben een plek.</p>`
    }`;
}

// ---------- indeling importeren ----------

const IMPORT_MATCH = 0.75;

// Voorbeeld opbouwen: per getypte naam de beste bestaande secties bij deze winkel.
function buildImportPreview(store, text) {
  const blocks = parseLayoutText(text);
  const pool = sectionsForStoreAll(store);
  return blocks.map((b, bi) => ({
    name: b.name,
    rows: b.items.map((typed, ii) => {
      const ranked = pool
        .map((s) => ({ id: s.id, name: s.name, score: nameSimilarity(typed, s.name) + (s.custom ? 0.01 : 0) }))
        .filter((c) => c.score >= 0.5)
        .sort((x, y) => y.score - x.score)
        .slice(0, 4);
      const best = ranked[0];
      return {
        key: `${bi}:${ii}`,
        typed,
        candidates: ranked,
        choice: best && best.score >= IMPORT_MATCH ? best.id : 'new',
        parentKey: guessParentKey(typed),
      };
    }),
  }));
}

function importCard(store) {
  const d = state.importDraft;
  const chain = chainOf(store);
  if (!d.preview) {
    return `
      <section class="card import-card">
        <h2 class="card-title">Indeling plakken</h2>
        <p class="muted small">Eén blok per regel. Zonder dubbele punt wordt de regel een blok met één sectie.</p>
        <pre class="import-example mono">Fruit
Gangpad 1: brood, pasta, soep
Koeling: koeling (zuivel), koeling (vlees)</pre>
        <label class="sr-only" for="import-text">Indeling</label>
        <textarea id="import-text" class="input import-text" data-import-text rows="9" placeholder="Plak hier je indeling">${esc(d.text || '')}</textarea>
        ${d.error ? `<p class="error" role="alert">${esc(d.error)}</p>` : ''}
        <div class="inline-form">
          <button class="btn btn-primary" data-action="import-preview">Bekijken</button>
          <button class="btn btn-ghost" data-action="import-cancel">Annuleren</button>
        </div>
      </section>`;
  }
  const rows = d.preview.flatMap((b) => b.rows);
  const seen = new Set();
  const dupes = new Set();
  for (const r of rows) {
    if (r.choice === 'skip' || r.choice === 'new') continue;
    if (seen.has(r.choice)) dupes.add(r.key);
    seen.add(r.choice);
  }
  const nNew = rows.filter((r) => r.choice === 'new').length;
  const nMatch = rows.filter((r) => r.choice !== 'new' && r.choice !== 'skip').length;
  return `
    <section class="card import-card">
      <h2 class="card-title">Voorbeeld</h2>
      <p class="muted small">${nMatch} gekoppeld aan bestaande secties · ${nNew} nieuw${chain ? ` (voor ${esc(chain.name)})` : ''}. Kies per regel waar hij bij hoort.</p>
      ${d.preview
        .map(
          (b, bi) => `
        <div class="import-block">
          <h3 class="chain-group-title"><span class="layout-num mono">${bi + 1}</span> ${esc(b.name)}</h3>
          ${b.rows.length ? '' : '<p class="muted small">Leeg blok</p>'}
          ${b.rows
            .map((r) => {
              const exact = r.candidates[0] && r.candidates[0].score >= 1 && r.choice === r.candidates[0].id;
              return `
            <div class="import-row${dupes.has(r.key) ? ' is-dupe' : ''}">
              <span class="import-typed">${esc(r.typed)}</span>
              <label class="sr-only" for="ir-${r.key}">Koppeling voor ${esc(r.typed)}</label>
              <select id="ir-${r.key}" class="input import-select${exact ? ' is-exact' : ''}" data-import-row="${r.key}">
                ${r.candidates
                  .map((c) => `<option value="${c.id}"${c.id === r.choice ? ' selected' : ''}>→ ${esc(c.name)}</option>`)
                  .join('')}
                <option value="new"${r.choice === 'new' ? ' selected' : ''}>+ Nieuw: ${esc(r.typed)} (onder ${esc(sectionByKey(r.parentKey)?.name || 'Overig')})</option>
                <option value="skip"${r.choice === 'skip' ? ' selected' : ''}>Overslaan</option>
              </select>
              ${dupes.has(r.key) ? '<span class="muted small">staat al eerder in de lijst, alleen de eerste telt</span>' : ''}
            </div>`;
            })
            .join('')}
        </div>`,
        )
        .join('')}
      <label class="check-row"><input type="checkbox" data-import-replace${d.replace ? ' checked' : ''}> Huidige looproute vervangen (anders komt dit erachter)</label>
      <div class="inline-form">
        <button class="btn btn-primary" data-action="import-apply">Toepassen</button>
        <button class="btn btn-ghost" data-action="import-back">Tekst aanpassen</button>
        <button class="btn btn-ghost" data-action="import-cancel">Annuleren</button>
      </div>
      <p class="muted small">Na toepassen is alles gewoon aan te passen, en in één keer ongedaan te maken.</p>
    </section>`;
}

async function applyImport(store) {
  const d = state.importDraft;
  const used = new Set();
  const newByName = new Map();
  const newSections = [];
  let order = nextSectionOrder();
  const blocks = d.preview
    .map((b) => {
      const ids = [];
      for (const r of b.rows) {
        if (r.choice === 'skip') continue;
        let id = r.choice;
        if (id === 'new') {
          const k = r.typed.toLocaleLowerCase('nl');
          if (!newByName.has(k)) {
            const tempId = `new_${newSections.length}`;
            newSections.push({ tempId, name: r.typed.slice(0, 40), parentKey: r.parentKey, order: order++ });
            newByName.set(k, tempId);
          }
          id = newByName.get(k);
        }
        if (used.has(id)) continue;
        used.add(id);
        ids.push(id);
      }
      return { id: newGroupId(), name: b.name.slice(0, 40), sectionIds: ids };
    });

  // Erachter plakken: bestaande blokken houden, maar zonder secties die nu een nieuwe plek krijgen.
  const layout = d.replace
    ? blocks
    : [...(store.layout || []).map((g) => ({ ...g, sectionIds: (g.sectionIds || []).filter((id) => !used.has(id)) })), ...blocks];
  const off = new Set(store.disabledSectionIds || []);
  const enableIds = [...used].filter((id) => off.has(id));
  const label = `Indeling ${store.name} geïmporteerd (${blocks.length} blokken${newSections.length ? `, ${newSections.length} ${newSections.length === 1 ? 'nieuwe sectie' : 'nieuwe secties'}` : ''})`;
  const actionId = await run(() =>
    importLayout(state.hid, state.user, { store, chainId: store.chainId, newSections, layout, enableIds, label }),
  );
  if (actionId) {
    state.importDraft = null;
    toast(label, actionId);
    render();
  }
}

async function saveLayout(store, layout, label) {
  const actionId = await run(() => updateStore(state.hid, state.user, store, { layout }, label));
  return actionId;
}

const newGroupId = () => Math.random().toString(36).slice(2, 9);

// ---------- opties ----------

function viewPlaceholder(title, text) {
  return `
    <header class="page-head"><h1 class="page-title">${esc(title)}</h1></header>
    <section class="card empty"><p class="muted">${esc(text)}</p></section>`;
}

function parentSelect(id, current, attr) {
  return `<select id="${id}" class="input sec-row-scope" ${attr}>
    ${state.sections
      .filter(isStandard)
      .map((p) => `<option value="${p.key}"${p.key === current ? ' selected' : ''}>valt onder ${esc(p.name)}</option>`)
      .join('')}
  </select>`;
}

function sectionRow(s, idx, total, kind) {
  const extra =
    kind === 'custom' || kind === 'custom-chain'
      ? `<label class="sr-only" for="sp-${s.id}">Valt onder</label>${parentSelect(`sp-${s.id}`, s.parentKey || 'overig', `data-section-parent="${s.id}"`)}
         <label class="sr-only" for="sc-${s.id}">Geldt voor</label>
         <select id="sc-${s.id}" class="input sec-row-scope" data-section-chain="${s.id}">
           <option value=""${!s.chainId ? ' selected' : ''}>voor alle winkels</option>
           ${state.chains.map((c) => `<option value="${c.id}"${s.chainId === c.id ? ' selected' : ''}>alleen ${esc(c.name)}</option>`).join('')}
         </select>`
      : '';
  const movable = kind !== 'custom-chain';
  return `
    <div class="sec-row">
      <div class="sec-row-main">
        <label class="sr-only" for="sn-${s.id}">Naam</label>
        <input id="sn-${s.id}" class="input sec-row-name" data-section-name="${s.id}" value="${esc(s.name)}" maxlength="40">
        ${
          movable
            ? `<button class="icon-btn icon-btn-quiet" data-action="section-up" data-list="${kind}" data-id="${s.id}" ${idx === 0 ? 'disabled' : ''} aria-label="${esc(s.name)} omhoog">${icon('up', 18)}</button>
               <button class="icon-btn icon-btn-quiet" data-action="section-down" data-list="${kind}" data-id="${s.id}" ${idx === total - 1 ? 'disabled' : ''} aria-label="${esc(s.name)} omlaag">${icon('down', 18)}</button>`
            : ''
        }
        ${
          isOverig(s)
            ? `<span class="icon-btn icon-btn-quiet" aria-hidden="true"></span>`
            : `<button class="icon-btn icon-btn-quiet" data-action="section-delete" data-id="${s.id}" aria-label="${esc(s.name)} ${kind === 'std' ? 'verbergen' : 'verwijderen'}">${icon('trash', 18)}</button>`
        }
      </div>
      ${extra}
    </div>`;
}

function viewSecties() {
  const std = state.sections.filter(isStandard);
  const custom = state.sections.filter((s) => s.custom && !s.chainId && !s.storeId).sort(bySectionSort);
  const hidden = state.allSections.filter((s) => s.deleted && isStandard(s));
  return `
    <header class="page-head">
      <div>
        <button class="back-link" data-action="opt-back">${icon('back', 16)} Opties</button>
        <h1 class="page-title">Secties</h1>
      </div>
    </header>
    <p class="muted">Standaardsecties zijn de basis voor elke winkel. Ketens kunnen ze vervangen door hun eigen schapnamen.</p>

    <section class="card">
      <h2 class="card-title">Per keten</h2>
      ${
        state.chains.length
          ? state.chains
              .map((c) => {
                const n = state.sections.filter((s) => isChainSection(s) && s.chainId === c.id).length;
                const f = storesOfChain(c.id).length;
                return `<button class="row-link" data-action="chain-open" data-id="${c.id}">
                  <span>${esc(c.name)} <span class="muted mono small">${n} ${n === 1 ? 'sectie' : 'secties'} · ${f} ${f === 1 ? 'filiaal' : 'filialen'}</span></span>${icon('next', 18)}
                </button>`;
              })
              .join('')
          : '<p class="muted small">Nog geen ketens. Die ontstaan vanzelf als je winkels toevoegt.</p>'
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Standaard</h2>
        <button class="btn btn-ghost btn-sm" data-action="sections-reset">Herstellen</button>
      </div>
      <div class="sec-list">${std.map((s, i) => sectionRow(s, i, std.length, 'std')).join('')}</div>
      ${hidden.length ? `<p class="muted small">Verborgen: ${hidden.map((s) => esc(s.name)).join(', ')}. "Herstellen" zet ze terug.</p>` : ''}
    </section>

    <section class="card">
      <h2 class="card-title">Eigen secties voor alle winkels</h2>
      ${
        custom.length
          ? `<div class="sec-list">${custom.map((s, i) => sectionRow(s, i, custom.length, 'custom')).join('')}</div>`
          : '<p class="muted small">Geen. Schapnamen van één keten maak je bij die keten.</p>'
      }
      <form class="add-section" data-form="add-section">
        <label class="sr-only" for="new-section-name">Naam nieuwe sectie</label>
        <input id="new-section-name" class="input" name="name" placeholder="Nieuwe sectie" maxlength="40" required>
        <label class="sr-only" for="new-section-parent">Valt onder</label>
        ${parentSelect('new-section-parent', 'overig', 'name="parent"')}
        <button class="btn btn-primary" type="submit">Toevoegen</button>
      </form>
    </section>`;
}

function viewChain(chain) {
  const secs = state.sections.filter((s) => isChainSection(s) && s.chainId === chain.id).sort(bySectionSort);
  const stores = storesOfChain(chain.id);
  const byParent = new Map();
  for (const s of secs) {
    const k = s.parentKey || 'overig';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(s);
  }
  const stdList = state.sections.filter(isStandard);
  const usesStandard = stdList.filter((p) => !byParent.has(p.key) && !isOverig(p));

  return `
    <header class="page-head">
      <div>
        <button class="back-link" data-action="chain-back">${icon('back', 16)} Winkels</button>
        <label class="sr-only" for="chain-name">Naam van de keten</label>
        <input id="chain-name" class="title-input" data-chain-name="${chain.id}" value="${esc(chain.name)}" maxlength="40">
      </div>
    </header>
    <p class="muted">Deze secties gelden voor alle filialen. Een sectie vervangt de standaardsectie waar hij onder valt, en nieuwe producten komen daar vanzelf in.</p>

    <section class="card">
      <h2 class="card-title">Filialen</h2>
      ${
        stores.length
          ? stores
              .map(
                (s) => `<button class="row-link" data-action="layout-open" data-id="${s.id}">
                  <span>${esc(s.name)} <span class="muted mono small">${esc(layoutSummary(s))}</span></span>${icon('next', 18)}
                </button>`,
              )
              .join('')
          : '<p class="muted small">Geen filialen.</p>'
      }
      <form class="inline-form" data-form="add-branch" data-chain="${chain.id}">
        <label class="sr-only" for="branch-name">Nieuw filiaal</label>
        <input id="branch-name" class="input" name="name" placeholder="Bijv. ${esc(chain.name)} Leeuwarden" maxlength="40" required>
        <button class="btn btn-primary" type="submit">Toevoegen</button>
      </form>
    </section>

    <section class="card">
      <h2 class="card-title">Secties van ${esc(chain.name)}</h2>
      ${
        secs.length
          ? stdList
              .filter((p) => byParent.has(p.key))
              .map(
                (p) => `<div class="chain-group">
                  <h3 class="chain-group-title">${esc(p.name)}</h3>
                  <div class="sec-list">${byParent
                    .get(p.key)
                    .map((s) => sectionRow(s, 0, 1, 'custom-chain'))
                    .join('')}</div>
                </div>`,
              )
              .join('')
          : '<p class="muted small">Nog geen eigen secties: deze keten gebruikt de standaardsecties.</p>'
      }
      <form class="add-section" data-form="add-chain-section" data-chain="${chain.id}">
        <label class="sr-only" for="chain-section-name">Naam nieuwe sectie</label>
        <input id="chain-section-name" class="input" name="name" placeholder="Schapnaam, bijv. Koeling (Zuivel)" maxlength="40" required>
        <label class="sr-only" for="chain-section-parent">Valt onder</label>
        <select id="chain-section-parent" class="input" name="parent">
          <option value="">valt onder: raden op naam</option>
          ${stdList.map((p) => `<option value="${p.key}">valt onder ${esc(p.name)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" type="submit">Toevoegen</button>
      </form>
    </section>

    ${
      usesStandard.length
        ? `<section class="card">
            <h2 class="card-title">Gebruikt de standaardsectie</h2>
            <div class="layout-secs">${usesStandard.map((s) => `<span class="sec-chip sec-chip-free">${esc(s.name)}</span>`).join('')}</div>
          </section>`
        : ''
    }`;
}

function viewOpties() {
  const pref = getThemePref();
  const isOwner = state.household?.ownerUid === state.user?.uid;
  const themeBtn = (val, label) =>
    `<button class="seg-btn${pref === val ? ' is-active' : ''}" data-theme-set="${val}" aria-pressed="${pref === val}">${label}</button>`;

  return `
    <header class="page-head"><h1 class="page-title">Opties</h1></header>

    <section class="card">
      <h2 class="card-title">Account</h2>
      <dl class="rows">
        <div class="row"><dt>Naam</dt><dd>${esc(state.user?.displayName || '—')}</dd></div>
        <div class="row"><dt>E-mail</dt><dd class="mono">${esc(state.user?.email || '—')}</dd></div>
      </dl>
      <button class="btn btn-ghost" data-action="logout">Uitloggen</button>
    </section>

    <section class="card">
      <h2 class="card-title">Huishouden</h2>
      <dl class="rows">
        <div class="row"><dt>Naam</dt><dd>${esc(state.household?.name || '—')}</dd></div>
        <div class="row"><dt>Rol</dt><dd>${isOwner ? 'Eigenaar' : 'Lid'}</dd></div>
        <div class="row"><dt>Leden</dt><dd class="mono">${state.household?.members?.length ?? 0}</dd></div>
        <div class="row"><dt>Winkels</dt><dd class="mono">${state.stores.length}</dd></div>
        <div class="row"><dt>Secties</dt><dd class="mono">${state.sections.length}</dd></div>
        <div class="row"><dt>Producten in geheugen</dt><dd class="mono">${state.products.size}</dd></div>
      </dl>
    </section>

    <section class="card">
      <h2 class="card-title">Secties</h2>
      <button class="row-link" data-action="opt-sections">
        <span>${state.sections.filter(isStandard).length} standaard · ${state.chains.length} ${state.chains.length === 1 ? 'keten' : 'ketens'}</span>
        ${icon('next', 18)}
      </button>
    </section>

    <section class="card">
      <h2 class="card-title">Weergave</h2>
      <div class="seg" role="group" aria-label="Thema">
        ${themeBtn('system', 'Systeem')}${themeBtn('light', 'Licht')}${themeBtn('dark', 'Donker')}
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Over</h2>
      <dl class="rows">
        <div class="row"><dt>Versie</dt><dd class="mono">${esc(APP_VERSION)}</dd></div>
        <div class="row"><dt>Datamodel</dt><dd class="mono">v${SCHEMA_VERSION}</dd></div>
        <div class="row"><dt>Undo</dt><dd>${state.activityReady ? 'Actief' : 'Wacht op index'}</dd></div>
      </dl>
    </section>`;
}

// ---------- sheet (onderin uitschuivend paneel) ----------

function openSheet(sheet) {
  state.sheet = sheet;
  renderSheet();
  document.body.classList.add('sheet-open');
  const first = document.querySelector('#sheet-root [data-autofocus]');
  if (first) setTimeout(() => first.focus(), 30);
}

function closeSheet() {
  state.sheet = null;
  document.getElementById('sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
}

function renderSheet() {
  const root = document.getElementById('sheet-root');
  const s = state.sheet;
  if (!s) {
    root.innerHTML = '';
    return;
  }
  const body = s.mode === 'stores' ? sheetStores() : s.mode === 'confirm-disable' ? sheetConfirmDisable(s) : sheetItem(s);
  root.innerHTML = `
    <div class="sheet-overlay" data-action="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(s.title || '')}">
      <div class="sheet-handle" aria-hidden="true"></div>
      ${body}
    </div>`;
}

function storeGrid(selectedId, s) {
  return `
    <div class="store-grid">
      ${state.stores
        .map(
          (st) => `<button type="button" class="store-opt${st.id === selectedId ? ' is-active' : ''}"
            data-action="sheet-store" data-id="${st.id}" aria-pressed="${st.id === selectedId}">${esc(st.name)}</button>`,
        )
        .join('')}
      <button type="button" class="store-opt store-opt-new" data-action="sheet-new-store">+ Nieuwe winkel</button>
    </div>
    ${
      s.newStoreOpen
        ? `<div class="inline-form">
            <label class="sr-only" for="sheet-new-store">Naam nieuwe winkel</label>
            <input id="sheet-new-store" class="input" data-field="newStoreName" value="${esc(s.newStoreName || '')}" placeholder="Naam winkel" maxlength="40" data-autofocus>
            <button type="button" class="btn btn-primary" data-action="sheet-add-store">Toevoegen</button>
          </div>`
        : ''
    }`;
}

function sheetItem(s) {
  const isNew = s.mode === 'item-new';
  const store = storeById(s.storeId);
  return `
    <form class="sheet-body" data-form="item">
      ${
        isNew
          ? `<div>
              <p class="eyebrow">nieuw product</p>
              <h2 class="sheet-title">Waar haal je ${esc(s.name)}?</h2>
            </div>`
          : `<label class="field">
              <span class="field-label">Naam</span>
              <input class="input" data-field="name" value="${esc(s.name)}" maxlength="80" required>
            </label>`
      }

      <div class="field">
        <span class="field-label">Winkel</span>
        ${storeGrid(s.storeId, s)}
      </div>

      <div class="field">
        <label class="field-label" for="sheet-section">Sectie${store ? ` bij ${esc(store.name)}` : ''}</label>
        <select id="sheet-section" class="input" data-field="sectionId">
          ${sectionsForStore(store)
            .map((sec) => `<option value="${sec.id}"${sec.id === s.sectionId ? ' selected' : ''}>${esc(sec.name)}</option>`)
            .join('')}
          <option value="__new__">+ Nieuwe sectie…</option>
        </select>
        ${
          s.newSectionOpen
            ? `<div class="new-section">
                <div class="inline-form">
                  <label class="sr-only" for="sheet-new-section">Naam nieuwe sectie</label>
                  <input id="sheet-new-section" class="input" data-field="newSectionName" value="${esc(s.newSectionName || '')}" placeholder="Bijv. Kaas (koeling)" maxlength="40">
                  <button type="button" class="btn btn-primary" data-action="sheet-add-section">Toevoegen</button>
                </div>
                ${chainOf(store) ? `<label class="check-row"><input type="checkbox" data-field="newSectionOnlyStore"${s.newSectionOnlyStore !== false ? ' checked' : ''}> Alleen voor ${esc(chainOf(store).name)}</label>` : ''}
              </div>`
            : ''
        }
      </div>

      <div class="field-row">
        <label class="field">
          <span class="field-label">Aantal</span>
          <input class="input mono" data-field="qty" inputmode="decimal" value="${esc(s.qty ?? '')}" placeholder="—">
        </label>
        <label class="field">
          <span class="field-label">Eenheid</span>
          <select class="input" data-field="unit">
            ${UNITS.map((u) => `<option value="${u.id}"${u.id === s.unit ? ' selected' : ''}>${u.label}</option>`).join('')}
          </select>
        </label>
      </div>

      ${s.error ? `<p class="error" role="alert">${esc(s.error)}</p>` : ''}

      <button class="btn btn-primary btn-block" type="submit">${
        isNew ? (store ? `Toevoegen aan ${esc(store.name)}` : 'Toevoegen') : 'Opslaan'
      }</button>
      ${
        isNew
          ? `<p class="muted small center">Volgende keer weet de app het zelf.</p>`
          : `<button class="btn btn-ghost btn-block btn-danger" type="button" data-action="sheet-delete">Verwijderen</button>`
      }
    </form>`;
}

function sheetConfirmDisable(s) {
  const store = storeById(s.storeId);
  const sec = sectionById(s.sectionId);
  return `
    <div class="sheet-body">
      <h2 class="sheet-title">${esc(sec?.name || '')} uitzetten bij ${esc(store?.name || '')}?</h2>
      <p class="muted">Er ${s.count === 1 ? 'staat nog 1 item in deze sectie. Dat gaat' : `staan nog ${s.count} items in deze sectie. Die gaan`} naar Overig. Je kunt dit ongedaan maken.</p>
      <button class="btn btn-primary btn-block" data-action="confirm-disable">Uitzetten en naar Overig</button>
      <button class="btn btn-ghost btn-block" data-action="sheet-close">Annuleren</button>
    </div>`;
}

function sheetStores() {
  const list = activeList();
  const counts = storeCounts(listItems(list).filter((i) => !i.checked));
  const current = currentStoreId();
  return `
    <div class="sheet-body">
      <h2 class="sheet-title">Winkels</h2>
      <div class="store-pick">
        ${state.stores
          .map(
            (s) => `<button class="store-pick-row${s.id === current ? ' is-active' : ''}" data-action="pick-store" data-id="${s.id}">
              <span>${esc(s.name)}</span><span class="mono muted">${counts[s.id]?.open || ''}</span>
            </button>`,
          )
          .join('')}
      </div>
      <form class="inline-form" data-form="add-store">
        <label class="sr-only" for="sheet-store-name">Nieuwe winkel</label>
        <input id="sheet-store-name" class="input" name="name" placeholder="Nieuwe winkel" maxlength="40" required>
        <button class="btn btn-primary" type="submit">Toevoegen</button>
      </form>
    </div>`;
}

// ---------- acties ----------

async function createStore(name, chainId = null) {
  const clean = capitalize(name).slice(0, 40);
  if (!clean) return null;
  if (state.stores.some((s) => s.name.toLocaleLowerCase('nl') === clean.toLocaleLowerCase('nl'))) {
    toast(`${clean} bestaat al`);
    return state.stores.find((s) => s.name.toLocaleLowerCase('nl') === clean.toLocaleLowerCase('nl')).id;
  }
  const order = state.stores.reduce((m, s) => Math.max(m, s.order ?? 0), -1) + 1;
  // Nieuw filiaal: looproute (en wat er uit staat) overnemen van een bestaand filiaal.
  const source = chainId ? storesOfChain(chainId).find((s) => (s.layout || []).length) || storesOfChain(chainId)[0] : null;
  const opts = { chainId };
  if (source) {
    opts.layout = (source.layout || []).map((g) => ({ ...g, id: newGroupId() }));
  }
  const res = await run(() => addStore(state.hid, state.user, clean, order, opts));
  if (res) toast(`${clean} toegevoegd${source && opts.layout.length ? ` (looproute van ${source.name})` : ''}`, res.actionId);
  return res?.storeId || null;
}

function productFor(list, key) {
  const own = state.products.get(productIdFor(list.ownerUid, key));
  if (own) return own;
  if (list.ownerUid !== SHARED) return state.products.get(productIdFor(SHARED, key)) || null;
  return null;
}

async function quickAdd(text) {
  const list = activeList();
  const { qty, unit, name } = parseQuickAdd(text);
  if (!name || !list) return false;
  const key = productKey(name);

  const dup = liveItems().find((i) => i.listId === list.id && !i.checked && i.key === key);
  if (dup) {
    toast(`${dup.name} staat al op de lijst bij ${storeById(dup.storeId)?.name || 'een winkel'}`);
    return true;
  }

  const known = productFor(list, key);
  const activeStore = currentStoreId();
  if (known && (known.sectionId || known.sectionByStore || known.sectionByChain)) {
    const storeId = (storeById(known.preferredStoreId) && known.preferredStoreId) || activeStore;
    const sectionId = resolveSection(known, storeById(storeId), name);
    const pid = productIdFor(list.ownerUid, key);
    const fields = {
      name: known.name || name,
      key,
      qty: qty ?? known.defaultQty ?? null,
      unit: unit || known.defaultUnit || 'st',
      storeId,
      sectionId,
    };
    const res = await run(() => addItem(state.hid, state.user, list, fields, { id: pid, isNew: !state.products.has(pid) }));
    if (res) {
      const where = storeId !== activeStore ? ` → ${storeById(storeId)?.name}` : ' toegevoegd';
      toast(`${fields.name}${where}`, res.actionId);
    }
    return !!res;
  }

  // Onbekend product: vragen waar het vandaan komt.
  openSheet({
    mode: 'item-new',
    title: `Waar haal je ${name}?`,
    name,
    key,
    qty: qty ?? '',
    unit: unit || 'st',
    storeId: activeStore,
    sectionId: resolveSection(known, storeById(activeStore), name),
  });
  return true;
}

function parseQtyInput(v) {
  const t = String(v ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function saveSheetItem() {
  const s = state.sheet;
  const list = activeList();
  if (!s.storeId || !storeById(s.storeId)) {
    s.error = 'Kies een winkel.';
    renderSheet();
    return;
  }
  const qty = parseQtyInput(s.qty);

  if (s.mode === 'item-new') {
    const pid = productIdFor(list.ownerUid, s.key);
    const fields = { name: s.name, key: s.key, qty, unit: s.unit, storeId: s.storeId, sectionId: s.sectionId };
    const store = storeById(s.storeId);
    const generalSectionId = generalSectionFor(s.sectionId, s.name);
    const extra = store?.chainId ? { sectionByChain: { [store.chainId]: s.sectionId } } : {};
    closeSheet();
    const res = await run(() => addItem(state.hid, state.user, list, fields, { id: pid, isNew: true, generalSectionId, extra }));
    if (res) toast(`${s.name} → ${storeById(s.storeId)?.name}`, res.actionId);
    return;
  }

  const item = state.items.find((i) => i.id === s.itemId);
  if (!item) return closeSheet();
  const name = capitalize(s.name || '');
  if (!name) {
    s.error = 'Geef het product een naam.';
    renderSheet();
    return;
  }
  const key = productKey(name);
  const next = { name, key, qty, unit: s.unit, storeId: s.storeId, sectionId: s.sectionId };
  if (key !== item.key) next.productId = productIdFor(item.ownerUid, key);
  const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => (item[k] ?? null) !== (v ?? null)));
  closeSheet();
  if (!Object.keys(changes).length) return;

  // Geheugen corrigeren: sectie en eenheid gelden voortaan voor dit product.
  const pid = changes.productId || item.productId || productIdFor(item.ownerUid, key);
  let productUpdates = null;
  if (changes.productId || s.sectionTouched || changes.unit || changes.name) {
    const data = { name, key, defaultUnit: next.unit };
    const chainId = storeById(next.storeId)?.chainId;
    if (s.sectionTouched || !state.products.has(pid)) {
      if (chainId) data.sectionByChain = { [chainId]: next.sectionId };
      data.sectionId = generalSectionFor(next.sectionId, name);
    }
    if (!state.products.has(pid)) Object.assign(data, { defaultQty: qty, preferredStoreId: next.storeId });
    productUpdates = { id: pid, data };
  }
  if (!item.productId && !changes.productId) changes.productId = pid;

  const actionId = await run(() => updateItem(state.hid, state.user, item, changes, productUpdates));
  if (actionId) {
    toast(changes.storeId ? `${name} → ${storeById(changes.storeId)?.name}` : `${name} aangepast`, actionId);
  }
}

function sheetProduct(sh) {
  if (sh.mode === 'item-edit') {
    const item = state.items.find((i) => i.id === sh.itemId);
    return item ? state.products.get(item.productId) || null : null;
  }
  const list = activeList();
  return list ? productFor(list, sh.key) : null;
}

// chainId null = sectie voor alle winkels. parentKey leeg = raden op naam.
async function createSection(name, chainId = null, parentKey = '') {
  const clean = capitalize(name || '').slice(0, 40);
  if (!clean) return null;
  const same = state.sections.find(
    (s) => s.name.toLocaleLowerCase('nl') === clean.toLocaleLowerCase('nl') && (s.chainId || null) === (chainId || null) && (s.custom || !chainId),
  );
  if (same) {
    toast(`${clean} bestaat al`);
    return same.id;
  }
  const parent = parentKey || guessParentKey(clean);
  const res = await run(() => addSection(state.hid, state.user, { name: clean, chainId, parentKey: parent, order: nextSectionOrder() }));
  if (res) toast(`Sectie ${clean} toegevoegd (onder ${sectionByKey(parent)?.name || 'Overig'})`, res.actionId);
  return res?.sectionId || null;
}

const itemsInSection = (sid, storeId = null) =>
  liveItems().filter((i) => i.sectionId === sid && (!storeId || i.storeId === storeId));

async function setSectionEnabled(store, sid, enabled) {
  const sec = sectionById(sid);
  const overig = fallbackSection();
  const off = new Set(store.disabledSectionIds || []);
  if (enabled) off.delete(sid);
  else off.add(sid);
  const changes = [
    { col: 'stores', id: store.id, before: { disabledSectionIds: store.disabledSectionIds || [] }, after: { disabledSectionIds: [...off] } },
  ];
  if (!enabled && overig) {
    for (const i of itemsInSection(sid, store.id)) {
      changes.push({ col: 'items', id: i.id, before: { sectionId: sid }, after: { sectionId: overig.id } });
    }
  }
  const label = `${sec?.name} ${enabled ? 'aangezet' : 'uitgezet'} bij ${store.name}`;
  const actionId = await run(() => applyChanges(state.hid, state.user, { type: 'compound', label, changes }));
  if (actionId) toast(label, actionId);
}

async function removeSection(sec) {
  if (!sec || isOverig(sec)) return;
  // Items gaan naar de categorie waar de sectie onder viel (of Overig).
  const target = (sec.custom && sectionByKey(sec.parentKey)) || fallbackSection();
  const moved = itemsInSection(sec.id);
  const changes = [{ col: 'sections', id: sec.id, before: { deleted: false }, after: { deleted: true } }];
  for (const i of moved) changes.push({ col: 'items', id: i.id, before: { sectionId: sec.id }, after: { sectionId: target.id } });
  const label = `${sec.name} ${isStandard(sec) ? 'verborgen' : 'verwijderd'}${moved.length ? ` (${moved.length} naar ${target.name})` : ''}`;
  const actionId = await run(() => applyChanges(state.hid, state.user, { type: 'compound', label, changes }));
  if (actionId) toast(label, actionId);
}

async function resetStandardSections() {
  const changes = [];
  DEFAULT_SECTIONS.forEach((d, i) => {
    const s = state.allSections.find((x) => !x.custom && x.key === d.key);
    if (!s) return;
    const before = { deleted: !!s.deleted, name: s.name, order: s.order ?? 0 };
    const after = { deleted: false, name: d.name, order: i };
    if (before.deleted !== after.deleted || before.name !== after.name || before.order !== after.order) {
      changes.push({ col: 'sections', id: s.id, before, after });
    }
  });
  state.sections
    .filter((s) => s.custom)
    .forEach((s, j) => {
      const order = DEFAULT_SECTIONS.length + j;
      if ((s.order ?? 0) !== order) changes.push({ col: 'sections', id: s.id, before: { order: s.order ?? 0 }, after: { order } });
    });
  if (!changes.length) {
    toast('De standaardsecties staan al goed');
    return;
  }
  const actionId = await run(() =>
    applyChanges(state.hid, state.user, { type: 'compound', label: 'Standaardsecties hersteld', changes }),
  );
  if (actionId) toast('Standaardsecties hersteld', actionId);
}

async function undoById(id) {
  const action = state.activity.find((a) => a.id === id);
  if (!action) {
    toast('Deze actie kan niet meer ongedaan worden gemaakt.');
    return;
  }
  const done = await run(() => undoAction(state.hid, state.user, action));
  if (done !== null) toast(`Ongedaan: ${action.label}`);
}

// ---------- data koppelen ----------

function startHousehold(hid) {
  stopWatching();
  state.hid = hid;
  state.loaded = new Set();
  state.mounted = false;
  renderBoot('Lijsten laden…');

  const fatal = (err) => {
    console.error(err);
    stopWatching();
    renderError(err);
  };
  const got = (key) => {
    state.loaded.add(key);
    render();
  };

  state.unsubs.push(
    watchHousehold(
      hid,
      (h) => {
        if (!h) {
          stopWatching();
          renderSetup();
          return;
        }
        state.household = h;
        got('household');
      },
      fatal,
    ),
    watchLists(
      hid,
      state.user.uid,
      (lists) => {
        state.lists = lists;
        if (!lists.some((l) => l.id === state.activeListId)) state.activeListId = lists[0]?.id || null;
        got('lists');
      },
      fatal,
    ),
    watchSections(
      hid,
      (s) => {
        state.allSections = s;
        state.sections = s.filter((x) => !x.deleted);
        got('sections');
      },
      fatal,
    ),
    watchStores(hid, (s) => ((state.stores = s), got('stores')), fatal),
    watchChains(hid, (c) => ((state.chains = c), got('chains')), fatal),
    watchItems(hid, state.user.uid, (items) => ((state.items = items), got('items')), fatal),
    watchProducts(
      hid,
      state.user.uid,
      (products) => {
        state.products = new Map(products.map((p) => [p.id, p]));
        got('products');
        renderDatalist();
      },
      fatal,
    ),
    // Undo is een extraatje: als de index nog bouwt, werkt de rest gewoon door.
    watchActivity(
      hid,
      state.user.uid,
      (acts) => {
        state.activity = acts;
        state.activityReady = true;
        render();
      },
      (err) => {
        console.warn('Activiteitenlog nog niet beschikbaar:', err?.message);
        state.activityReady = false;
        render();
      },
    ),
  );
}

onAuthStateChanged(auth, async (user) => {
  stopWatching();
  closeSheetSafe();
  Object.assign(state, {
    user,
    hid: null,
    household: null,
    lists: [],
    sections: [],
    stores: [],
    items: [],
    products: new Map(),
    activity: [],
    activityReady: false,
    loaded: new Set(),
  });

  if (!user) {
    renderLogin();
    return;
  }

  renderBoot('Huishouden laden…');
  try {
    const profile = await getUserProfile(user.uid);
    if (!profile?.householdId) {
      renderSetup();
      return;
    }
    startHousehold(profile.householdId);
  } catch (err) {
    console.error(err);
    renderError(err);
  }
});

function closeSheetSafe() {
  state.sheet = null;
  document.body.classList.remove('sheet-open');
}

// ---------- interactie ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action], [data-nav], [data-list], [data-store], [data-theme-set]');
  if (!el || el.disabled) return;

  if (el.dataset.nav) {
    state.view = el.dataset.nav;
    state.renamingStoreId = null;
    state.layoutStoreId = null;
    state.layoutNewSection = null;
    state.importDraft = null;
    state.optSub = null;
    state.chainView = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (el.dataset.list) {
    state.activeListId = el.dataset.list;
    datalistSig = '';
    renderDatalist();
    render();
    return;
  }
  if (el.dataset.store) {
    state.activeStoreByList[activeList().id] = el.dataset.store;
    state.cartOpen = false;
    render();
    return;
  }
  if (el.dataset.themeSet) {
    setThemePref(el.dataset.themeSet);
    render();
    return;
  }

  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'login': {
      el.disabled = true;
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
      } catch (err) {
        console.error(err);
        renderLogin(friendlyError(err) || '');
      }
      break;
    }
    case 'logout':
      await signOut(auth);
      break;
    case 'reload':
      location.reload();
      break;

    case 'toggle': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      const actionId = await run(() => setItemChecked(state.hid, state.user, item, !item.checked));
      if (actionId) toast(`${item.name} ${item.checked ? 'teruggezet' : 'afgevinkt'}`, actionId);
      break;
    }
    case 'edit-item': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      openSheet({
        mode: 'item-edit',
        title: `${item.name} bewerken`,
        itemId: item.id,
        name: item.name,
        qty: item.qty ?? '',
        unit: item.unit || 'st',
        storeId: item.storeId,
        sectionId: displaySection(storeById(item.storeId), item.sectionId)?.id || fallbackSection()?.id,
      });
      break;
    }
    case 'toggle-cart':
      state.cartOpen = !state.cartOpen;
      render();
      break;
    case 'undo': {
      const a = latestUndoable();
      if (a) await undoById(a.id);
      break;
    }
    case 'undo-one':
      document.getElementById('toast-root').innerHTML = '';
      await undoById(id);
      break;

    case 'stores-sheet':
      openSheet({ mode: 'stores', title: 'Winkels' });
      break;
    case 'pick-store':
      state.activeStoreByList[activeList().id] = id;
      state.cartOpen = false;
      closeSheet();
      render();
      break;

    case 'sheet-close':
      closeSheet();
      break;
    case 'sheet-store': {
      const sh = state.sheet;
      const st = storeById(id);
      sh.storeId = id;
      sh.error = '';
      if (!sh.sectionTouched || !sectionAvailable(st, sh.sectionId)) sh.sectionId = resolveSection(sheetProduct(sh), st, sh.name);
      renderSheet();
      break;
    }
    case 'sheet-add-section': {
      const sh = state.sheet;
      if (!sh) break;
      const chain = chainOf(storeById(sh.storeId));
      const onlyChain = sh.newSectionOnlyStore !== false && chain;
      let parent = guessParentKey(sh.newSectionName || '');
      if (parent === 'overig') parent = guessSectionKey(sh.name || '');
      const newId = await createSection(sh.newSectionName, onlyChain ? chain.id : null, parent);
      if (newId && state.sheet) {
        Object.assign(state.sheet, { sectionId: newId, sectionTouched: true, newSectionOpen: false, newSectionName: '' });
        renderSheet();
      }
      break;
    }
    case 'confirm-disable': {
      const sh = state.sheet;
      closeSheet();
      const st = storeById(sh?.storeId);
      if (st) await setSectionEnabled(st, sh.sectionId, false);
      break;
    }
    case 'sec-toggle': {
      const st = storeById(state.layoutStoreId);
      if (!st) break;
      const isOff = (st.disabledSectionIds || []).includes(id);
      if (isOff) {
        await setSectionEnabled(st, id, true);
        break;
      }
      const count = itemsInSection(id, st.id).length;
      if (count) openSheet({ mode: 'confirm-disable', title: 'Sectie uitzetten', storeId: st.id, sectionId: id, count });
      else await setSectionEnabled(st, id, false);
      break;
    }
    case 'chain-open':
      state.view = 'winkels';
      state.chainView = id;
      state.layoutStoreId = null;
      state.optSub = null;
      render();
      window.scrollTo(0, 0);
      break;
    case 'chain-back':
      state.chainView = null;
      render();
      break;
    case 'layout-new-section-cancel':
      state.layoutNewSection = null;
      render();
      break;
    case 'opt-sections':
      state.optSub = 'secties';
      render();
      window.scrollTo(0, 0);
      break;
    case 'opt-back':
      state.optSub = null;
      render();
      break;
    case 'sections-reset':
      await resetStandardSections();
      break;
    case 'section-delete':
      await removeSection(sectionById(id));
      break;
    case 'section-up':
    case 'section-down': {
      const pool = state.sections.filter((s) => (el.dataset.list === 'std' ? isStandard(s) : s.custom && !s.chainId && !s.storeId)).sort(bySectionSort);
      const idx = pool.findIndex((s) => s.id === id);
      const other = pool[el.dataset.action === 'section-up' ? idx - 1 : idx + 1];
      if (idx < 0 || !other) break;
      const ids = state.sections.map((s) => s.id);
      const a1 = ids.indexOf(id);
      const b1 = ids.indexOf(other.id);
      [ids[a1], ids[b1]] = [ids[b1], ids[a1]];
      await run(() => setSectionOrder(state.hid, state.user, ids));
      break;
    }
    case 'sheet-new-store':
      state.sheet.newStoreOpen = true;
      renderSheet();
      document.getElementById('sheet-new-store')?.focus();
      break;
    case 'sheet-add-store': {
      const newId = await createStore(state.sheet?.newStoreName || '');
      if (newId && state.sheet) {
        Object.assign(state.sheet, { storeId: newId, newStoreOpen: false, newStoreName: '', error: '' });
        renderSheet();
      }
      break;
    }
    case 'sheet-delete': {
      const item = state.items.find((i) => i.id === state.sheet?.itemId);
      closeSheet();
      if (!item) break;
      const actionId = await run(() => deleteItem(state.hid, state.user, item));
      if (actionId) toast(`${item.name} verwijderd`, actionId);
      break;
    }

    case 'store-up':
    case 'store-down': {
      const ids = state.stores.map((s) => s.id);
      const idx = ids.indexOf(id);
      const to = el.dataset.action === 'store-up' ? idx - 1 : idx + 1;
      if (idx < 0 || to < 0 || to >= ids.length) break;
      [ids[idx], ids[to]] = [ids[to], ids[idx]];
      await run(() => setStoreOrder(state.hid, state.user, ids));
      break;
    }
    case 'store-rename':
      state.renamingStoreId = id;
      render();
      document.getElementById(`rename-${id}`)?.select();
      break;
    case 'layout-open':
      state.chainView = null;
      state.layoutStoreId = id;
      render();
      window.scrollTo(0, 0);
      break;
    case 'layout-back':
      state.layoutStoreId = null;
      state.layoutNewSection = null;
      state.importDraft = null;
      render();
      break;
    case 'import-open':
      state.importDraft = { storeId: state.layoutStoreId, text: '', preview: null, replace: true, error: '' };
      render();
      document.getElementById('import-text')?.focus();
      break;
    case 'import-cancel':
      state.importDraft = null;
      render();
      break;
    case 'import-back':
      if (state.importDraft) state.importDraft.preview = null;
      render();
      break;
    case 'import-preview': {
      const st = storeById(state.layoutStoreId);
      const dr = state.importDraft;
      if (!st || !dr) break;
      const preview = buildImportPreview(st, dr.text);
      if (!preview.length) {
        dr.error = 'Geen blokken gevonden. Zet elk blok op een eigen regel.';
      } else {
        dr.error = '';
        dr.preview = preview;
      }
      render();
      break;
    }
    case 'import-apply': {
      const st = storeById(state.layoutStoreId);
      if (st && state.importDraft?.preview) await applyImport(st);
      break;
    }
    case 'layout-add-group': {
      const store = storeById(state.layoutStoreId);
      if (!store) break;
      const layout = storeLayout(store);
      const name = `Gangpad ${layout.length + 1}`;
      await saveLayout(store, [...layout, { id: newGroupId(), name, sectionIds: [] }], `${name} toegevoegd aan ${store.name}`);
      break;
    }
    case 'layout-up':
    case 'layout-down': {
      const store = storeById(state.layoutStoreId);
      if (!store) break;
      const layout = storeLayout(store);
      const idx = layout.findIndex((g) => g.id === id);
      const to = el.dataset.action === 'layout-up' ? idx - 1 : idx + 1;
      if (idx < 0 || to < 0 || to >= layout.length) break;
      [layout[idx], layout[to]] = [layout[to], layout[idx]];
      await saveLayout(store, layout, `Volgorde ${store.name} aangepast`);
      break;
    }
    case 'layout-delete': {
      const store = storeById(state.layoutStoreId);
      if (!store) break;
      const layout = storeLayout(store);
      const g = layout.find((x) => x.id === id);
      const actionId = await saveLayout(store, layout.filter((x) => x.id !== id), `${g?.name || 'Blok'} verwijderd uit ${store.name}`);
      if (actionId) toast(`${g?.name || 'Blok'} verwijderd`, actionId);
      break;
    }
    case 'layout-sec-remove':
    case 'layout-sec-left': {
      const store = storeById(state.layoutStoreId);
      if (!store) break;
      const layout = storeLayout(store).map((g) => {
        if (g.id !== el.dataset.group) return g;
        const ids = [...g.sectionIds];
        const i = ids.indexOf(id);
        if (i < 0) return g;
        if (el.dataset.action === 'layout-sec-remove') ids.splice(i, 1);
        else if (i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        return { ...g, sectionIds: ids };
      });
      await saveLayout(store, layout, `Indeling ${store.name} aangepast`);
      break;
    }
    case 'cancel-rename':
      state.renamingStoreId = null;
      render();
      break;
    case 'store-delete': {
      const store = storeById(id);
      if (!store) break;
      const open = liveItems().filter((i) => i.storeId === id).length;
      if (open) {
        toast(`Er staan nog ${open} items bij ${store.name}. Verplaats of verwijder die eerst.`);
        break;
      }
      const actionId = await run(() => updateStore(state.hid, state.user, store, { deleted: true }, `Winkel ${store.name} verwijderd`));
      if (actionId) toast(`${store.name} verwijderd`, actionId);
      break;
    }
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;

  // Indeling importeren: keuze per regel en vervangen/erachter.
  if (t.dataset.importRow && state.importDraft?.preview) {
    const row = state.importDraft.preview.flatMap((b) => b.rows).find((r) => r.key === t.dataset.importRow);
    if (row) row.choice = t.value;
    render();
    return;
  }
  if (t.dataset.importReplace !== undefined && state.importDraft) {
    state.importDraft.replace = t.checked;
    return;
  }

  // Item-sheet: sectie kiezen of een nieuwe maken.
  if (state.sheet && t.dataset.field === 'sectionId') {
    if (t.value === '__new__') {
      state.sheet.newSectionOpen = true;
      renderSheet();
      document.getElementById('sheet-new-section')?.focus();
    } else {
      state.sheet.sectionId = t.value;
      state.sheet.sectionTouched = true;
    }
    return;
  }
  if (state.sheet && t.dataset.field === 'newSectionOnlyStore') {
    state.sheet.newSectionOnlyStore = t.checked;
    return;
  }

  // Sectiebeheer (Opties → Secties).
  if (t.dataset.sectionName) {
    const sec = sectionById(t.dataset.sectionName);
    const name = capitalize(t.value).slice(0, 40);
    if (!sec || !name || name === sec.name) {
      if (sec && !name) t.value = sec.name;
      return;
    }
    const actionId = await run(() =>
      applyChanges(state.hid, state.user, {
        type: 'compound',
        label: `${sec.name} hernoemd naar ${name}`,
        changes: [{ col: 'sections', id: sec.id, before: { name: sec.name }, after: { name } }],
      }),
    );
    if (actionId) toast(`Hernoemd naar ${name}`, actionId);
    return;
  }
  if (t.dataset.sectionParent) {
    const sec = sectionById(t.dataset.sectionParent);
    const parentKey = t.value;
    if (!sec || sec.parentKey === parentKey) return;
    const label = `${sec.name} valt nu onder ${sectionByKey(parentKey)?.name}`;
    const actionId = await run(() =>
      applyChanges(state.hid, state.user, {
        type: 'compound',
        label,
        changes: [{ col: 'sections', id: sec.id, before: { parentKey: sec.parentKey || 'overig' }, after: { parentKey } }],
      }),
    );
    if (actionId) toast(label, actionId);
    return;
  }
  if (t.dataset.sectionChain) {
    const sec = sectionById(t.dataset.sectionChain);
    const chainId = t.value || null;
    if (!sec || (sec.chainId || null) === chainId) return;
    const label = `${sec.name} geldt nu voor ${chainId ? `alleen ${chainById(chainId)?.name}` : 'alle winkels'}`;
    const actionId = await run(() =>
      applyChanges(state.hid, state.user, {
        type: 'compound',
        label,
        changes: [{ col: 'sections', id: sec.id, before: { chainId: sec.chainId || null }, after: { chainId } }],
      }),
    );
    if (actionId) toast(label, actionId);
    return;
  }
  if (t.dataset.chainName) {
    const chain = chainById(t.dataset.chainName);
    const name = capitalize(t.value).slice(0, 40);
    if (!chain || !name || name === chain.name) {
      if (chain && !name) t.value = chain.name;
      return;
    }
    const actionId = await run(() =>
      applyChanges(state.hid, state.user, {
        type: 'compound',
        label: `Keten ${chain.name} hernoemd naar ${name}`,
        changes: [{ col: 'chains', id: chain.id, before: { name: chain.name }, after: { name } }],
      }),
    );
    if (actionId) toast(`Hernoemd naar ${name}`, actionId);
    return;
  }
  if (t.dataset.storeChain) {
    const store = storeById(t.dataset.storeChain);
    if (!store) return;
    let chainId = t.value;
    if (chainId === '__new__') {
      chainId = await run(() => addChain(state.hid, state.user, store.name));
      if (!chainId) return;
    }
    if (chainId === store.chainId) return;
    const label = `${store.name} hoort nu bij ${chainById(chainId)?.name || store.name}`;
    const actionId = await run(() =>
      applyChanges(state.hid, state.user, {
        type: 'compound',
        label,
        changes: [{ col: 'stores', id: store.id, before: { chainId: store.chainId || null }, after: { chainId } }],
      }),
    );
    if (actionId) toast(label, actionId);
    return;
  }

  // Looproute-editor.
  const store = storeById(state.layoutStoreId);
  if (!store) return;
  if (t.dataset.layoutAdd && t.value === '__new__') {
    state.layoutNewSection = t.dataset.layoutAdd;
    render();
    document.getElementById(`lns-${t.dataset.layoutAdd}`)?.focus();
    return;
  }
  if (t.dataset.layoutAdd && t.value) {
    const sid = t.value;
    const layout = storeLayout(store).map((g) =>
      g.id === t.dataset.layoutAdd ? { ...g, sectionIds: [...g.sectionIds.filter((x) => x !== sid), sid] } : { ...g, sectionIds: g.sectionIds.filter((x) => x !== sid) },
    );
    await saveLayout(store, layout, `${sectionById(sid)?.name} ingedeeld bij ${store.name}`);
    return;
  }
  if (t.dataset.layoutName) {
    const name = t.value.trim().slice(0, 40);
    const layout = storeLayout(store);
    const g = layout.find((x) => x.id === t.dataset.layoutName);
    if (!g || !name || name === g.name) {
      if (g && !name) t.value = g.name;
      return;
    }
    await saveLayout(store, layout.map((x) => (x.id === g.id ? { ...x, name } : x)), `${g.name} hernoemd naar ${name}`);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.dataset?.importText !== undefined && state.importDraft) {
    state.importDraft.text = e.target.value;
    return;
  }
  const field = e.target.dataset?.field;
  if (field === 'sectionId' || field === 'newSectionOnlyStore') return;
  if (field && state.sheet) state.sheet[field] = e.target.value;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sheet) closeSheet();
  if (e.key === 'Enter' && (e.target.dataset?.layoutName || e.target.dataset?.sectionName || e.target.dataset?.chainName)) e.target.blur();
  // Enter in een mini-formulier binnen het sheet: niet het hele item opslaan.
  if (e.key === 'Enter' && e.target.dataset?.field === 'newSectionName') {
    e.preventDefault();
    document.querySelector('[data-action="sheet-add-section"]')?.click();
  }
  if (e.key === 'Enter' && e.target.dataset?.field === 'newStoreName') {
    e.preventDefault();
    document.querySelector('[data-action="sheet-add-store"]')?.click();
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;

  if (kind === 'setup') {
    const name = new FormData(form).get('name').toString().trim();
    if (!name) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Bezig…';
    try {
      const hid = await createHousehold(state.user, name);
      startHousehold(hid);
    } catch (err) {
      console.error(err);
      renderSetup(friendlyError(err) || '');
    }
    return;
  }

  if (kind === 'quick-add') {
    const input = form.querySelector('input[name="q"]');
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    const ok = await quickAdd(text);
    if (!ok) input.value = text;
    if (!state.sheet) input.focus();
    return;
  }

  if (kind === 'add-store') {
    const input = form.querySelector('input[name="name"]');
    const chainSel = form.querySelector('select[name="chain"]');
    const newId = await createStore(input.value, chainSel?.value || null);
    input.value = '';
    if (newId && state.sheet?.mode === 'stores') {
      state.activeStoreByList[activeList().id] = newId;
      closeSheet();
      render();
    }
    return;
  }

  if (kind === 'add-branch') {
    const input = form.querySelector('input[name="name"]');
    await createStore(input.value, form.dataset.chain);
    input.value = '';
    return;
  }

  if (kind === 'add-chain-section') {
    const input = form.querySelector('input[name="name"]');
    const parent = form.querySelector('select[name="parent"]').value;
    await createSection(input.value, form.dataset.chain, parent);
    input.value = '';
    return;
  }

  if (kind === 'layout-new-section') {
    const store = storeById(state.layoutStoreId);
    const groupId = form.dataset.group;
    const name = form.querySelector('input[name="name"]').value;
    const onlyChain = form.querySelector('input[name="onlyStore"]')?.checked;
    state.layoutNewSection = null;
    if (!store) return;
    const sid = await createSection(name, onlyChain ? store.chainId : null);
    if (sid) {
      const fresh = storeById(store.id);
      const layout = storeLayout(fresh).map((g) =>
        g.id === groupId ? { ...g, sectionIds: [...g.sectionIds.filter((x) => x !== sid), sid] } : { ...g, sectionIds: g.sectionIds.filter((x) => x !== sid) },
      );
      // De nieuwe sectie is direct beschikbaar; layout zelf filtert hem nog niet weg.
      const target = layout.find((g) => g.id === groupId);
      if (target && !target.sectionIds.includes(sid)) target.sectionIds.push(sid);
      await saveLayout(fresh, layout, `${capitalize(name)} ingedeeld bij ${store.name}`);
    } else {
      render();
    }
    return;
  }

  if (kind === 'add-section') {
    const input = form.querySelector('input[name="name"]');
    const parent = form.querySelector('select[name="parent"]').value;
    await createSection(input.value, null, parent);
    input.value = '';
    return;
  }

  if (kind === 'rename-store') {
    const store = storeById(form.dataset.id);
    const name = capitalize(form.querySelector('input[name="name"]').value).slice(0, 40);
    state.renamingStoreId = null;
    if (store && name && name !== store.name) {
      const actionId = await run(() => updateStore(state.hid, state.user, store, { name }, `${store.name} hernoemd naar ${name}`));
      if (actionId) toast(`Hernoemd naar ${name}`, actionId);
    }
    render();
    return;
  }

  if (kind === 'item') {
    await saveSheetItem();
  }
});

// ---------- PWA: service worker + update-balk ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Lokaal geen service worker: anders zie je je eigen wijzigingen niet.
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (isLocal) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    return;
  }

  let userAskedReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAskedReload) location.reload();
  });

  const bar = document.getElementById('update-bar');
  const showUpdate = (worker) => {
    bar.hidden = false;
    bar.querySelector('[data-action="apply-update"]').onclick = () => {
      userAskedReload = true;
      worker.postMessage('SKIP_WAITING');
    };
  };

  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  });
}

initTheme();
registerServiceWorker();
