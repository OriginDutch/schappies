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
  createInvite,
  getInvite,
  inviteStatus,
  watchMyInvites,
  revokeInvite,
  joinHousehold,
  removeMember,
  normalizeCode,
  isMemberOf,
  checkHouseholdAccess,
  finishRound,
  watchTrips,
  commitCompound,
  newItemDoc,
  nowTs,
  watchTrashItems,
  purgeTrash,
  purgeTripLines,
  tripLine,
  DEFAULT_SECTIONS,
} from './data.js';
import {
  UNITS,
  parseQuickAdd,
  productKey,
  guessSectionKey,
  guessParentKey,
  formatItemQty,
  capitalize,
  parseLayoutText,
  nameSimilarity,
} from './parse.js';
import { initTheme, getThemePref, setThemePref } from './theme.js';

const APP_VERSION = self.APP_VERSION || 'dev';
const $app = document.getElementById('app');

// ---------- uitnodigingslink (?join=CODE) ----------
// De code wordt bewaard tot na het inloggen, en uit de adresbalk gehaald.
const JOIN_KEY = 'bs.join';
const pendingJoin = () => {
  try {
    return sessionStorage.getItem(JOIN_KEY);
  } catch {
    return null;
  }
};
const setPendingJoin = (code) => {
  try {
    sessionStorage.setItem(JOIN_KEY, code);
  } catch {
    /* zonder opslag werkt alleen de huidige sessie */
  }
};
const clearJoin = () => {
  try {
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    /* niets */
  }
};
(() => {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (!code) return;
  setPendingJoin(code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
  params.delete('join');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
})();

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
  profile: null,
  invites: [],
  joinInvite: null,
  optSub: null,
  allSections: [],
  chains: [],
  chainView: null,
  trips: [],
  tripsReady: false,
  openTripId: null,
  productQuery: '',
  allStores: [],
  trashItems: [],
  trashReady: false,
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
  state.loaded = new Set();
  stopInvitesWatch();
  stopTripsWatch();
  stopTrashWatch();
  purgeDone = false;
  linePurgeDone = false;
}

// Uitnodigingen pas ophalen als je het ledenscherm (Opties) opent. Een
// geweigerde listener kan de Firestore-SDK laten crashen (b815), dus deze
// hoort niet bij het opstarten van de app.
let invitesUnsub = null;
function ensureInvitesWatch() {
  if (invitesUnsub || !state.user) return;
  invitesUnsub = watchMyInvites(
    state.user.uid,
    (inv) => {
      state.invites = inv;
      if (state.view === 'opties') render();
    },
    (err) => {
      console.warn('Uitnodigingen niet beschikbaar:', err?.message);
      // Niet opnieuw proberen tot de volgende keer dat de app start.
    },
  );
}
// Historie pas laden als je hem opent (scheelt reads bij elke start).
let tripsUnsub = null;
function ensureTripsWatch() {
  if (tripsUnsub || !state.user || !state.hid) return;
  tripsUnsub = watchTrips(
    state.hid,
    state.user.uid,
    (trips) => {
      state.trips = trips;
      state.tripsReady = true;
      maybePurgeLines();
      if (state.view === 'historie' || state.view === 'opties') render();
    },
    (err) => {
      console.warn('Historie niet beschikbaar:', err?.message);
      state.tripsError = friendlyError(err);
      if (state.view === 'historie') render();
    },
  );
}
function stopTripsWatch() {
  if (tripsUnsub) tripsUnsub();
  tripsUnsub = null;
  state.trips = [];
  state.tripsReady = false;
  state.tripsError = null;
}

// Prullenbak: verwijderde items. Ook nodig voor het opruimen na een week.
let trashUnsub = null;
function ensureTrashWatch() {
  if (trashUnsub || !state.user || !state.hid) return;
  trashUnsub = watchTrashItems(
    state.hid,
    state.user.uid,
    (items) => {
      state.trashItems = items;
      const first = !state.trashReady;
      state.trashReady = true;
      if (first) maybePurge();
      if (state.view === 'opties') render();
    },
    (err) => console.warn('Prullenbak niet beschikbaar:', err?.message),
  );
}
function stopTrashWatch() {
  if (trashUnsub) trashUnsub();
  trashUnsub = null;
  state.trashItems = [];
  state.trashReady = false;
}

function stopInvitesWatch() {
  if (invitesUnsub) invitesUnsub();
  invitesUnsub = null;
  state.invites = [];
}

function friendlyError(err) {
  const code = err?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
  if (code === 'auth/popup-blocked') return 'De pop-up werd geblokkeerd. Sta pop-ups toe voor deze site en probeer opnieuw.';
  if (code === 'auth/unauthorized-domain')
    return `Dit domein (${location.hostname}) mag nog niet inloggen. Voeg het toe in Firebase → Authentication → Settings → Authorized domains.`;
  if (code === 'auth/network-request-failed' || code === 'unavailable') return 'Geen verbinding. Check je internet en probeer opnieuw.';
  if (code === 'permission-denied') return 'Geen toegang. Zijn de nieuwste security rules gedeployed?';
  if (code === 'round-changed') return err.message;
  if (code === 'too-big') return 'Te veel items in één keer. Rond de ronde in delen af.';
  if (code === 'not-found') return 'Dat kan niet meer: het is definitief verwijderd (langer dan een week in de prullenbak).';
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
// Keuzelijst met secties in looproute-volgorde: gangpaden als kopjes, daarna
// wat nog niet is ingedeeld, en Overig altijd onderaan.
function sectionOptions(store, selectedId) {
  const opt = (sec) => `<option value="${sec.id}"${sec.id === selectedId ? ' selected' : ''}>${esc(sec.name)}</option>`;
  const avail = sectionsForStore(store);
  const overig = avail.filter(isOverig);
  const rest = avail.filter((x) => !isOverig(x));
  const layout = storeLayout(store).filter((g) => g.sectionIds.length);
  if (!layout.length) return [...rest, ...overig].map(opt).join('');
  const placed = new Set();
  const parts = layout.map((g) => {
    const secs = g.sectionIds.map(sectionById).filter((x) => x && !isOverig(x) && !placed.has(x.id));
    secs.forEach((x) => placed.add(x.id));
    if (!secs.length) return '';
    // Blok met één sectie van dezelfde naam (bijv. "Fruit"): geen kopje nodig.
    if (secs.length === 1 && secs[0].name.toLocaleLowerCase('nl') === String(g.name || '').toLocaleLowerCase('nl')) return opt(secs[0]);
    return `<optgroup label="${esc(g.name || 'Blok')}">${secs.map(opt).join('')}</optgroup>`;
  });
  const loose = rest.filter((x) => !placed.has(x.id));
  if (loose.length) parts.push(`<optgroup label="Niet ingedeeld">${loose.map(opt).join('')}</optgroup>`);
  return parts.join('') + overig.map(opt).join('');
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
  if (!root) {
    // App nog aan het laden: tonen zodra de schil er staat.
    state.pendingToast = [message, actionId];
    return;
  }
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
        <p class="muted">${
          pendingJoin()
            ? 'Je bent uitgenodigd voor een huishouden. Log in met Google om mee te doen.'
            : 'Log in om je lijsten te openen en te synchroniseren.'
        }</p>
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
          <input class="input" name="name" required maxlength="60" autocomplete="off" autocapitalize="sentences" value="Thuis">
        </label>
        <button class="btn btn-primary btn-block" type="submit">Huishouden aanmaken</button>
        <button class="btn btn-ghost btn-block" type="button" data-action="logout">Ander account gebruiken</button>
        ${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
      </form>
      <form class="auth-card" data-form="join-code">
        <h2 class="card-title">Uitgenodigd?</h2>
        <p class="muted small">Vul de code in die je hebt gekregen.</p>
        <div class="inline-form">
          <label class="sr-only" for="join-code-setup">Uitnodigingscode</label>
          <input id="join-code-setup" class="input mono code-input" name="code" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="ABC234">
          <button class="btn btn-primary" type="submit">Meedoen</button>
        </div>
      </form>
    </div>`;
  $app.querySelector('input[name="name"]').select();
}

function renderJoin(invite, message = '') {
  state.mounted = false;
  const status = inviteStatus(invite);
  const otherHousehold = state.profile?.householdId && state.profile.householdId !== invite?.hid;
  $app.innerHTML = `
    <div class="center-screen">
      <div class="auth-card">
        <p class="eyebrow">uitnodiging</p>
        ${
          status === 'geldig'
            ? `<h1 class="auth-title">${esc(invite.householdName || 'Huishouden')}</h1>
              <p class="muted">${esc(invite.createdByName || 'Iemand')} nodigt je uit om mee te doen. Je deelt dan de gedeelde lijst, winkels en looproutes. Je krijgt je eigen Privé-lijst.</p>
              ${otherHousehold ? '<p class="muted small">Je zit nu in een ander huishouden. Als je meedoet, stap je over. Je huidige huishouden blijft gewoon bestaan.</p>' : ''}
              <button class="btn btn-primary btn-block" data-action="join-accept">Meedoen</button>
              <button class="btn btn-ghost btn-block" data-action="join-decline">Niet nu</button>`
            : `<h1 class="auth-title">Werkt niet</h1>
              <p class="muted">Deze uitnodiging is ${esc(status)}. Vraag om een nieuwe.</p>
              <button class="btn btn-primary btn-block" data-action="join-decline">Verder</button>`
        }
        ${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
      </div>
    </div>`;
}

// Uitnodiging openen (na inloggen, via link of ingevulde code).
async function showJoin(code) {
  renderBoot('Uitnodiging openen…');
  let invite = null;
  try {
    invite = await getInvite(code);
  } catch (err) {
    console.error(err);
  }
  // Echt al lid (niet alleen volgens je profiel, want een verwijderd lid wijst nog
  // naar het oude huishouden): gewoon door naar de lijsten.
  if (invite && (await isMemberOf(invite.hid, state.user.uid))) {
    clearJoin();
    state.profile = { ...(state.profile || {}), householdId: invite.hid };
    startHousehold(invite.hid);
    return;
  }
  state.joinInvite = invite;
  renderJoin(invite);
}

function continueWithoutJoin() {
  clearJoin();
  state.joinInvite = null;
  if (state.profile?.householdId) startHousehold(state.profile.householdId);
  else renderSetup();
}

// Server bevestigt: jij kunt niet (meer) bij dit huishouden.
function renderNoAccess() {
  state.mounted = false;
  $app.innerHTML = `
    <div class="center-screen">
      <div class="auth-card">
        <h1 class="auth-title">Geen toegang</h1>
        <p class="error" role="alert">Je bent geen lid (meer) van dit huishouden, of het bestaat niet meer.</p>
        <button class="btn btn-primary btn-block" data-action="reload">Opnieuw proberen</button>
        <button class="btn btn-ghost btn-block" data-action="choose-household">Ander huishouden kiezen</button>
        <button class="btn btn-ghost btn-block" data-action="logout">Uitloggen</button>
      </div>
    </div>`;
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
  { id: 'producten', label: 'Producten' },
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
            placeholder="Product toevoegen…" enterkeyhint="done" autocomplete="off" maxlength="80" autocapitalize="sentences">
          <button class="btn btn-primary addbar-btn" type="submit" aria-label="Toevoegen">${icon('plus', 22)}</button>
          <datalist id="product-names"></datalist>
        </form>
      </main>
    </div>
    <div id="sheet-root"></div>
    <div id="toast-root" class="toast-root" aria-live="polite"></div>`;
  state.mounted = true;
  if (state.pendingToast) {
    const [msg, act] = state.pendingToast;
    state.pendingToast = null;
    setTimeout(() => toast(msg, act), 0);
  }
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
  ensureTrashWatch();
  renderNav();
  renderView();
  renderAddbar();
  syncHistory();
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
  else if (state.view === 'opties')
    el.innerHTML = state.optSub === 'secties' ? viewSecties() : state.optSub === 'prullenbak' ? viewPrullenbak() : viewOpties();
  else if (state.view === 'historie') el.innerHTML = viewHistorie();
  else if (state.view === 'producten') el.innerHTML = viewProducten();
  else el.innerHTML = viewPlaceholder('', '');
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
    .filter((p) => !p.deleted && (!list || p.ownerUid === SHARED || p.ownerUid === list.ownerUid))
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
  const withItems = state.stores.find((s) => counts[s.id]?.total > 0);
  return (withOpen || withItems || state.stores[0]).id;
}

function latestUndoable() {
  const undone = new Set(state.activity.filter((a) => a.type === 'undo').map((a) => a.undoOf));
  return state.activity.find((a) => a.by === state.user.uid && UNDOABLE.has(a.type) && !undone.has(a.id)) || null;
}

function itemRow(item) {
  const qty = formatItemQty(item);
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
          <input id="first-store" class="input" name="name" placeholder="Bijv. Lidl" maxlength="40" required autocapitalize="sentences">
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

  // Een winkel blijft in de balk zolang er iets op staat (ook alles afgevinkt),
  // anders kom je niet meer bij "Ronde afronden".
  const barStores = state.stores.filter((s) => counts[s.id]?.total > 0 || s.id === storeId);
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
            <p class="muted">Rond de ronde af: wat je gehaald hebt gaat naar de historie.</p>
            <button class="btn btn-primary btn-block" data-action="finish-start">Ronde afronden</button>
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
    }

    ${
      total && open.length
        ? `<div class="finish-row">
            <button class="btn btn-ghost btn-block" data-action="finish-start">Klaar bij ${esc(store?.name || '')}</button>
          </div>`
        : ''
    }`;
}

// ---------- historie ----------

function formatWhen(ts) {
  const ms = ts?.toMillis ? ts.toMillis() : Number(ts) || 0;
  return new Date(ms).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const tripById = (id) => state.trips.find((t) => t.id === id) || null;

function viewHistorie() {
  ensureTripsWatch();
  const head = `<header class="page-head"><h1 class="page-title">Historie</h1></header>`;
  if (state.tripsError && !state.tripsReady) {
    return `${head}<section class="card"><p class="error" role="alert">${esc(state.tripsError)}</p></section>`;
  }
  if (!state.tripsReady) return `${head}<p class="muted">Laden…</p>`;
  if (!state.trips.some((t) => (t.items || []).length)) {
    return `${head}
      <section class="card empty">
        <h2 class="card-title">Nog geen rondes</h2>
        <p class="muted">Rond een ronde af op je lijst ("Klaar bij …"), dan komt hij hier te staan.</p>
      </section>`;
  }
  return `${head}
    <div class="trips">
      ${state.trips.filter((t) => (t.items || []).length).map(tripCard).join('')}
    </div>`;
}

function tripCard(t) {
  const open = state.openTripId === t.id;
  const items = t.items || [];
  const priv = t.ownerUid !== SHARED;
  return `
    <section class="card trip${open ? ' is-open' : ''}">
      <button class="trip-head" data-action="trip-toggle" data-id="${t.id}" aria-expanded="${open}">
        <span class="trip-title">${esc(t.storeName || storeById(t.storeId)?.name || 'Winkel')}${priv ? ' <span class="tag">privé</span>' : ''}</span>
        <span class="trip-meta muted small">${esc(formatWhen(t.finishedAt))} · ${items.length} ${items.length === 1 ? 'item' : 'items'}</span>
        <span class="trip-chevron">${icon(open ? 'up' : 'down', 18)}</span>
      </button>
      ${
        open
          ? `<div class="trip-body">
              <p class="muted small">Afgerond door ${esc(t.finishedByName || memberName(t.finishedBy))}</p>
              <div class="trip-items">
                ${items
                  .map((line) => {
                    const qty = formatItemQty(line);
                    return `<div class="trip-item">
                      <div class="trip-item-main">
                        <span class="item-name">${esc(line.name)}</span>
                        ${qty ? `<span class="item-qty">${esc(qty)}</span>` : ''}
                        <span class="trip-by muted small">${line.added ? 'later toegevoegd' : `✓ ${esc(line.checkedByName || memberName(line.checkedBy) || '')}`}</span>
                      </div>
                      <button class="btn btn-ghost btn-sm" data-action="trip-again" data-id="${t.id}" data-line="${esc(line.lineId)}">Nog een keer</button>
                      <button class="icon-btn icon-btn-quiet" data-action="trip-item-edit" data-id="${t.id}" data-line="${esc(line.lineId)}" aria-label="${esc(line.name)} aanpassen">${icon('edit', 18)}</button>
                    </div>`;
                  })
                  .join('')}
              </div>
              <button class="btn btn-ghost btn-sm" data-action="trip-add" data-id="${t.id}">+ Vergeten item toevoegen</button>
            </div>`
          : ''
      }
    </section>`;
}

// ---------- producten ----------

function visibleProducts() {
  return [...state.products.values()]
    .filter((p) => !p.deleted && p.name && (p.ownerUid === SHARED || p.ownerUid === state.user.uid))
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
}

function productStats(p) {
  const counts = Object.entries(p.storeCounts || {}).filter(([, n]) => n > 0);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const top = counts.sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    mostlyAt: top ? storeById(top[0])?.name || null : null,
    last: p.lastBoughtAt ? formatWhen(p.lastBoughtAt) : null,
    lastAt: p.lastBoughtStoreId ? storeById(p.lastBoughtStoreId)?.name || null : null,
  };
}

function productRows() {
  const q = state.productQuery.trim().toLocaleLowerCase('nl');
  const all = visibleProducts();
  const shown = q ? all.filter((p) => p.name.toLocaleLowerCase('nl').includes(q)) : all;
  if (!all.length) return `<p class="muted">Nog geen producten. Alles wat je op de lijst zet, onthoudt de app hier.</p>`;
  if (!shown.length) return `<p class="muted">Niks gevonden voor "${esc(state.productQuery)}".</p>`;
  return shown
    .map((p) => {
      const st = productStats(p);
      const meta = [storeById(p.preferredStoreId)?.name, st.total ? `${st.total}× gekocht` : null, p.recurring ? 'iedere keer' : null]
        .filter(Boolean)
        .join(' · ');
      return `<button class="product-row" data-action="product-open" data-id="${esc(p.id)}">
        <span class="product-name">${esc(p.name)}${p.ownerUid !== SHARED ? ' <span class="tag">privé</span>' : ''}</span>
        <span class="muted small">${esc(meta)}</span>
      </button>`;
    })
    .join('');
}

function viewProducten() {
  const n = visibleProducts().length;
  return `
    <header class="page-head"><h1 class="page-title">Producten</h1><span class="muted mono small">${n}</span></header>
    <div class="product-search">
      <label class="sr-only" for="product-search">Zoeken</label>
      <input id="product-search" class="input" type="search" data-product-search value="${esc(state.productQuery)}" placeholder="Zoeken…" autocomplete="off" autocapitalize="off">
    </div>
    <div class="product-list" id="product-list">${productRows()}</div>`;
}

// Per keten de sectie van dit product (zoals de app hem nu zou kiezen).
function productChainRows(p, sh) {
  return state.chains
    .map((c) => {
      const store = storesOfChain(c.id)[0];
      if (!store) return '';
      const current = sh.chainSections[c.id];
      return `<div class="field">
        <label class="field-label" for="pc-${c.id}">Sectie bij ${esc(c.name)}</label>
        <select id="pc-${c.id}" class="input" data-product-chain="${c.id}">
          ${sectionOptions(store, current)}
        </select>
      </div>`;
    })
    .join('');
}

function sheetProductEdit(sh) {
  const p = state.products.get(sh.productId);
  if (!p) return '<div class="sheet-body"><p class="muted">Product niet gevonden.</p></div>';
  const st = productStats(p);
  const general = state.sections.filter((x) => !x.chainId && !x.storeId).sort(bySectionSort);
  return `
    <form class="sheet-body" data-form="product">
      <div>
        <p class="eyebrow">product${p.ownerUid !== SHARED ? ' · privé' : ''}</p>
        <h2 class="sheet-title">${esc(p.name)}</h2>
      </div>
      <dl class="rows product-stats">
        <div class="row"><dt>Gekocht</dt><dd>${st.total ? `${st.total}×` : 'nog nooit'}</dd></div>
        <div class="row"><dt>Laatst</dt><dd>${st.last ? `${esc(st.last)}${st.lastAt ? ` · ${esc(st.lastAt)}` : ''}` : '—'}</dd></div>
        <div class="row"><dt>Meestal bij</dt><dd>${esc(st.mostlyAt || '—')}</dd></div>
      </dl>
      <label class="field">
        <span class="field-label">Naam</span>
        <input class="input" data-field="name" value="${esc(sh.name)}" maxlength="80" required autocapitalize="sentences">
      </label>
      <div class="field">
        <label class="field-label" for="pp-store">Vaste winkel</label>
        <select id="pp-store" class="input" data-field="preferredStoreId">
          ${sh.preferredStoreId ? '' : '<option value="" selected>— geen —</option>'}
          ${state.stores.map((x) => `<option value="${x.id}"${x.id === sh.preferredStoreId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="pp-unit">Eenheid</label>
        <select id="pp-unit" class="input" data-field="defaultUnit">
          ${UNITS.map((u) => `<option value="${u.id}"${u.id === sh.defaultUnit ? ' selected' : ''}>${u.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="pp-section">Algemene sectie</label>
        <select id="pp-section" class="input" data-field="generalSectionId">
          ${[...general.filter((x) => !isOverig(x)), ...general.filter(isOverig)]
            .map((x) => `<option value="${x.id}"${x.id === sh.generalSectionId ? ' selected' : ''}>${esc(x.name)}</option>`)
            .join('')}
        </select>
      </div>
      ${productChainRows(p, sh)}
      <label class="check-row"><input type="checkbox" data-field="recurring"${sh.recurring ? ' checked' : ''}> Iedere keer op de lijst</label>
      ${sh.error ? `<p class="error" role="alert">${esc(sh.error)}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit">Opslaan</button>
      ${
        sh.confirmDelete
          ? (() => {
              const open = liveItems().filter((i) => i.productId === p.id);
              return `<div class="remove-choice">
                ${
                  open.length && TRASH_OPEN_ITEMS
                    ? `<p class="warn small">Let op: ${esc(p.name)} staat nog op de lijst (${open
                        .map((i) => esc(storeById(i.storeId)?.name || '?'))
                        .join(', ')}). ${open.length === 1 ? 'Dat item gaat' : 'Die items gaan'} mee naar de prullenbak.</p>`
                    : ''
                }
                <p class="muted small">${esc(p.name)} blijft ${TRASH_DAYS} dagen in de prullenbak. Daarna is het geheugen van dit product definitief weg.</p>
                <button class="btn btn-ghost btn-block btn-danger" type="button" data-action="product-delete">Ja, naar de prullenbak</button>
              </div>`;
            })()
          : `<button class="btn btn-ghost btn-block btn-danger" type="button" data-action="product-delete-ask">Naar de prullenbak</button>`
      }
    </form>`;
}

function openProductSheet(pid) {
  const p = state.products.get(pid);
  if (!p) return;
  const chainSections = {};
  for (const c of state.chains) {
    const store = storesOfChain(c.id)[0];
    if (store) chainSections[c.id] = resolveSection(p, store, p.name);
  }
  openSheet({
    mode: 'product',
    title: p.name,
    productId: pid,
    name: p.name,
    preferredStoreId: storeById(p.preferredStoreId) ? p.preferredStoreId : '',
    defaultUnit: p.defaultUnit || 'st',
    generalSectionId: generalSectionFor(p.sectionId, p.name),
    chainSections,
    chainTouched: {},
    recurring: !!p.recurring,
  });
}

// ---------- prullenbak ----------

const TRASH_DAYS = 7;
const DAY = 24 * 3600 * 1000;
const trashedAt = (d) => toMillisSafe(d.deletedAt) || toMillisSafe(d.updatedAt) || Date.now();

// all: ook dingen zonder deletedAt (ongedaan gemaakte toevoegingen). Die tonen
// we niet, maar ruimen we na een week wel op.
function trashEntries(all = false) {
  const out = [];
  const shown = (d) => all || !!d.deletedAt;
  for (const p of state.products.values()) {
    if (p.deleted && p.name && shown(p) && (p.ownerUid === SHARED || p.ownerUid === state.user.uid)) {
      out.push({ col: 'products', id: p.id, name: p.name || '?', kind: 'product', at: trashedAt(p), ownerUid: p.ownerUid });
    }
  }
  for (const i of state.trashItems.filter(shown)) {
    out.push({ col: 'items', id: i.id, name: i.name || '?', kind: `item${storeById(i.storeId) ? ` · ${storeById(i.storeId).name}` : ''}`, at: trashedAt(i), ownerUid: i.ownerUid, doc: i });
  }
  for (const st of state.allStores.filter((x) => x.deleted && shown(x))) {
    out.push({ col: 'stores', id: st.id, name: st.name, kind: 'winkel', at: trashedAt(st), ownerUid: SHARED });
  }
  for (const sec of state.allSections.filter((x) => x.deleted && x.custom && shown(x))) {
    const chain = chainById(sec.chainId);
    out.push({ col: 'sections', id: sec.id, name: sec.name, kind: `sectie${chain ? ` · ${chain.name}` : ''}`, at: trashedAt(sec), ownerUid: SHARED });
  }
  // Regels die met "Alleen uit de historie" uit een ronde zijn gehaald.
  for (const t of state.trips) {
    for (const line of t.removed || []) {
      out.push({
        col: 'line',
        id: `${t.id}:${line.lineId}`,
        tripId: t.id,
        lineId: line.lineId,
        name: line.name,
        kind: `uit ronde ${t.storeName} · ${formatWhen(t.finishedAt)}`,
        at: toMillisSafe(line.removedAt) || Date.now(),
        ownerUid: t.ownerUid,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function viewPrullenbak() {
  ensureTrashWatch();
  ensureTripsWatch();
  const entries = trashEntries();
  const left = (at) => {
    const days = Math.ceil((at + TRASH_DAYS * DAY - Date.now()) / DAY);
    return days <= 0 ? 'wordt opgeruimd' : days === 1 ? 'nog 1 dag' : `nog ${days} dagen`;
  };
  return `
    <header class="page-head">
      <div>
        <button class="back-link" data-action="opt-back">${icon('back', 16)} Opties</button>
        <h1 class="page-title">Prullenbak</h1>
      </div>
    </header>
    <p class="muted">Wat je verwijdert blijft hier ${TRASH_DAYS} dagen staan. Daarna is het definitief weg, ook voor ongedaan maken.</p>
    ${
      !state.trashReady
        ? '<p class="muted">Laden…</p>'
        : entries.length
          ? `<section class="card trash-list">
              ${entries
                .map(
                  (e) => `<div class="trash-row">
                    <div class="trash-main">
                      <span class="product-name">${esc(e.name)}</span>
                      <span class="muted small">${esc(e.kind)} · ${left(e.at)}</span>
                    </div>
                    <button class="btn btn-ghost btn-sm" data-action="trash-restore" data-col="${e.col}" data-id="${esc(e.id)}">Terugzetten</button>
                  </div>`,
                )
                .join('')}
            </section>`
          : `<section class="card empty"><h2 class="card-title">Leeg</h2><p class="muted">Niks in de prullenbak.</p></section>`
    }`;
}

async function restoreFromTrash(colName, id) {
  const e = trashEntries().find((x) => x.col === colName && x.id === id);
  if (!e) return;
  // Ongedaan maken van terugzetten = weer in de prullenbak, vanaf nu.
  const back = { deleted: true, deletedAt: nowTs() };
  let label = `${e.name} teruggezet uit de prullenbak`;
  const opts = { ownerUid: e.ownerUid };

  if (colName === 'line') {
    opts.tripOps = [{ tripId: e.tripId, op: 'restore', lineId: e.lineId, effects: [] }];
    // Bij weghalen ging de telling eraf; bij terugzetten komt hij er weer bij.
    const t = tripById(e.tripId);
    const line = (t?.removed || []).find((l) => l.lineId === e.lineId);
    const p = line?.productId ? state.products.get(line.productId) : null;
    if (p?.name && (!line.added || COUNT_ADDED_TO_TRIP)) {
      const eff = countEffect(p, t.storeId, 1);
      if (eff) opts.tripOps[0].effects.push(eff);
    }
    label = `${e.name} terug in ronde ${tripById(e.tripId)?.storeName || ''}`.trim();
  } else if (colName === 'items') {
    const i = e.doc;
    const after = { deleted: false, archived: false, checked: false, deletedAt: null };
    const before = { ...back, archived: true, checked: !!i?.checked };
    // Winkel bestaat niet meer: naar de vaste winkel (of de eerste), anders zie je het nergens.
    if (!storeById(i?.storeId)) {
      const p = liveProduct(i?.productId);
      const to = storeById(p?.preferredStoreId) || state.stores[0];
      if (!to) return toast('Er is geen winkel om het item in terug te zetten');
      Object.assign(after, { storeId: to.id, sectionId: resolveSection(p, to, i.name) });
      Object.assign(before, { storeId: i?.storeId ?? null, sectionId: i?.sectionId ?? null });
      label = `${e.name} teruggezet bij ${to.name} (de oude winkel bestaat niet meer)`;
    }
    opts.changes = [{ col: 'items', id, before, after }];
  } else if (colName === 'products') {
    const p = state.products.get(id);
    const clash = p && productOf(p.ownerUid, p.key || productKey(p.name));
    if (clash && clash.id !== id) return toast(`Er is al een product "${clash.name}". Hernoem of verwijder dat eerst.`);
    opts.changes = [{ col: 'products', id, before: back, after: { deleted: false, deletedAt: null } }];
  } else {
    opts.changes = [{ col: colName, id, before: back, after: { deleted: false, deletedAt: null } }];
  }
  const res = await run(() => commitCompound(state.hid, state.user, { label, ...opts }));
  if (res?.actionId) toast(label, res.actionId);
}

// Eén keer per sessie: alles wat langer dan een week weg is, definitief verwijderen.
// Een uur speling, zodat een iets verkeerde klok niet botst met de rules.
let purgeDone = false;
async function maybePurge() {
  if (purgeDone || !state.trashReady || !ready()) return;
  purgeDone = true;
  const limit = Date.now() - TRASH_DAYS * DAY - 3600 * 1000;
  const targets = trashEntries(true)
    .filter((e) => e.at < limit && e.col !== 'line')
    .map((e) => ({ col: e.col, id: e.id }));
  if (!targets.length) return;
  try {
    const n = await purgeTrash(state.hid, state.user, targets);
    console.info(`Prullenbak: ${n} definitief verwijderd`);
  } catch (err) {
    console.warn('Prullenbak opruimen mislukt:', err?.message);
  }
}

// Regels in de prullenbak van rondes: opruimen zodra de historie geladen is.
let linePurgeDone = false;
async function maybePurgeLines() {
  if (linePurgeDone || !state.tripsReady) return;
  linePurgeDone = true;
  const limit = Date.now() - TRASH_DAYS * DAY - 3600 * 1000;
  for (const t of state.trips) {
    const old = (t.removed || []).filter((l) => toMillisSafe(l.removedAt) < limit).map((l) => l.lineId);
    if (!old.length) continue;
    try {
      await purgeTripLines(state.hid, state.user, t, old);
    } catch (err) {
      console.warn('Opruimen rondes mislukt:', err?.message);
    }
  }
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
        <input id="new-store" class="input" name="name" placeholder="Bijv. Kruidvat of Lidl Leeuwarden" maxlength="40" required autocapitalize="sentences">
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
                        <input id="rename-${s.id}" class="input" name="name" value="${esc(s.name)}" maxlength="40" required autocapitalize="sentences">
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
          <input id="lg-${g.id}" class="input layout-name" data-layout-name="${g.id}" value="${esc(g.name)}" maxlength="40" autocapitalize="sentences">
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
                  <input id="lns-${g.id}" class="input" name="name" placeholder="Bijv. Kaas (koeling)" maxlength="40" required autocapitalize="sentences">
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
        <input id="sn-${s.id}" class="input sec-row-name" data-section-name="${s.id}" value="${esc(s.name)}" maxlength="40" autocapitalize="sentences">
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
        <input id="new-section-name" class="input" name="name" placeholder="Nieuwe sectie" maxlength="40" required autocapitalize="sentences">
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
        <input id="chain-name" class="title-input" data-chain-name="${chain.id}" value="${esc(chain.name)}" maxlength="40" autocapitalize="sentences">
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
        <input id="branch-name" class="input" name="name" placeholder="Bijv. ${esc(chain.name)} Leeuwarden" maxlength="40" required autocapitalize="sentences">
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
        <input id="chain-section-name" class="input" name="name" placeholder="Schapnaam, bijv. Koeling (Zuivel)" maxlength="40" required autocapitalize="sentences">
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

function memberName(uid) {
  const n = state.household?.memberNames?.[uid];
  if (n) return n;
  if (uid === state.user?.uid) return state.user.displayName || 'Jij';
  return 'Lid';
}

function formatExpiry(ts) {
  const ms = ts?.toMillis ? ts.toMillis() : 0;
  return new Date(ms).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function inviteLink(code) {
  return `${location.origin}${location.pathname}?join=${code}`;
}

function viewMembers(isOwner) {
  const members = state.household?.members || [];
  const active = state.invites
    .filter((i) => i.hid === state.hid && inviteStatus(i) === 'geldig')
    .sort((a, b) => (b.expiresAt?.toMillis?.() || 0) - (a.expiresAt?.toMillis?.() || 0));
  return `
    <section class="card">
      <h2 class="card-title">Leden</h2>
      <div class="member-list">
        ${members
          .map(
            (uid) => `<div class="member-row">
              <span class="member-name">${esc(memberName(uid))}${uid === state.user.uid ? ' <span class="muted small">(jij)</span>' : ''}</span>
              <span class="muted mono small">${uid === state.household.ownerUid ? 'eigenaar' : 'lid'}</span>
              ${
                isOwner && uid !== state.user.uid
                  ? `<button class="icon-btn icon-btn-quiet" data-action="member-remove" data-id="${uid}" aria-label="${esc(memberName(uid))} verwijderen uit het huishouden">${icon('trash', 18)}</button>`
                  : ''
              }
            </div>`,
          )
          .join('')}
      </div>
      ${
        isOwner
          ? `${active
              .map(
                (i) => `<div class="invite">
                  <div class="invite-main">
                    <span class="invite-code mono">${esc(i.code)}</span>
                    <span class="muted small">Eén keer te gebruiken · geldig tot ${esc(formatExpiry(i.expiresAt))}</span>
                  </div>
                  <div class="inline-form">
                    <button class="btn btn-primary btn-sm" data-action="invite-share" data-id="${esc(i.code)}">Delen</button>
                    <button class="btn btn-ghost btn-sm" data-action="invite-revoke" data-id="${esc(i.code)}">Intrekken</button>
                  </div>
                </div>`,
              )
              .join('')}
            <button class="btn btn-ghost" data-action="invite-create">+ Iemand uitnodigen</button>`
          : '<p class="muted small">Alleen de eigenaar kan mensen uitnodigen.</p>'
      }
      <details class="join-other">
        <summary class="muted small">Zelf een uitnodigingscode gekregen?</summary>
        <form class="inline-form" data-form="join-code">
          <label class="sr-only" for="join-code-opties">Uitnodigingscode</label>
          <input id="join-code-opties" class="input mono code-input" name="code" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="ABC234">
          <button class="btn btn-primary" type="submit">Openen</button>
        </form>
      </details>
    </section>`;
}

function viewOpties() {
  if (state.household?.ownerUid === state.user?.uid) ensureInvitesWatch();
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
        <div class="row"><dt>Winkels</dt><dd class="mono">${state.stores.length}</dd></div>
        <div class="row"><dt>Secties</dt><dd class="mono">${state.sections.length}</dd></div>
        <div class="row"><dt>Producten in geheugen</dt><dd class="mono">${visibleProducts().length}</dd></div>
      </dl>
    </section>

    ${viewMembers(isOwner)}

    <section class="card">
      <h2 class="card-title">Prullenbak</h2>
      <button class="row-link" data-action="opt-trash">
        <span>${state.trashReady ? `${trashEntries().length} ${trashEntries().length === 1 ? 'ding' : 'dingen'}` : 'Bekijken'} · ${TRASH_DAYS} dagen bewaard</span>
        ${icon('next', 18)}
      </button>
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
  // Toetsenbord van het invoerveld eronder dichtdoen, anders blijft het hangen.
  if (document.activeElement && !document.activeElement.closest?.('#sheet-root')) document.activeElement.blur();
  state.sheet = sheet;
  renderSheet();
  document.body.classList.add('sheet-open');
  const first = document.querySelector('#sheet-root [data-autofocus]');
  if (first) setTimeout(() => first.focus(), 30);
  syncHistory();
}

function closeSheet() {
  state.sheet = null;
  document.getElementById('sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
  syncHistory();
}

function renderSheet() {
  const root = document.getElementById('sheet-root');
  const s = state.sheet;
  if (!s) {
    root.innerHTML = '';
    return;
  }
  const body =
    s.mode === 'stores'
      ? sheetStores()
      : s.mode === 'confirm-disable'
        ? sheetConfirmDisable(s)
        : s.mode === 'confirm-remove'
          ? sheetConfirmRemove(s)
          : s.mode === 'finish'
            ? sheetFinish(s)
            : s.mode === 'trip-item' || s.mode === 'trip-add'
              ? sheetTripItem(s)
              : s.mode === 'product'
                ? sheetProductEdit(s)
                : sheetItem(s);
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
            <input id="sheet-new-store" class="input" data-field="newStoreName" value="${esc(s.newStoreName || '')}" placeholder="Naam winkel" maxlength="40" data-autofocus autocapitalize="sentences">
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
              <input class="input" data-field="name" value="${esc(s.name)}" maxlength="80" required autocapitalize="sentences">
            </label>`
      }

      <div class="field">
        <span class="field-label">Winkel</span>
        ${storeGrid(s.storeId, s)}
      </div>

      <div class="field">
        <label class="field-label" for="sheet-section">Sectie${store ? ` bij ${esc(store.name)}` : ''}</label>
        <select id="sheet-section" class="input" data-field="sectionId">
          ${sectionOptions(store, s.sectionId)}
          <option value="__new__">+ Nieuwe sectie…</option>
        </select>
        ${
          s.newSectionOpen
            ? `<div class="new-section">
                <div class="inline-form">
                  <label class="sr-only" for="sheet-new-section">Naam nieuwe sectie</label>
                  <input id="sheet-new-section" class="input" data-field="newSectionName" value="${esc(s.newSectionName || '')}" placeholder="Bijv. Kaas (koeling)" maxlength="40" autocapitalize="sentences">
                  <button type="button" class="btn btn-primary" data-action="sheet-add-section">Toevoegen</button>
                </div>
                ${chainOf(store) ? `<label class="check-row"><input type="checkbox" data-field="newSectionOnlyStore"${s.newSectionOnlyStore !== false ? ' checked' : ''}> Alleen voor ${esc(chainOf(store).name)}</label>` : ''}
              </div>`
            : ''
        }
      </div>

      ${qtyRows(s)}

      <label class="check-row"><input type="checkbox" data-field="recurring"${s.recurring ? ' checked' : ''}> Iedere keer op de lijst <span class="muted small">(komt na afronden terug)</span></label>

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

// Ronde afronden met nog open items: per item kiezen.
const FINISH_CHOICES = [
  ['stay', 'Laten staan'],
  ['forward', 'Doorsturen'],
  ['trash', 'Weg'],
];
function sheetFinish(s) {
  const store = storeById(s.storeId);
  const others = state.stores.filter((x) => x.id !== s.storeId);
  const nChecked = finishItems(s).checked.length;
  return `
    <div class="sheet-body">
      <div>
        <p class="eyebrow">ronde afronden</p>
        <h2 class="sheet-title">Niet gehaald bij ${esc(store?.name || '')}</h2>
        <p class="muted small">${nChecked ? `${nChecked} ${nChecked === 1 ? 'item gaat' : 'items gaan'} naar de historie.` : 'Je hebt niks afgevinkt, er komt geen ronde in de historie.'} Wat moet er met de rest?</p>
      </div>
      <div class="finish-list">
        ${s.choices
          .map((c) => {
            const item = state.items.find((i) => i.id === c.itemId);
            if (!item) return '';
            const qty = formatItemQty(item);
            return `<div class="finish-item">
              <div class="finish-name">${esc(item.name)}${qty ? ` <span class="item-qty">${esc(qty)}</span>` : ''}</div>
              <div class="seg" role="group" aria-label="${esc(item.name)}">
                ${FINISH_CHOICES.map(
                  ([v, label]) => `<button type="button" class="seg-btn${c.choice === v ? ' is-active' : ''}" aria-pressed="${c.choice === v}"
                    data-action="finish-choice" data-id="${item.id}" data-choice="${v}"${v === 'forward' && !others.length ? ' disabled' : ''}>${label}</button>`,
                ).join('')}
              </div>
              ${
                c.choice === 'forward'
                  ? `<label class="sr-only" for="fw-${item.id}">Doorsturen naar</label>
                    <select id="fw-${item.id}" class="input" data-finish-store="${item.id}">
                      ${others.map((o) => `<option value="${o.id}"${o.id === c.storeId ? ' selected' : ''}>→ ${esc(o.name)}</option>`).join('')}
                    </select>`
                  : ''
              }
            </div>`;
          })
          .join('')}
      </div>
      <button class="btn btn-primary btn-block" data-action="finish-confirm">Ronde afronden</button>
      <button class="btn btn-ghost btn-block" data-action="sheet-close">Annuleren</button>
    </div>`;
}

function qtyRows(s) {
  return `
    <div class="field">
      <div class="qty-head">
        <span class="field-label">Aantal</span>
        <span class="field-label">Eenheid</span>
      </div>
      ${s.parts
        .map(
          (p, i) => `<div class="qty-row">
            <label class="sr-only" for="pq-${i}">Aantal${s.parts.length > 1 ? ` regel ${i + 1}` : ''}</label>
            <input id="pq-${i}" class="input mono" data-part-qty="${i}" inputmode="decimal" value="${esc(p.qty ?? '')}" placeholder="—">
            <label class="sr-only" for="pu-${i}">Eenheid${s.parts.length > 1 ? ` regel ${i + 1}` : ''}</label>
            <select id="pu-${i}" class="input" data-part-unit="${i}">
              ${UNITS.map((u) => `<option value="${u.id}"${u.id === p.unit ? ' selected' : ''}>${u.label}</option>`).join('')}
            </select>
            ${
              s.parts.length > 1
                ? `<button type="button" class="icon-btn icon-btn-quiet" data-action="part-remove" data-id="${i}" aria-label="Regel ${i + 1} weghalen">${icon('x', 18)}</button>`
                : ''
            }
          </div>`,
        )
        .join('')}
      <button type="button" class="btn btn-ghost btn-sm qty-add" data-action="part-add">+ Nog een</button>
    </div>`;
}

// Historie: een regel uit een ronde aanpassen, of een vergeten item toevoegen.
function sheetTripItem(s) {
  const t = tripById(s.tripId);
  const adding = s.mode === 'trip-add';
  return `
    <form class="sheet-body" data-form="trip-item">
      <div>
        <p class="eyebrow">${esc(t?.storeName || '')} · ${esc(formatWhen(t?.finishedAt))}</p>
        <h2 class="sheet-title">${adding ? 'Vergeten item toevoegen' : esc(s.name)}</h2>
      </div>
      ${
        adding
          ? `<label class="field">
              <span class="field-label">Product</span>
              <input class="input" data-field="name" value="${esc(s.name || '')}" maxlength="80" list="product-names" placeholder="Bijv. Kaas" data-autofocus autocapitalize="sentences">
            </label>`
          : ''
      }
      ${qtyRows(s)}
      ${s.error ? `<p class="error" role="alert">${esc(s.error)}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit">${adding ? 'Toevoegen aan deze ronde' : 'Opslaan'}</button>
      ${
        adding
          ? ''
          : s.confirmRemove
            ? (() => {
                const line = lineOf(t, s.lineId);
                const back = line && t ? backStoreFor(t, line) : null;
                const moved = back && back.id !== t.storeId;
                return `<div class="remove-choice">
                  <p class="muted small">${esc(s.name)} uit deze ronde halen:</p>
                  <button class="btn btn-ghost btn-block" type="button" data-action="trip-remove" data-mode="back">Terug op de lijst${back ? ` bij ${esc(back.name)}` : ''}</button>
                  ${moved ? `<p class="warn small">Let op: dit komt bij ${esc(back.name)} (de vaste winkel), niet bij ${esc(t.storeName)} waar deze ronde was.</p>` : ''}
                  <button class="btn btn-ghost btn-block btn-danger" type="button" data-action="trip-remove" data-mode="gone">Alleen uit de historie</button>
                  <p class="muted small">Alleen uit de historie: de regel gaat ${TRASH_DAYS} dagen naar de prullenbak.</p>
                </div>`;
              })()
            : `<button class="btn btn-ghost btn-block btn-danger" type="button" data-action="trip-remove-ask">Uit deze ronde halen</button>`
      }
    </form>`;
}

function sheetConfirmRemove(s) {
  return `
    <div class="sheet-body">
      <h2 class="sheet-title">${esc(s.name)} verwijderen uit het huishouden?</h2>
      <p class="muted">${esc(s.name)} ziet de gedeelde lijst dan niet meer. Haar of zijn Privé-lijst blijft bewaard, maar is voor jou niet zichtbaar. Opnieuw uitnodigen kan altijd.</p>
      <button class="btn btn-primary btn-block" data-action="confirm-remove">Verwijderen</button>
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
        <input id="sheet-store-name" class="input" name="name" placeholder="Nieuwe winkel" maxlength="40" required autocapitalize="sentences">
        <button class="btn btn-primary" type="submit">Toevoegen</button>
      </form>
    </div>`;
}

// ---------- acties ----------

// ---------- historie: acties ----------

// Keuzes van Marcel: "terug op de lijst" gaat naar de vaste winkel (met melding
// als dat een andere winkel is dan die van de ronde), en een later toegevoegd
// item telt mee in de stats.
const TRIP_BACK_TO = 'preferred';
const COUNT_ADDED_TO_TRIP = true;

function sheetParts(s) {
  let parts = s.parts.map((p) => ({ qty: parseQtyInput(p.qty), unit: p.unit || 'st' }));
  if (parts.length > 1) parts = parts.filter((p) => p.qty != null);
  if (!parts.length) parts = [{ qty: null, unit: s.parts[0]?.unit || 'st' }];
  return { qty: parts[0].qty, unit: parts[0].unit, parts: parts.length > 1 ? parts : null };
}

// Telling 'x keer gekocht bij winkel' als teller (increment), ook bij undo.
function countEffect(p, storeId, delta) {
  if (!p || !storeId) return null;
  return { productId: p.id, ownerUid: p.ownerUid, path: ['storeCounts', storeId], delta };
}

function listForTrip(t) {
  return state.lists.find((l) => l.id === t.listId) || state.lists.find((l) => l.ownerUid === t.ownerUid) || null;
}

const lineOf = (t, lineId) => (t?.items || []).find((l) => l.lineId === lineId) || null;

// Waar komt een regel terug op de lijst? Vaste winkel, anders die van de ronde.
function backStoreFor(t, line) {
  const p = liveProduct(line.productId);
  const preferred = TRIP_BACK_TO === 'preferred' ? storeById(p?.preferredStoreId) : null;
  return preferred || storeById(t.storeId) || storeById(p?.preferredStoreId) || state.stores[0] || null;
}

async function tripAgain(t, line) {
  const list = listForTrip(t);
  if (!list) return toast('Die lijst bestaat niet meer');
  const key = productKey(line.name);
  const known = liveProduct(line.productId)?.ownerUid === list.ownerUid ? liveProduct(line.productId) : productFor(list, key);
  const pid = known && known.ownerUid === list.ownerUid ? known.id : pidFor(list.ownerUid, key);
  const p = known;
  const store = storeById(p?.preferredStoreId) || storeById(t.storeId) || storeById(currentStoreId());
  if (!store) return toast('Geen winkel gevonden');
  const dup = liveItems().find((i) => i.listId === list.id && !i.checked && i.key === key);
  if (dup) return toast(`${dup.name} staat al op de lijst bij ${storeById(dup.storeId)?.name || 'een winkel'}`);
  const sectionId = resolveSection(p, store, line.name);
  const fields = {
    name: line.name,
    key,
    qty: line.qty ?? null,
    unit: line.unit || p?.defaultUnit || 'st',
    parts: Array.isArray(line.parts) && line.parts.length > 1 ? line.parts : null,
    storeId: store.id,
    sectionId,
  };
  const extra = { generalSectionId: generalSectionFor(sectionId, line.name), extra: store.chainId ? { sectionByChain: { [store.chainId]: sectionId } } : {} };
  const res = await run(() => addItem(state.hid, state.user, list, fields, productArg(pid, extra)));
  if (res) toast(`${line.name} → ${store.name}`, res.actionId);
}

async function saveTripItem() {
  const s = state.sheet;
  const t = tripById(s.tripId);
  if (!t) return closeSheet();
  const { qty, unit, parts } = sheetParts(s);
  const tripOps = [];
  const effects = [];
  const changes = [];
  let label;

  if (s.mode === 'trip-add') {
    const name = capitalize(s.name || '').trim();
    if (!name) {
      s.error = 'Welk product?';
      renderSheet();
      return;
    }
    // Alleen een product van dezelfde eigenaar: een privé-aankoop telt niet in het gedeelde geheugen.
    const p = productOf(t.ownerUid, productKey(name));
    const line = {
      ...tripLine({ name, qty, unit, parts, productId: p?.id || null, checkedBy: state.user.uid }, state.household?.memberNames || {}),
      checkedAt: t.finishedAt || null,
      added: true,
    };
    const op = { tripId: t.id, op: 'add', line, effects: [] };
    tripOps.push(op);
    if (COUNT_ADDED_TO_TRIP && p) {
      const e = countEffect(p, t.storeId, 1);
      if (e) op.effects.push(e);
      if (toMillisSafe(t.finishedAt) > toMillisSafe(p.lastBoughtAt)) {
        changes.push({
          col: 'products',
          id: p.id,
          before: { lastBoughtAt: p.lastBoughtAt ?? null, lastBoughtStoreId: p.lastBoughtStoreId ?? null },
          after: { lastBoughtAt: t.finishedAt, lastBoughtStoreId: t.storeId },
        });
      }
    }
    label = `${name} toegevoegd aan ronde ${t.storeName}`;
  } else {
    const line = lineOf(t, s.lineId);
    if (!line) return closeSheet();
    const after = { qty, unit, parts };
    if (JSON.stringify({ qty: line.qty ?? null, unit: line.unit ?? null, parts: line.parts ?? null }) === JSON.stringify(after)) return closeSheet();
    tripOps.push({ tripId: t.id, op: 'edit', lineId: line.lineId, after });
    label = `${line.name} aangepast in ronde ${t.storeName}`;
  }
  closeSheet();
  const res = await run(() => commitCompound(state.hid, state.user, { label, ownerUid: t.ownerUid, tripOps, effects, changes }));
  if (res?.actionId) toast(label, res.actionId);
}

const toMillisSafe = (ts) => (ts?.toMillis ? ts.toMillis() : Number(ts) || 0);

// mode 'back' = terug op de lijst; 'gone' = alleen uit de historie (naar de prullenbak).
async function removeFromTrip(mode) {
  const s = state.sheet;
  const t = tripById(s.tripId);
  const line = lineOf(t, s.lineId);
  closeSheet();
  if (!t || !line) return;
  const tripOps = [{ tripId: t.id, op: 'remove', lineId: line.lineId, toTrash: mode === 'gone', effects: [] }];
  const effects = [];
  const creates = [];
  const p = line.productId ? state.products.get(line.productId) : null;
  if (p?.name && (!line.added || COUNT_ADDED_TO_TRIP)) {
    const e = countEffect(p, t.storeId, -1);
    if (e) tripOps[0].effects.push(e);
  }
  let note = mode === 'gone' ? ' (in de prullenbak)' : '';
  if (mode === 'back') {
    const list = listForTrip(t);
    const key = productKey(line.name);
    const dup = list && liveItems().find((i) => i.listId === list.id && !i.checked && i.key === key);
    const store = backStoreFor(t, line);
    if (!list) note = ' (lijst bestaat niet meer)';
    else if (dup) note = ' (stond al op de lijst)';
    else if (store) {
      const live = liveProduct(line.productId);
      creates.push({
        col: 'items',
        data: newItemDoc(
          state.user,
          list,
          { name: line.name, key, qty: line.qty, unit: line.unit, parts: line.parts, storeId: store.id, sectionId: resolveSection(live, store, line.name) },
          live ? live.id : null,
        ),
        before: { deleted: true, archived: true },
        after: { deleted: false, archived: false },
      });
      note = store.id !== t.storeId ? ` → terug op de lijst bij ${store.name} (niet ${t.storeName})` : ` → terug op de lijst bij ${store.name}`;
    }
  }
  const label = `${line.name} uit ronde ${t.storeName} gehaald${note}`;
  const res = await run(() => commitCompound(state.hid, state.user, { label, ownerUid: t.ownerUid, creates, effects, tripOps }));
  if (res?.actionId) toast(label, res.actionId);
}

// ---------- producten: acties ----------

// Keuzes van Marcel: hernoemen geldt ook voor wat op de lijst staat, en bij
// verwijderen gaan open items mee naar de prullenbak (met waarschuwing vooraf).
const RENAME_OPEN_ITEMS = true;
const TRASH_OPEN_ITEMS = true;

async function saveProduct() {
  const sh = state.sheet;
  const p = state.products.get(sh.productId);
  if (!p) return closeSheet();
  const name = capitalize(sh.name || '').trim().slice(0, 80);
  if (!name) {
    sh.error = 'Geef het product een naam.';
    renderSheet();
    return;
  }
  const key = productKey(name);
  if (key !== p.key) {
    const clash = productOf(p.ownerUid, key);
    if (clash && clash.id !== p.id) {
      sh.error = `${clash.name} bestaat al. Kies een andere naam.`;
      renderSheet();
      return;
    }
  }
  const after = {};
  if (name !== p.name) Object.assign(after, { name, key });
  if (sh.preferredStoreId && sh.preferredStoreId !== p.preferredStoreId) after.preferredStoreId = sh.preferredStoreId;
  if (sh.defaultUnit !== (p.defaultUnit || 'st')) after.defaultUnit = sh.defaultUnit;
  if (sh.generalSectionId && sh.generalSectionId !== generalSectionFor(p.sectionId, p.name)) after.sectionId = sh.generalSectionId;
  if (!!sh.recurring !== !!p.recurring) after.recurring = !!sh.recurring;
  const touched = Object.keys(sh.chainTouched).filter((c) => sh.chainTouched[c]);
  if (touched.length) {
    const map = { ...(p.sectionByChain || {}) };
    for (const c of touched) map[c] = sh.chainSections[c];
    after.sectionByChain = map;
  }
  if (!Object.keys(after).length) return closeSheet();
  const before = Object.fromEntries(Object.keys(after).map((k) => [k, p[k] ?? null]));
  const changes = [{ col: 'products', id: p.id, before, after }];
  if (after.name && RENAME_OPEN_ITEMS) {
    for (const i of liveItems().filter((x) => x.productId === p.id)) {
      changes.push({ col: 'items', id: i.id, before: { name: i.name, key: i.key }, after: { name, key } });
    }
  }
  closeSheet();
  const label = after.name ? `${p.name} hernoemd naar ${name}` : `${name} aangepast`;
  const res = await run(() => commitCompound(state.hid, state.user, { label, ownerUid: p.ownerUid, changes }));
  if (res?.actionId) toast(label, res.actionId);
}

async function trashProduct() {
  const sh = state.sheet;
  const p = state.products.get(sh?.productId);
  closeSheet();
  if (!p) return;
  const now = nowTs();
  const changes = [{ col: 'products', id: p.id, before: { deleted: false, deletedAt: null }, after: { deleted: true, deletedAt: now } }];
  const open = TRASH_OPEN_ITEMS ? liveItems().filter((x) => x.productId === p.id) : [];
  for (const i of open) {
    changes.push({ col: 'items', id: i.id, before: { deleted: false, archived: false, deletedAt: null }, after: { deleted: true, archived: true, deletedAt: now } });
  }
  const label = `${p.name} naar de prullenbak${open.length ? ` (met ${open.length} ${open.length === 1 ? 'item' : 'items'} van de lijst)` : ''}`;
  const res = await run(() => commitCompound(state.hid, state.user, { label, ownerUid: p.ownerUid, changes }));
  if (res?.actionId) toast(label, res.actionId);
}

// Items van één winkel in één lijst, gesplitst in afgevinkt en open.
function finishItems({ listId, storeId }) {
  const inStore = liveItems().filter((i) => i.listId === listId && i.storeId === storeId);
  return { checked: inStore.filter((i) => i.checked), open: inStore.filter((i) => !i.checked) };
}

function startFinish() {
  const list = activeList();
  const storeId = currentStoreId();
  if (!list || !storeId) return;
  const { checked, open } = finishItems({ listId: list.id, storeId });
  if (!checked.length && !open.length) return;
  if (!open.length) {
    doFinish(list.id, storeId, []);
    return;
  }
  const firstOther = state.stores.find((x) => x.id !== storeId)?.id || null;
  openSheet({
    mode: 'finish',
    title: 'Ronde afronden',
    listId: list.id,
    storeId,
    choices: open.map((i) => ({ itemId: i.id, choice: 'stay', storeId: firstOther })),
  });
}

async function doFinish(listId, storeId, choices) {
  const list = state.lists.find((l) => l.id === listId);
  const store = storeById(storeId);
  if (!list || !store) return;
  const { checked, open } = finishItems({ listId, storeId });
  const byId = new Map(choices.map((c) => [c.itemId, c]));

  const openChoices = open.map((item) => {
    const c = byId.get(item.id) || { choice: 'stay' };
    if (c.choice !== 'forward') return { item, choice: c.choice };
    const to = storeById(c.storeId);
    if (!to) return { item, choice: 'stay' };
    const product = liveProduct(item.productId);
    return { item, choice: 'forward', storeId: to.id, sectionId: resolveSection(product, to, item.name), productOwnerUid: productOwner(item.productId) };
  });

  // 'Iedere keer': direct weer op de lijst, bij de vaste winkel van het product.
  // Niet dubbel: als hetzelfde product nog open op de lijst blijft, niets toevoegen.
  const staysOpen = new Set(
    liveItems()
      .filter((i) => i.listId === listId && !i.checked)
      .filter((i) => {
        const oc = openChoices.find((o) => o.item.id === i.id);
        return !oc || oc.choice !== 'trash';
      })
      .map((i) => i.key),
  );
  const recurring = [];
  for (const i of checked) {
    const p = state.products.get(i.productId);
    if (!p?.recurring || p.deleted || staysOpen.has(i.key)) continue;
    staysOpen.add(i.key);
    const target = storeById(p.preferredStoreId) || store;
    recurring.push({
      productId: i.productId,
      fields: {
        name: i.name,
        key: i.key,
        qty: i.qty ?? null,
        unit: i.unit || 'st',
        parts: Array.isArray(i.parts) && i.parts.length > 1 ? i.parts : null,
        storeId: target.id,
        sectionId: resolveSection(p, target, i.name),
      },
    });
  }

  const seen = new Set();
  const products = [];
  for (const i of checked) {
    const p = state.products.get(i.productId);
    if (!p?.name || seen.has(p.id)) continue;
    seen.add(p.id);
    products.push({ id: p.id, ownerUid: p.ownerUid, before: { lastBoughtAt: p.lastBoughtAt ?? null, lastBoughtStoreId: p.lastBoughtStoreId ?? null } });
  }

  const res = await run(() =>
    finishRound(state.hid, state.user, {
      list,
      store,
      checked,
      open: openChoices,
      recurring,
      products,
      names: state.household?.memberNames || {},
    }),
  );
  if (!res?.actionId) return;
  state.cartOpen = false;
  const parts = [];
  if (checked.length) parts.push(`${checked.length} naar de historie`);
  const fw = openChoices.filter((o) => o.choice === 'forward').length;
  const tr = openChoices.filter((o) => o.choice === 'trash').length;
  if (fw) parts.push(`${fw} doorgestuurd`);
  if (tr) parts.push(`${tr} weg`);
  if (recurring.length) parts.push(`${recurring.length} weer op de lijst`);
  toast(`Ronde ${store.name} afgerond${parts.length ? ` · ${parts.join(', ')}` : ''}`, res.actionId);
}

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

// Een product in de prullenbak telt als onbekend: het wordt opnieuw geleerd.
const liveProduct = (id) => {
  const p = state.products.get(id);
  return p && !p.deleted ? p : null;
};

// Product van één eigenaar op sleutel. Normaal is het id afgeleid van de
// sleutel, maar na hernoemen niet meer: dan zoeken op het key-veld.
function productOf(ownerUid, key) {
  const direct = liveProduct(productIdFor(ownerUid, key));
  if (direct && (direct.key || key) === key) return direct;
  for (const p of state.products.values()) {
    if (!p.deleted && p.ownerUid === ownerUid && p.key === key) return p;
  }
  return null;
}

function productFor(list, key) {
  return productOf(list.ownerUid, key) || (list.ownerUid !== SHARED ? productOf(SHARED, key) : null);
}

// Id voor een product: het bestaande (ook in de prullenbak), of een nieuw id.
// Is het standaard-id al bezet door een hernoemd product, dan een uniek id.
function pidFor(ownerUid, key) {
  const live = productOf(ownerUid, key);
  if (live) return live.id;
  const base = productIdFor(ownerUid, key);
  const taken = state.products.get(base);
  // Vrij, of een naamloos restje (alleen tellers): mag gebruikt worden.
  // Ligt er een product in de prullenbak: dat laten we met rust (terugzetten blijft kunnen).
  if (!taken || (!taken.name && !taken.deleted)) return base;
  return `${base}_${Math.random().toString(36).slice(2, 7)}`;
}

// Meegeven aan addItem: nieuw product, of een verwijderd product dat opnieuw begint.
function productArg(pid, extra = {}) {
  const existing = state.products.get(pid);
  if (existing && !existing.deleted && existing.name) return { id: pid, isNew: false };
  return { id: pid, isNew: true, ...extra };
}

// Bestaat het productdocument nog (ook in de prullenbak)? Dan mag een teller erop.
const productExists = (id) => !!id && !!state.products.get(id)?.name;
// Eigenaar van het product (als het nog bestaat), voor tellers.
const productOwner = (id) => (productExists(id) ? state.products.get(id).ownerUid : null);

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
    const pid = pidFor(list.ownerUid, key);
    const fields = {
      name: known.name || name,
      key,
      qty: qty ?? null,
      unit: unit || known.defaultUnit || 'st',
      storeId,
      sectionId,
    };
    const res = await run(() => addItem(state.hid, state.user, list, fields, productArg(pid)));
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
    parts: [{ qty: qty ?? '', unit: unit || 'st' }],
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
  // Meerdere regels: lege regels vallen weg; één regel = gewoon aantal + eenheid.
  const { qty, unit, parts: multi } = sheetParts(s);

  if (s.mode === 'item-new') {
    const pid = pidFor(list.ownerUid, s.key);
    const fields = { name: s.name, key: s.key, qty, unit, parts: multi, storeId: s.storeId, sectionId: s.sectionId };
    const store = storeById(s.storeId);
    const generalSectionId = generalSectionFor(s.sectionId, s.name);
    const extra = store?.chainId ? { sectionByChain: { [store.chainId]: s.sectionId } } : {};
    if (s.recurring) extra.recurring = true;
    closeSheet();
    const res = await run(() => addItem(state.hid, state.user, list, fields, productArg(pid, { generalSectionId, extra })));
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
  const next = { name, key, qty, unit, parts: multi, storeId: s.storeId, sectionId: s.sectionId };
  if (key !== item.key) next.productId = pidFor(item.ownerUid, key);
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(item[k], v)));
  closeSheet();

  // Geheugen corrigeren: sectie en eenheid gelden voortaan voor dit product.
  const pid = changes.productId || item.productId || pidFor(item.ownerUid, key);
  let productUpdates = null;
  if (changes.productId || s.sectionTouched || changes.unit || changes.name) {
    const data = { name, key, defaultUnit: next.unit };
    const chainId = storeById(next.storeId)?.chainId;
    if (s.sectionTouched || !state.products.has(pid)) {
      if (chainId) data.sectionByChain = { [chainId]: next.sectionId };
      data.sectionId = generalSectionFor(next.sectionId, name);
    }
    if (!state.products.has(pid)) Object.assign(data, { preferredStoreId: next.storeId });
    productUpdates = { id: pid, data };
  }
  if (!item.productId && !changes.productId) changes.productId = pid;
  // 'Iedere keer' als losse wijziging, zodat undo hem ook terugzet.
  const extraChanges = [];
  const existing = state.products.get(pid);
  if (!!s.recurring !== !!existing?.recurring) {
    if (existing?.name) extraChanges.push({ col: 'products', id: pid, before: { recurring: !!existing.recurring }, after: { recurring: !!s.recurring } });
    else {
      productUpdates ||= { id: pid, data: { name, key } };
      productUpdates.data.recurring = !!s.recurring;
    }
  }
  if (!Object.keys(changes).length && !productUpdates && !extraChanges.length) return;

  const actionId = await run(() =>
    updateItem(state.hid, state.user, item, changes, productUpdates, { productOwnerUid: productOwner(changes.productId || item.productId), extraChanges }),
  );
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
  const after = sec.custom ? { deleted: true, deletedAt: nowTs() } : { deleted: true };
  const changes = [{ col: 'sections', id: sec.id, before: sec.custom ? { deleted: false, deletedAt: null } : { deleted: false }, after }];
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

const undoing = new Set();
async function undoById(id) {
  const action = state.activity.find((a) => a.id === id);
  if (!action) {
    toast('Deze actie kan niet meer ongedaan worden gemaakt.');
    return;
  }
  if (undoing.has(id) || state.activity.some((a) => a.type === 'undo' && a.undoOf === id)) {
    toast('Dat is al ongedaan gemaakt.');
    return;
  }
  // Een product terug uit de prullenbak halen terwijl er al een product met die naam is: niet doen.
  for (const c of action.changes || []) {
    if (c.col !== 'products' || c.before?.deleted !== false || c.after?.deleted !== true) continue;
    const p = state.products.get(c.id);
    const clash = p && productOf(p.ownerUid, p.key || productKey(p.name || ''));
    if (clash && clash.id !== c.id) {
      toast(`Kan niet: er is intussen al een product "${clash.name}".`);
      return;
    }
  }
  undoing.add(id);
  try {
    const done = await run(() => undoAction(state.hid, state.user, action));
    if (done !== null) toast(`Ongedaan: ${action.label}`);
  } finally {
    setTimeout(() => undoing.delete(id), 5000);
  }
}

// ---------- data koppelen ----------

function startHousehold(hid) {
  stopWatching();
  state.hid = hid;
  state.loaded = new Set();
  state.mounted = false;
  renderBoot('Lijsten laden…');

  // Eén fout is genoeg: de rest van de listeners volgt vaak met dezelfde.
  let failed = false;
  const fatal = async (err) => {
    console.error(err);
    if (failed || state.hid !== hid) return;
    failed = true;
    stopWatching();
    renderBoot('Toegang controleren…');
    if (err?.code !== 'permission-denied') {
      renderError(err);
      return;
    }
    // Weigering kan ook komen doordat de rules niet bij deze versie passen.
    // Alleen als de server zelf zegt dat je er niet bij kunt: geen toegang.
    try {
      const access = await checkHouseholdAccess(hid);
      if (state.hid !== hid) return;
      if (access === 'ok') {
        renderError(err); // 'Geen toegang. Zijn de nieuwste security rules gedeployed?'
      } else {
        renderNoAccess();
      }
    } catch (e) {
      renderError(e);
    }
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
          // Door de server bevestigd (zie watchHousehold): bestaat niet meer.
          stopWatching();
          renderNoAccess();
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
    watchStores(
      hid,
      (s) => {
        state.allStores = s;
        state.stores = s.filter((x) => !x.deleted);
        got('stores');
      },
      fatal,
    ),
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
    state.profile = profile;
    if (pendingJoin()) {
      await showJoin(pendingJoin());
      return;
    }
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
    case 'choose-household':
      renderSetup();
      break;

    case 'toggle': {
      const item = state.items.find((i) => i.id === id);
      if (!item) break;
      const actionId = await run(() => setItemChecked(state.hid, state.user, item, !item.checked, productOwner(item.productId)));
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
        parts:
          Array.isArray(item.parts) && item.parts.length > 1
            ? item.parts.map((p) => ({ qty: p.qty ?? '', unit: p.unit || 'st' }))
            : [{ qty: item.qty ?? '', unit: item.unit || 'st' }],
        storeId: item.storeId,
        sectionId: displaySection(storeById(item.storeId), item.sectionId)?.id || fallbackSection()?.id,
        recurring: !!state.products.get(item.productId)?.recurring,
      });
      break;
    }
    case 'product-open':
      openProductSheet(id);
      break;
    case 'product-delete-ask':
      if (state.sheet) {
        state.sheet.confirmDelete = true;
        renderSheet();
      }
      break;
    case 'product-delete':
      await trashProduct();
      break;
    case 'trip-toggle':
      state.openTripId = state.openTripId === id ? null : id;
      render();
      break;
    case 'trip-again': {
      const t = tripById(id);
      const line = lineOf(t, el.dataset.line);
      if (line) await tripAgain(t, line);
      break;
    }
    case 'trip-item-edit': {
      const t = tripById(id);
      const line = lineOf(t, el.dataset.line);
      if (!line) break;
      openSheet({
        mode: 'trip-item',
        title: `${line.name} aanpassen`,
        tripId: t.id,
        lineId: line.lineId,
        name: line.name,
        parts:
          Array.isArray(line.parts) && line.parts.length > 1
            ? line.parts.map((p) => ({ qty: p.qty ?? '', unit: p.unit || 'st' }))
            : [{ qty: line.qty ?? '', unit: line.unit || 'st' }],
      });
      break;
    }
    case 'trip-add':
      openSheet({ mode: 'trip-add', title: 'Vergeten item toevoegen', tripId: id, name: '', parts: [{ qty: '', unit: 'st' }] });
      break;
    case 'trip-remove-ask':
      if (state.sheet) {
        state.sheet.confirmRemove = true;
        renderSheet();
      }
      break;
    case 'trip-remove':
      await removeFromTrip(el.dataset.mode);
      break;
    case 'finish-start':
      startFinish();
      break;
    case 'finish-choice': {
      const c = state.sheet?.choices?.find((x) => x.itemId === id);
      if (!c) break;
      c.choice = el.dataset.choice;
      renderSheet();
      break;
    }
    case 'finish-confirm': {
      const sh = state.sheet;
      if (!sh || sh.mode !== 'finish') break;
      closeSheet();
      await doFinish(sh.listId, sh.storeId, sh.choices);
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
    case 'part-add': {
      const sh = state.sheet;
      if (!sh) break;
      const last = sh.parts[sh.parts.length - 1];
      sh.parts.push({ qty: '', unit: last?.unit || 'st' });
      renderSheet();
      document.getElementById(`pq-${sh.parts.length - 1}`)?.focus();
      break;
    }
    case 'part-remove': {
      const sh = state.sheet;
      if (!sh || sh.parts.length < 2) break;
      sh.parts.splice(Number(id), 1);
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
    case 'opt-trash':
      state.optSub = 'prullenbak';
      render();
      window.scrollTo(0, 0);
      break;
    case 'trash-restore':
      await restoreFromTrash(el.dataset.col, id);
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
    case 'join-accept': {
      const inv = state.joinInvite;
      if (!inv) break;
      el.disabled = true;
      el.textContent = 'Bezig…';
      try {
        const hid = await joinHousehold(state.user, inv);
        clearJoin();
        state.joinInvite = null;
        state.profile = { ...(state.profile || {}), householdId: hid };
        state.view = 'lijst';
        startHousehold(hid);
        toast(`Welkom bij ${inv.householdName || 'het huishouden'}`);
      } catch (err) {
        console.error(err);
        renderJoin(inv, friendlyError(err) || 'Meedoen lukte niet.');
      }
      break;
    }
    case 'join-decline':
      continueWithoutJoin();
      break;
    case 'invite-create': {
      el.disabled = true;
      const code = await run(() => createInvite(state.hid, state.user, state.household?.name || ''));
      el.disabled = false;
      if (code) toast(`Uitnodiging ${code} gemaakt`);
      break;
    }
    case 'invite-share': {
      const link = inviteLink(id);
      const text = `Doe mee met ons boodschappenlijstje in Schappies: ${link} (code ${id})`;
      try {
        if (navigator.share) {
          await navigator.share({ title: 'Schappies', text });
          break;
        }
      } catch (err) {
        if (err?.name === 'AbortError') break;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast('Link gekopieerd');
      } catch {
        toast(`Code: ${id}`);
      }
      break;
    }
    case 'invite-revoke':
      if (await run(() => revokeInvite(id)) !== null) toast(`Uitnodiging ${id} ingetrokken`);
      break;
    case 'member-remove':
      openSheet({ mode: 'confirm-remove', title: 'Lid verwijderen', uid: id, name: memberName(id) });
      break;
    case 'confirm-remove': {
      const sh = state.sheet;
      closeSheet();
      if (sh && (await run(() => removeMember(state.hid, state.user, sh.uid, sh.name))) !== null) toast(`${sh.name} verwijderd`);
      break;
    }
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
      const actionId = await run(() => updateStore(state.hid, state.user, store, { deleted: true, deletedAt: nowTs() }, `Winkel ${store.name} verwijderd`));
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

  if (t.dataset.productChain && state.sheet?.mode === 'product') {
    state.sheet.chainSections[t.dataset.productChain] = t.value;
    state.sheet.chainTouched[t.dataset.productChain] = true;
    return;
  }
  if (t.dataset.finishStore && state.sheet?.mode === 'finish') {
    const c = state.sheet.choices.find((x) => x.itemId === t.dataset.finishStore);
    if (c) c.storeId = t.value;
    return;
  }

  if (t.dataset.partUnit !== undefined && state.sheet?.parts) {
    state.sheet.parts[Number(t.dataset.partUnit)].unit = t.value;
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
  if (state.sheet && t.dataset.field === 'recurring') {
    state.sheet.recurring = t.checked;
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
  if (e.target.dataset?.productSearch !== undefined) {
    state.productQuery = e.target.value;
    const box = document.getElementById('product-list');
    if (box) box.innerHTML = productRows();
    return;
  }
  if (e.target.dataset?.partQty !== undefined && state.sheet?.parts) {
    state.sheet.parts[Number(e.target.dataset.partQty)].qty = e.target.value;
    return;
  }
  if (e.target.dataset?.importText !== undefined && state.importDraft) {
    state.importDraft.text = e.target.value;
    return;
  }
  const field = e.target.dataset?.field;
  if (field === 'sectionId' || field === 'newSectionOnlyStore' || field === 'recurring') return;
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
      state.profile = { ...(state.profile || {}), householdId: hid };
      startHousehold(hid);
    } catch (err) {
      console.error(err);
      renderSetup(friendlyError(err) || '');
    }
    return;
  }

  if (kind === 'join-code') {
    const code = normalizeCode(form.querySelector('input[name="code"]').value);
    if (code.length !== 6) {
      toast('Een code heeft 6 tekens');
      return;
    }
    setPendingJoin(code);
    stopWatching();
    closeSheetSafe();
    await showJoin(code);
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
  if (kind === 'trip-item') {
    await saveTripItem();
  }
  if (kind === 'product') {
    await saveProduct();
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

// ---------- terugswipen / terugknop ----------
//
// Elke open "laag" (sheet, import, subpagina) krijgt een eigen stap in de
// browsergeschiedenis. Terug sluit de bovenste laag in plaats van de site te
// verlaten. Tabbladen tellen niet mee. Staat er niks open, dan vraagt de app
// eerst "Nog een keer terug om te sluiten".

const nav = { depth: 0, skipPops: 0, guard: false, armed: false, armTimer: null };

// Hoeveel lagen staan er nu open, afgeleid uit de state.
function openDepth() {
  let d = 0;
  if (state.importDraft) d += state.importDraft.preview ? 2 : 1;
  if (state.layoutStoreId || state.chainView || state.optSub) d += 1;
  if (state.sheet) d += 1;
  return d;
}

// Geschiedenis gelijktrekken met wat er open staat.
function syncHistory() {
  const want = openDepth();
  while (nav.depth < want) {
    history.pushState({ bs: 'layer' }, '');
    nav.depth += 1;
  }
  if (nav.depth > want) {
    nav.skipPops += 1;
    history.go(want - nav.depth);
    nav.depth = want;
  }
}

// De bovenste laag sluiten, zonder zelf de geschiedenis aan te raken.
function closeTopLayer() {
  if (state.sheet) {
    state.sheet = null;
    document.getElementById('sheet-root').innerHTML = '';
    document.body.classList.remove('sheet-open');
    return;
  }
  if (state.importDraft) {
    if (state.importDraft.preview) state.importDraft.preview = null;
    else state.importDraft = null;
    return;
  }
  state.layoutStoreId = null;
  state.layoutNewSection = null;
  state.chainView = null;
  state.optSub = null;
}

// Vangnet onder alle lagen: pas na de eerste aanraking (browsers negeren
// geschiedenisstappen die zonder interactie zijn gemaakt).
function ensureGuard() {
  if (nav.guard || nav.depth > 0) return;
  history.pushState({ bs: 'guard' }, '');
  nav.guard = true;
}
document.addEventListener('pointerdown', ensureGuard, true);
document.addEventListener('keydown', ensureGuard, true);

window.addEventListener('popstate', () => {
  if (nav.skipPops > 0) {
    nav.skipPops -= 1;
    return;
  }
  if (nav.depth > 0) {
    nav.depth -= 1;
    closeTopLayer();
    render();
    return;
  }
  // Niks open: het vangnet is net weggehaald.
  nav.guard = false;
  if (nav.armed) {
    history.back();
    return;
  }
  nav.armed = true;
  clearTimeout(nav.armTimer);
  nav.armTimer = setTimeout(() => (nav.armed = false), 2500);
  toast('Nog een keer terug om te sluiten');
  history.pushState({ bs: 'guard' }, '');
  nav.guard = true;
});

initTheme();
registerServiceWorker();
