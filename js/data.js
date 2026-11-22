// Datalaag: alles wat met Firestore praat.
//
// Principes:
// - Elke wijziging gaat in één batch samen met een regel in het activiteitenlog.
// - Niets wordt echt verwijderd: "verwijderen" = deleted/archived-vlag.
// - Undo = een nieuwe actie die de velden van vóór de wijziging terugzet.
import { db } from './firebase.js';
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  writeBatch,
  serverTimestamp,
  increment,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const SCHEMA_VERSION = 1;

// Gedeelde documenten krijgen ownerUid 'shared'; privé = de uid van de eigenaar.
export const SHARED = 'shared';

// Standaard sectieset. 'overig' is de vangnet-sectie en kan niet weg.
export const DEFAULT_SECTIONS = [
  { key: 'groente-fruit', name: 'Groente & fruit' },
  { key: 'brood', name: 'Brood & bakkerij' },
  { key: 'zuivel', name: 'Zuivel & eieren' },
  { key: 'kaas-vleeswaren', name: 'Kaas & vleeswaren' },
  { key: 'vlees-vis', name: 'Vlees & vis' },
  { key: 'vega', name: 'Vegetarisch' },
  { key: 'diepvries', name: 'Diepvries' },
  { key: 'houdbaar', name: 'Houdbaar' },
  { key: 'ontbijt-beleg', name: 'Ontbijt & beleg' },
  { key: 'kruiden-sauzen', name: 'Kruiden & sauzen' },
  { key: 'snacks', name: 'Snacks & snoep' },
  { key: 'dranken', name: 'Dranken' },
  { key: 'drogisterij', name: 'Drogisterij & verzorging' },
  { key: 'huishouden', name: 'Huishouden & schoonmaak' },
  { key: 'huisdier', name: 'Huisdier' },
  { key: 'overig', name: 'Overig' },
];

const userRef = (uid) => doc(db, 'users', uid);
const householdRef = (hid) => doc(db, 'households', hid);
const col = (hid, name) => collection(db, 'households', hid, name);
const ref = (hid, name, id) => doc(db, 'households', hid, name, id);

// Productgeheugen: gedeeld en privé gescheiden, zodat privé-aankopen
// niet in het gedeelde geheugen terechtkomen.
export function productIdFor(ownerUid, key) {
  return ownerUid === SHARED ? `s_${key}` : `u_${ownerUid}_${key}`;
}

// ---------- profiel & huishouden ----------

export async function getUserProfile(uid) {
  const snap = await getDoc(userRef(uid));
  return snap.exists() ? snap.data() : null;
}

// Maakt in één atomische batch: huishouden, profielkoppeling, twee lijsten,
// de standaard secties en een eerste regel in het activiteitenlog.
export async function createHousehold(user, name) {
  const batch = writeBatch(db);
  const hRef = doc(collection(db, 'households'));
  const now = serverTimestamp();
  const base = { schemaVersion: SCHEMA_VERSION, createdAt: now, createdBy: user.uid };

  batch.set(hRef, { ...base, name, ownerUid: user.uid, members: [user.uid] });
  batch.set(
    userRef(user.uid),
    { schemaVersion: SCHEMA_VERSION, householdId: hRef.id, displayName: user.displayName || '', updatedAt: now },
    { merge: true },
  );
  batch.set(doc(collection(hRef, 'lists')), { ...base, name: 'Gedeeld', ownerUid: SHARED, order: 0, deleted: false });
  batch.set(doc(collection(hRef, 'lists')), { ...base, name: 'Privé', ownerUid: user.uid, order: 1, deleted: false });
  DEFAULT_SECTIONS.forEach((s, i) => {
    batch.set(doc(collection(hRef, 'sections')), {
      ...base,
      key: s.key,
      name: s.name,
      order: i,
      system: s.key === 'overig',
      deleted: false,
    });
  });
  batch.set(doc(collection(hRef, 'activity')), {
    schemaVersion: SCHEMA_VERSION,
    type: 'household.created',
    label: `Huishouden "${name}" aangemaakt`,
    by: user.uid,
    at: now,
    ownerUid: SHARED,
  });

  await batch.commit();
  return hRef.id;
}

// ---------- luisteren ----------

export function watchHousehold(hid, onData, onError) {
  return onSnapshot(
    householdRef(hid),
    (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError,
  );
}

const toDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));

// Gedeelde + eigen privé-documenten. Twee aparte queries, zodat elke query
// aantoonbaar binnen de security rules valt.
function watchVisible(colRef, uid, extra, onData, onError) {
  const parts = { shared: null, mine: null };
  const emit = () => {
    if (parts.shared && parts.mine) onData([...parts.shared, ...parts.mine]);
  };
  const u1 = onSnapshot(
    query(colRef, where('ownerUid', '==', SHARED), ...extra),
    (snap) => {
      parts.shared = toDocs(snap);
      emit();
    },
    onError,
  );
  const u2 = onSnapshot(
    query(colRef, where('ownerUid', '==', uid), ...extra),
    (snap) => {
      parts.mine = toDocs(snap);
      emit();
    },
    onError,
  );
  return () => {
    u1();
    u2();
  };
}

export function watchLists(hid, uid, onData, onError) {
  return watchVisible(
    col(hid, 'lists'),
    uid,
    [],
    (docs) => onData(docs.filter((l) => !l.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
    onError,
  );
}

export function watchSections(hid, onData, onError) {
  return onSnapshot(
    query(col(hid, 'sections'), orderBy('order')),
    (snap) => onData(toDocs(snap)),
    onError,
  );
}

export function watchChains(hid, onData, onError) {
  return onSnapshot(
    col(hid, 'chains'),
    (snap) => onData(toDocs(snap).filter((c) => !c.deleted).sort((a, b) => a.name.localeCompare(b.name, 'nl'))),
    onError,
  );
}

// Eenmalige omzetting naar ketens: elke winkel krijgt een keten, winkel-gebonden
// secties worden ketensecties, en elke eigen sectie krijgt een "valt onder".
// guessParent: (naam) => standaard-sleutel. Idempotent: doet niets als alles al klopt.
export async function migrateToChains(hid, user, { stores, sections, guessParent }) {
  const batch = writeBatch(db);
  let writes = 0;
  const chainOfStore = {};
  for (const s of stores) {
    if (s.chainId) {
      chainOfStore[s.id] = s.chainId;
      continue;
    }
    const cRef = doc(col(hid, 'chains'));
    batch.set(cRef, { schemaVersion: SCHEMA_VERSION, name: s.name, deleted: false, createdAt: serverTimestamp(), createdBy: user.uid });
    batch.update(ref(hid, 'stores', s.id), { chainId: cRef.id, updatedAt: serverTimestamp(), updatedBy: user.uid });
    chainOfStore[s.id] = cRef.id;
    writes += 2;
  }
  for (const sec of sections) {
    if (!sec.custom) continue;
    const patch = {};
    if (sec.storeId && !sec.chainId && chainOfStore[sec.storeId]) {
      patch.chainId = chainOfStore[sec.storeId];
      patch.storeId = null;
    }
    if (!sec.parentKey) patch.parentKey = guessParent(sec.name);
    if (Object.keys(patch).length) {
      batch.update(ref(hid, 'sections', sec.id), { ...patch, updatedAt: serverTimestamp(), updatedBy: user.uid });
      writes += 1;
    }
  }
  if (!writes) return 0;
  logAction(batch, hid, user, { type: 'migration.chains', label: 'Omgezet naar ketens' });
  await batch.commit();
  return writes;
}

export function watchStores(hid, onData, onError) {
  return onSnapshot(
    col(hid, 'stores'),
    (snap) =>
      onData(
        toDocs(snap)
          .filter((s) => !s.deleted)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'nl')),
      ),
    onError,
  );
}

// Alleen actieve items (open + in de kar). Gearchiveerde/verwijderde items
// worden niet live geladen: dat spaart reads.
export function watchItems(hid, uid, onData, onError) {
  return watchVisible(col(hid, 'items'), uid, [where('archived', '==', false)], onData, onError);
}

export function watchProducts(hid, uid, onData, onError) {
  return watchVisible(col(hid, 'products'), uid, [], onData, onError);
}

// Laatste acties, voor undo. Vereist een samengestelde index (ownerUid + at).
export function watchActivity(hid, uid, onData, onError) {
  return watchVisible(
    col(hid, 'activity'),
    uid,
    [orderBy('at', 'desc'), limit(40)],
    (docs) => onData(docs.sort((a, b) => toMillis(b.at) - toMillis(a.at))),
    onError,
  );
}

export function toMillis(ts) {
  if (!ts) return Date.now();
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return Number(ts) || 0;
}

// ---------- activiteitenlog ----------

function logAction(batch, hid, user, entry) {
  const aRef = doc(col(hid, 'activity'));
  batch.set(aRef, {
    schemaVersion: SCHEMA_VERSION,
    by: user.uid,
    byName: user.displayName || '',
    at: serverTimestamp(),
    ownerUid: SHARED,
    before: null,
    after: null,
    ...entry,
  });
  return aRef.id;
}

// { path: ['storeCounts', storeId], delta: 1 } → { storeCounts: { [storeId]: increment(1) } }
function nestedIncrement(path, delta) {
  return path.reduceRight((acc, key) => ({ [key]: acc }), increment(delta));
}

function applyProductEffect(batch, hid, effect, sign = 1) {
  if (!effect) return;
  batch.set(
    ref(hid, 'products', effect.productId),
    { ...nestedIncrement(effect.path, effect.delta * sign), updatedAt: serverTimestamp() },
    { merge: true },
  );
}

// ---------- winkels ----------

export async function addChain(hid, user, name) {
  const batch = writeBatch(db);
  const cRef = doc(col(hid, 'chains'));
  batch.set(cRef, { schemaVersion: SCHEMA_VERSION, name, deleted: false, createdAt: serverTimestamp(), createdBy: user.uid });
  await batch.commit();
  return cRef.id;
}

// Zonder chainId krijgt de winkel een eigen keten met dezelfde naam.
// Met layout kan de looproute van een ander filiaal worden meegegeven.
export async function addStore(hid, user, name, order, { chainId = null, layout = [] } = {}) {
  const batch = writeBatch(db);
  const sRef = doc(col(hid, 'stores'));
  let chain = chainId;
  if (!chain) {
    const cRef = doc(col(hid, 'chains'));
    chain = cRef.id;
    batch.set(cRef, {
      schemaVersion: SCHEMA_VERSION,
      name,
      deleted: false,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    });
  }
  batch.set(sRef, {
    schemaVersion: SCHEMA_VERSION,
    name,
    order,
    chainId: chain,
    disabledSectionIds: [],
    layout,
    deleted: false,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  const actionId = logAction(batch, hid, user, {
    type: 'store.add',
    label: `Winkel ${name} toegevoegd`,
    target: { col: 'stores', id: sRef.id },
    before: { deleted: true },
    after: { deleted: false },
  });
  await batch.commit();
  return { storeId: sRef.id, actionId };
}

export async function updateStore(hid, user, store, changes, label) {
  const batch = writeBatch(db);
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, store[k] ?? null]));
  batch.update(ref(hid, 'stores', store.id), { ...changes, updatedAt: serverTimestamp(), updatedBy: user.uid });
  const actionId = logAction(batch, hid, user, {
    type: changes.deleted ? 'store.delete' : 'store.edit',
    label,
    target: { col: 'stores', id: store.id },
    before,
    after: changes,
  });
  await batch.commit();
  return actionId;
}

// Volgorde van de winkelbalk opslaan (geen undo: cosmetisch en direct terug te zetten).
export async function setStoreOrder(hid, user, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => {
    batch.update(ref(hid, 'stores', id), { order: i, updatedAt: serverTimestamp(), updatedBy: user.uid });
  });
  await batch.commit();
}

// ---------- items ----------

// fields: { name, key, qty, unit, storeId, sectionId }
// product: { id, isNew, data } — data wordt bij een nieuw product als geheugen opgeslagen.
export async function addItem(hid, user, list, fields, product) {
  const batch = writeBatch(db);
  const iRef = doc(col(hid, 'items'));
  batch.set(iRef, {
    schemaVersion: SCHEMA_VERSION,
    name: fields.name,
    key: fields.key,
    productId: product.id,
    qty: fields.qty,
    unit: fields.unit,
    listId: list.id,
    ownerUid: list.ownerUid,
    storeId: fields.storeId,
    sectionId: fields.sectionId,
    checked: false,
    checkedAt: null,
    checkedBy: null,
    archived: false,
    deleted: false,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });

  const productData = {
    schemaVersion: SCHEMA_VERSION,
    name: fields.name,
    key: fields.key,
    ownerUid: list.ownerUid,
    updatedAt: serverTimestamp(),
  };
  if (product.isNew) {
    Object.assign(productData, {
      // Algemene sectie (geldt overal) + waar het in déze winkel ligt.
      sectionId: product.generalSectionId || fields.sectionId,
      ...(product.extra || {}),
      defaultUnit: fields.unit,
      defaultQty: fields.qty,
      preferredStoreId: fields.storeId,
      createdAt: serverTimestamp(),
    });
  }
  batch.set(ref(hid, 'products', product.id), productData, { merge: true });

  const actionId = logAction(batch, hid, user, {
    type: 'item.add',
    label: `${fields.name} toegevoegd`,
    ownerUid: list.ownerUid,
    target: { col: 'items', id: iRef.id },
    before: { deleted: true, archived: true },
    after: { deleted: false, archived: false },
  });
  await batch.commit();
  return { itemId: iRef.id, actionId };
}

export async function setItemChecked(hid, user, item, checked) {
  const batch = writeBatch(db);
  batch.update(ref(hid, 'items', item.id), {
    checked,
    checkedAt: checked ? serverTimestamp() : null,
    checkedBy: checked ? user.uid : null,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  // Afvinken telt als "gekocht bij deze winkel"; terugzetten draait dat terug.
  const productEffect = item.productId
    ? { productId: item.productId, path: ['storeCounts', item.storeId], delta: checked ? 1 : -1 }
    : null;
  applyProductEffect(batch, hid, productEffect);
  const actionId = logAction(batch, hid, user, {
    type: checked ? 'item.check' : 'item.uncheck',
    label: `${item.name} ${checked ? 'afgevinkt' : 'teruggezet'}`,
    ownerUid: item.ownerUid,
    target: { col: 'items', id: item.id },
    before: { checked: !checked },
    after: { checked },
    productEffect,
  });
  await batch.commit();
  return actionId;
}

// changes: subset van { name, key, productId, qty, unit, storeId, sectionId }
// productUpdates: geheugen bijwerken (sectie/eenheid corrigeren), of null.
export async function updateItem(hid, user, item, changes, productUpdates) {
  const batch = writeBatch(db);
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, item[k] ?? null]));
  batch.update(ref(hid, 'items', item.id), { ...changes, updatedAt: serverTimestamp(), updatedBy: user.uid });

  if (productUpdates) {
    batch.set(
      ref(hid, 'products', productUpdates.id),
      { ...productUpdates.data, ownerUid: item.ownerUid, schemaVersion: SCHEMA_VERSION, updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  // Ander winkel = doorsturen. Bijhouden voor de suggesties (3x zelfde richting).
  let productEffect = null;
  const moved = changes.storeId && changes.storeId !== item.storeId;
  if (moved) {
    productEffect = {
      productId: changes.productId || item.productId,
      path: ['forwardStats', `${item.storeId}__${changes.storeId}`],
      delta: 1,
    };
    applyProductEffect(batch, hid, productEffect);
  }

  const actionId = logAction(batch, hid, user, {
    type: moved ? 'item.move' : 'item.edit',
    label: moved ? `${item.name} verplaatst` : `${changes.name || item.name} aangepast`,
    ownerUid: item.ownerUid,
    target: { col: 'items', id: item.id },
    before,
    after: changes,
    productEffect,
  });
  await batch.commit();
  return actionId;
}

export async function deleteItem(hid, user, item) {
  const batch = writeBatch(db);
  batch.update(ref(hid, 'items', item.id), {
    deleted: true,
    archived: true,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  const actionId = logAction(batch, hid, user, {
    type: 'item.delete',
    label: `${item.name} verwijderd`,
    ownerUid: item.ownerUid,
    target: { col: 'items', id: item.id },
    before: { deleted: false, archived: false },
    after: { deleted: true, archived: true },
  });
  await batch.commit();
  return actionId;
}

// ---------- samengestelde wijzigingen ----------

// changes: [{ col, id, before, after }] — alles in één batch, één regel in het log,
// en dus ook in één keer ongedaan te maken.
export async function applyChanges(hid, user, { type, label, ownerUid = SHARED, changes }) {
  const batch = writeBatch(db);
  for (const c of changes) {
    batch.update(ref(hid, c.col, c.id), { ...c.after, updatedAt: serverTimestamp(), updatedBy: user.uid });
  }
  const actionId = logAction(batch, hid, user, {
    type,
    label,
    ownerUid,
    changes: changes.map((c) => ({ col: c.col, id: c.id, before: c.before, after: c.after })),
  });
  await batch.commit();
  return actionId;
}

// ---------- secties ----------

// chainId null = voor alle winkels; anders alleen voor die keten.
// parentKey = de standaardsectie waar hij onder valt (en die hij bij die keten vervangt).
export async function addSection(hid, user, { name, chainId, parentKey, order }) {
  const batch = writeBatch(db);
  const sRef = doc(col(hid, 'sections'));
  batch.set(sRef, {
    schemaVersion: SCHEMA_VERSION,
    name,
    custom: true,
    storeId: null,
    chainId: chainId || null,
    parentKey: parentKey || 'overig',
    order,
    deleted: false,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  const actionId = logAction(batch, hid, user, {
    type: 'section.add',
    label: `Sectie ${name} toegevoegd`,
    target: { col: 'sections', id: sRef.id },
    before: { deleted: true },
    after: { deleted: false },
  });
  await batch.commit();
  return { sectionId: sRef.id, actionId };
}

// Indeling importeren in één batch: nieuwe secties + looproute (+ secties weer aanzetten).
// newSections: [{ tempId, name, parentKey, order }] — tempId komt in de layout voor
// en wordt hier vervangen door het echte id. Eén regel in het log, in één keer ongedaan te maken.
export async function importLayout(hid, user, { store, chainId, newSections, layout, enableIds, label }) {
  const batch = writeBatch(db);
  const idMap = {};
  const changes = [];
  for (const s of newSections) {
    const sRef = doc(col(hid, 'sections'));
    idMap[s.tempId] = sRef.id;
    batch.set(sRef, {
      schemaVersion: SCHEMA_VERSION,
      name: s.name,
      custom: true,
      storeId: null,
      chainId: chainId || null,
      parentKey: s.parentKey || 'overig',
      order: s.order,
      deleted: false,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    });
    changes.push({ col: 'sections', id: sRef.id, before: { deleted: true }, after: { deleted: false } });
  }
  const finalLayout = layout.map((g) => ({ ...g, sectionIds: g.sectionIds.map((id) => idMap[id] || id) }));
  const before = { layout: store.layout || [] };
  const after = { layout: finalLayout };
  if (enableIds?.length) {
    before.disabledSectionIds = store.disabledSectionIds || [];
    after.disabledSectionIds = (store.disabledSectionIds || []).filter((id) => !enableIds.includes(id));
  }
  batch.update(ref(hid, 'stores', store.id), { ...after, updatedAt: serverTimestamp(), updatedBy: user.uid });
  changes.push({ col: 'stores', id: store.id, before, after });
  const actionId = logAction(batch, hid, user, { type: 'compound', label, changes });
  await batch.commit();
  return actionId;
}

// Volgorde opslaan (geen undo: cosmetisch en direct terug te zetten).
export async function setSectionOrder(hid, user, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => {
    batch.update(ref(hid, 'sections', id), { order: i, updatedAt: serverTimestamp(), updatedBy: user.uid });
  });
  await batch.commit();
}

// ---------- undo ----------

export const UNDOABLE = new Set([
  'compound',
  'section.add',
  'store.add',
  'store.edit',
  'store.delete',
  'item.add',
  'item.check',
  'item.uncheck',
  'item.edit',
  'item.move',
  'item.delete',
]);

export async function undoAction(hid, user, action) {
  if (action.changes?.length) {
    const batch = writeBatch(db);
    for (const c of action.changes) {
      batch.update(ref(hid, c.col, c.id), { ...c.before, updatedAt: serverTimestamp(), updatedBy: user.uid });
    }
    logAction(batch, hid, user, {
      type: 'undo',
      undoOf: action.id,
      label: `Ongedaan: ${action.label}`,
      ownerUid: action.ownerUid || SHARED,
      changes: action.changes.map((c) => ({ col: c.col, id: c.id, before: c.after, after: c.before })),
    });
    await batch.commit();
    return;
  }
  if (!UNDOABLE.has(action.type) || !action.target || !action.before) throw new Error('Niet terug te draaien');
  const batch = writeBatch(db);
  const fields = { ...action.before, updatedAt: serverTimestamp(), updatedBy: user.uid };
  if ('checked' in action.before) {
    fields.checkedAt = action.before.checked ? serverTimestamp() : null;
    fields.checkedBy = action.before.checked ? user.uid : null;
  }
  batch.update(ref(hid, action.target.col, action.target.id), fields);
  applyProductEffect(batch, hid, action.productEffect, -1);
  logAction(batch, hid, user, {
    type: 'undo',
    undoOf: action.id,
    label: `Ongedaan: ${action.label}`,
    ownerUid: action.ownerUid || SHARED,
    target: action.target,
    before: action.after,
    after: action.before,
  });
  await batch.commit();
}
