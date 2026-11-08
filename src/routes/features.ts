// Personnes et attributions, corbeille, modification en masse, recherche rapide (Ctrl+K), mode rangement (scan QR).
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { config } from '../config.js';
import { render, redirect, setFlash } from '../views.js';
import { loadTree } from '../services/tree.js';
import { audit } from '../services/audit.js';
import { Body, str, optStr, id, escapeLike } from '../services/forms.js';
import { removeStoredFiles } from './attachments.js';

const TRASH_DAYS = 30;

function parseIds(raw: unknown): number[] {
  const s = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return [...new Set(s.split(',').map((x) => id(x)).filter((x): x is number => x !== null))].slice(0, 2000);
}

// Suppression définitive (fichiers compris) des objets donnés.
export async function purgeItems(ids: number[]) {
  if (!ids.length) return 0;
  const files = await db.selectFrom('attachments').select(['stored_name', 'thumb_name']).where('item_id', 'in', ids).execute();
  await db.deleteFrom('items').where('id', 'in', ids).execute();
  await removeStoredFiles(files.flatMap((f) => [f.stored_name, ...(f.thumb_name ? [f.thumb_name] : [])]));
  return ids.length;
}

// Vidage automatique : objets dans la corbeille depuis plus de 30 jours.
export async function purgeOldTrash() {
  const old = await db.selectFrom('items').select('id').where('deleted_at', '<', new Date(Date.now() - TRASH_DAYS * 86400_000)).execute();
  const n = await purgeItems(old.map((o) => o.id));
  if (n) await db.insertInto('audit_log').values({ user_id: null, entity: 'objet', entity_id: null, action: 'purge', summary: `${n} objet(s) supprimé(s) définitivement (corbeille de plus de ${TRASH_DAYS} jours)`, changes: null, ip: null }).execute();
}

export async function featureRoutes(app: FastifyInstance) {
  // ================= Personnes =================
  app.get('/personnes', async (req, reply) => {
    const people = await db
      .selectFrom('people')
      .leftJoin('items', (j) => j.onRef('items.assigned_person_id', '=', 'people.id').on('items.deleted_at', 'is', null))
      .select(['people.id', 'people.name', 'people.notes', db.fn.count<number>('items.id').as('n')])
      .groupBy(['people.id', 'people.name', 'people.notes'])
      .orderBy('people.name')
      .execute();
    return render(req, reply, 'people/index', { title: 'Personnes', people: people.map((p) => ({ ...p, n: Number(p.n) })) });
  });

  app.post('/personnes', async (req, reply) => {
    const body = req.body as Body;
    const name = str(body, 'name', 120);
    if (!name) setFlash(reply, 'erreur', 'Le nom est obligatoire.');
    else if (await db.selectFrom('people').select('id').where('name', '=', name).executeTakeFirst()) setFlash(reply, 'erreur', `« ${name} » existe déjà.`);
    else {
      const r = await db.insertInto('people').values({ name, notes: optStr(body, 'notes', 5000) }).executeTakeFirstOrThrow();
      await audit(req, 'personne', Number(r.insertId), 'creation', `Personne « ${name} » créée`);
      setFlash(reply, 'ok', `« ${name} » ajoutée.`);
    }
    return redirect(req, reply, '/personnes');
  });

  app.get('/personnes/:id', async (req, reply) => {
    const pid = id((req.params as Body).id);
    const person = pid ? await db.selectFrom('people').selectAll().where('id', '=', pid).executeTakeFirst() : undefined;
    if (!person) return reply.callNotFound();
    const locs = await loadTree('locations');
    const items = await db
      .selectFrom('items')
      .leftJoin('statuses', 'statuses.id', 'items.status_id')
      .select(['items.id', 'items.name', 'items.brand', 'items.model', 'items.location_id', 'items.assigned_at', 'statuses.name as status_name', 'statuses.color as status_color'])
      .where('items.assigned_person_id', '=', person.id)
      .where('items.deleted_at', 'is', null)
      .orderBy('items.assigned_at', 'desc')
      .orderBy('items.name')
      .execute();
    return render(req, reply, 'people/show', {
      title: person.name,
      person,
      items: items.map((i) => ({ ...i, locationPath: i.location_id ? locs.byId.get(i.location_id)?.path : null })),
    });
  });

  app.post('/personnes/:id', async (req, reply) => {
    const pid = id((req.params as Body).id);
    const person = pid ? await db.selectFrom('people').selectAll().where('id', '=', pid).executeTakeFirst() : undefined;
    if (!person) return reply.callNotFound();
    const body = req.body as Body;
    const name = str(body, 'name', 120);
    const notes = optStr(body, 'notes', 5000);
    const clash = name ? await db.selectFrom('people').select('id').where('name', '=', name).where('id', '!=', person.id).executeTakeFirst() : undefined;
    if (!name) setFlash(reply, 'erreur', 'Le nom est obligatoire.');
    else if (clash) setFlash(reply, 'erreur', `« ${name} » existe déjà.`);
    else {
      await db.updateTable('people').set({ name, notes }).where('id', '=', person.id).execute();
      if (name !== person.name) await audit(req, 'personne', person.id, 'modification', `Personne renommée : ${person.name} → ${name}`);
      setFlash(reply, 'ok', 'Enregistré.');
    }
    return redirect(req, reply, `/personnes/${person.id}`);
  });

  app.post('/personnes/:id/supprimer', async (req, reply) => {
    const pid = id((req.params as Body).id);
    const person = pid ? await db.selectFrom('people').selectAll().where('id', '=', pid).executeTakeFirst() : undefined;
    if (!person) return reply.callNotFound();
    const items = await db.selectFrom('items').select('id').where('assigned_person_id', '=', person.id).execute();
    await db.deleteFrom('people').where('id', '=', person.id).execute(); // attributions retirées (ON DELETE SET NULL)
    for (const i of items) await audit(req, 'objet', i.id, 'attribution', `Attribution retirée (personne « ${person.name} » supprimée)`);
    await audit(req, 'personne', person.id, 'suppression', `Personne « ${person.name} » supprimée (${items.length} attribution(s) retirée(s))`);
    setFlash(reply, 'ok', `« ${person.name} » supprimée.`);
    return redirect(req, reply, '/personnes');
  });

  // ================= Corbeille =================
  app.get('/corbeille', async (req, reply) => {
    const items = await db
      .selectFrom('items')
      .select(['id', 'name', 'brand', 'model', 'deleted_at'])
      .where('deleted_at', 'is not', null)
      .orderBy('deleted_at', 'desc')
      .execute();
    return render(req, reply, 'trash', {
      title: 'Corbeille',
      items: items.map((i) => ({ ...i, purgeAt: new Date(new Date(i.deleted_at!).getTime() + TRASH_DAYS * 86400_000) })),
      days: TRASH_DAYS,
    });
  });

  app.post('/corbeille/:id/supprimer', async (req, reply) => {
    const iid = id((req.params as Body).id);
    const it = iid ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', iid).where('deleted_at', 'is not', null).executeTakeFirst() : undefined;
    if (!it) return reply.callNotFound();
    await purgeItems([it.id]);
    await audit(req, 'objet', it.id, 'suppression', `« ${it.name} » supprimé définitivement`);
    setFlash(reply, 'ok', `« ${it.name} » supprimé définitivement.`);
    return redirect(req, reply, '/corbeille');
  });

  app.post('/corbeille/vider', async (req, reply) => {
    const all = await db.selectFrom('items').select('id').where('deleted_at', 'is not', null).execute();
    const n = await purgeItems(all.map((a) => a.id));
    await audit(req, 'objet', null, 'purge', `Corbeille vidée : ${n} objet(s) supprimé(s) définitivement`);
    setFlash(reply, 'ok', `Corbeille vidée (${n} objet(s)).`);
    return redirect(req, reply, '/corbeille');
  });

  // ================= Modification en masse =================
  app.get('/objets/masse', async (req, reply) => {
    const ids = parseIds((req.query as Body).ids);
    const items = ids.length ? await db.selectFrom('items').select(['id', 'name']).where('id', 'in', ids).where('deleted_at', 'is', null).orderBy('name').execute() : [];
    if (!items.length) {
      setFlash(reply, 'erreur', 'Sélectionnez d’abord des objets dans la liste.');
      return redirect(req, reply, '/objets');
    }
    const [cats, locs, statuses, people] = await Promise.all([
      loadTree('categories'),
      loadTree('locations'),
      db.selectFrom('statuses').selectAll().orderBy('sort_order').execute(),
      db.selectFrom('people').select(['id', 'name']).orderBy('name').execute(),
    ]);
    return render(req, reply, 'items/bulk', { title: 'Modifier la sélection', items, cats: cats.flat, locs: locs.flat, statuses, people, today: new Date().toISOString().slice(0, 10) });
  });

  app.post('/objets/masse', async (req, reply) => {
    const body = req.body as Body;
    const ids = parseIds(body.ids);
    const items = ids.length ? await db.selectFrom('items').select(['id', 'name']).where('id', 'in', ids).where('deleted_at', 'is', null).execute() : [];
    if (!items.length) return redirect(req, reply, '/objets');
    const set: Record<string, unknown> = {};
    const labels: string[] = [];
    const statusV = str(body, 'status');
    if (statusV === 'none') {
      set.status_id = null;
      labels.push('statut retiré');
    } else if (id(statusV)) {
      const s = await db.selectFrom('statuses').select(['id', 'name']).where('id', '=', id(statusV)!).executeTakeFirst();
      if (s) {
        set.status_id = s.id;
        labels.push(`statut : ${s.name}`);
      }
    }
    const locV = str(body, 'location');
    if (locV === 'none') {
      set.location_id = null;
      labels.push('emplacement retiré');
    } else if (id(locV)) {
      const t = await loadTree('locations');
      const l = t.byId.get(id(locV)!);
      if (l) {
        set.location_id = l.id;
        labels.push(`emplacement : ${l.path}`);
      }
    }
    const catV = str(body, 'category');
    if (catV === 'none') {
      set.category_id = null;
      labels.push('catégorie retirée');
    } else if (id(catV)) {
      const t = await loadTree('categories');
      const c = t.byId.get(id(catV)!);
      if (c) {
        set.category_id = c.id;
        labels.push(`catégorie : ${c.path}`);
      }
    }
    const personV = str(body, 'person');
    if (personV === 'none') {
      set.assigned_person_id = null;
      set.assigned_at = null;
      labels.push('attribution retirée');
    } else if (id(personV)) {
      const p = await db.selectFrom('people').select(['id', 'name']).where('id', '=', id(personV)!).executeTakeFirst();
      if (p) {
        set.assigned_person_id = p.id;
        set.assigned_at = new Date().toISOString().slice(0, 10);
        labels.push(`attribué à : ${p.name}`);
      }
    }
    if (!labels.length) {
      setFlash(reply, 'info', 'Aucune modification choisie.');
      return redirect(req, reply, `/objets/masse?ids=${items.map((i) => i.id).join(',')}`);
    }
    await db.updateTable('items').set(set as any).where('id', 'in', items.map((i) => i.id)).execute();
    for (const i of items) await audit(req, 'objet', i.id, 'modification', `Modification en masse : ${labels.join(', ')}`);
    setFlash(reply, 'ok', `${items.length} objet(s) modifié(s) : ${labels.join(', ')}.`);
    return redirect(req, reply, '/objets');
  });

  // ================= Recherche rapide (Ctrl+K) =================
  app.get('/recherche.json', async (req, reply) => {
    const q = str(req.query as Body, 'q', 100);
    const out: { type: string; label: string; sub?: string; href: string }[] = [];
    if (q) {
      const like = `%${escapeLike(q)}%`;
      const [cats, locs] = await Promise.all([loadTree('categories'), loadTree('locations')]);
      const items = await db
        .selectFrom('items')
        .select(['id', 'name', 'brand', 'model', 'serial', 'location_id'])
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('name', 'like', like), eb('brand', 'like', like), eb('model', 'like', like), eb('serial', 'like', like)]))
        .orderBy('name')
        .limit(8)
        .execute();
      for (const i of items) out.push({ type: 'Objet', label: i.name, sub: [[i.brand, i.model].filter(Boolean).join(' '), i.location_id ? locs.byId.get(i.location_id)?.path : ''].filter(Boolean).join(' · '), href: `/objets/${i.id}` });
      const n = q.toLowerCase();
      for (const l of locs.flat.filter((e) => e.name.toLowerCase().includes(n)).slice(0, 4)) out.push({ type: 'Emplacement', label: l.name, sub: l.path, href: `/emplacements/${l.id}` });
      for (const c of cats.flat.filter((e) => e.name.toLowerCase().includes(n)).slice(0, 4)) out.push({ type: 'Catégorie', label: c.name, sub: c.path, href: `/categories/${c.id}` });
      const people = await db.selectFrom('people').select(['id', 'name']).where('name', 'like', like).orderBy('name').limit(4).execute();
      for (const p of people) out.push({ type: 'Personne', label: p.name, href: `/personnes/${p.id}` });
      const admin = req.user?.role === 'admin';
      const pages: [string, string, boolean][] = [
        ['Tableau de bord', '/', true], ['Objets', '/objets', true], ['Nouvel objet', '/objets/nouveau', admin], ['Emplacements', '/emplacements', true],
        ['Catégories', '/categories', true], ['Statuts', '/statuts', true], ['Personnes', '/personnes', true], ['Rangement (scanner)', '/rangement', admin],
        ['Import', '/import', admin], ['Export', '/export', admin], ['Historique', '/historique', true], ['Corbeille', '/corbeille', admin],
        ['Administration', '/administration', admin], ['Comptes', '/administration/comptes', admin], ['Mon compte', '/compte', true],
      ];
      for (const [label, href, ok] of pages) if (ok && label.toLowerCase().includes(n)) out.push({ type: 'Page', label, href });
    }
    return reply.header('Cache-Control', 'no-store').send({ resultats: out.slice(0, 20) });
  });

  // ================= Mode rangement (scan des étiquettes QR) =================
  app.get('/rangement', async (req, reply) => {
    const locs = await loadTree('locations');
    return render(req, reply, 'scan', { title: 'Rangement', scripts: ['vendor/jsqr.js'], publicUrl: config.publicUrl, locs: locs.flat });
  });

  // Résout le contenu d'un QR code (adresse d'une fiche ou d'un emplacement) sans rien modifier.
  app.post('/rangement/resoudre', async (req, reply) => {
    const raw = str(req.body as Body, 'code', 500);
    const m = /\/(objets|emplacements)\/(\d+)\/?$/.exec(raw.replace(/[?#].*$/, '')) ?? /^(?:#)?(\d+)$/.exec(raw);
    if (!m) return reply.code(404).send({ erreur: 'Code non reconnu (ce n’est pas une étiquette de l’inventaire).' });
    const kind = m.length === 3 ? m[1] : 'objets';
    const num = Number(m.length === 3 ? m[2] : m[1]);
    if (kind === 'emplacements') {
      const locs = await loadTree('locations');
      const l = locs.byId.get(num);
      return l ? reply.send({ type: 'emplacement', id: l.id, nom: l.name, chemin: l.path }) : reply.code(404).send({ erreur: 'Emplacement introuvable.' });
    }
    const it = await db.selectFrom('items').select(['id', 'name', 'location_id']).where('id', '=', num).where('deleted_at', 'is', null).executeTakeFirst();
    if (!it) return reply.code(404).send({ erreur: 'Objet introuvable.' });
    const locs = await loadTree('locations');
    return reply.send({ type: 'objet', id: it.id, nom: it.name, emplacement: it.location_id ? locs.byId.get(it.location_id)?.path ?? null : null });
  });

  app.post('/rangement/deplacer', async (req, reply) => {
    const body = req.body as Body;
    const itemId = id(body.item_id);
    const locId = id(body.location_id);
    const locs = await loadTree('locations');
    const loc = locId ? locs.byId.get(locId) : undefined;
    const it = itemId ? await db.selectFrom('items').select(['id', 'name', 'location_id']).where('id', '=', itemId).where('deleted_at', 'is', null).executeTakeFirst() : undefined;
    if (!it || !loc) return reply.code(404).send({ erreur: 'Objet ou emplacement introuvable.' });
    const from = it.location_id ? locs.byId.get(it.location_id)?.path ?? null : null;
    if (it.location_id === loc.id) return reply.send({ ok: true, deja: true, nom: it.name, chemin: loc.path });
    await db.updateTable('items').set({ location_id: loc.id }).where('id', '=', it.id).execute();
    await audit(req, 'objet', it.id, 'deplacement', `Rangé dans « ${loc.path} » (scan)`, { Emplacement: { avant: from, apres: loc.path } });
    return reply.send({ ok: true, nom: it.name, chemin: loc.path, avant: from });
  });
}
