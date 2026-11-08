// Recherche filtrée des objets (liste, export, étiquettes).
import { sql } from 'kysely';
import { db } from '../db.js';
import { Tree, descendantIds } from './tree.js';
import { escapeLike, id as toId } from './forms.js';

export interface ItemFilters {
  q: string;
  cat: number | 'none' | null;
  loc: number | 'none' | null;
  status: number | 'none' | null;
  attr: string;
  op: 'eq' | 'contains' | 'gt' | 'lt' | 'exists' | 'missing';
  val: string;
  lot: boolean;
  sort: 'name' | 'brand' | 'category' | 'location' | 'status' | 'updated' | 'created';
  dir: 'asc' | 'desc';
  ids: number[]; // sélection explicite (étiquettes, export) : remplace les autres filtres
  manque: '' | 'photo' | 'serie' | 'carac'; // fiches incomplètes
  etiquette: '' | 'jamais'; // étiquette jamais imprimée
  caracIds?: number[]; // calculé par resolveFilters pour manque=carac
}

export const MANQUES: Record<Exclude<ItemFilters['manque'], ''>, string> = {
  photo: 'Sans photo',
  serie: 'Sans n° de série',
  carac: 'Caractéristiques manquantes',
};

export const SORTS: Record<ItemFilters['sort'], string> = {
  name: 'Nom',
  brand: 'Marque',
  category: 'Catégorie',
  location: 'Emplacement',
  status: 'Statut',
  updated: 'Dernière modification',
  created: 'Date de création',
};
export const OPS: Record<ItemFilters['op'], string> = {
  contains: 'contient',
  eq: 'égal à',
  gt: 'supérieur à',
  lt: 'inférieur à',
  exists: 'est renseigné',
  missing: 'n’est pas renseigné',
};

export function parseFilters(q: Record<string, unknown>): ItemFilters {
  const s = (k: string, max = 200) => String(q[k] ?? '').trim().slice(0, max);
  const op = s('op') as ItemFilters['op'];
  const sort = s('sort') as ItemFilters['sort'];
  const status = s('status');
  return {
    q: s('q'),
    cat: s('cat') === 'none' ? 'none' : toId(q.cat),
    loc: s('loc') === 'none' ? 'none' : toId(q.loc),
    status: status === 'none' ? 'none' : toId(status),
    attr: s('attr', 120),
    op: op in OPS ? op : 'contains',
    val: s('val'),
    lot: s('lot') === '1',
    sort: sort in SORTS ? sort : 'name',
    dir: s('dir') === 'desc' ? 'desc' : 'asc',
    manque: (['photo', 'serie', 'carac'].includes(s('manque')) ? s('manque') : '') as ItemFilters['manque'],
    etiquette: s('etiquette') === 'jamais' ? 'jamais' : '',
    ids: [...new Set(s('ids', 20000).split(',').map((x) => toId(x)).filter((x): x is number => x !== null))].slice(0, 2000),
  };
}

// Paramètres à conserver dans les liens (pagination, export, étiquettes).
export function filterParams(f: ItemFilters): Record<string, string | number | null> {
  return {
    q: f.q,
    cat: f.cat,
    loc: f.loc,
    status: f.status,
    attr: f.attr,
    op: f.attr ? f.op : null,
    val: f.attr ? f.val : null,
    lot: f.lot ? 1 : null,
    manque: f.manque || null,
    etiquette: f.etiquette || null,
    sort: f.sort === 'name' ? null : f.sort,
    dir: f.dir === 'asc' ? null : f.dir,
  };
}

export function hasFilters(f: ItemFilters) {
  return !!(f.q || f.cat || f.loc || f.status || f.attr || f.lot || f.manque || f.etiquette);
}

export function buildItemQuery(f: ItemFilters, catTree: Tree, locTree: Tree) {
  let qb = db
    .selectFrom('items')
    .leftJoin('statuses', 'statuses.id', 'items.status_id')
    .select([
      'items.id',
      'items.name',
      'items.brand',
      'items.model',
      'items.serial',
      'items.quantity',
      'items.notes',
      'items.category_id',
      'items.location_id',
      'items.status_id',
      'items.updated_at',
      'items.created_at',
      'statuses.name as status_name',
      'statuses.color as status_color',
    ]);

  if (f.ids.length) return qb.where('items.id', 'in', f.ids);

  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    qb = qb.where((eb) =>
      eb.or([
        eb('items.name', 'like', like),
        eb('items.brand', 'like', like),
        eb('items.model', 'like', like),
        eb('items.serial', 'like', like),
        eb('items.notes', 'like', like),
        eb.exists(eb.selectFrom('item_values as sv').select('sv.id').whereRef('sv.item_id', '=', 'items.id').where('sv.value_text', 'like', like)),
      ]),
    );
  }
  if (f.cat === 'none') qb = qb.where('items.category_id', 'is', null);
  else if (f.cat) qb = qb.where('items.category_id', 'in', descendantIds(catTree, f.cat).concat([-1]));
  if (f.loc === 'none') qb = qb.where('items.location_id', 'is', null);
  else if (f.loc) qb = qb.where('items.location_id', 'in', descendantIds(locTree, f.loc).concat([-1]));
  if (f.etiquette === 'jamais') qb = qb.where('items.label_printed_at', 'is', null);
  if (f.manque === 'serie') {
    qb = qb
      .where((eb) => eb.or([eb('items.serial', 'is', null), eb('items.serial', '=', '')]))
      .where((eb) => eb.not(eb.exists(eb.selectFrom('item_na as n').select('n.item_id').whereRef('n.item_id', '=', 'items.id').where('n.field', '=', 'serial'))));
  }
  if (f.manque === 'photo') {
    qb = qb
      .where((eb) => eb.not(eb.exists(eb.selectFrom('attachments as a').select('a.id').whereRef('a.item_id', '=', 'items.id').where('a.kind', '=', 'photo'))))
      .where((eb) => eb.not(eb.exists(eb.selectFrom('item_na as n').select('n.item_id').whereRef('n.item_id', '=', 'items.id').where('n.field', '=', 'photo'))));
  }
  if (f.manque === 'carac') qb = qb.where('items.id', 'in', (f.caracIds ?? []).concat([-1]));
  if (f.status === 'none') qb = qb.where('items.status_id', 'is', null);
  else if (f.status) qb = qb.where('items.status_id', '=', f.status);
  if (f.lot) qb = qb.where('items.quantity', '>', 1);

  if (f.attr) {
    const name = f.attr;
    const val = f.val;
    const num = /^-?\d+([.,]\d+)?$/.test(val.replace(/\s/g, '')) ? val.replace(/\s/g, '').replace(',', '.') : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : null;
    const sub = (eb: any) => eb.selectFrom('item_values as fv').select('fv.id').whereRef('fv.item_id', '=', 'items.id').where('fv.name', '=', name);
    if (f.op === 'exists') qb = qb.where((eb) => eb.exists(sub(eb)));
    else if (f.op === 'missing') qb = qb.where((eb) => eb.not(eb.exists(sub(eb))));
    else if (val !== '') {
      qb = qb.where((eb) =>
        eb.exists(
          sub(eb).where((w: any) => {
            const conds: any[] = [];
            if (f.op === 'contains') conds.push(w('fv.value_text', 'like', `%${escapeLike(val)}%`));
            if (f.op === 'eq') {
              conds.push(w('fv.value_text', '=', val));
              if (num !== null) conds.push(w('fv.value_number', '=', num));
              if (date) conds.push(w('fv.value_date', '=', date));
              if (/^(oui|non)$/i.test(val)) conds.push(w('fv.value_bool', '=', /^oui$/i.test(val) ? 1 : 0));
            }
            if (f.op === 'gt' || f.op === 'lt') {
              const o = f.op === 'gt' ? '>' : '<';
              if (num !== null) conds.push(w('fv.value_number', o, num));
              if (date) conds.push(w('fv.value_date', o, date));
            }
            return conds.length ? w.or(conds) : sql<boolean>`FALSE`;
          }),
        ),
      );
    }
  }
  return qb;
}

// Tri. Catégories et emplacements suivent l'ordre de l'arborescence affichée (chemin alphabétique).
export function orderItems(qb: any, f: ItemFilters, catTree?: Tree, locTree?: Tree) {
  const byTree = (col: string, tree?: Tree) => {
    const ids = tree?.flat.map((e) => e.id) ?? [];
    qb = qb.orderBy(sql`(${sql.ref(col)} IS NULL)`, 'asc');
    if (ids.length) qb = qb.orderBy(sql`FIELD(${sql.ref(col)}, ${sql.join(ids)})`, f.dir);
  };
  switch (f.sort) {
    case 'category':
      byTree('items.category_id', catTree);
      break;
    case 'location':
      byTree('items.location_id', locTree);
      break;
    case 'status':
      qb = qb.orderBy(sql`(statuses.sort_order IS NULL)`, 'asc').orderBy('statuses.sort_order', f.dir);
      break;
    case 'brand':
      qb = qb.orderBy(sql`(items.brand IS NULL OR items.brand = '')`, 'asc').orderBy('items.brand', f.dir).orderBy('items.model', f.dir);
      break;
    case 'updated':
      qb = qb.orderBy('items.updated_at', f.dir);
      break;
    case 'created':
      qb = qb.orderBy('items.created_at', f.dir);
      break;
    default:
      qb = qb.orderBy('items.name', f.dir);
  }
  if (f.sort !== 'name') qb = qb.orderBy('items.name', 'asc');
  return qb.orderBy('items.id', 'asc');
}

export async function attributeNames(): Promise<string[]> {
  const rows = await db
    .selectFrom('item_values')
    .select('name')
    .distinct()
    .unionAll(db.selectFrom('attribute_defs').select('name'))
    .execute();
  return [...new Set(rows.map((r) => r.name))].sort((a, b) => a.localeCompare(b, 'fr'));
}

// Complète les filtres qui demandent un calcul préalable (caractéristiques manquantes).
export async function resolveFilters(f: ItemFilters, catTree: Tree): Promise<ItemFilters> {
  if (f.manque === 'carac') {
    const { completenessSummary } = await import('./completeness.js');
    f.caracIds = (await completenessSummary(catTree)).attrs;
  }
  return f;
}
