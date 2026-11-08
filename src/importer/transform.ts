// Correspondance colonnes -> champs, découpages (marque/modèle, RAM, stockage, année) et construction de l'aperçu.
import type { AttrType, Status } from '../db.js';
import type { Tree } from '../services/tree.js';
import { descendantIds, lineage } from '../services/tree.js';
import type { EffectiveDef } from '../services/attributes.js';
import { Extracted, extractColumns, extractRows, norm, RawSheet } from './read.js';

export const TARGETS: { value: string; label: string; valueMap?: boolean }[] = [
  { value: 'ignore', label: 'Ignorer' },
  { value: 'name', label: 'Nom' },
  { value: 'brand', label: 'Marque' },
  { value: 'model', label: 'Modèle' },
  { value: 'brand_model', label: 'Marque + modèle (découpage)' },
  { value: 'serial', label: 'N° de série' },
  { value: 'quantity', label: 'Quantité' },
  { value: 'status', label: 'Statut', valueMap: true },
  { value: 'location', label: 'Emplacement', valueMap: true },
  { value: 'category', label: 'Catégorie', valueMap: true },
  { value: 'subcategory', label: 'Sous-catégorie', valueMap: true },
  { value: 'notes', label: 'Notes' },
  { value: 'ram', label: 'Mémoire : RAM (Go) + Type RAM' },
  { value: 'storage1', label: 'Stockage 1 : capacité + type + modèle' },
  { value: 'storage2', label: 'Stockage 2 : capacité + type + modèle' },
  { value: 'year', label: 'Année (nombre)' },
  { value: 'free', label: 'Caractéristique libre (texte, nom = en-tête)' },
];
export const VALUE_MAP_TARGETS = TARGETS.filter((t) => t.valueMap).map((t) => t.value);

export interface ColumnMap {
  source: string;
  target: string; // une valeur de TARGETS ou "attr:<nom de caractéristique>"
}
export interface SheetConfig {
  name: string;
  include: boolean;
  layout: 'rows' | 'columns';
  header: boolean;
  categoryId: number | null;
  locationId: number | null;
  statusKey: string; // "" | "id:3"
  forcedBrand: string;
  columns: ColumnMap[];
  valueMaps: Record<string, Record<string, string>>; // source -> valeur -> clé ("id:3", "new", "")
  mapsCategoryId?: number | null;
}
export interface Batch {
  filename: string;
  sheets: RawSheet[];
  configs: SheetConfig[];
  replacements: string;
  rows?: PreviewRow[];
}
export interface PreviewValue {
  name: string;
  type: AttrType;
  unit: string | null;
  raw: string;
}
export interface PreviewRow {
  sheet: string;
  include: boolean;
  name: string;
  brand: string;
  model: string;
  serial: string;
  quantity: string;
  categoryId: number | null;
  locationId: number | null;
  statusKey: string; // "" | "id:3" | "new:Nom"
  notes: string;
  values: PreviewValue[];
  warnings: string[];
}

export const IGNORED_VALUES = new Set(['', '/', '?']);
const ignored = (v: string | null | undefined) => v === null || v === undefined || IGNORED_VALUES.has(v.trim());

export function extract(sheet: RawSheet, cfg: Pick<SheetConfig, 'layout' | 'header'>): Extracted {
  return cfg.layout === 'columns' ? extractColumns(sheet.grid) : extractRows(sheet.grid, cfg.header);
}

// ---------- Correspondances par défaut ----------
const RULES: [string[], string][] = [
  [['lieu', 'emplacement', 'localisation'], 'location'],
  [['marque', 'fabricant'], 'brand'],
  [['modele'], 'model'],
  [['machine', 'appareil'], 'brand_model'],
  [['nom', 'surnom'], 'name'],
  [['type', 'sous categorie'], 'subcategory'],
  [['categorie'], 'category'],
  [['etat', 'statut'], 'status'],
  [['description', 'remarques', 'remarque', 'notes', 'note', 'commentaire', 'commentaires'], 'notes'],
  [['sn', 's n', 'numero de serie', 'n de serie', 'no de serie', 'serial', 'serie'], 'serial'],
  [['memoire', 'memoire vive'], 'ram'],
  [['stockage 1', 'stockage'], 'storage1'],
  [['stockage 2'], 'storage2'],
  [['quantite', 'qte', 'nombre'], 'quantity'],
  [['id'], 'ignore'],
];
// Intitulés courants qui correspondent à des caractéristiques existantes sous un autre nom.
const ALIASES: Record<string, string> = {
  'carte mere chipset': 'Carte mère',
  'optique 1': 'Lecteur optique',
  'optique': 'Lecteur optique',
  'dispo pointage': 'Dispositif de pointage',
  'o s': 'OS',
  'systeme': 'OS',
};

export function defaultTarget(header: string, synthetic: boolean, defs: EffectiveDef[], hasHeader: boolean, isOnlyColumn: boolean): string {
  if (!hasHeader) return isOnlyColumn ? 'brand_model' : 'free';
  if (synthetic) return 'notes';
  const n = norm(header.replace(/\s*\([^)]*\)\s*$/, '')); // « RAM (Go) » -> « ram »
  if (n === 'annee' || n === 'date' || n === 'annee de sortie') return 'year';
  const def = defs.find((d) => norm(d.name) === n);
  if (def) return `attr:${def.name}`;
  for (const [keys, target] of RULES) if (keys.includes(n)) return target;
  const alias = ALIASES[n];
  if (alias && defs.some((d) => d.name === alias)) return `attr:${alias}`;
  return 'free';
}

// ---------- Correspondance de valeurs (statut, emplacement, catégories) ----------
function matchStatus(v: string, statuses: Status[]): string {
  const s = statuses.find((x) => norm(x.name) === norm(v));
  return s ? `id:${s.id}` : 'new';
}
function matchTree(v: string, tree: Tree, scope: number[] | null): number | null {
  const n = norm(v);
  const pool = scope ? tree.flat.filter((e) => scope.includes(e.id)) : tree.flat;
  const exact = pool.find((e) => norm(e.name) === n || norm(e.path) === n);
  if (exact) return exact.id;
  // « Vinyl » -> « Platine vinyle », « CD » -> « Lecteur CD »
  const words = n.split(' ');
  const partial = pool.filter((e) => {
    const ew = norm(e.name).split(' ');
    return words.every((w) => ew.some((x) => x.startsWith(w)));
  });
  return partial.length === 1 ? partial[0].id : null;
}

export function defaultValueKey(target: string, value: string, ctx: { statuses: Status[]; locs: Tree; cats: Tree; cfg: SheetConfig }): string {
  switch (target) {
    case 'status':
      return matchStatus(value, ctx.statuses);
    case 'location': {
      const m = matchTree(value, ctx.locs, null);
      return m ? `id:${m}` : '';
    }
    case 'category': {
      const m = matchTree(value, ctx.cats, null);
      return m ? `id:${m}` : '';
    }
    case 'subcategory': {
      const scope = ctx.cfg.categoryId ? descendantIds(ctx.cats, ctx.cfg.categoryId).filter((x) => x !== ctx.cfg.categoryId) : null;
      const m = matchTree(value, ctx.cats, scope);
      return m ? `id:${m}` : '';
    }
  }
  return '';
}

// ---------- Découpages ----------
export function splitBrandModel(s: string): { brand: string; model: string; warn: string | null } {
  const t = s.trim().replace(/\s+/g, ' ');
  const i = t.indexOf(' ');
  if (i < 0) return { brand: t, model: '', warn: `« ${t} » : un seul mot, placé en marque` };
  return { brand: t.slice(0, i), model: t.slice(i + 1), warn: null };
}

const CAP = /(\d+(?:[.,]\d+)?)\s*(to|tb|go|gb|mo|mb)\b/i;

export function parseRam(s: string): { gb: string | null; kind: string | null; warn: string | null } {
  const m = CAP.exec(s);
  if (!m) return { gb: null, kind: s.trim() || null, warn: `Mémoire « ${s} » non reconnue, gardée en Type RAM` };
  let n = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  let warn: string | null = null;
  if (unit === 'mo' || unit === 'mb') {
    n = n / 1024;
    warn = `Mémoire « ${m[0]} » convertie en ${String(Number(n.toFixed(6))).replace('.', ',')} Go`;
  } else if (unit === 'to' || unit === 'tb') n = n * 1024;
  const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { gb: String(Number(n.toFixed(6))), kind: rest || null, warn };
}

const STORAGE_KINDS: [RegExp, string][] = [
  [/\bnvme\b/i, 'NVMe'],
  [/\bsshd\b/i, 'SSHD'],
  [/\bssd\b/i, 'SSD'],
  [/\bsas\b/i, 'SAS'],
  [/\bide\b/i, 'IDE'],
  [/\bhdd\b/i, 'HDD'],
];

export function parseStorage(s: string): { gb: string | null; kind: string | null; model: string | null; warn: string | null } {
  let rest = s;
  let gb: string | null = null;
  const m = CAP.exec(rest);
  if (m) {
    let n = Number(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase();
    if (unit === 'to' || unit === 'tb') n *= 1000;
    if (unit === 'mo' || unit === 'mb') n /= 1000;
    gb = String(Number(n.toFixed(6)));
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
  }
  let kind: string | null = null;
  for (const [re, k] of STORAGE_KINDS) {
    if (re.test(rest)) {
      kind = k;
      break;
    }
  }
  // Retire les mots-clés de type du reste (le type principal et ses compléments, ex. « SSD NVMe »).
  for (const [re] of STORAGE_KINDS) rest = rest.replace(new RegExp(re.source, 'gi'), ' ');
  const model = rest.replace(/\s+/g, ' ').trim() || null;
  let warn = gb === null ? `Stockage « ${s} » : capacité non trouvée` : null;
  if (!warn && /\b\d+\s*x\b/i.test(s)) warn = `Stockage « ${s} » : plusieurs disques, capacité unitaire retenue`;
  return { gb, kind, model, warn };
}

export function parseYear(s: string): { year: string | null; note: string | null; warn: string | null } {
  const t = s.trim();
  if (/^\d{4}$/.test(t)) return { year: t, note: null, warn: null };
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return { year: iso[1], note: `Date d'origine : ${iso[3]}/${iso[2]}/${iso[1]}`, warn: null };
  const y = /\b(1[89]\d{2}|20\d{2})\b/.exec(t);
  if (y) return { year: y[1], note: `Année d'origine : ${t}`, warn: `Année extraite de « ${t} »` };
  return { year: null, note: `Année d'origine : ${t}`, warn: `Année « ${t} » non reconnue, gardée dans les notes` };
}

export function parseReplacements(text: string): [RegExp, string][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split('=>').map((x) => x.trim()))
    .filter((p) => p.length === 2 && p[0])
    .map(([a, b]) => [new RegExp(`(^|[^\\p{L}\\p{N}])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu'), b] as [RegExp, string]);
}
function applyReplacements(s: string, reps: [RegExp, string][]) {
  let out = s;
  for (const [re, b] of reps) out = out.replace(re, (_m, pre) => `${pre}${b}`);
  return out;
}

// ---------- Construction des lignes d'aperçu ----------
export interface BuildCtx {
  cats: Tree;
  locs: Tree;
  statuses: Status[];
  defsFor: (categoryId: number | null) => EffectiveDef[];
}

export function buildRows(batch: Batch, ctx: BuildCtx): PreviewRow[] {
  const reps = parseReplacements(batch.replacements);
  const out: PreviewRow[] = [];
  batch.sheets.forEach((sheet, si) => {
    const cfg = batch.configs[si];
    if (!cfg?.include) return;
    const ex = extract(sheet, cfg);
    for (const rec of ex.records) {
      const row: PreviewRow = {
        sheet: sheet.name,
        include: true,
        name: '',
        brand: '',
        model: '',
        serial: '',
        quantity: '1',
        categoryId: cfg.categoryId,
        locationId: cfg.locationId,
        statusKey: cfg.statusKey,
        notes: '',
        values: [],
        warnings: [],
      };
      const notes: string[] = [];
      const pending: { name: string; type: AttrType; unit: string | null; raw: string }[] = [];
      let hasData = false;

      for (const col of cfg.columns) {
        const v = rec[col.source];
        if (ignored(v)) continue;
        const val = v!.trim();
        if (col.target !== 'ignore') hasData = true;
        const mapKey = cfg.valueMaps[col.source]?.[val] ?? '';
        switch (col.target) {
          case 'ignore':
            break;
          case 'name':
            row.name = val;
            break;
          case 'brand':
            row.brand = val;
            break;
          case 'model':
            row.model = val;
            break;
          case 'brand_model': {
            if (cfg.forcedBrand) {
              row.brand = cfg.forcedBrand;
              row.model = val;
            } else {
              const sp = splitBrandModel(applyReplacements(val, reps));
              row.brand = sp.brand;
              row.model = sp.model;
              if (sp.warn) row.warnings.push(sp.warn);
            }
            break;
          }
          case 'serial':
            row.serial = val;
            break;
          case 'quantity':
            row.quantity = val;
            break;
          case 'notes':
            notes.push(val);
            break;
          case 'status':
            row.statusKey = mapKey === 'new' ? `new:${val.slice(0, 60)}` : mapKey || row.statusKey;
            break;
          case 'location':
            if (mapKey.startsWith('id:')) row.locationId = Number(mapKey.slice(3));
            break;
          case 'category':
          case 'subcategory':
            if (mapKey.startsWith('id:')) row.categoryId = Number(mapKey.slice(3));
            break;
          case 'ram': {
            const r = parseRam(val);
            if (r.gb !== null) pending.push({ name: 'RAM', type: 'number', unit: 'Go', raw: r.gb });
            if (r.kind) pending.push({ name: 'Type RAM', type: 'text', unit: null, raw: r.kind });
            if (r.warn) row.warnings.push(r.warn);
            break;
          }
          case 'storage1':
          case 'storage2': {
            const n = col.target === 'storage1' ? 1 : 2;
            const s = parseStorage(val);
            if (s.gb !== null) pending.push({ name: `Stockage ${n} capacité`, type: 'number', unit: 'Go', raw: s.gb });
            if (s.kind) pending.push({ name: `Stockage ${n} type`, type: 'text', unit: null, raw: s.kind });
            if (s.model) pending.push({ name: `Stockage ${n} modèle`, type: 'text', unit: null, raw: s.model });
            if (s.warn) row.warnings.push(s.warn);
            break;
          }
          case 'year': {
            const y = parseYear(val);
            if (y.year) pending.push({ name: 'Année', type: 'number', unit: null, raw: y.year });
            if (y.note) notes.push(y.note);
            if (y.warn) row.warnings.push(y.warn);
            break;
          }
          case 'free':
            pending.push({ name: col.source, type: 'text', unit: null, raw: val });
            break;
          default:
            if (col.target.startsWith('attr:')) pending.push({ name: col.target.slice(5), type: 'text', unit: null, raw: val });
        }
      }
      if (!hasData) continue;

      row.brand = applyReplacements(row.brand, reps);
      row.model = applyReplacements(row.model, reps);
      row.name = applyReplacements(row.name, reps);
      if (!row.name) row.name = [row.brand, row.model].filter(Boolean).join(' ');
      if (!row.name) {
        row.name = 'Sans nom';
        row.warnings.push('Aucun nom : à compléter');
      }
      row.notes = notes.join('\n');
      if (row.statusKey.startsWith('new:')) row.warnings.push(`Nouveau statut « ${row.statusKey.slice(4)} » créé à l'import`);

      // Type et unité pris sur la définition de la catégorie quand elle existe.
      const defs = ctx.defsFor(row.categoryId);
      const seen = new Set<string>();
      for (const p of pending) {
        const key = p.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const def = defs.find((d) => d.name.toLowerCase() === key);
        row.values.push(def ? { name: def.name, type: def.type, unit: def.unit, raw: p.raw } : p);
      }
      out.push(row);
    }
  });
  return out;
}

export function initialConfig(sheet: RawSheet, detected: { layout: 'rows' | 'columns'; header: boolean }, ctx: BuildCtx): SheetConfig {
  const n = norm(sheet.name);
  const singular = (s: string) => s.replace(/s$/, '');
  // Le moins profond l'emporte : la feuille « AMPLI » va dans « Amplis » plutôt que dans la sous-catégorie « Ampli ».
  const cat = ctx.cats.flat
    .filter((c) => norm(c.name) === n || singular(norm(c.name)) === singular(n))
    .sort((a, b) => a.depth - b.depth)[0];
  const cfg: SheetConfig = {
    name: sheet.name,
    include: true,
    layout: detected.layout,
    header: detected.header,
    categoryId: cat?.id ?? null,
    locationId: ctx.locs.flat.find((l) => l.name === 'À classer')?.id ?? null,
    statusKey: '',
    forcedBrand: '',
    columns: [],
    valueMaps: {},
    mapsCategoryId: undefined,
  };
  return refreshConfig(sheet, cfg, ctx, true);
}

// Recalcule les colonnes (si la disposition a changé) et complète les correspondances de valeurs.
export function refreshConfig(sheet: RawSheet, cfg: SheetConfig, ctx: BuildCtx, resetColumns = false): SheetConfig {
  const ex = extract(sheet, cfg);
  const defs = ctx.defsFor(cfg.categoryId);
  const known = new Map(cfg.columns.map((c) => [c.source, c.target]));
  const allDefNames = new Set(defs.map((d) => d.name));
  const catChanged = cfg.mapsCategoryId !== cfg.categoryId;
  cfg.columns = ex.headers.map((h) => {
    let prev = resetColumns ? undefined : known.get(h);
    // Catégorie changée : les colonnes « caractéristique » sont recalculées sur les caractéristiques de la nouvelle catégorie.
    if (catChanged && prev && (prev === 'free' || prev.startsWith('attr:'))) prev = undefined;
    const valid = prev && (TARGETS.some((t) => t.value === prev) || (prev.startsWith('attr:') && allDefNames.has(prev.slice(5))));
    return { source: h, target: valid ? prev! : defaultTarget(h, ex.synthetic.has(h), defs, cfg.layout === 'columns' || cfg.header, ex.headers.length === 1) };
  });
  const maps: SheetConfig['valueMaps'] = {};
  for (const col of cfg.columns) {
    if (!VALUE_MAP_TARGETS.includes(col.target)) continue;
    const distinct = [...new Set(ex.records.map((r) => r[col.source]).filter((v): v is string => !ignored(v)).map((v) => v.trim()))];
    const prev = cfg.valueMaps[col.source] ?? {};
    // Si la catégorie de la feuille a changé, les sous-catégories sont recalculées.
    const categoryChanged = col.target === 'subcategory' && cfg.mapsCategoryId !== cfg.categoryId;
    const stillValid = () => !categoryChanged;
    maps[col.source] = Object.fromEntries(
      distinct.map((v) => [v, v in prev && stillValid() ? prev[v] : defaultValueKey(col.target, v, { ...ctx, cfg })]),
    );
  }
  cfg.valueMaps = maps;
  cfg.mapsCategoryId = cfg.categoryId;
  return cfg;
}

export function samples(sheet: RawSheet, cfg: SheetConfig): Record<string, string[]> {
  const ex = extract(sheet, cfg);
  const out: Record<string, string[]> = {};
  for (const h of ex.headers) out[h] = ex.records.map((r) => r[h]).filter((v): v is string => !ignored(v)).slice(0, 3);
  return out;
}

export function recordCount(sheet: RawSheet, cfg: SheetConfig) {
  return extract(sheet, cfg).records.length;
}

export { lineage };
