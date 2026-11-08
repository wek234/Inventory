// Emplacements et catégories : arborescences de profondeur illimitée. Les catégories portent les caractéristiques.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db, AttrType } from '../db.js';
import { render, redirect, setFlash } from '../views.js';
import { loadTree, descendantIds, lineage, nameTakenAmongSiblings, TreeTableName, Tree } from '../services/tree.js';
import { effectiveDefs, isAttrType, parseOptions } from '../services/attributes.js';
import { audit } from '../services/audit.js';
import { Body, str, optStr, id, intIn } from '../services/forms.js';

interface Kind {
  table: TreeTableName;
  base: string; // préfixe d'URL
  entity: string; // pour l'historique
  one: string;
  many: string;
  itemFilter: 'cat' | 'loc';
  itemColumn: 'category_id' | 'location_id';
}

const KINDS: Kind[] = [
  { table: 'locations', base: '/emplacements', entity: 'emplacement', one: 'emplacement', many: 'Emplacements', itemFilter: 'loc', itemColumn: 'location_id' },
  { table: 'categories', base: '/categories', entity: 'categorie', one: 'catégorie', many: 'Catégories', itemFilter: 'cat', itemColumn: 'category_id' },
];

async function counts(kind: Kind, tree: Tree) {
  const rows = await db
    .selectFrom('items')
    .select([kind.itemColumn, db.fn.countAll<number>().as('n')])
    .where(kind.itemColumn, 'is not', null)
    .groupBy(kind.itemColumn)
    .execute();
  const direct = new Map<number, number>(rows.map((r: any) => [Number(r[kind.itemColumn]), Number(r.n)]));
  const total = new Map<number, number>();
  for (const e of tree.flat) total.set(e.id, descendantIds(tree, e.id).reduce((s, d) => s + (direct.get(d) ?? 0), 0));
  return { direct, total };
}

export async function treeRoutes(app: FastifyInstance) {
  for (const kind of KINDS) {
    app.get(kind.base, async (req, reply) => {
      const tree = await loadTree(kind.table);
      const c = await counts(kind, tree);
      return render(req, reply, 'trees/index', { title: kind.many, kind, flat: tree.flat, direct: c.direct, total: c.total });
    });

    app.post(kind.base, async (req, reply) => {
      const body = req.body as Body;
      const name = str(body, 'name', 120);
      const parentId = id(body.parent_id);
      const back = parentId ? `${kind.base}/${parentId}` : kind.base;
      if (!name) {
        setFlash(reply, 'erreur', 'Le nom est obligatoire.');
        return redirect(req, reply, back);
      }
      if (parentId && !(await db.selectFrom(kind.table).select('id').where('id', '=', parentId).executeTakeFirst())) return reply.callNotFound();
      if (await nameTakenAmongSiblings(kind.table, parentId, name)) {
        setFlash(reply, 'erreur', `« ${name} » existe déjà à ce niveau.`);
        return redirect(req, reply, back);
      }
      const r = await db.insertInto(kind.table).values({ name, parent_id: parentId, description: optStr(body, 'description', 5000) }).executeTakeFirstOrThrow();
      const newId = Number(r.insertId);
      const tree = await loadTree(kind.table);
      await audit(req, kind.entity, newId, 'creation', `Création de ${kind.one === 'emplacement' ? "l'emplacement" : 'la catégorie'} « ${tree.byId.get(newId)?.path} »`);
      setFlash(reply, 'ok', `« ${name} » créé.`);
      return redirect(req, reply, `${kind.base}/${newId}`);
    });

    app.get(`${kind.base}/:id`, async (req, reply) => {
      const nodeId = id((req.params as Body).id);
      const tree = await loadTree(kind.table);
      const node = nodeId ? tree.byId.get(nodeId) : undefined;
      if (!node) return reply.callNotFound();
      const c = await counts(kind, tree);
      const excluded = new Set(descendantIds(tree, node.id));
      const data: Record<string, unknown> = {
        title: node.name,
        kind,
        node,
        lineage: lineage(tree, node.id),
        children: node.children,
        direct: c.direct,
        total: c.total,
        parents: tree.flat.filter((e) => !excluded.has(e.id)),
      };
      if (kind.table === 'categories') {
        const all = await effectiveDefs(tree, node.id);
        const ownIds = all.filter((d) => !d.inherited).map((d) => d.id);
        const used = ownIds.length
          ? await db.selectFrom('item_values').select(['def_id', db.fn.countAll<number>().as('n')]).where('def_id', 'in', ownIds).groupBy('def_id').execute()
          : [];
        data.inheritedDefs = all.filter((d) => d.inherited);
        data.ownDefs = all.filter((d) => !d.inherited).map((d) => ({ ...d, used: Number(used.find((u) => u.def_id === d.id)?.n ?? 0) }));
      }
      return render(req, reply, 'trees/show', data);
    });

    app.post(`${kind.base}/:id`, async (req, reply) => {
      const nodeId = id((req.params as Body).id);
      const tree = await loadTree(kind.table);
      const node = nodeId ? tree.byId.get(nodeId) : undefined;
      if (!node) return reply.callNotFound();
      const body = req.body as Body;
      const name = str(body, 'name', 120);
      const parentId = id(body.parent_id);
      const back = `${kind.base}/${node.id}`;
      if (!name) {
        setFlash(reply, 'erreur', 'Le nom est obligatoire.');
        return redirect(req, reply, back);
      }
      if (parentId && (!tree.byId.has(parentId) || descendantIds(tree, node.id).includes(parentId))) {
        setFlash(reply, 'erreur', 'Impossible de déplacer un élément dans lui-même ou dans un de ses sous-éléments.');
        return redirect(req, reply, back);
      }
      if (await nameTakenAmongSiblings(kind.table, parentId, name, node.id)) {
        setFlash(reply, 'erreur', `« ${name} » existe déjà à ce niveau.`);
        return redirect(req, reply, back);
      }
      const description = optStr(body, 'description', 5000);
      await db.updateTable(kind.table).set({ name, parent_id: parentId, description }).where('id', '=', node.id).execute();
      const after = await loadTree(kind.table);
      const changes: Record<string, { avant: unknown; apres: unknown }> = {};
      if (node.path !== after.byId.get(node.id)?.path) changes['Chemin'] = { avant: node.path, apres: after.byId.get(node.id)?.path };
      if ((node.description ?? null) !== description) changes['Description'] = { avant: node.description, apres: description };
      if (Object.keys(changes).length) await audit(req, kind.entity, node.id, 'modification', `Modification de « ${after.byId.get(node.id)?.path} »`, changes);
      setFlash(reply, 'ok', 'Modifications enregistrées.');
      return redirect(req, reply, back);
    });

    app.post(`${kind.base}/:id/supprimer`, async (req, reply) => {
      const nodeId = id((req.params as Body).id);
      const tree = await loadTree(kind.table);
      const node = nodeId ? tree.byId.get(nodeId) : undefined;
      if (!node) return reply.callNotFound();
      const used = await db.selectFrom('items').select(db.fn.countAll<number>().as('n')).where(kind.itemColumn, '=', node.id).executeTakeFirstOrThrow();
      if (node.children.length || Number(used.n) > 0) {
        setFlash(reply, 'erreur', 'Suppression impossible : cet élément contient des sous-éléments ou des objets. Déplacez-les d’abord.');
        return redirect(req, reply, `${kind.base}/${node.id}`);
      }
      await db.deleteFrom(kind.table).where('id', '=', node.id).execute();
      await audit(req, kind.entity, node.id, 'suppression', `Suppression de « ${node.path} »`);
      setFlash(reply, 'ok', `« ${node.name} » supprimé.`);
      return redirect(req, reply, node.parent_id ? `${kind.base}/${node.parent_id}` : kind.base);
    });
  }

  // ---- Définitions de caractéristiques (sur les catégories) ----
  const defBack = (catId: number) => `/categories/${catId}#caracteristiques`;

  async function readDef(req: FastifyRequest, reply: FastifyReply, catId: number, exceptId?: number) {
    const body = req.body as Body;
    const name = str(body, 'name', 120);
    const type = str(body, 'type', 20);
    const unit = optStr(body, 'unit', 32);
    const options = str(body, 'options', 10000)
      .split(/\r?\n/)
      .map((s) => s.trim().slice(0, 200))
      .filter(Boolean);
    const sort = intIn(body.sort_order, -10000, 10000, 0);
    let error: string | null = null;
    if (!name) error = 'Le nom de la caractéristique est obligatoire.';
    else if (!isAttrType(type)) error = 'Type invalide.';
    else if (type === 'select' && !options.length) error = 'Une liste de choix doit avoir au moins une option (une par ligne).';
    else {
      // Pas de doublon de nom dans la catégorie, ses ancêtres et ses descendants (héritage).
      const tree = await loadTree('categories');
      const related = [...lineage(tree, catId).map((e) => e.id), ...descendantIds(tree, catId)];
      const clash = await db
        .selectFrom('attribute_defs')
        .select(['id', 'category_id'])
        .where('category_id', 'in', related)
        .where('name', '=', name)
        .executeTakeFirst();
      if (clash && clash.id !== exceptId) error = `Une caractéristique « ${name} » existe déjà dans cette branche (${tree.byId.get(clash.category_id)?.path}).`;
    }
    return { error, name, type: type as AttrType, unit: type === 'number' ? unit : null, options: type === 'select' ? [...new Set(options)] : [], sort };
  }

  app.post('/categories/:id/caracteristiques', async (req, reply) => {
    const catId = id((req.params as Body).id);
    const cat = catId ? await db.selectFrom('categories').select(['id', 'name']).where('id', '=', catId).executeTakeFirst() : undefined;
    if (!cat) return reply.callNotFound();
    const d = await readDef(req, reply, cat.id);
    if (d.error) {
      setFlash(reply, 'erreur', d.error);
      return redirect(req, reply, defBack(cat.id));
    }
    const max = await db.selectFrom('attribute_defs').select(sql<number>`COALESCE(MAX(sort_order), -1)`.as('m')).where('category_id', '=', cat.id).executeTakeFirstOrThrow();
    const r = await db
      .insertInto('attribute_defs')
      .values({ category_id: cat.id, name: d.name, type: d.type, unit: d.unit, options: d.options.length ? JSON.stringify(d.options) : null, sort_order: Number(max.m) + 1 })
      .executeTakeFirstOrThrow();
    await audit(req, 'categorie', cat.id, 'caracteristique', `Caractéristique « ${d.name} » ajoutée à « ${cat.name} »`);
    setFlash(reply, 'ok', `Caractéristique « ${d.name} » ajoutée.`);
    void r;
    return redirect(req, reply, defBack(cat.id));
  });

  app.post('/caracteristiques/:id', async (req, reply) => {
    const defId = id((req.params as Body).id);
    const def = defId ? await db.selectFrom('attribute_defs').selectAll().where('id', '=', defId).executeTakeFirst() : undefined;
    if (!def) return reply.callNotFound();
    const d = await readDef(req, reply, def.category_id, def.id);
    if (d.error) {
      setFlash(reply, 'erreur', d.error);
      return redirect(req, reply, defBack(def.category_id));
    }
    const used = await db.selectFrom('item_values').select(db.fn.countAll<number>().as('n')).where('def_id', '=', def.id).executeTakeFirstOrThrow();
    if (Number(used.n) > 0 && d.type !== def.type) {
      setFlash(reply, 'erreur', `Le type ne peut pas changer : ${used.n} objet(s) ont déjà une valeur pour « ${def.name} ».`);
      return redirect(req, reply, defBack(def.category_id));
    }
    if (d.type === 'select' && Number(used.n) > 0) {
      const values = await db.selectFrom('item_values').select('value_text').distinct().where('def_id', '=', def.id).execute();
      const missing = values.map((v) => v.value_text).filter((v): v is string => !!v && !d.options.includes(v));
      if (missing.length) {
        setFlash(reply, 'erreur', `Options encore utilisées, impossible de les retirer : ${missing.join(', ')}.`);
        return redirect(req, reply, defBack(def.category_id));
      }
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('attribute_defs')
        .set({ name: d.name, type: d.type, unit: d.unit, options: d.options.length ? JSON.stringify(d.options) : null, sort_order: d.sort })
        .where('id', '=', def.id)
        .execute();
      // Les valeurs gardent une copie du nom et de l'unité (recherche et export).
      await trx.updateTable('item_values').set({ name: d.name, unit: d.unit }).where('def_id', '=', def.id).execute();
    });
    const changes: Record<string, { avant: unknown; apres: unknown }> = {};
    if (def.name !== d.name) changes['Nom'] = { avant: def.name, apres: d.name };
    if ((def.unit ?? null) !== d.unit) changes['Unité'] = { avant: def.unit, apres: d.unit };
    if (def.type !== d.type) changes['Type'] = { avant: def.type, apres: d.type };
    if (JSON.stringify(parseOptions(def.options)) !== JSON.stringify(d.options)) changes['Options'] = { avant: parseOptions(def.options).join(', '), apres: d.options.join(', ') };
    if (def.sort_order !== d.sort) changes['Ordre'] = { avant: def.sort_order, apres: d.sort };
    if (Object.keys(changes).length) await audit(req, 'categorie', def.category_id, 'caracteristique', `Caractéristique « ${d.name} » modifiée`, changes);
    setFlash(reply, 'ok', 'Caractéristique enregistrée.');
    return redirect(req, reply, defBack(def.category_id));
  });

  app.post('/caracteristiques/:id/supprimer', async (req, reply) => {
    const defId = id((req.params as Body).id);
    const def = defId ? await db.selectFrom('attribute_defs').selectAll().where('id', '=', defId).executeTakeFirst() : undefined;
    if (!def) return reply.callNotFound();
    // Les valeurs déjà saisies sont conservées en caractéristiques libres (clé étrangère ON DELETE SET NULL).
    await db.transaction().execute(async (trx) => {
      if (def.type === 'select') await trx.updateTable('item_values').set({ type: 'text' }).where('def_id', '=', def.id).execute();
      await trx.deleteFrom('attribute_defs').where('id', '=', def.id).execute();
    });
    await audit(req, 'categorie', def.category_id, 'caracteristique', `Caractéristique « ${def.name} » supprimée (valeurs conservées en caractéristiques libres)`);
    setFlash(reply, 'ok', `« ${def.name} » supprimée. Les valeurs déjà saisies restent sur les objets en caractéristiques libres.`);
    return redirect(req, reply, defBack(def.category_id));
  });
}
