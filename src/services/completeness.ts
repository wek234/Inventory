// Complétude des fiches : photo, n° de série et caractéristiques de la catégorie.
// Ne compte pas : les caractéristiques marquées « facultative » sur la catégorie, ni ce qui est marqué « sans objet » sur l'objet.
import { db } from '../db.js';
import { Tree } from './tree.js';
import { effectiveDefs } from './attributes.js';

export const NA_PHOTO = 'photo';
export const NA_SERIAL = 'serial';
export const naAttr = (name: string) => `attr:${name}`;

export interface MissingField {
  field: string; // clé « sans objet »
  label: string;
}

async function requiredDefsByCategory(cats: Tree) {
  const map = new Map<number, string[]>();
  for (const c of cats.flat) {
    const defs = await effectiveDefs(cats, c.id);
    map.set(c.id, defs.filter((d) => !d.optional).map((d) => d.name));
  }
  return map;
}

export interface CompletenessSummary {
  photo: number[];
  serial: number[];
  attrs: number[];
}

export async function completenessSummary(cats: Tree): Promise<CompletenessSummary> {
  const [items, photos, nas, values, required] = await Promise.all([
    db.selectFrom('items').select(['id', 'category_id', 'serial']).where('deleted_at', 'is', null).execute(),
    db.selectFrom('attachments').select('item_id').distinct().where('kind', '=', 'photo').execute(),
    db.selectFrom('item_na').select(['item_id', 'field']).execute(),
    db.selectFrom('item_values').select(['item_id', 'name']).execute(),
    requiredDefsByCategory(cats),
  ]);
  const hasPhoto = new Set(photos.map((p) => p.item_id));
  const na = new Set(nas.map((n) => `${n.item_id}|${n.field.toLowerCase()}`));
  const vals = new Set(values.map((v) => `${v.item_id}|${v.name.toLowerCase()}`));
  const out: CompletenessSummary = { photo: [], serial: [], attrs: [] };
  for (const i of items) {
    if (!hasPhoto.has(i.id) && !na.has(`${i.id}|${NA_PHOTO}`)) out.photo.push(i.id);
    if (!i.serial && !na.has(`${i.id}|${NA_SERIAL}`)) out.serial.push(i.id);
    const req = i.category_id ? required.get(i.category_id) ?? [] : [];
    if (req.some((n) => !vals.has(`${i.id}|${n.toLowerCase()}`) && !na.has(`${i.id}|${naAttr(n).toLowerCase()}`))) out.attrs.push(i.id);
  }
  return out;
}

// Détail pour une fiche : ce qui manque et ce qui est marqué « sans objet ».
export async function itemCompleteness(cats: Tree, item: { id: number; category_id: number | null; serial: string | null }) {
  const [hasPhoto, nas, values] = await Promise.all([
    db.selectFrom('attachments').select('id').where('item_id', '=', item.id).where('kind', '=', 'photo').executeTakeFirst(),
    db.selectFrom('item_na').select('field').where('item_id', '=', item.id).execute(),
    db.selectFrom('item_values').select('name').where('item_id', '=', item.id).execute(),
  ]);
  const naSet = new Set(nas.map((n) => n.field.toLowerCase()));
  const valSet = new Set(values.map((v) => v.name.toLowerCase()));
  const defs = (await effectiveDefs(cats, item.category_id)).filter((d) => !d.optional);
  const candidates: (MissingField & { present: boolean })[] = [
    { field: NA_PHOTO, label: 'Photo', present: !!hasPhoto },
    { field: NA_SERIAL, label: 'N° de série', present: !!item.serial },
    ...defs.map((d) => ({ field: naAttr(d.name), label: d.name, present: valSet.has(d.name.toLowerCase()) })),
  ];
  const missing = candidates.filter((c) => !c.present && !naSet.has(c.field.toLowerCase())).map(({ field, label }) => ({ field, label }));
  const notApplicable = nas.map((n) => ({
    field: n.field,
    label: n.field === NA_PHOTO ? 'Photo' : n.field === NA_SERIAL ? 'N° de série' : n.field.replace(/^attr:/, ''),
  }));
  return { missing, notApplicable };
}

export function isValidNaField(field: string) {
  return field === NA_PHOTO || field === NA_SERIAL || (/^attr:.{1,120}$/.test(field) && !/[\u0000-\u001f]/.test(field));
}
