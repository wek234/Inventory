import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, AttrType } from '../db.js';
import { render, redirect, setFlash, isHtmx, helpers } from '../views.js';
import { config } from '../config.js';

const LIST_COOKIE = 'inv_liste';
import { loadTree, lineage, Tree } from '../services/tree.js';
import { effectiveDefs, parseValue, rawValue, replaceItemValues, valueSummary, EffectiveDef, ValueInput, parseOptions } from '../services/attributes.js';
import { audit, diff } from '../services/audit.js';
import { Body, str, strs, optStr, id, intIn } from '../services/forms.js';
import { parseFilters, buildItemQuery, orderItems, filterParams, hasFilters, attributeNames, resolveFilters, SORTS, OPS, MANQUES } from '../services/items.js';
import { removeStoredFiles } from './attachments.js';
import { itemCompleteness, isValidNaField } from '../services/completeness.js';

const PAGE_SIZE = 50;
const FREE_TYPES: AttrType[] = ['text', 'number', 'date', 'boolean', 'url'];

interface FormValue {
  name: string;
  type: AttrType;
  unit: string | null;
  raw: string;
}
interface ArrangedDef extends EffectiveDef {
  raw: string;
}

const ITEM_LABELS = {
  name: 'Nom',
  brand: 'Marque',
  model: 'Modèle',
  serial: 'N° de série',
  quantity: 'Quantité',
  category: 'Catégorie',
  location: 'Emplacement',
  status: 'Statut',
  notes: 'Notes',
};

async function lookups() {
  const [cats, locs, statuses] = await Promise.all([
    loadTree('categories'),
    loadTree('locations'),
    db.selectFrom('statuses').selectAll().orderBy('sort_order').orderBy('name').execute(),
  ]);
  return { cats, locs, statuses };
}

async function valuesFromDb(itemId: number): Promise<FormValue[]> {
  const rows = await db.selectFrom('item_values').selectAll().where('item_id', '=', itemId).orderBy('sort_order').orderBy('id').execute();
  return rows.map((r) => ({ name: r.name, type: r.type === 'select' && r.def_id === null ? 'text' : r.type, unit: r.unit, raw: rawValue(r) }));
}

async function valuesFromBody(body: Body): Promise<FormValue[]> {
  const out: FormValue[] = [];
  const defIds = Object.keys(body)
    .map((k) => /^attr_(\d+)$/.exec(k)?.[1])
    .filter(Boolean)
    .map(Number);
  if (defIds.length) {
    const defs = await db.selectFrom('attribute_defs').selectAll().where('id', 'in', defIds).execute();
    for (const d of defs) out.push({ name: d.name, type: d.type, unit: d.unit, raw: str(body, `attr_${d.id}`, 5000) });
  }
  const names = strs(body, 'free_name', 120);
  const types = strs(body, 'free_type', 20);
  const units = strs(body, 'free_unit', 32);
  const vals = strs(body, 'free_value', 5000);
  names.forEach((name, i) => {
    const type = (FREE_TYPES.includes(types[i] as AttrType) ? types[i] : 'text') as AttrType;
    if (name === '' && (vals[i] ?? '') === '') return;
    out.push({ name, type, unit: units[i] || null, raw: vals[i] ?? '' });
  });
  return out;
}

const key = (s: string) => s.trim().toLowerCase();

function arrange(defs: EffectiveDef[], values: FormValue[]) {
  const byName = new Map<string, FormValue>();
  const free: FormValue[] = [];
  for (const v of values) {
    if (v.name && !byName.has(key(v.name))) byName.set(key(v.name), v);
    else free.push(v); // doublons ou lignes sans nom : laissés en lignes libres (erreur à l'enregistrement)
  }
  const arranged: ArrangedDef[] = defs.map((d) => {
    const v = byName.get(key(d.name));
    if (v) byName.delete(key(d.name));
    return { ...d, raw: v?.raw ?? '' };
  });
  const rest = [...byName.values(), ...free].map((v) => ({ ...v, type: FREE_TYPES.includes(v.type) ? v.type : ('text' as AttrType) }));
  return { defs: arranged, free: rest };
}

function validateValues(arr: { defs: ArrangedDef[]; free: FormValue[] }) {
  const errors: Record<string, string> = {};
  const inputs: ValueInput[] = [];
  let sort = 0;
  for (const d of arr.defs) {
    const p = parseValue(d.type, d.raw, d.optionList);
    if (!p.ok) errors[`attr_${d.id}`] = p.error;
    else if (p.v) inputs.push({ defId: d.id, name: d.name, type: d.type, unit: d.unit, parsed: p.v, sort: sort++ });
  }
  const seen = new Set(arr.defs.map((d) => key(d.name)));
  arr.free.forEach((f, i) => {
    if (!f.name) {
      errors[`free_${i}`] = 'nom de la caractéristique manquant';
      return;
    }
    if (seen.has(key(f.name))) {
      errors[`free_${i}`] = `« ${f.name} » existe déjà sur cet objet`;
      return;
    }
    seen.add(key(f.name));
    const p = parseValue(f.type, f.raw);
    if (!p.ok) errors[`free_${i}`] = p.error;
    else if (p.v) inputs.push({ defId: null, name: f.name.slice(0, 120), type: f.type, unit: f.unit, parsed: p.v, sort: sort++ });
  });
  return { errors, inputs };
}

interface ItemForm {
  name: string;
  brand: string;
  model: string;
  serial: string;
  quantity: string;
  category_id: number | null;
  location_id: number | null;
  status_id: number | null;
  notes: string;
}

function formFromBody(body: Body): ItemForm {
  return {
    name: str(body, 'name', 200),
    brand: str(body, 'brand', 120),
    model: str(body, 'model', 200),
    serial: str(body, 'serial', 120),
    quantity: str(body, 'quantity', 10) || '1',
    category_id: id(body.category_id),
    location_id: id(body.location_id),
    status_id: id(body.status_id),
    notes: str(body, 'notes', 20000),
  };
}

async function renderForm(req: FastifyRequest, reply: FastifyReply, opts: { item: ItemForm; itemId?: number; values: FormValue[]; errors?: Record<string, string>; status?: number; duplicateOf?: { id: number; name: string } }) {
  const { cats, locs, statuses } = await lookups();
  const defs = await effectiveDefs(cats, opts.item.category_id);
  return render(
    req,
    reply,
    'items/form',
    {
      title: opts.itemId ? `Modifier « ${opts.item.name} »` : 'Nouvel objet',
      item: opts.item,
      itemId: opts.itemId ?? null,
      attrs: arrange(defs, opts.values),
      errors: opts.errors ?? {},
      cats: cats.flat,
      locs: locs.flat,
      statuses,
      freeTypes: FREE_TYPES,
      duplicateOf: opts.duplicateOf ?? null,
    },
    opts.status ?? 200,
  );
}

async function validateItem(body: Body, cats: Tree, locs: Tree) {
  const item = formFromBody(body);
  const errors: Record<string, string> = {};
  if (!item.name) errors.name = 'Le nom est obligatoire.';
  const qty = Number(item.quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 1_000_000) errors.quantity = 'La quantité doit être un entier positif.';
  if (item.category_id && !cats.byId.has(item.category_id)) errors.category_id = 'Catégorie inconnue.';
  if (item.location_id && !locs.byId.has(item.location_id)) errors.location_id = 'Emplacement inconnu.';
  if (item.status_id && !(await db.selectFrom('statuses').select('id').where('id', '=', item.status_id).executeTakeFirst())) errors.status_id = 'Statut inconnu.';
  const values = await valuesFromBody(body);
  const defs = await effectiveDefs(cats, item.category_id);
  const v = validateValues(arrange(defs, values));
  return { item, qty, values, errors: { ...errors, ...v.errors }, inputs: v.inputs };
}

function itemRow(item: ItemForm, qty: number) {
  return {
    name: item.name,
    brand: item.brand || null,
    model: item.model || null,
    serial: item.serial || null,
    quantity: qty,
    category_id: item.category_id,
    location_id: item.location_id,
    status_id: item.status_id,
    notes: item.notes || null,
  };
}

async function auditView(itemId: number, cats: Tree, locs: Tree) {
  const it = await db
    .selectFrom('items')
    .leftJoin('statuses', 'statuses.id', 'items.status_id')
    .selectAll('items')
    .select('statuses.name as status_name')
    .where('items.id', '=', itemId)
    .executeTakeFirstOrThrow();
  return {
    ...it,
    category: it.category_id ? cats.byId.get(it.category_id)?.path : null,
    location: it.location_id ? locs.byId.get(it.location_id)?.path : null,
    status: it.status_name,
  };
}

export async function itemRoutes(app: FastifyInstance) {
  // Un objet dans la corbeille est en lecture seule : seule la restauration est possible.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    const m = /^\/objets\/(\d+)(\/[a-z-]+)?$/.exec(path);
    if (!m) return;
    const action = m[2] ?? '';
    const mutating = req.method === 'POST' || action === '/modifier';
    if (!mutating || action === '/restaurer') return;
    const it = await db.selectFrom('items').select('deleted_at').where('id', '=', Number(m[1])).executeTakeFirst();
    if (it?.deleted_at) {
      setFlash(reply, 'erreur', 'Cet objet est dans la corbeille : restaurez-le pour le modifier.');
      return redirect(req, reply, `/objets/${m[1]}`);
    }
  });

  // ---- Liste filtrée ----
  app.get('/objets', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    // Mémoire de la liste : revenir sur « Objets » retrouve les filtres, le tri et la page précédents.
    if (q.reset !== undefined) {
      reply.clearCookie(LIST_COOKIE, { path: '/' });
      return reply.redirect('/objets', 303);
    }
    if (!Object.keys(q).length && !isHtmx(req)) {
      const saved = req.cookies[LIST_COOKIE];
      const un = saved ? req.unsignCookie(saved) : null;
      if (un?.valid && un.value) return reply.redirect(`/objets?${un.value}`, 303);
    }
    const f = { ...parseFilters(q), ids: [] };
    const page = intIn(q.page, 1, 100000, 1);
    const listQs = helpers.qs(filterParams(f), { page: page > 1 ? page : null }).slice(1);
    if (listQs) reply.setCookie(LIST_COOKIE, listQs, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, signed: true, maxAge: 30 * 86400 });
    else reply.clearCookie(LIST_COOKIE, { path: '/' });
    // HTMX inscrit dans l'historique l'adresse normalisée (identique à celle mémorisée).
    if (isHtmx(req)) reply.header('HX-Push-Url', listQs ? `/objets?${listQs}` : '/objets');
    const { cats, locs, statuses } = await lookups();
    await resolveFilters(f, cats);
    const base = buildItemQuery(f, cats, locs);
    const countRow = await db
      .selectFrom(base.as('b'))
      .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('b.quantity').as('units')])
      .executeTakeFirstOrThrow();
    const total = Number(countRow.n);
    const items = await orderItems(base, f, cats, locs).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE).execute();
    const data = {
      title: 'Objets',
      items: items.map((i: any) => ({
        ...i,
        categoryName: i.category_id ? cats.byId.get(i.category_id)?.name : null,
        categoryPath: i.category_id ? cats.byId.get(i.category_id)?.path : null,
        locationPath: i.location_id ? locs.byId.get(i.location_id)?.path : null,
      })),
      total,
      units: Number(countRow.units ?? 0),
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      f,
      params: filterParams(f),
      filtered: hasFilters(f),
      cats: cats.flat,
      locs: locs.flat,
      statuses,
      attrNames: await attributeNames(),
      sorts: SORTS,
      ops: OPS,
      manques: MANQUES,
      people: await db.selectFrom('people').select(['id', 'name']).orderBy('name').execute(),
    };
    if (isHtmx(req) && req.headers['hx-target'] === 'resultats') return render(req, reply, 'items/_results', data);
    return render(req, reply, 'items/list', data);
  });

  // ---- Création ----
  app.get('/objets/nouveau', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const fromId = id(q.depuis);
    const src = fromId ? await db.selectFrom('items').selectAll().where('id', '=', fromId).executeTakeFirst() : undefined;
    if (src) {
      // Dupliquer : mêmes informations et caractéristiques, sans n° de série ni fichiers ; rien n'est créé avant validation.
      const item: ItemForm = {
        name: `${src.name} (copie)`.slice(0, 200),
        brand: src.brand ?? '',
        model: src.model ?? '',
        serial: '',
        quantity: String(src.quantity),
        category_id: src.category_id,
        location_id: src.location_id,
        status_id: src.status_id,
        notes: src.notes ?? '',
      };
      return renderForm(req, reply, { item, values: await valuesFromDb(src.id), duplicateOf: { id: src.id, name: src.name } });
    }
    const item: ItemForm = { name: '', brand: '', model: '', serial: '', quantity: '1', category_id: id(q.cat), location_id: id(q.loc), status_id: null, notes: '' };
    return renderForm(req, reply, { item, values: [] });
  });

  app.post('/objets', async (req, reply) => {
    const body = req.body as Body;
    const { cats, locs } = await lookups();
    const v = await validateItem(body, cats, locs);
    if (Object.keys(v.errors).length) return renderForm(req, reply, { item: v.item, values: v.values, errors: v.errors, status: 422 });
    const newId = await db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('items').values(itemRow(v.item, v.qty)).executeTakeFirstOrThrow();
      const itemId = Number(r.insertId);
      await replaceItemValues(trx, itemId, v.inputs);
      return itemId;
    });
    await audit(req, 'objet', newId, 'creation', `Création de « ${v.item.name} »`);
    setFlash(reply, 'ok', 'Objet créé.');
    return redirect(req, reply, `/objets/${newId}`);
  });

  // ---- Fragments HTMX du formulaire ----
  app.get('/objets/formulaire/caracteristiques', async (req, reply) => {
    const q = req.query as Body;
    const { cats } = await lookups();
    const defs = await effectiveDefs(cats, id(q.category_id));
    const values = await valuesFromBody(q);
    return render(req, reply, 'items/_attributes', { attrs: arrange(defs, values), errors: {}, freeTypes: FREE_TYPES });
  });
  app.get('/objets/formulaire/ligne-libre', async (req, reply) => {
    return render(req, reply, 'items/_free_row', { row: { name: '', type: 'text', unit: '', raw: '' }, i: 0, error: null, freeTypes: FREE_TYPES });
  });

  // ---- Fiche ----
  app.get('/objets/:id', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    if (!itemId) return reply.callNotFound();
    const item = await db
      .selectFrom('items')
      .leftJoin('statuses', 'statuses.id', 'items.status_id')
      .selectAll('items')
      .select(['statuses.name as status_name', 'statuses.color as status_color'])
      .where('items.id', '=', itemId)
      .executeTakeFirst();
    if (!item) return reply.callNotFound();
    const { cats, locs } = await lookups();
    const [values, attachments, parents, children, maintenance, history, allItems, people] = await Promise.all([
      db.selectFrom('item_values').selectAll().where('item_id', '=', itemId).orderBy('sort_order').orderBy('id').execute(),
      db.selectFrom('attachments').selectAll().where('item_id', '=', itemId).orderBy('created_at', 'desc').execute(),
      db
        .selectFrom('item_links')
        .innerJoin('items', 'items.id', 'item_links.parent_item_id')
        .select(['item_links.id as link_id', 'item_links.label', 'items.id', 'items.name', 'items.deleted_at'])
        .where('item_links.child_item_id', '=', itemId)
        .execute(),
      db
        .selectFrom('item_links')
        .innerJoin('items', 'items.id', 'item_links.child_item_id')
        .select(['item_links.id as link_id', 'item_links.label', 'items.id', 'items.name', 'items.deleted_at'])
        .where('item_links.parent_item_id', '=', itemId)
        .execute(),
      db.selectFrom('maintenance').selectAll().where('item_id', '=', itemId).orderBy('date', 'desc').orderBy('id', 'desc').execute(),
      db
        .selectFrom('audit_log')
        .leftJoin('users', 'users.id', 'audit_log.user_id')
        .select(['audit_log.id', 'audit_log.action', 'audit_log.summary', 'audit_log.changes', 'audit_log.created_at', 'users.username'])
        .where('audit_log.entity', '=', 'objet')
        .where('audit_log.entity_id', '=', itemId)
        .orderBy('audit_log.id', 'desc')
        .limit(200)
        .execute(),
      db.selectFrom('items').select(['id', 'name']).where('id', '!=', itemId).where('deleted_at', 'is', null).orderBy('name').execute(),
      db.selectFrom('people').select(['id', 'name']).orderBy('name').execute(),
    ]);
    // Chronologie : historique de la fiche et interventions d'entretien, du plus récent au plus ancien.
    const timeline = [
      ...history.map((h) => ({ kind: 'event', action: h.action, at: new Date(h.created_at), title: h.summary, user: h.username, changes: h.changes ? JSON.parse(h.changes) : null, text: null as string | null })),
      ...maintenance.map((m) => ({ kind: 'maintenance', action: 'entretien', at: new Date(m.date + 'T12:00:00Z'), title: m.title, user: null, changes: null, text: m.description, id: m.id, date: m.date })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const assigned = item.assigned_person_id ? people.find((p) => p.id === item.assigned_person_id) ?? null : null;
    const completeness = await itemCompleteness(cats, item);
    return render(req, reply, 'items/show', {
      title: item.name,
      item,
      values,
      completeness,
      categoryLineage: lineage(cats, item.category_id),
      locationLineage: lineage(locs, item.location_id),
      photos: attachments.filter((a) => a.kind === 'photo'),
      docs: attachments.filter((a) => a.kind !== 'photo'),
      parents,
      children,
      maintenance,
      timeline,
      allItems,
      people,
      assigned,
      primary: attachments.find((a) => a.kind === 'photo' && a.is_primary) ?? attachments.find((a) => a.kind === 'photo') ?? null,
      today: new Date().toISOString().slice(0, 10),
    });
  });

  // ---- Modification ----
  app.get('/objets/:id/modifier', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const it = itemId ? await db.selectFrom('items').selectAll().where('id', '=', itemId).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    const item: ItemForm = {
      name: it.name,
      brand: it.brand ?? '',
      model: it.model ?? '',
      serial: it.serial ?? '',
      quantity: String(it.quantity),
      category_id: it.category_id,
      location_id: it.location_id,
      status_id: it.status_id,
      notes: it.notes ?? '',
    };
    return renderForm(req, reply, { item, itemId: it.id, values: await valuesFromDb(it.id) });
  });

  app.post('/objets/:id', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    if (!itemId || !(await db.selectFrom('items').select('id').where('id', '=', itemId).executeTakeFirst())) return reply.callNotFound();
    const body = req.body as Body;
    const { cats, locs } = await lookups();
    const v = await validateItem(body, cats, locs);
    if (Object.keys(v.errors).length) return renderForm(req, reply, { item: v.item, itemId, values: v.values, errors: v.errors, status: 422 });
    const before = await auditView(itemId, cats, locs);
    const beforeValues = valueSummary(await db.selectFrom('item_values').selectAll().where('item_id', '=', itemId).execute());
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('items').set(itemRow(v.item, v.qty)).where('id', '=', itemId).execute();
      await replaceItemValues(trx, itemId, v.inputs);
    });
    const after = await auditView(itemId, cats, locs);
    const afterValues = valueSummary(await db.selectFrom('item_values').selectAll().where('item_id', '=', itemId).execute());
    const changes = diff(before, after, ITEM_LABELS);
    const names = new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)]);
    for (const n of names) {
      if ((beforeValues[n] ?? null) !== (afterValues[n] ?? null)) changes[n] = { avant: beforeValues[n] ?? null, apres: afterValues[n] ?? null };
    }
    if (Object.keys(changes).length) await audit(req, 'objet', itemId, 'modification', `Modification de « ${v.item.name} »`, changes);
    setFlash(reply, 'ok', 'Modifications enregistrées.');
    return redirect(req, reply, `/objets/${itemId}`);
  });

  app.post('/objets/:id/supprimer', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const it = itemId ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).where('deleted_at', 'is', null).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    // Corbeille : l'objet est masqué partout et supprimé définitivement après 30 jours.
    await db.updateTable('items').set({ deleted_at: new Date() }).where('id', '=', it.id).execute();
    await audit(req, 'objet', it.id, 'corbeille', `« ${it.name} » mis à la corbeille`);
    setFlash(reply, 'ok', `« ${it.name} » mis à la corbeille (récupérable pendant 30 jours).`);
    return redirect(req, reply, '/objets');
  });

  app.post('/objets/:id/restaurer', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const it = itemId ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).where('deleted_at', 'is not', null).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    await db.updateTable('items').set({ deleted_at: null }).where('id', '=', it.id).execute();
    await audit(req, 'objet', it.id, 'restauration', `« ${it.name} » restauré depuis la corbeille`);
    setFlash(reply, 'ok', `« ${it.name} » restauré.`);
    return redirect(req, reply, `/objets/${it.id}`);
  });

  // ---- Attribution à une personne ----
  app.post('/objets/:id/attribution', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const it = itemId ? await db.selectFrom('items').selectAll().where('id', '=', itemId).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    const body = req.body as Body;
    const before = it.assigned_person_id ? await db.selectFrom('people').select('name').where('id', '=', it.assigned_person_id).executeTakeFirst() : undefined;
    if (str(body, 'action') === 'retirer') {
      await db.updateTable('items').set({ assigned_person_id: null, assigned_at: null }).where('id', '=', it.id).execute();
      await audit(req, 'objet', it.id, 'attribution', `Attribution retirée${before ? ` (était : ${before.name})` : ''}`);
      setFlash(reply, 'ok', 'Attribution retirée.');
      return redirect(req, reply, `/objets/${it.id}#attribution`);
    }
    const personId = id(body.person_id);
    const person = personId ? await db.selectFrom('people').select(['id', 'name']).where('id', '=', personId).executeTakeFirst() : undefined;
    const date = str(body, 'date', 10);
    if (!person) {
      setFlash(reply, 'erreur', 'Choisissez une personne.');
      return redirect(req, reply, `/objets/${it.id}#attribution`);
    }
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date));
    await db.updateTable('items').set({ assigned_person_id: person.id, assigned_at: okDate ? date : new Date().toISOString().slice(0, 10) }).where('id', '=', it.id).execute();
    await audit(req, 'objet', it.id, 'attribution', `Attribué à ${person.name}${before && before.name !== person.name ? ` (au lieu de ${before.name})` : ''}`);
    setFlash(reply, 'ok', `Attribué à ${person.name}.`);
    return redirect(req, reply, `/objets/${it.id}#attribution`);
  });

  // ---- Informations « sans objet » (ne comptent plus comme manquantes) ----
  app.post('/objets/:id/sans-objet', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const it = itemId ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    const body = req.body as Body;
    const field = str(body, 'field', 130);
    const remove = str(body, 'action') === 'retirer';
    if (!isValidNaField(field)) return reply.code(400).send('Champ invalide');
    const label = field === 'photo' ? 'Photo' : field === 'serial' ? 'N° de série' : field.slice(5);
    if (remove) await db.deleteFrom('item_na').where('item_id', '=', it.id).where('field', '=', field).execute();
    else await db.insertInto('item_na').values({ item_id: it.id, field }).onDuplicateKeyUpdate({ field }).execute();
    await audit(req, 'objet', it.id, 'complétude', remove ? `« ${label} » de nouveau attendu` : `« ${label} » marqué sans objet`);
    return redirect(req, reply, `/objets/${it.id}#completude`);
  });

  // ---- Liens entre objets ----
  app.post('/objets/:id/liens', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const body = req.body as Body;
    const otherRaw = str(body, 'other', 300);
    const other = id(/^#?(\d+)/.exec(otherRaw)?.[1]);
    const direction = str(body, 'direction') === 'parent' ? 'parent' : 'child';
    const label = optStr(body, 'label', 120);
    if (!itemId || !other || other === itemId) {
      setFlash(reply, 'erreur', 'Choisissez un autre objet dans la liste.');
      return redirect(req, reply, `/objets/${itemId}#liens`);
    }
    const [a, b] = await Promise.all([
      db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).executeTakeFirst(),
      db.selectFrom('items').select(['id', 'name']).where('id', '=', other).executeTakeFirst(),
    ]);
    if (!a || !b) return reply.callNotFound();
    const parent = direction === 'child' ? a : b;
    const child = direction === 'child' ? b : a;
    const exists = await db
      .selectFrom('item_links')
      .select('id')
      .where((eb) =>
        eb.or([
          eb.and([eb('parent_item_id', '=', parent.id), eb('child_item_id', '=', child.id)]),
          eb.and([eb('parent_item_id', '=', child.id), eb('child_item_id', '=', parent.id)]),
        ]),
      )
      .executeTakeFirst();
    if (exists) {
      setFlash(reply, 'erreur', 'Ces deux objets sont déjà liés.');
      return redirect(req, reply, `/objets/${itemId}#liens`);
    }
    await db.insertInto('item_links').values({ parent_item_id: parent.id, child_item_id: child.id, label }).execute();
    await audit(req, 'objet', itemId, 'lien', `Lien : « ${child.name} » rattaché à « ${parent.name} »${label ? ` (${label})` : ''}`);
    if (other !== itemId) await audit(req, 'objet', other, 'lien', `Lien : « ${child.name} » rattaché à « ${parent.name} »${label ? ` (${label})` : ''}`);
    setFlash(reply, 'ok', 'Lien ajouté.');
    return redirect(req, reply, `/objets/${itemId}#liens`);
  });

  app.post('/liens/:id/supprimer', async (req, reply) => {
    const linkId = id((req.params as Body).id);
    const back = id((req.body as Body).back);
    const link = linkId
      ? await db
          .selectFrom('item_links')
          .innerJoin('items as p', 'p.id', 'item_links.parent_item_id')
          .innerJoin('items as c', 'c.id', 'item_links.child_item_id')
          .select(['item_links.id', 'p.id as pid', 'p.name as pname', 'c.id as cid', 'c.name as cname'])
          .where('item_links.id', '=', linkId)
          .executeTakeFirst()
      : undefined;
    if (!link) return reply.callNotFound();
    await db.deleteFrom('item_links').where('id', '=', link.id).execute();
    for (const e of [link.pid, link.cid]) await audit(req, 'objet', e, 'lien', `Lien supprimé : « ${link.cname} » / « ${link.pname} »`);
    setFlash(reply, 'ok', 'Lien supprimé.');
    return redirect(req, reply, `/objets/${back ?? link.pid}#liens`);
  });

  // ---- Entretien / réparations ----
  app.post('/objets/:id/entretien', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const it = itemId ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    const body = req.body as Body;
    const title = str(body, 'title', 200);
    const date = str(body, 'date', 10);
    const description = optStr(body, 'description', 20000);
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date));
    if (!title || !okDate) {
      setFlash(reply, 'erreur', 'Indiquez une date et un intitulé.');
      return redirect(req, reply, `/objets/${it.id}#entretien`);
    }
    await db.insertInto('maintenance').values({ item_id: it.id, date, title, description }).execute();
    await audit(req, 'objet', it.id, 'entretien', `Intervention ajoutée : ${title} (${date})`);
    setFlash(reply, 'ok', 'Intervention ajoutée.');
    return redirect(req, reply, `/objets/${it.id}#entretien`);
  });

  app.post('/entretien/:id/supprimer', async (req, reply) => {
    const mid = id((req.params as Body).id);
    const m = mid ? await db.selectFrom('maintenance').selectAll().where('id', '=', mid).executeTakeFirst() : undefined;
    if (!m) return reply.callNotFound();
    await db.deleteFrom('maintenance').where('id', '=', m.id).execute();
    await audit(req, 'objet', m.item_id, 'entretien', `Intervention supprimée : ${m.title} (${m.date})`);
    setFlash(reply, 'ok', 'Intervention supprimée.');
    return redirect(req, reply, `/objets/${m.item_id}#entretien`);
  });
}

export { parseOptions };
