// API REST JSON (préfixe /api/v1), authentifiée par jeton : « Authorization: Bearer inv_… ».
// Jeton « lecture » : GET uniquement. Jeton « écriture » (administrateurs) : création, modification, corbeille.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, AttrType } from '../db.js';
import { loadTree, Tree } from '../services/tree.js';
import { effectiveDefs, parseValue, displayValue, replaceItemValues, ValueInput, isAttrType } from '../services/attributes.js';
import { audit } from '../services/audit.js';
import { parseFilters, buildItemQuery, orderItems, resolveFilters } from '../services/items.js';
import { id } from '../services/forms.js';

type J = Record<string, unknown>;
const bad = (reply: FastifyReply, msg: string, code = 400) => reply.code(code).send({ erreur: msg });

async function trees() {
  const [cats, locs] = await Promise.all([loadTree('categories'), loadTree('locations')]);
  return { cats, locs };
}

async function itemJson(itemId: number, cats: Tree, locs: Tree) {
  const it = await db
    .selectFrom('items')
    .leftJoin('statuses', 'statuses.id', 'items.status_id')
    .leftJoin('people', 'people.id', 'items.assigned_person_id')
    .selectAll('items')
    .select(['statuses.name as status_name', 'people.name as person_name'])
    .where('items.id', '=', itemId)
    .where('items.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!it) return null;
  const [values, files] = await Promise.all([
    db.selectFrom('item_values').selectAll().where('item_id', '=', itemId).orderBy('sort_order').execute(),
    db.selectFrom('attachments').select(['id', 'kind', 'original_name', 'mime', 'size', 'is_primary', 'created_at']).where('item_id', '=', itemId).execute(),
  ]);
  return {
    id: it.id,
    nom: it.name,
    marque: it.brand,
    modele: it.model,
    numero_serie: it.serial,
    quantite: it.quantity,
    statut: it.status_id ? { id: it.status_id, nom: it.status_name } : null,
    categorie: it.category_id ? { id: it.category_id, chemin: cats.byId.get(it.category_id)?.path ?? null } : null,
    emplacement: it.location_id ? { id: it.location_id, chemin: locs.byId.get(it.location_id)?.path ?? null } : null,
    attribue_a: it.assigned_person_id ? { id: it.assigned_person_id, nom: it.person_name, depuis: it.assigned_at } : null,
    notes: it.notes,
    caracteristiques: Object.fromEntries(
      values.map((v) => [v.name, { valeur: v.type === 'number' ? (v.value_number === null ? null : Number(v.value_number)) : v.type === 'boolean' ? v.value_bool === null ? null : !!v.value_bool : v.type === 'date' ? v.value_date : v.value_text, affichage: displayValue(v), type: v.type, unite: v.unit, libre: v.def_id === null }]),
    ),
    fichiers: files.map((f) => ({ ...f, url: `/fichiers/${f.id}` })),
    etiquette_imprimee_le: it.label_printed_at,
    cree_le: it.created_at,
    modifie_le: it.updated_at,
  };
}

// Valide les champs d'un objet envoyés en JSON (création : tous ; modification : seulement ceux présents).
async function readItem(body: J, partial: boolean, cats: Tree, locs: Tree) {
  const errors: string[] = [];
  const row: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const text = (k: string, col: string, max: number) => {
    if (!has(k)) return;
    const v = body[k];
    if (v === null || v === '') row[col] = null;
    else if (typeof v !== 'string' || v.length > max) errors.push(`${k} : texte de ${max} caractères maximum attendu`);
    else row[col] = v.trim();
  };
  if (!partial || has('nom')) {
    if (typeof body.nom !== 'string' || !body.nom.trim() || body.nom.length > 200) errors.push('nom : obligatoire (200 caractères maximum)');
    else row.name = body.nom.trim();
  }
  text('marque', 'brand', 120);
  text('modele', 'model', 200);
  text('numero_serie', 'serial', 120);
  text('notes', 'notes', 20000);
  if (has('quantite')) {
    const q = Number(body.quantite);
    if (!Number.isInteger(q) || q < 1 || q > 1_000_000) errors.push('quantite : entier positif attendu');
    else row.quantity = q;
  } else if (!partial) row.quantity = 1;
  const ref = async (k: string, col: string, check: (n: number) => Promise<boolean> | boolean) => {
    if (!has(k)) return;
    if (body[k] === null) row[col] = null;
    else if (!id(body[k]) || !(await check(id(body[k])!))) errors.push(`${k} : identifiant inconnu`);
    else row[col] = id(body[k]);
  };
  await ref('categorie_id', 'category_id', (n) => cats.byId.has(n));
  await ref('emplacement_id', 'location_id', (n) => locs.byId.has(n));
  await ref('statut_id', 'status_id', async (n) => !!(await db.selectFrom('statuses').select('id').where('id', '=', n).executeTakeFirst()));
  return { row, errors };
}

// Caractéristiques { "RAM": 16, "Couleur": "noir" } : typées selon la catégorie, libres (texte) sinon. null = supprimer.
async function readValues(body: J, categoryId: number | null, cats: Tree, current: ValueInput[]) {
  const errors: string[] = [];
  const raw = body.caracteristiques;
  if (raw === undefined) return { values: current, errors, changed: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { values: current, errors: ['caracteristiques : objet { nom: valeur } attendu'], changed: false };
  const defs = await effectiveDefs(cats, categoryId);
  const byName = new Map(current.map((v) => [v.name.toLowerCase(), v]));
  for (const [name, val] of Object.entries(raw as J)) {
    if (!name.trim() || name.length > 120) {
      errors.push('caracteristiques : nom invalide');
      continue;
    }
    if (val === null) {
      byName.delete(name.toLowerCase());
      continue;
    }
    const def = defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
    const type: AttrType = def ? def.type : typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'text';
    const str = typeof val === 'boolean' ? (val ? 'oui' : 'non') : String(val);
    const p = parseValue(type, str, def?.optionList ?? []);
    if (!p.ok) errors.push(`${name} : ${p.error}`);
    else if (p.v) byName.set(name.toLowerCase(), { defId: def?.id ?? null, name: def?.name ?? name.trim(), type: isAttrType(type) ? type : 'text', unit: def?.unit ?? null, parsed: p.v, sort: byName.size });
  }
  return { values: [...byName.values()], errors, changed: true };
}

async function currentValues(itemId: number): Promise<ValueInput[]> {
  const rows = await db.selectFrom('item_values').selectAll().where('item_id', '=', itemId).orderBy('sort_order').execute();
  return rows.map((r, i) => ({ defId: r.def_id, name: r.name, type: r.type, unit: r.unit, parsed: { value_text: r.value_text, value_number: r.value_number, value_date: r.value_date, value_bool: r.value_bool }, sort: i }));
}

const apiAudit = (req: FastifyRequest, itemId: number, action: string, summary: string) => audit(req, 'objet', itemId, action, `${summary} (API)`);

export async function apiRoutes(app: FastifyInstance) {
  app.get('/', async () => ({
    api: 'Inventaire',
    version: 1,
    authentification: 'En-tête « Authorization: Bearer <jeton> » (Mon compte > Jetons d’API).',
    routes: {
      'GET /api/v1/objets': 'Liste (filtres : q, cat, loc, status, personne, attr, op, val, manque, sort, dir ; pagination : limit ≤ 500, offset).',
      'GET /api/v1/objets/:id': 'Détail d’un objet avec ses caractéristiques.',
      'POST /api/v1/objets': 'Créer (jeton écriture) : { nom, marque, modele, numero_serie, quantite, categorie_id, emplacement_id, statut_id, notes, caracteristiques: { nom: valeur } }.',
      'PATCH /api/v1/objets/:id': 'Modifier les champs envoyés (jeton écriture). Une caractéristique à null est supprimée.',
      'POST /api/v1/objets/:id/deplacer': 'Déplacer : { emplacement_id } (jeton écriture).',
      'DELETE /api/v1/objets/:id': 'Mettre à la corbeille (jeton écriture).',
      'GET /api/v1/emplacements': 'Arborescence des emplacements.',
      'GET /api/v1/categories': 'Catégories et caractéristiques applicables.',
      'GET /api/v1/statuts': 'Statuts.',
      'GET /api/v1/personnes': 'Personnes.',
    },
  }));

  app.get('/objets', async (req) => {
    const q = req.query as J;
    const f = parseFilters(q);
    const { cats, locs } = await trees();
    await resolveFilters(f, cats);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const offset = Math.max(0, Number(q.offset) || 0);
    const base = buildItemQuery(f, cats, locs);
    const total = Number((await db.selectFrom(base.as('b')).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = (await orderItems(base, f, cats, locs).limit(limit).offset(offset).execute()) as any[];
    const objets: unknown[] = [];
    for (const r of rows) objets.push(await itemJson(r.id, cats, locs));
    return { total, limit, offset, objets };
  });

  app.get('/objets/:id', async (req, reply) => {
    const itemId = id((req.params as J).id);
    const { cats, locs } = await trees();
    const it = itemId ? await itemJson(itemId, cats, locs) : null;
    return it ?? bad(reply, 'Objet introuvable.', 404);
  });

  app.post('/objets', async (req, reply) => {
    const body = (req.body ?? {}) as J;
    const { cats, locs } = await trees();
    const r = await readItem(body, false, cats, locs);
    const v = await readValues(body, (r.row.category_id as number) ?? null, cats, []);
    const errors = [...r.errors, ...v.errors];
    if (errors.length) return bad(reply, errors.join(' ; '), 422);
    const newId = await db.transaction().execute(async (trx) => {
      const ins = await trx.insertInto('items').values(r.row as any).executeTakeFirstOrThrow();
      const nid = Number(ins.insertId);
      await replaceItemValues(trx, nid, v.values);
      return nid;
    });
    await apiAudit(req, newId, 'creation', `Création de « ${r.row.name} »`);
    return reply.code(201).send(await itemJson(newId, cats, locs));
  });

  app.patch('/objets/:id', async (req, reply) => {
    const itemId = id((req.params as J).id);
    const cur = itemId ? await db.selectFrom('items').selectAll().where('id', '=', itemId).where('deleted_at', 'is', null).executeTakeFirst() : undefined;
    if (!cur) return bad(reply, 'Objet introuvable.', 404);
    const body = (req.body ?? {}) as J;
    const { cats, locs } = await trees();
    const r = await readItem(body, true, cats, locs);
    const categoryId = 'category_id' in r.row ? (r.row.category_id as number | null) : cur.category_id;
    const v = await readValues(body, categoryId, cats, await currentValues(cur.id));
    const errors = [...r.errors, ...v.errors];
    if (errors.length) return bad(reply, errors.join(' ; '), 422);
    await db.transaction().execute(async (trx) => {
      if (Object.keys(r.row).length) await trx.updateTable('items').set(r.row as any).where('id', '=', cur.id).execute();
      if (v.changed) await replaceItemValues(trx, cur.id, v.values);
    });
    await apiAudit(req, cur.id, 'modification', `Modification de « ${(r.row.name as string) ?? cur.name} » : ${[...Object.keys(body)].join(', ')}`);
    return itemJson(cur.id, cats, locs);
  });

  app.post('/objets/:id/deplacer', async (req, reply) => {
    const itemId = id((req.params as J).id);
    const cur = itemId ? await db.selectFrom('items').selectAll().where('id', '=', itemId).where('deleted_at', 'is', null).executeTakeFirst() : undefined;
    if (!cur) return bad(reply, 'Objet introuvable.', 404);
    const { cats, locs } = await trees();
    const locId = id(((req.body ?? {}) as J).emplacement_id);
    const loc = locId ? locs.byId.get(locId) : undefined;
    if (!loc) return bad(reply, 'emplacement_id : identifiant inconnu', 422);
    await db.updateTable('items').set({ location_id: loc.id }).where('id', '=', cur.id).execute();
    await apiAudit(req, cur.id, 'deplacement', `Déplacé dans « ${loc.path} »`);
    return itemJson(cur.id, cats, locs);
  });

  app.delete('/objets/:id', async (req, reply) => {
    const itemId = id((req.params as J).id);
    const cur = itemId ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).where('deleted_at', 'is', null).executeTakeFirst() : undefined;
    if (!cur) return bad(reply, 'Objet introuvable.', 404);
    await db.updateTable('items').set({ deleted_at: new Date() }).where('id', '=', cur.id).execute();
    await apiAudit(req, cur.id, 'corbeille', `« ${cur.name} » mis à la corbeille`);
    return { ok: true, corbeille: true };
  });

  app.get('/emplacements', async () => {
    const { locs } = await trees();
    return locs.flat.map((l) => ({ id: l.id, nom: l.name, parent_id: l.parent_id, chemin: l.path, description: l.description }));
  });
  app.get('/categories', async () => {
    const { cats } = await trees();
    const out: unknown[] = [];
    for (const c of cats.flat) {
      const defs = await effectiveDefs(cats, c.id);
      out.push({ id: c.id, nom: c.name, parent_id: c.parent_id, chemin: c.path, caracteristiques: defs.map((d) => ({ nom: d.name, type: d.type, unite: d.unit, options: d.optionList, facultative: !!d.optional, heritee: d.inherited })) });
    }
    return out;
  });
  app.get('/statuts', async () => (await db.selectFrom('statuses').selectAll().orderBy('sort_order').execute()).map((s) => ({ id: s.id, nom: s.name, couleur: s.color, a_traiter: !!s.to_handle })));
  app.get('/personnes', async () => (await db.selectFrom('people').select(['id', 'name', 'notes']).orderBy('name').execute()).map((p) => ({ id: p.id, nom: p.name, notes: p.notes })));
}
