// Caractéristiques typées : définitions par catégorie (héritées) et valeurs par objet.
import type { Kysely, Transaction } from 'kysely';
import { db, Database, AttributeDef, AttrType, ItemValue } from '../db.js';
import { Tree, lineage } from './tree.js';

export const ATTR_TYPES: { value: AttrType; label: string }[] = [
  { value: 'text', label: 'Texte' },
  { value: 'number', label: 'Nombre' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Oui / non' },
  { value: 'select', label: 'Liste de choix' },
  { value: 'url', label: 'Lien (adresse web)' },
];
export const isAttrType = (t: unknown): t is AttrType => ATTR_TYPES.some((x) => x.value === t);

export interface EffectiveDef extends AttributeDef {
  optionList: string[];
  ownerName: string;
  inherited: boolean; // défini sur une catégorie parente
}

export function parseOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// Définitions applicables à une catégorie : celles de ses ancêtres puis les siennes.
export async function effectiveDefs(categoryTree: Tree, categoryId: number | null | undefined): Promise<EffectiveDef[]> {
  const chain = lineage(categoryTree, categoryId);
  if (!chain.length) return [];
  const ids = chain.map((c) => c.id);
  const defs = await db.selectFrom('attribute_defs').selectAll().where('category_id', 'in', ids).execute();
  const out: EffectiveDef[] = [];
  for (const c of chain) {
    const own = defs.filter((d) => d.category_id === c.id).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    for (const d of own) {
      out.push({ ...d, optionList: parseOptions(d.options), ownerName: c.name, inherited: c.id !== categoryId });
    }
  }
  return out;
}

export interface ParsedValue {
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_bool: number | null;
}

// Convertit une saisie en valeur typée. Renvoie null si vide, ou une erreur lisible.
export function parseValue(type: AttrType, raw: string, options: string[] = []): { ok: true; v: ParsedValue | null } | { ok: false; error: string } {
  const s = (raw ?? '').trim();
  const empty: ParsedValue = { value_text: null, value_number: null, value_date: null, value_bool: null };
  if (s === '') return { ok: true, v: null };
  switch (type) {
    case 'text':
      if (s.length > 5000) return { ok: false, error: 'texte trop long (5000 caractères max.)' };
      return { ok: true, v: { ...empty, value_text: s } };
    case 'select':
      if (options.length && !options.includes(s)) return { ok: false, error: `« ${s} » ne fait pas partie de la liste` };
      return { ok: true, v: { ...empty, value_text: s } };
    case 'number': {
      const n = s.replace(/\s/g, '').replace(',', '.');
      if (!/^-?\d+(\.\d+)?$/.test(n)) return { ok: false, error: `« ${s} » n'est pas un nombre` };
      if (Math.abs(Number(n)) >= 1e18) return { ok: false, error: 'nombre trop grand' };
      return { ok: true, v: { ...empty, value_number: n } };
    }
    case 'date': {
      let iso = s;
      const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (fr) iso = `${fr[3]}-${fr[2].padStart(2, '0')}-${fr[1].padStart(2, '0')}`;
      const d = new Date(iso + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
        return { ok: false, error: `« ${s} » n'est pas une date valide (JJ/MM/AAAA)` };
      }
      return { ok: true, v: { ...empty, value_date: iso } };
    }
    case 'url': {
      if (s.length > 2000) return { ok: false, error: 'adresse trop longue' };
      let u: URL;
      try {
        u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      } catch {
        return { ok: false, error: `« ${s} » n'est pas une adresse web valide` };
      }
      // Seules les adresses http(s) sont acceptées (pas de javascript:, data:, file:…).
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'seules les adresses http(s) sont acceptées' };
      return { ok: true, v: { ...empty, value_text: u.href } };
    }
    case 'boolean':
      if (s === '1' || s.toLowerCase() === 'oui') return { ok: true, v: { ...empty, value_bool: 1 } };
      if (s === '0' || s.toLowerCase() === 'non') return { ok: true, v: { ...empty, value_bool: 0 } };
      return { ok: false, error: 'valeur oui/non invalide' };
  }
}

export function formatNumber(n: string | number | null): string {
  if (n === null || n === undefined || n === '') return '';
  const num = Number(n);
  // Pas de séparateur de milliers sous 10 000 (années, petites valeurs) : 2009 et non « 2 009 ».
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6, useGrouping: Math.abs(num) >= 10000 }).format(num);
}

// Valeur brute pour pré-remplir un champ de formulaire.
export function rawValue(v: Pick<ItemValue, 'type' | 'value_text' | 'value_number' | 'value_date' | 'value_bool'> | undefined): string {
  if (!v) return '';
  switch (v.type) {
    case 'number':
      return v.value_number === null ? '' : String(Number(v.value_number)).replace('.', ',');
    case 'date':
      return v.value_date ?? '';
    case 'boolean':
      return v.value_bool === null ? '' : v.value_bool ? '1' : '0';
    default:
      return v.value_text ?? '';
  }
}

// Valeur lisible pour l'affichage.
export function displayValue(v: Pick<ItemValue, 'type' | 'unit' | 'value_text' | 'value_number' | 'value_date' | 'value_bool'>): string {
  switch (v.type) {
    case 'number':
      return v.value_number === null ? '' : `${formatNumber(v.value_number)}${v.unit ? ' ' + v.unit : ''}`;
    case 'date':
      return v.value_date ? new Date(v.value_date + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '';
    case 'boolean':
      return v.value_bool === null ? '' : v.value_bool ? 'Oui' : 'Non';
    default:
      return v.value_text ?? '';
  }
}

export interface ValueInput {
  defId: number | null;
  name: string;
  type: AttrType;
  unit: string | null;
  parsed: ParsedValue;
  sort: number;
}

// Remplace toutes les valeurs d'un objet (dans une transaction).
export async function replaceItemValues(trx: Kysely<Database> | Transaction<Database>, itemId: number, values: ValueInput[]) {
  await trx.deleteFrom('item_values').where('item_id', '=', itemId).execute();
  if (!values.length) return;
  await trx
    .insertInto('item_values')
    .values(
      values.map((v) => ({
        item_id: itemId,
        def_id: v.defId,
        name: v.name,
        type: v.type,
        unit: v.unit,
        sort_order: v.sort,
        ...v.parsed,
      })),
    )
    .execute();
}

export function valueSummary(values: ItemValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) out[v.name] = displayValue(v);
  return out;
}
