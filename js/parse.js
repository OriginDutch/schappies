// Tekst-hulpjes: snel-toevoegen ontleden, productsleutels, sectie raden.

export const UNITS = [
  { id: 'st', label: 'stuks' },
  { id: 'g', label: 'gram' },
  { id: 'kg', label: 'kilo' },
  { id: 'ml', label: 'ml' },
  { id: 'l', label: 'liter' },
  { id: 'pak', label: 'pak' },
  { id: 'blik', label: 'blik' },
  { id: 'fles', label: 'fles' },
  { id: 'pot', label: 'pot' },
  { id: 'zak', label: 'zak' },
  { id: 'bos', label: 'bos' },
  { id: 'doos', label: 'doos' },
];

const UNIT_ALIASES = {
  st: 'st', stuk: 'st', stuks: 'st', x: 'st',
  g: 'g', gr: 'g', gram: 'g',
  kg: 'kg', kilo: 'kg',
  ml: 'ml',
  l: 'l', liter: 'l', ltr: 'l',
  pak: 'pak', pakken: 'pak', pakje: 'pak', pakjes: 'pak',
  blik: 'blik', blikken: 'blik', blikje: 'blik', blikjes: 'blik',
  fles: 'fles', flessen: 'fles', flesje: 'fles', flesjes: 'fles',
  pot: 'pot', potten: 'pot', potje: 'pot', potjes: 'pot',
  zak: 'zak', zakken: 'zak', zakje: 'zak', zakjes: 'zak',
  bos: 'bos', bossen: 'bos', bosje: 'bos',
  doos: 'doos', dozen: 'doos', doosje: 'doos',
};

export function capitalize(s) {
  const t = s.trim();
  return t ? t[0].toLocaleUpperCase('nl') + t.slice(1) : t;
}

// "500 g wortels" → { qty: 500, unit: 'g', name: 'Wortels' }
// "2 melk"        → { qty: 2, unit: null, name: 'Melk' }
// "melk"          → { qty: null, unit: null, name: 'Melk' }
export function parseQuickAdd(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?\s+(.+)$/);
  if (!m) return { qty: null, unit: null, name: capitalize(text) };
  const qty = parseFloat(m[1].replace(',', '.'));
  const word = (m[2] || '').toLowerCase();
  if (word && UNIT_ALIASES[word]) return { qty, unit: UNIT_ALIASES[word], name: capitalize(m[3]) };
  const name = word ? `${m[2]} ${m[3]}` : m[3];
  return { qty, unit: null, name: capitalize(name) };
}

// Sleutel voor het productgeheugen: hoofdletterongevoelig, spaties genormaliseerd.
export function productKey(name) {
  return String(name || '')
    .toLocaleLowerCase('nl')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[/\\]/g, '-')
    .slice(0, 120);
}

export function formatQty(qty, unit) {
  if (qty == null || qty === '') return '';
  const n = Number(qty);
  const num = Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
  return unit ? `${num} ${unit}` : num;
}

// Sectie raden op basis van woorden. Volgorde telt: specifiek vóór algemeen.
// Korte woorden (≤ 3 tekens) moeten als heel woord voorkomen, langere mogen
// ergens in een samenstelling staan ("rundergehakt" → gehakt).
const RULES = [
  ['vega', ['vega', 'vegetarisch', 'plantaardig', 'tofu', 'tempeh', 'seitan', 'falafel', 'vegan']],
  ['huisdier', ['kattenvoer', 'kattenbak', 'kattengrit', 'kattensnack', 'hondenvoer', 'kat', 'hond', 'brokjes']],
  ['drogisterij', ['shampoo', 'conditioner', 'douchegel', 'zeep', 'tandpasta', 'tandenborstel', 'deo', 'deodorant', 'scheer', 'maandverband', 'tampon', 'wattenschijf', 'zonnebrand', 'paracetamol', 'ibuprofen', 'pleister', 'bodylotion', 'handcrème', 'mondwater', 'flosdraad']],
  ['huishouden', ['toiletpapier', 'wc-papier', 'wc papier', 'keukenrol', 'wasmiddel', 'wasverzachter', 'wasverz', 'vaatwas', 'afwasmiddel', 'schoonmaak', 'allesreiniger', 'vuilniszak', 'afvalzak', 'aluminiumfolie', 'bakpapier', 'vershoudfolie', 'spons', 'batterij', 'lamp', 'theedoek']],
  ['kruiden-sauzen', ['paprikapoeder', 'ketchup', 'mayo', 'mayonaise', 'mosterd', 'saus', 'sambal', 'sojasaus', 'ketjap', 'kokki', 'peper', 'zout', 'kruiden', 'komijn', 'kurkuma', 'oregano', 'pesto', 'dressing', 'curry', 'sriracha', 'kaneel', 'nootmuskaat']],
  ['ontbijt-beleg', ['pindakaas', 'hagelslag', 'jam', 'honing', 'nutella', 'chocopasta', 'cornflakes', 'muesli', 'granola', 'havermout', 'cruesli', 'ontbijtkoek', 'appelstroop', 'vlokken']],
  ['houdbaar', ['kokosmelk', 'tomatenblokjes', 'passata', 'tomatenpuree', 'pasta', 'spaghetti', 'macaroni', 'penne', 'fusilli', 'lasagne', 'rijst', 'noedels', 'mie', 'kikkererwten', 'linzen', 'bouillon', 'meel', 'tarwebloem', 'patentbloem', 'suiker', 'olie', 'azijn', 'tortilla', 'wraps', 'tonijn']],
  ['snacks', ['chips', 'nootjes', 'noten', 'pinda', 'chocolade', 'snoep', 'drop', 'koekjes', 'koek', 'popcorn', 'borrel', 'repen', 'mars', 'snickers']],
  ['dranken', ['appelsap', 'jus', 'cola', 'frisdrank', 'fris', 'water', 'spa', 'sap', 'bier', 'wijn', 'thee', 'koffie', 'energy', 'ranja', 'siroop', 'pepper', 'pepsi', 'fanta', 'sprite', 'ice tea', 'icetea', 'smoothie']],
  ['diepvries', ['diepvries', 'ijs', 'ijsjes', 'pizza', 'friet', 'patat', 'kroket', 'bitterbal', 'loempia', 'doperwten', 'spinazie à la crème']],
  ['groente-fruit', ['sperziebonen', 'appel', 'peer', 'banaan', 'bananen', 'sinaasappel', 'mandarijn', 'citroen', 'limoen', 'druiven', 'aardbei', 'bessen', 'frambo', 'kiwi', 'mango', 'ananas', 'meloen', 'avocado', 'tomaat', 'tomaten', 'trostomaten', 'komkommer', 'paprika', 'ui', 'uien', 'knoflook', 'prei', 'wortel', 'wortels', 'winterpeen', 'broccoli', 'bloemkool', 'spinazie', 'sla', 'rucola', 'courgette', 'aubergine', 'champignon', 'paddenstoel', 'aardappel', 'krieltjes', 'gember', 'peterselie', 'koriander', 'bieslook', 'spruitjes', 'boerenkool', 'andijvie', 'bosui', 'radijs', 'selderij', 'pompoen', 'groente', 'fruit']],
  ['kaas-vleeswaren', ['kaas', 'cheddar', 'mozzarella', 'parmezaan', 'feta', 'brie', 'ham', 'salami', 'rookvlees', 'filet americain', 'leverworst', 'boterhamworst']],
  ['vlees-vis', ['kipfilet', 'kippendij', 'kipnug', 'nuggets', 'kip', 'gehakt', 'biefstuk', 'steak', 'speklap', 'spek', 'bacon', 'rookworst', 'braadworst', 'worst', 'karbonade', 'schnitzel', 'riblap', 'runder', 'varken', 'zalm', 'vis', 'kabeljauw', 'garnalen', 'shoarma', 'hamburger']],
  ['zuivel', ['karnemelk', 'melk', 'yoghurt', 'kwark', 'vla', 'slagroom', 'zure room', 'room', 'roomboter', 'boter', 'margarine', 'eieren', 'ei', 'scharrel', 'crème fraîche', 'creme fraiche', 'skyr', 'chocomel']],
  ['brood', ['brood', 'bolletjes', 'broodjes', 'croissant', 'stokbrood', 'baguette', 'beschuit', 'krentenbol', 'pistolet']],
  ['houdbaar', ['bonen', 'soep', 'blik']],
];

export function guessSectionKey(name) {
  const text = ` ${String(name || '').toLocaleLowerCase('nl')} `;
  const words = text.split(/[^a-zà-ÿ-]+/).filter(Boolean);
  for (const [key, keywords] of RULES) {
    for (const kw of keywords) {
      if (kw.length <= 3 ? words.includes(kw) : text.includes(kw)) return key;
    }
  }
  return 'overig';
}

// "Valt onder" raden voor een sectienaam (bijv. een bord in de winkel).
// Eerst woorden die typisch zijn voor schapnamen, daarna de productgok.
const SECTION_NAME_RULES = [
  ['houdbaar', ['conserven', 'conserve']],
  ['vlees-vis', ['koeling (vlees', 'vlees', 'vis']],
  ['zuivel', ['koeling (zuivel', 'zuivel', 'koeling']],
  ['groente-fruit', ['groente', 'fruit', 'aardappel']],
  ['brood', ['afbakbrood', 'broodvervanger', 'brood', 'bakkerij', 'bake off']],
  ['kruiden-sauzen', ['kruiden', 'specerij', 'saus', 'sauzen', 'olie', 'olien', 'oliën', 'vetten', 'azijn']],
  ['houdbaar', ['soep', 'pasta', 'rijst', 'noedel', 'wereldkeuken', 'conserven', 'blik', 'houdbaar', 'meel', 'bakken']],
  ['snacks', ['chips', 'noten', 'chocola', 'koek', 'snoep', 'snack', 'zoutjes']],
  ['dranken', ['drinken', 'drank', 'frisdrank', 'alcohol', 'bier', 'wijn', 'sap', 'water', 'koffie', 'thee']],
  ['diepvries', ['diepvries', 'vries', 'ijs']],
  ['drogisterij', ['verzorging', 'drogist', 'baby', 'hygiëne', 'hygiene']],
  ['huishouden', ['schoonmaak', 'huishoud', 'was', 'papier']],
  ['huisdier', ['dier', 'kat', 'hond']],
  ['ontbijt-beleg', ['ontbijt', 'beleg', 'cereal', 'muesli', 'broodbeleg']],
  ['kaas-vleeswaren', ['kaas', 'vleeswaren']],
  ['overig', ['actie', 'buitenland', 'non-food', 'nonfood', 'aanbieding']],
];

export function guessParentKey(sectionName) {
  const text = String(sectionName || '').toLocaleLowerCase('nl');
  const words = text.split(/[^a-zà-ÿ-]+/).filter(Boolean);
  for (const [key, kws] of SECTION_NAME_RULES) {
    for (const kw of kws) {
      if (kw.length <= 3 ? words.includes(kw) : text.includes(kw)) return key;
    }
  }
  return guessSectionKey(sectionName);
}
