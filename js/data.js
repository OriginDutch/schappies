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
  getDocFromServer,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  writeBatch,
  runTransaction,
  waitForPendingWrites,
  deleteDoc,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  Timestamp,
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

  batch.set(hRef, { ...base, name, ownerUid: user.uid, members: [user.uid], memberNames: { [user.uid]: user.displayName || '' } });
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

// ---------- uitnodigen ----------

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // geen 0/O en 1/I
const INVITE_HOURS = 24;

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

// Alleen de eigenaar. Eén keer te gebruiken, 24 uur geldig.
export async function createInvite(hid, user, householdName) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const iRef = doc(db, 'invites', code);
    const existing = await getDoc(iRef).catch(() => null);
    if (existing?.exists()) continue;
    const batch = writeBatch(db);
    batch.set(iRef, {
      schemaVersion: SCHEMA_VERSION,
      hid,
      householdName,
      createdBy: user.uid,
      createdByName: user.displayName || '',
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + INVITE_HOURS * 3600 * 1000),
      usedBy: null,
      usedAt: null,
      revoked: false,
    });
    await batch.commit();
    return code;
  }
  throw new Error('Kon geen unieke code maken, probeer opnieuw.');
}

export async function getInvite(code) {
  const snap = await getDoc(doc(db, 'invites', normalizeCode(code)));
  return snap.exists() ? { code: snap.id, ...snap.data() } : null;
}

// Ben je (nog) lid? Een verwijderd lid mag het huishouden niet meer lezen.
export async function isMemberOf(hid, uid) {
  try {
    const snap = await getDoc(householdRef(hid));
    return snap.exists() && (snap.data().members || []).includes(uid);
  } catch {
    return false;
  }
}

export function inviteStatus(invite) {
  if (!invite) return 'onbekend';
  if (invite.revoked) return 'ingetrokken';
  if (invite.usedBy) return 'gebruikt';
  const exp = invite.expiresAt?.toMillis ? invite.expiresAt.toMillis() : 0;
  if (exp <= Date.now()) return 'verlopen';
  return 'geldig';
}

export function watchMyInvites(uid, onData, onError) {
  return onSnapshot(
    query(collection(db, 'invites'), where('createdBy', '==', uid)),
    (snap) => onData(snap.docs.map((d) => ({ code: d.id, ...d.data() }))),
    onError,
  );
}

export async function revokeInvite(code) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'invites', code), { revoked: true, revokedAt: serverTimestamp() });
  await batch.commit();
}

// Meedoen: uitnodiging gebruiken, jezelf toevoegen, profiel omzetten,
// een eigen Privé-lijst aanmaken en het vastleggen in het log. Alles in één batch.
export async function joinHousehold(user, invite) {
  const hid = invite.hid;
  const batch = writeBatch(db);
  batch.update(doc(db, 'invites', invite.code), { usedBy: user.uid, usedAt: serverTimestamp() });
  batch.update(householdRef(hid), {
    members: arrayUnion(user.uid),
    [`memberNames.${user.uid}`]: user.displayName || '',
    lastJoinCode: invite.code,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  batch.set(
    userRef(user.uid),
    { schemaVersion: SCHEMA_VERSION, householdId: hid, displayName: user.displayName || '', updatedAt: serverTimestamp() },
    { merge: true },
  );
  batch.set(doc(col(hid, 'lists')), {
    schemaVersion: SCHEMA_VERSION,
    name: 'Privé',
    ownerUid: user.uid,
    order: 1,
    deleted: false,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
  });
  logAction(batch, hid, user, { type: 'member.join', label: `${user.displayName || 'Iemand'} doet mee` });
  await batch.commit();
  return hid;
}

// Alleen de eigenaar. Haar/zijn privélijst blijft bestaan, maar is voor niemand anders zichtbaar.
export async function removeMember(hid, user, memberUid, memberName) {
  const batch = writeBatch(db);
  batch.update(householdRef(hid), { members: arrayRemove(memberUid), updatedAt: serverTimestamp(), updatedBy: user.uid });
  logAction(batch, hid, user, { type: 'member.remove', label: `${memberName || 'Lid'} verwijderd uit het huishouden` });
  await batch.commit();
}

// ---------- luisteren ----------

export function watchHousehold(hid, onData, onError) {
  return onSnapshot(
    householdRef(hid),
    (snap) => {
      // Een lege cache (bijv. na 'gegevens wissen') zegt niets: alleen de
      // server mag zeggen dat het huishouden echt niet bestaat.
      if (!snap.exists() && snap.metadata.fromCache) return;
      onData(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    },
    onError,
  );
}

// Vraagt de server direct of je bij het huishouden kunt.
// 'ok' | 'missing' | 'denied'; gooit bij andere fouten (bijv. offline).
export async function checkHouseholdAccess(hid) {
  try {
    const snap = await getDocFromServer(householdRef(hid));
    return snap.exists() ? 'ok' : 'missing';
  } catch (err) {
    if (err?.code === 'permission-denied') return 'denied';
    throw err;
  }
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

// Alle winkels, ook die in de prullenbak (de app filtert zelf).
export function watchStores(hid, onData, onError) {
  return onSnapshot(
    col(hid, 'stores'),
    (snap) => onData(toDocs(snap).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'nl'))),
    onError,
  );
}

// Verwijderde items (prullenbak). Alleen geladen als dat nodig is.
export function watchTrashItems(hid, uid, onData, onError) {
  return watchVisible(col(hid, 'items'), uid, [where('deleted', '==', true)], onData, onError);
}

// Definitief verwijderen wat langer dan een week in de prullenbak ligt.
// Per document, zodat één weigering (bijv. al door een ander toestel opgeruimd)
// de rest niet tegenhoudt. De rules controleren zelf ook of het echt een week is.
export async function purgeTrash(hid, user, targets) {
  if (!targets.length) return 0;
  const results = await Promise.allSettled(targets.slice(0, 200).map((t) => deleteDoc(ref(hid, t.col, t.id))));
  const n = results.filter((r) => r.status === 'fulfilled').length;
  if (n) {
    const batch = writeBatch(db);
    logAction(batch, hid, user, { type: 'trash.purge', label: `Prullenbak: ${n} definitief verwijderd` });
    await batch.commit().catch(() => {});
  }
  return n;
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

function logEntry(user, entry) {
  return {
    schemaVersion: SCHEMA_VERSION,
    by: user.uid,
    byName: user.displayName || '',
    at: serverTimestamp(),
    ownerUid: SHARED,
    before: null,
    after: null,
    ...entry,
  };
}

function logAction(batch, hid, user, entry) {
  const aRef = doc(col(hid, 'activity'));
  batch.set(aRef, logEntry(user, entry));
  return aRef.id;
}

// { path: ['storeCounts', storeId], delta: 1 } → { storeCounts: { [storeId]: increment(1) } }
function nestedIncrement(path, delta) {
  return path.reduceRight((acc, key) => ({ [key]: acc }), increment(delta));
}

// Teller op een product ophogen. ownerUid gaat mee, zodat het ook klopt met de
// rules als het product intussen definitief verwijderd is.
function applyProductEffect(batch, hid, effect, sign = 1) {
  if (!effect) return;
  const extra = effect.ownerUid ? { ownerUid: effect.ownerUid } : {};
  batch.set(
    ref(hid, 'products', effect.productId),
    { ...nestedIncrement(effect.path, effect.delta * sign), ...extra, updatedAt: serverTimestamp() },
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
    parts: fields.parts || null,
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
      deleted: false,
      // Algemene sectie (geldt overal) + waar het in déze winkel ligt.
      sectionId: product.generalSectionId || fields.sectionId,
      ...(product.extra || {}),
      defaultUnit: fields.unit,
      preferredStoreId: fields.storeId,
      createdAt: serverTimestamp(),
    });
  }
  // reset: product lag in de prullenbak (of is vergeten) → helemaal opnieuw leren.
  batch.set(ref(hid, 'products', product.id), productData, product.reset ? {} : { merge: true });

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

// productOwnerUid: eigenaar van het product als dat nog bestaat; null = geen teller.
export async function setItemChecked(hid, user, item, checked, productOwnerUid = null) {
  const batch = writeBatch(db);
  batch.update(ref(hid, 'items', item.id), {
    checked,
    checkedAt: checked ? serverTimestamp() : null,
    checkedBy: checked ? user.uid : null,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  // Afvinken telt als "gekocht bij deze winkel"; terugzetten draait dat terug.
  const productEffect =
    item.productId && productOwnerUid
      ? { productId: item.productId, ownerUid: productOwnerUid, path: ['storeCounts', item.storeId], delta: checked ? 1 : -1 }
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
// extraChanges: [{ col, id, before, after }] die mee ongedaan gemaakt worden (bijv. 'iedere keer').
export async function updateItem(hid, user, item, changes, productUpdates, { productOwnerUid = null, extraChanges = [] } = {}) {
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
  if (moved && productOwnerUid && (changes.productId || item.productId)) {
    productEffect = {
      productId: changes.productId || item.productId,
      ownerUid: productOwnerUid,
      path: ['forwardStats', `${item.storeId}__${changes.storeId}`],
      delta: 1,
    };
    applyProductEffect(batch, hid, productEffect);
  }
  for (const c of extraChanges) {
    batch.update(ref(hid, c.col, c.id), { ...c.after, updatedAt: serverTimestamp(), updatedBy: user.uid });
  }

  const actionId = logAction(batch, hid, user, {
    type: moved ? 'item.move' : 'item.edit',
    label: moved ? `${item.name} verplaatst` : `${changes.name || item.name} aangepast`,
    ownerUid: item.ownerUid,
    target: { col: 'items', id: item.id },
    before,
    after: changes,
    productEffect,
    changes: extraChanges.length ? extraChanges : null,
  });
  await batch.commit();
  return actionId;
}

export async function deleteItem(hid, user, item) {
  const batch = writeBatch(db);
  batch.update(ref(hid, 'items', item.id), {
    deleted: true,
    archived: true,
    deletedAt: Timestamp.fromMillis(Date.now()),
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
  const actionId = logAction(batch, hid, user, {
    type: 'item.delete',
    label: `${item.name} verwijderd`,
    ownerUid: item.ownerUid,
    target: { col: 'items', id: item.id },
    before: { deleted: false, archived: false, deletedAt: null },
    after: { deleted: true, archived: true },
  });
  await batch.commit();
  return actionId;
}

// ---------- rondes ----------

// Te veel schrijfacties voor één transactie (Firestore-limiet 500).
const MAX_WRITES = 480;
const conflict = (msg) => Object.assign(new Error(msg), { code: 'round-changed' });

// Een ronde afronden bij één winkel, voor één lijst. Als transactie: eerst
// controleren dat niemand anders hem net heeft afgerond of aangepast.
// checked: afgevinkte items → naar de historie (archived + tripId).
// open: [{ item, choice: 'stay'|'forward'|'trash', storeId, sectionId, productOwnerUid }]
// recurring: [{ fields, productId }] → nieuwe items voor 'iedere keer'-producten.
// products: [{ id, before }] → lastBoughtAt/lastBoughtStoreId bijwerken.
export async function finishRound(hid, user, { list, store, checked, open, recurring, products, names }) {
  const writes = checked.length + open.length * 2 + recurring.length + products.length + 3;
  if (writes > MAX_WRITES) throw Object.assign(new Error('Te veel items in één ronde.'), { code: 'too-big' });

  // Eerst alles wat dit toestel nog moet versturen (bijv. net afgevinkt) naar de
  // server, anders ziet de transactie de oude stand. Zonder verbinding: duidelijke fout.
  await pendingWritesOrOffline();

  const tRef = checked.length ? doc(col(hid, 'trips')) : null;
  const newItemRefs = recurring.map(() => doc(col(hid, 'items')));
  const aRef = doc(col(hid, 'activity'));

  const actionId = await runTransaction(db, async (tx) => {
    // Lezen: klopt de staat nog met wat dit toestel ziet?
    const touched = [
      ...checked.map((i) => ({ i, want: 'checked' })),
      ...open.filter((o) => o.choice !== 'stay').map((o) => ({ i: o.item, want: 'open' })),
    ];
    const snaps = await Promise.all(touched.map((t) => tx.get(ref(hid, 'items', t.i.id))));
    snaps.forEach((snap, k) => {
      const d = snap.exists() ? snap.data() : null;
      if (!d || d.archived || d.deleted) throw conflict('Deze ronde is net door iemand anders afgerond of aangepast.');
      if (touched[k].want === 'checked' && !d.checked) throw conflict('Er is net iets teruggezet. Kijk even opnieuw.');
      if (touched[k].want === 'open' && d.checked) throw conflict('Er is net iets afgevinkt. Kijk even opnieuw.');
    });

    const now = Timestamp.fromMillis(Date.now());
    const changes = [];
    const effects = [];

    if (tRef) {
      tx.set(tRef, {
        schemaVersion: SCHEMA_VERSION,
        ownerUid: list.ownerUid,
        listId: list.id,
        listName: list.name,
        storeId: store.id,
        storeName: store.name,
        chainId: store.chainId || null,
        finishedAt: now,
        finishedBy: user.uid,
        finishedByName: user.displayName || '',
        items: checked.map((i) => tripLine(i, names)),
        removed: [],
        deleted: false,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
      });
      changes.push({ col: 'trips', id: tRef.id, before: { deleted: true }, after: { deleted: false } });
      for (const i of checked) {
        const after = { archived: true, tripId: tRef.id };
        tx.update(ref(hid, 'items', i.id), { ...after, updatedAt: serverTimestamp(), updatedBy: user.uid });
        changes.push({ col: 'items', id: i.id, before: { archived: false, tripId: null }, after });
      }
    }

    for (const o of open) {
      let before = null;
      let after = null;
      if (o.choice === 'forward' && o.storeId && o.storeId !== o.item.storeId) {
        before = { storeId: o.item.storeId, sectionId: o.item.sectionId ?? null };
        after = { storeId: o.storeId, sectionId: o.sectionId ?? null };
        if (o.item.productId && o.productOwnerUid) {
          const e = { productId: o.item.productId, ownerUid: o.productOwnerUid, path: ['forwardStats', `${o.item.storeId}__${o.storeId}`], delta: 1 };
          applyProductEffect(tx, hid, e);
          effects.push(e);
        }
      } else if (o.choice === 'trash') {
        before = { deleted: false, archived: false, deletedAt: null };
        after = { deleted: true, archived: true, deletedAt: now };
      }
      if (!after) continue;
      tx.update(ref(hid, 'items', o.item.id), { ...after, updatedAt: serverTimestamp(), updatedBy: user.uid });
      changes.push({ col: 'items', id: o.item.id, before, after });
    }

    recurring.forEach((r, k) => {
      tx.set(newItemRefs[k], newItemDoc(user, list, r.fields, r.productId));
      changes.push({ col: 'items', id: newItemRefs[k].id, before: { deleted: true, archived: true }, after: { deleted: false, archived: false } });
    });

    for (const p of products) {
      const after = { lastBoughtAt: now, lastBoughtStoreId: store.id };
      // merge + eigenaar: werkt ook als een ander toestel het product net heeft opgeruimd.
      tx.set(ref(hid, 'products', p.id), { ...after, ownerUid: p.ownerUid, updatedAt: serverTimestamp() }, { merge: true });
      changes.push({ col: 'products', id: p.id, before: p.before, after });
    }

    if (!changes.length) return null;
    tx.set(aRef, logEntry(user, { type: 'compound', label: `Ronde ${store.name} afgerond`, ownerUid: list.ownerUid, changes, effects }));
    return aRef.id;
  });
  return { tripId: tRef?.id || null, actionId };
}

async function pendingWritesOrOffline() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw Object.assign(new Error('offline'), { code: 'unavailable' });
  }
  await Promise.race([
    waitForPendingWrites(db),
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('offline'), { code: 'unavailable' })), 15000)),
  ]);
}

const newLineId = () => Math.random().toString(36).slice(2, 10);

// Kopie van een item zoals het in de historie komt. names: uid → naam.
export function tripLine(i, names = {}) {
  return {
    lineId: newLineId(),
    itemId: i.id || null,
    productId: i.productId || null,
    name: i.name,
    qty: i.qty ?? null,
    unit: i.unit || null,
    parts: Array.isArray(i.parts) && i.parts.length > 1 ? i.parts : null,
    checkedBy: i.checkedBy || null,
    checkedByName: (i.checkedBy && names[i.checkedBy]) || '',
    checkedAt: i.checkedAt && typeof i.checkedAt.toMillis === 'function' ? Timestamp.fromMillis(i.checkedAt.toMillis()) : null,
  };
}

function newItemDoc(user, list, fields, productId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: fields.name,
    key: fields.key,
    productId: productId || null,
    qty: fields.qty ?? null,
    unit: fields.unit || 'st',
    parts: fields.parts || null,
    listId: list.id,
    ownerUid: list.ownerUid,
    storeId: fields.storeId,
    sectionId: fields.sectionId ?? null,
    checked: false,
    checkedAt: null,
    checkedBy: null,
    archived: false,
    deleted: false,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  };
}

// Eén bewerking op de regels van een ronde, op lineId (niet op positie), zodat
// twee mensen tegelijk elkaars wijziging niet overschrijven.
// Geeft { items, removed, inverse } of null als de regel er niet (meer) is.
function applyTripOp(trip, op) {
  const items = [...(trip.items || [])];
  const removed = [...(trip.removed || [])];
  const idx = items.findIndex((l) => l.lineId === op.lineId);
  switch (op.op) {
    case 'add': {
      if (items.some((l) => l.lineId === op.line.lineId)) return null;
      items.splice(Math.min(op.index ?? items.length, items.length), 0, op.line);
      return { items, removed, inverse: { op: 'remove', lineId: op.line.lineId, toTrash: false } };
    }
    case 'remove': {
      if (idx < 0) return null;
      const [line] = items.splice(idx, 1);
      if (op.toTrash) removed.push({ ...line, removedAt: Timestamp.fromMillis(Date.now()) });
      return { items, removed, inverse: { op: 'restore', lineId: line.lineId, line, index: idx } };
    }
    case 'restore': {
      if (idx >= 0) return null;
      const r = removed.findIndex((l) => l.lineId === op.lineId);
      let line = op.line;
      if (r >= 0) [line] = removed.splice(r, 1);
      if (!line) return null;
      const { removedAt, ...clean } = line;
      items.splice(Math.min(op.index ?? items.length, items.length), 0, clean);
      return { items, removed, inverse: { op: 'remove', lineId: op.lineId, toTrash: r >= 0 } };
    }
    case 'edit': {
      if (idx < 0) return null;
      const before = Object.fromEntries(Object.keys(op.after).map((k) => [k, items[idx][k] ?? null]));
      items[idx] = { ...items[idx], ...op.after };
      return { items, removed, inverse: { op: 'edit', lineId: op.lineId, after: before } };
    }
    case 'purge': {
      const r = removed.findIndex((l) => l.lineId === op.lineId);
      if (r < 0) return null;
      removed.splice(r, 1);
      return { items, removed, inverse: null };
    }
    default:
      return null;
  }
}

// Bewerkingen op rondes uitvoeren binnen een transactie. strict: een regel die er
// niet meer is = fout (bij gewone acties); bij undo gewoon overslaan.
// Een op kan tellers meedragen (effects): die gaan alleen mee als de op echt
// uitgevoerd wordt, zodat undo na een gelijktijdige wijziging niet dubbel telt.
async function runTripOps(tx, hid, tripOps, strict, sign = 1) {
  const ids = [...new Set(tripOps.map((t) => t.tripId))];
  const snaps = await Promise.all(ids.map((id) => tx.get(ref(hid, 'trips', id))));
  const trips = new Map(snaps.map((sn, k) => [ids[k], sn.exists() ? sn.data() : null]));
  const inverses = [];
  const changed = new Set();
  for (const t of tripOps) {
    const trip = trips.get(t.tripId);
    const res = trip && applyTripOp(trip, t);
    if (!res) {
      if (strict) throw conflict('Deze ronde is net aangepast. Kijk even opnieuw.');
      continue;
    }
    trip.items = res.items;
    trip.removed = res.removed;
    changed.add(t.tripId);
    for (const e of t.effects || []) applyProductEffect(tx, hid, e, sign);
    if (res.inverse) inverses.unshift({ tripId: t.tripId, ...res.inverse, effects: t.effects || [] });
  }
  const write = () => {
    for (const id of changed) {
      const trip = trips.get(id);
      if (trip) tx.update(ref(hid, 'trips', id), { items: trip.items || [], removed: trip.removed || [], updatedAt: serverTimestamp() });
    }
  };
  return { inverses, write, count: changed.size };
}

// Algemene samengestelde wijziging, in één keer ongedaan te maken.
// creates: [{ col, data, before, after }] — data is het volledige nieuwe document;
//   before/after zijn de velden die undo omzet (bijv. deleted true/false).
// changes: [{ col, id, before, after }] — gewone updates.
// effects: [{ productId, ownerUid, path, delta }] — tellers (increment, ook bij undo).
// tripOps: [{ tripId, op, ... }] — regels van een ronde, als transactie.
export async function commitCompound(hid, user, { label, ownerUid = SHARED, creates = [], changes = [], effects = [], tripOps = [] }) {
  if (!creates.length && !changes.length && !effects.length && !tripOps.length) return { actionId: null, ids: [] };
  const createRefs = creates.map((c) => doc(col(hid, c.col)));
  const aRef = doc(col(hid, 'activity'));
  const writeRest = (w) => {
    const all = [];
    creates.forEach((c, k) => {
      w.set(createRefs[k], { schemaVersion: SCHEMA_VERSION, ...c.data, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid });
      all.push({ col: c.col, id: createRefs[k].id, before: c.before, after: c.after });
    });
    for (const c of changes) {
      w.update(ref(hid, c.col, c.id), { ...c.after, updatedAt: serverTimestamp(), updatedBy: user.uid });
      all.push({ col: c.col, id: c.id, before: c.before, after: c.after });
    }
    for (const e of effects) applyProductEffect(w, hid, e);
    return all;
  };

  if (tripOps.length) {
    await pendingWritesOrOffline();
    await runTransaction(db, async (tx) => {
      const t = await runTripOps(tx, hid, tripOps, true);
      t.write();
      const all = writeRest(tx);
      tx.set(aRef, logEntry(user, { type: 'compound', label, ownerUid, changes: all, effects, tripUndo: t.inverses }));
    });
  } else {
    const batch = writeBatch(db);
    const all = writeRest(batch);
    batch.set(aRef, logEntry(user, { type: 'compound', label, ownerUid, changes: all, effects }));
    await batch.commit();
  }
  return { actionId: aRef.id, ids: createRefs.map((r) => r.id) };
}

// Suggestie voor de vaste winkel beantwoorden, als transactie: wie het eerst
// antwoordt beslist. answer: 'yes' | 'no' | 'never'.
// moves: [{ id, before, after }] — items die meeverhuizen (alleen bij 'yes').
export async function answerSuggestion(hid, user, { productId, key, toStoreId, answer, moves = [], label, threshold = 3 }) {
  await pendingWritesOrOffline();
  const pRef = ref(hid, 'products', productId);
  const aRef = doc(col(hid, 'activity'));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pRef);
    const p = snap.exists() ? snap.data() : null;
    // Items die meeverhuizen opnieuw lezen: alleen wat nog open op de lijst staat
    // en niet al bij de nieuwe winkel, met de echte 'before' van de server.
    const moveSnaps = answer === 'yes' ? await Promise.all(moves.map((m) => tx.get(ref(hid, 'items', m.id)))) : [];
    const n = p?.forwardStats?.[key] || 0;
    if (!p || p.deleted || p.suggestOff || n < threshold || p.preferredStoreId === toStoreId) {
      throw conflict('Deze suggestie is net al beantwoord.');
    }
    const changes = [];
    // Teller van deze richting terug naar 0 (met de echte stand van de server).
    const effects = [{ productId, ownerUid: p.ownerUid, path: ['forwardStats', key], delta: -n }];
    applyProductEffect(tx, hid, effects[0]);
    const after = {};
    if (answer === 'never') after.suggestOff = true;
    if (answer === 'yes') after.preferredStoreId = toStoreId;
    if (Object.keys(after).length) {
      const before = Object.fromEntries(Object.keys(after).map((k) => [k, p[k] ?? (k === 'suggestOff' ? false : null)]));
      tx.update(pRef, { ...after, updatedAt: serverTimestamp() });
      changes.push({ col: 'products', id: productId, before, after });
    }
    moveSnaps.forEach((ms, k) => {
      const d = ms.exists() ? ms.data() : null;
      if (!d || d.deleted || d.archived || d.checked || d.storeId === toStoreId) return;
      const m = moves[k];
      const before = { storeId: d.storeId, sectionId: d.sectionId ?? null };
      tx.update(ref(hid, 'items', m.id), { ...m.after, updatedAt: serverTimestamp(), updatedBy: user.uid });
      changes.push({ col: 'items', id: m.id, before, after: m.after });
    });
    tx.set(aRef, logEntry(user, { type: 'compound', label, ownerUid: p.ownerUid, changes, effects }));
  });
  return aRef.id;
}

// Regels die langer dan een week in de prullenbak van een ronde liggen opruimen.
export async function purgeTripLines(hid, user, trip, lineIds) {
  await runTransaction(db, async (tx) => {
    const t = await runTripOps(tx, hid, lineIds.map((lineId) => ({ tripId: trip.id, op: 'purge', lineId })), false);
    if (!t.count) return;
    t.write();
    tx.set(doc(col(hid, 'activity')), logEntry(user, { type: 'trash.purge', label: `Prullenbak: ${lineIds.length} regel(s) uit ronde ${trip.storeName || ''} definitief verwijderd`, ownerUid: trip.ownerUid || SHARED }));
  });
}

export { newItemDoc };

export const nowTs = () => Timestamp.fromMillis(Date.now());

// Rondes (historie). Wordt pas geladen als je de Historie opent.
export function watchTrips(hid, uid, onData, onError) {
  return watchVisible(
    col(hid, 'trips'),
    uid,
    [],
    (docs) => onData(docs.filter((t) => !t.deleted).sort((a, b) => toMillis(b.finishedAt) - toMillis(a.finishedAt))),
    onError,
  );
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
  const changes = action.changes || [];
  const effects = action.effects || [];
  const tripUndo = action.tripUndo || [];
  const hasTarget = UNDOABLE.has(action.type) && action.target && action.before;
  if (!changes.length && !effects.length && !tripUndo.length && !hasTarget) throw new Error('Niet terug te draaien');

  // Vast id: een tweede undo van dezelfde actie wordt een update, en die weigeren de rules.
  const aRef = doc(col(hid, 'activity'), `undo_${action.id}`);
  const writeAll = (w) => {
    if (hasTarget) {
      const fields = { ...action.before, updatedAt: serverTimestamp(), updatedBy: user.uid };
      if ('checked' in action.before) {
        fields.checkedAt = action.before.checked ? serverTimestamp() : null;
        fields.checkedBy = action.before.checked ? user.uid : null;
      }
      w.update(ref(hid, action.target.col, action.target.id), fields);
    }
    for (const c of changes) {
      w.update(ref(hid, c.col, c.id), { ...c.before, updatedAt: serverTimestamp(), updatedBy: user.uid });
    }
    for (const e of effects) applyProductEffect(w, hid, e, -1);
    applyProductEffect(w, hid, action.productEffect, -1);
    w.set(
      aRef,
      logEntry(user, {
        type: 'undo',
        undoOf: action.id,
        label: `Ongedaan: ${action.label}`,
        ownerUid: action.ownerUid || SHARED,
        target: action.target || null,
        before: action.after || null,
        after: action.before || null,
        changes: changes.map((c) => ({ col: c.col, id: c.id, before: c.after, after: c.before })),
      }),
    );
  };

  if (tripUndo.length) {
    await runTransaction(db, async (tx) => {
      const t = await runTripOps(tx, hid, tripUndo, false, -1);
      t.write();
      writeAll(tx);
    });
  } else {
    const batch = writeBatch(db);
    writeAll(batch);
    await batch.commit();
  }
}
