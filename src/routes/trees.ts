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
    .where('deleted_at', 'is', null)
    .groupBy(kind.itemColumn)
    .execute();
  const direct = new Map<number, number>(rows.map((r: any) => [Number(r[kind.itemColumn]), Number(r.n)]));
  const total = new Map<number, number>();
  for (const e of tree.flat) total.set(e.id, descendantIds(tree, e.id).reduce((s, d) => s + (direct.get(d) ?? 0), 0));
  return { direct, total };
}

// Caractéristiques affichées sur la page d'une catégorie : héritées (groupées par catégorie d'origine) et propres.
async function categoryDefs(tree: Tree, catId: number) {
  const all = await effectiveDefs(tree, catId);
  const ownIds = all.filter((d) => !d.inherited).map((d) => d.id);
  const used = ownIds.length
    ? await db.selectFrom('item_values').select(['def_id', db.fn.countAll<number>().as('n')]).where('def_id', 'in', ownIds).groupBy('def_id').execute()
    : [];
  const groups: { id: number; name: string; path: string; defs: typeof all }[] = [];
  for (const d of all.filter((x) => x.inherited)) {
    let g = groups.find((x) => x.id === d.category_id);
    if (!g) groups.push((g = { id: d.category_id, name: d.ownerName, path: tree.byId.get(d.category_id)?.path ?? d.ownerName, defs: [] }));
    g.defs.push(d);
  }
  return {
    inheritedGroups: groups,
    ownDefs: all.filter((d) => !d.inherited).map((d) => ({ ...d, used: Number(used.find((u) => u.def_id === d.id)?.n ?? 0) })),
  };
}

interface DefInput {
  key: string; // d12 (existante) ou n3 (nouvelle)
  defId: number | null;
  name: string;
  type: string;
  unit: string | null;
  optionsRaw: string;
  options: string[];
  sort: number;
  optional: 0 | 1;
  error?: string;
}

function readDefFields(body: Body, key: string, defId: number | null, fallbackSort: number): DefInput {
  const type = str(body, `${key}_type`, 20);
  const optionsRaw = str(body, `${key}_options`, 10000);
  const options = [...new Set(optionsRaw.split(/\r?\n/).map((x) => x.trim().slice(0, 200)).filter(Boolean))];
  return {
    key,
    defId,
    name: str(body, `${key}_name`, 120),
    type,
    unit: type === 'number' ? optStr(body, `${key}_unit`, 32) : null,
    optionsRaw,
    options: type === 'select' ? options : [],
    sort: str(body, `${key}_sort`, 10) === '' ? fallbackSort : intIn(body[`${key}_sort`], -10000, 10000, fallbackSort),
    optional: str(body, `${key}_optional`) === '1' ? 1 : 0,
  };
}

// Enregistre toute la page d'une catégorie en une fois : nom, parent, description, caractéristiques modifiées et nouvelles.
// Rien n'est écrit si une erreur est trouvée : la page est réaffichée avec la saisie et les erreurs.
async function saveCategory(req: FastifyRequest, reply: FastifyReply, kind: Kind) {
  const nodeId = id((req.params as Body).id);
  const tree = await loadTree('categories');
  const node = nodeId ? tree.byId.get(nodeId) : undefined;
  if (!node) return reply.callNotFound();
  const body = req.body as Body;
  const name = str(body, 'name', 120);
  const parentId = id(body.parent_id);
  const description = optStr(body, 'description', 5000);
  const errors: string[] = [];

  if (!name) errors.push('Le nom de la catégorie est obligatoire.');
  if (parentId && (!tree.byId.has(parentId) || descendantIds(tree, node.id).includes(parentId))) errors.push('Impossible de déplacer une catégorie dans elle-même ou dans une de ses sous-catégories.');
  else if (name && (await nameTakenAmongSiblings('categories', parentId, name, node.id))) errors.push(`« ${name} » existe déjà à ce niveau.`);

  const current = await db.selectFrom('attribute_defs').selectAll().where('category_id', '=', node.id).execute();
  const usedRows = current.length
    ? await db.selectFrom('item_values').select(['def_id', db.fn.countAll<number>().as('n')]).where('def_id', 'in', current.map((d) => d.id)).groupBy('def_id').execute()
    : [];
  const usedOf = (defId: number) => Number(usedRows.find((u) => u.def_id === defId)?.n ?? 0);

  const edited: DefInput[] = current.filter((d) => body[`d${d.id}_name`] !== undefined).map((d) => readDefFields(body, `d${d.id}`, d.id, d.sort_order));
  let nextSort = current.reduce((m, d) => Math.max(m, d.sort_order), -1) + 1;
  const newKeys = [...new Set(Object.keys(body).map((k) => /^(n\d{1,4})_name$/.exec(k)?.[1]).filter((k): k is string => !!k))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const added: DefInput[] = [];
  for (const k of newKeys) {
    const d = readDefFields(body, k, null, nextSort);
    if (!d.name && !d.optionsRaw.trim() && !(d.unit ?? '')) continue; // ligne laissée vide : ignorée
    nextSort = Math.max(nextSort, d.sort) + 1;
    added.push(d);
  }

  // Noms déjà pris dans la branche (ancêtres de la future position et descendants), hors cette catégorie.
  const futureAncestors = parentId && tree.byId.has(parentId) ? lineage(tree, parentId).map((e) => e.id) : [];
  const related = [...futureAncestors, ...descendantIds(tree, node.id).filter((x) => x !== node.id)];
  const branchDefs = related.length ? await db.selectFrom('attribute_defs').select(['name', 'category_id']).where('category_id', 'in', related).execute() : [];
  const seen = new Map<string, string>();
  for (const d of [...edited, ...added]) {
    const label = d.name || (d.defId ? current.find((c) => c.id === d.defId)?.name : 'nouvelle ligne');
    if (!d.name) d.error = 'Nom obligatoire.';
    else if (!isAttrType(d.type)) d.error = 'Type invalide.';
    else if (d.type === 'select' && !d.options.length) d.error = 'Une liste de choix doit avoir au moins une option (une par ligne).';
    else {
      const lower = d.name.toLocaleLowerCase('fr');
      const clash = branchDefs.find((b) => b.name.toLocaleLowerCase('fr') === lower);
      if (clash) d.error = `« ${d.name} » existe déjà dans cette branche (${tree.byId.get(clash.category_id)?.path}).`;
      else if (seen.has(lower)) d.error = `« ${d.name} » apparaît deux fois sur la page.`;
      seen.set(lower, d.key);
    }
    if (!d.error && d.defId) {
      const def = current.find((c) => c.id === d.defId)!;
      const used = usedOf(def.id);
      if (used > 0 && d.type !== def.type) d.error = `Le type ne peut pas changer : ${used} objet(s) ont déjà une valeur.`;
      else if (d.type === 'select' && used > 0) {
        const values = await db.selectFrom('item_values').select('value_text').distinct().where('def_id', '=', def.id).execute();
        const missing = values.map((v) => v.value_text).filter((v): v is string => !!v && !d.options.includes(v));
        if (missing.length) d.error = `Options encore utilisées : ${missing.join(', ')}.`;
      }
    }
    if (d.error) errors.push(`${label} : ${d.error}`);
  }

  if (errors.length) {
    // Réaffichage avec la saisie : rien n'a été enregistré.
    const base = await categoryDefs(tree, node.id);
    const excluded = new Set(descendantIds(tree, node.id));
    const c = await counts(kind, tree);
    const ownDefs = base.ownDefs.map((d) => {
      const e = edited.find((x) => x.defId === d.id);
      return e ? { ...d, name: e.name, type: e.type as AttrType, unit: e.unit, sort_order: e.sort, optional: e.optional, optionList: e.type === 'select' ? e.options : e.optionsRaw ? e.optionsRaw.split(/\r?\n/) : d.optionList, error: e.error } : d;
    });
    return render(req, reply, 'trees/show', {
      title: node.name,
      kind,
      node: { ...node, name: name || node.name, parent_id: parentId, description },
      formName: name,
      lineage: lineage(tree, node.id),
      children: node.children,
      direct: c.direct,
      total: c.total,
      parents: tree.flat.filter((e) => !excluded.has(e.id)),
      inheritedGroups: base.inheritedGroups,
      ownDefs,
      newDefs: added,
      errors,
      flash: { type: 'erreur', msg: `Rien n’a été enregistré : ${errors.length} erreur(s) à corriger.` },
    }, 422);
  }

  // Écriture en une transaction, uniquement ce qui a changé.
  const changesLog: { summary: string; changes?: Record<string, { avant: unknown; apres: unknown }> }[] = [];
  await db.transaction().execute(async (trx) => {
    if (name !== node.name || (parentId ?? null) !== (node.parent_id ?? null) || (node.description ?? null) !== description) {
      await trx.updateTable('categories').set({ name, parent_id: parentId, description }).where('id', '=', node.id).execute();
    }
    for (const d of edited) {
      const def = current.find((c) => c.id === d.defId)!;
      const ch: Record<string, { avant: unknown; apres: unknown }> = {};
      if (def.name !== d.name) ch['Nom'] = { avant: def.name, apres: d.name };
      if ((def.unit ?? null) !== d.unit) ch['Unité'] = { avant: def.unit, apres: d.unit };
      if (def.type !== d.type) ch['Type'] = { avant: def.type, apres: d.type };
      if (JSON.stringify(parseOptions(def.options)) !== JSON.stringify(d.options)) ch['Options'] = { avant: parseOptions(def.options).join(', '), apres: d.options.join(', ') };
      if (def.sort_order !== d.sort) ch['Ordre'] = { avant: def.sort_order, apres: d.sort };
      if (Number(def.optional) !== d.optional) ch['Facultative'] = { avant: def.optional ? 'oui' : 'non', apres: d.optional ? 'oui' : 'non' };
      if (!Object.keys(ch).length) continue;
      await trx
        .updateTable('attribute_defs')
        .set({ name: d.name, type: d.type as AttrType, unit: d.unit, options: d.options.length ? JSON.stringify(d.options) : null, sort_order: d.sort, optional: d.optional })
        .where('id', '=', def.id)
        .execute();
      // Les valeurs gardent une copie du nom et de l'unité (recherche et export).
      if (ch['Nom'] || ch['Unité']) await trx.updateTable('item_values').set({ name: d.name, unit: d.unit }).where('def_id', '=', def.id).execute();
      changesLog.push({ summary: `Caractéristique « ${d.name} » modifiée`, changes: ch });
    }
    for (const d of added) {
      await trx
        .insertInto('attribute_defs')
        .values({ category_id: node.id, name: d.name, type: d.type as AttrType, unit: d.unit, options: d.options.length ? JSON.stringify(d.options) : null, sort_order: d.sort, optional: d.optional })
        .execute();
      changesLog.push({ summary: `Caractéristique « ${d.name} » ajoutée à « ${name} »` });
    }
  });
  const after = await loadTree('categories');
  const nodeChanges: Record<string, { avant: unknown; apres: unknown }> = {};
  if (node.path !== after.byId.get(node.id)?.path) nodeChanges['Chemin'] = { avant: node.path, apres: after.byId.get(node.id)?.path };
  if ((node.description ?? null) !== description) nodeChanges['Description'] = { avant: node.description, apres: description };
  if (Object.keys(nodeChanges).length) await audit(req, kind.entity, node.id, 'modification', `Modification de « ${after.byId.get(node.id)?.path} »`, nodeChanges);
  for (const l of changesLog) await audit(req, 'categorie', node.id, 'caracteristique', l.summary, l.changes);
  const n = changesLog.length + (Object.keys(nodeChanges).length ? 1 : 0);
  setFlash(reply, 'ok', n ? `Catégorie enregistrée (${n} modification${n > 1 ? 's' : ''}).` : 'Aucune modification à enregistrer.');
  return redirect(req, reply, `/categories/${node.id}`);
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
      if (kind.table === 'categories') Object.assign(data, await categoryDefs(tree, node.id));
      return render(req, reply, 'trees/show', data);
    });

    if (kind.table === 'categories') {
      app.post(`${kind.base}/:id`, (req, reply) => saveCategory(req, reply, kind));
    } else app.post(`${kind.base}/:id`, async (req, reply) => {
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
        setFlash(reply, 'erreur', 'Suppression impossible : cet élément contient des sous-éléments ou des objets (y compris dans la corbeille). Déplacez-les ou videz la corbeille d’abord.');
        return redirect(req, reply, `${kind.base}/${node.id}`);
      }
      await db.deleteFrom(kind.table).where('id', '=', node.id).execute();
      await audit(req, kind.entity, node.id, 'suppression', `Suppression de « ${node.path} »`);
      setFlash(reply, 'ok', `« ${node.name} » supprimé.`);
      return redirect(req, reply, node.parent_id ? `${kind.base}/${node.parent_id}` : kind.base);
    });
  }

  // ---- Suppression immédiate d'une caractéristique (bouton sur sa ligne) ----
  const defBack = (catId: number) => `/categories/${catId}#caracteristiques`;

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
