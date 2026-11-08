// Tableau de bord, statuts, historique, compte, export, étiquettes QR.
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { config } from '../config.js';
import { render, redirect, setFlash } from '../views.js';
import { loadTree, descendantIds } from '../services/tree.js';
import { displayValue, parseOptions } from '../services/attributes.js';
import { audit } from '../services/audit.js';
import { Body, str, id, intIn } from '../services/forms.js';
import { parseFilters, buildItemQuery, orderItems, resolveFilters } from '../services/items.js';
import { STATUS_COLORS } from '../seed.js';
import { completenessSummary } from '../services/completeness.js';
import { verifyPassword, hashPassword, passwordProblems, decrypt } from '../security.js';
import { checkTotp, createSession } from '../auth.js';
import { newTotpSecret } from '../totp.js';

const ENTITY_LABELS: Record<string, string> = {
  objet: 'Objets',
  emplacement: 'Emplacements',
  categorie: 'Catégories',
  statut: 'Statuts',
  import: 'Imports',
  connexion: 'Connexions',
  compte: 'Compte',
};

async function qrSvg(url: string) {
  return QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

export async function miscRoutes(app: FastifyInstance) {
  // ---- Tableau de bord ----
  app.get('/', async (req, reply) => {
    const [cats, locs] = await Promise.all([loadTree('categories'), loadTree('locations')]);
    const totals = await db
      .selectFrom('items')
      .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('quantity').as('units')])
      .executeTakeFirstOrThrow();
    const total = Number(totals.n);
    const lots = await db.selectFrom('items').select(db.fn.countAll<number>().as('n')).where('quantity', '>', 1).executeTakeFirstOrThrow();
    const byStatus = (
      await db
        .selectFrom('statuses')
        .leftJoin('items', 'items.status_id', 'statuses.id')
        .select(['statuses.id', 'statuses.name', 'statuses.color', 'statuses.to_handle', db.fn.count<number>('items.id').as('n')])
        .groupBy(['statuses.id', 'statuses.name', 'statuses.color', 'statuses.to_handle', 'statuses.sort_order'])
        .orderBy('statuses.sort_order')
        .execute()
    ).map((s) => ({ ...s, n: Number(s.n) }));
    const noStatus = Number((await db.selectFrom('items').select(db.fn.countAll<number>().as('n')).where('status_id', 'is', null).executeTakeFirstOrThrow()).n);
    const locRows = await db.selectFrom('items').select(['location_id', db.fn.countAll<number>().as('n')]).groupBy('location_id').execute();
    const locCount = new Map(locRows.map((r) => [r.location_id, Number(r.n)]));
    const locTotal = (lid: number) => descendantIds(locs, lid).reduce((s, d) => s + (locCount.get(d) ?? 0), 0);
    const byLocation = locs.roots.map((r) => ({ ...r, n: locTotal(r.id) }));
    const catRows = await db.selectFrom('items').select(['category_id', db.fn.countAll<number>().as('n')]).groupBy('category_id').execute();
    const catCount = new Map(catRows.map((r) => [r.category_id, Number(r.n)]));
    const byCategory = cats.roots.map((r) => ({ ...r, n: descendantIds(cats, r.id).reduce((s, d) => s + (catCount.get(d) ?? 0), 0) }));
    const unlocated = locCount.get(null) ?? 0;
    const uncategorized = catCount.get(null) ?? 0;

    // À traiter : statuts marqués « à traiter », emplacement « À classer », fiches sans classement.
    const toHandle: { label: string; n: number; href: string; color?: string }[] = [];
    for (const s of byStatus.filter((x) => x.to_handle)) toHandle.push({ label: s.name, n: s.n, href: `/objets?status=${s.id}`, color: s.color });
    const aClasser = locs.flat.find((l) => l.depth === 0 && l.name === 'À classer');
    if (aClasser) toHandle.push({ label: 'Dans « À classer »', n: locTotal(aClasser.id), href: `/objets?loc=${aClasser.id}` });
    toHandle.push({ label: 'Sans emplacement', n: unlocated, href: '/objets?loc=none' });
    toHandle.push({ label: 'Sans catégorie', n: uncategorized, href: '/objets?cat=none' });
    toHandle.push({ label: 'Sans statut', n: noStatus, href: '/objets?status=none' });

    const comp = await completenessSummary(cats);
    const incomplete = [
      { label: 'Sans photo', n: comp.photo.length, href: '/objets?manque=photo' },
      { label: 'Sans n° de série', n: comp.serial.length, href: '/objets?manque=serie' },
      { label: 'Caractéristiques manquantes', n: comp.attrs.length, href: '/objets?manque=carac' },
    ];
    const neverPrinted = Number((await db.selectFrom('items').select(db.fn.countAll<number>().as('n')).where('label_printed_at', 'is', null).executeTakeFirstOrThrow()).n);

    const recent = await db
      .selectFrom('items')
      .leftJoin('statuses', 'statuses.id', 'items.status_id')
      .select(['items.id', 'items.name', 'items.brand', 'items.model', 'items.quantity', 'items.location_id', 'items.updated_at', 'statuses.name as status_name', 'statuses.color as status_color'])
      .orderBy('items.updated_at', 'desc')
      .orderBy('items.id', 'desc')
      .limit(10)
      .execute();
    return render(req, reply, 'dashboard', {
      title: 'Tableau de bord',
      total,
      units: Number(totals.units ?? 0),
      lots: Number(lots.n),
      byStatus,
      noStatus,
      byLocation,
      unlocated,
      byCategory: byCategory.filter((c) => c.n > 0),
      uncategorized,
      toHandle: toHandle.filter((t) => t.n > 0),
      incomplete,
      neverPrinted,
      recent: recent.map((r) => ({ ...r, locationPath: r.location_id ? locs.byId.get(r.location_id)?.path : null })),
    });
  });

  // ---- Statuts ----
  app.get('/statuts', async (req, reply) => {
    const rows = await db
      .selectFrom('statuses')
      .leftJoin('items', 'items.status_id', 'statuses.id')
      .select(['statuses.id', 'statuses.name', 'statuses.color', 'statuses.sort_order', 'statuses.to_handle', db.fn.count<number>('items.id').as('n')])
      .groupBy(['statuses.id', 'statuses.name', 'statuses.color', 'statuses.sort_order', 'statuses.to_handle'])
      .orderBy('statuses.sort_order')
      .orderBy('statuses.name')
      .execute();
    return render(req, reply, 'statuses', { title: 'Statuts', statuses: rows.map((r) => ({ ...r, n: Number(r.n) })), colors: STATUS_COLORS });
  });

  const readStatus = (body: Body) => ({
    name: str(body, 'name', 60),
    color: (STATUS_COLORS as readonly string[]).includes(str(body, 'color')) ? str(body, 'color') : 'gris',
    sort_order: intIn(body.sort_order, -10000, 10000, 0),
    to_handle: str(body, 'to_handle') === '1' ? 1 : 0,
  });
  const nameClash = async (name: string, except?: number) => {
    const r = await db.selectFrom('statuses').select('id').where('name', '=', name).executeTakeFirst();
    return !!r && r.id !== except;
  };

  app.post('/statuts', async (req, reply) => {
    const s = readStatus(req.body as Body);
    if (!s.name) setFlash(reply, 'erreur', 'Le nom est obligatoire.');
    else if (await nameClash(s.name)) setFlash(reply, 'erreur', `Le statut « ${s.name} » existe déjà.`);
    else {
      const r = await db.insertInto('statuses').values(s).executeTakeFirstOrThrow();
      await audit(req, 'statut', Number(r.insertId), 'creation', `Statut « ${s.name} » créé`);
      setFlash(reply, 'ok', 'Statut créé.');
    }
    return redirect(req, reply, '/statuts');
  });

  app.post('/statuts/:id', async (req, reply) => {
    const sid = id((req.params as Body).id);
    const cur = sid ? await db.selectFrom('statuses').selectAll().where('id', '=', sid).executeTakeFirst() : undefined;
    if (!cur) return reply.callNotFound();
    const s = readStatus(req.body as Body);
    if (!s.name) setFlash(reply, 'erreur', 'Le nom est obligatoire.');
    else if (await nameClash(s.name, cur.id)) setFlash(reply, 'erreur', `Le statut « ${s.name} » existe déjà.`);
    else {
      await db.updateTable('statuses').set(s).where('id', '=', cur.id).execute();
      const changes: Record<string, { avant: unknown; apres: unknown }> = {};
      if (cur.name !== s.name) changes['Nom'] = { avant: cur.name, apres: s.name };
      if (cur.color !== s.color) changes['Couleur'] = { avant: cur.color, apres: s.color };
      if (cur.sort_order !== s.sort_order) changes['Ordre'] = { avant: cur.sort_order, apres: s.sort_order };
      if (Number(cur.to_handle) !== s.to_handle) changes['À traiter'] = { avant: cur.to_handle ? 'oui' : 'non', apres: s.to_handle ? 'oui' : 'non' };
      if (Object.keys(changes).length) await audit(req, 'statut', cur.id, 'modification', `Statut « ${s.name} » modifié`, changes);
      setFlash(reply, 'ok', 'Statut enregistré.');
    }
    return redirect(req, reply, '/statuts');
  });

  app.post('/statuts/:id/supprimer', async (req, reply) => {
    const sid = id((req.params as Body).id);
    const cur = sid ? await db.selectFrom('statuses').selectAll().where('id', '=', sid).executeTakeFirst() : undefined;
    if (!cur) return reply.callNotFound();
    const used = await db.selectFrom('items').select(db.fn.countAll<number>().as('n')).where('status_id', '=', cur.id).executeTakeFirstOrThrow();
    await db.deleteFrom('statuses').where('id', '=', cur.id).execute();
    await audit(req, 'statut', cur.id, 'suppression', `Statut « ${cur.name} » supprimé (${used.n} objet(s) passés sans statut)`);
    setFlash(reply, 'ok', `Statut « ${cur.name} » supprimé.`);
    return redirect(req, reply, '/statuts');
  });

  // ---- Historique global ----
  app.get('/historique', async (req, reply) => {
    const q = req.query as Body;
    const entity = str(q, 'type', 32);
    const page = intIn(q.page, 1, 100000, 1);
    const size = 100;
    let qb = db.selectFrom('audit_log').leftJoin('users', 'users.id', 'audit_log.user_id');
    if (entity && entity in ENTITY_LABELS) qb = qb.where('audit_log.entity', '=', entity);
    const total = Number((await qb.select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await qb
      .select(['audit_log.id', 'audit_log.entity', 'audit_log.entity_id', 'audit_log.action', 'audit_log.summary', 'audit_log.changes', 'audit_log.ip', 'audit_log.created_at', 'users.username'])
      .orderBy('audit_log.id', 'desc')
      .limit(size)
      .offset((page - 1) * size)
      .execute();
    return render(req, reply, 'history', {
      title: 'Historique',
      rows: rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null })),
      entity,
      entities: ENTITY_LABELS,
      page,
      pages: Math.max(1, Math.ceil(total / size)),
    });
  });

  // ---- Compte ----
  app.get('/compte', async (req, reply) => {
    const user = await db.selectFrom('users').select(['id', 'username', 'oidc_sub', 'password_changed_at', 'created_at']).where('id', '=', req.user!.id).executeTakeFirstOrThrow();
    const sessions = await db
      .selectFrom('sessions')
      .select(['id', 'created_at', 'last_seen_at', 'ip', 'user_agent', 'expires_at'])
      .where('user_id', '=', user.id)
      .where('state', '=', 'active')
      .where('expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc')
      .execute();
    return render(req, reply, 'account', { title: 'Mon compte', account: user, sessions, currentSession: req.session!.id, minLength: config.passwordMinLength });
  });

  app.post('/compte/mot-de-passe', async (req, reply) => {
    const body = req.body as Body;
    const user = await db.selectFrom('users').selectAll().where('id', '=', req.user!.id).executeTakeFirstOrThrow();
    const current = str(body, 'current', 300);
    const next = String(body.new ?? '').slice(0, 300);
    const confirm = String(body.confirm ?? '').slice(0, 300);
    const code = str(body, 'code', 10);
    if (!(await verifyPassword(user.password_hash, current))) setFlash(reply, 'erreur', 'Mot de passe actuel incorrect.');
    else if (next !== confirm) setFlash(reply, 'erreur', 'Les deux nouveaux mots de passe ne correspondent pas.');
    else if (passwordProblems(next, user.username)) setFlash(reply, 'erreur', passwordProblems(next, user.username)!);
    else {
      const step = user.totp_secret_enc ? checkTotp(decrypt(user.totp_secret_enc), code, user.totp_last_step) : null;
      if (step === null) setFlash(reply, 'erreur', 'Code TOTP invalide.');
      else {
        await db.updateTable('users').set({ password_hash: await hashPassword(next), password_changed_at: new Date(), totp_last_step: step }).where('id', '=', user.id).execute();
        // Déconnecte les autres sessions.
        await db.deleteFrom('sessions').where('user_id', '=', user.id).where('id', '!=', req.session!.id).execute();
        await audit(req, 'compte', user.id, 'mot-de-passe', 'Mot de passe modifié (autres sessions fermées)');
        setFlash(reply, 'ok', 'Mot de passe modifié. Vos autres sessions ont été fermées.');
      }
    }
    return redirect(req, reply, '/compte');
  });

  app.post('/compte/totp', async (req, reply) => {
    const body = req.body as Body;
    const user = await db.selectFrom('users').selectAll().where('id', '=', req.user!.id).executeTakeFirstOrThrow();
    const step = user.totp_secret_enc ? checkTotp(decrypt(user.totp_secret_enc), str(body, 'code', 10), user.totp_last_step) : null;
    if (!(await verifyPassword(user.password_hash, str(body, 'current', 300))) || step === null) {
      setFlash(reply, 'erreur', 'Mot de passe ou code TOTP incorrect.');
      return redirect(req, reply, '/compte');
    }
    await db.updateTable('users').set({ totp_last_step: step }).where('id', '=', user.id).execute();
    await db.deleteFrom('sessions').where('user_id', '=', user.id).where('id', '!=', req.session!.id).execute();
    await audit(req, 'compte', user.id, 'totp', 'Réinitialisation du TOTP demandée');
    // Nouvelle session limitée à l'enrôlement : l'ancien secret reste valable tant que le nouveau n'est pas confirmé.
    await createSession(req, reply, user.id, 'pending_enroll', newTotpSecret());
    return redirect(req, reply, '/login/enroll');
  });

  app.post('/compte/sessions/:sid/fermer', async (req, reply) => {
    const sid = String((req.params as Body).sid ?? '');
    if (/^[0-9a-f]{64}$/.test(sid)) {
      await db.deleteFrom('sessions').where('id', '=', sid).where('user_id', '=', req.user!.id).execute();
      await audit(req, 'compte', req.user!.id, 'session', 'Session fermée à distance');
    }
    setFlash(reply, 'ok', 'Session fermée.');
    return redirect(req, reply, sid === req.session!.id ? '/login' : '/compte');
  });

  app.post('/compte/oidc/dissocier', async (req, reply) => {
    await db.updateTable('users').set({ oidc_sub: null }).where('id', '=', req.user!.id).execute();
    await audit(req, 'compte', req.user!.id, 'oidc', 'Compte SSO dissocié');
    setFlash(reply, 'ok', 'Compte SSO dissocié.');
    return redirect(req, reply, '/compte');
  });

  // ---- Export ----
  app.get('/export', async (req, reply) => render(req, reply, 'export', { title: 'Export' }));

  async function exportRows(query: Record<string, unknown>) {
    const f = parseFilters(query);
    const [cats, locs] = await Promise.all([loadTree('categories'), loadTree('locations')]);
    await resolveFilters(f, cats);
    const items = await orderItems(buildItemQuery(f, cats, locs), f, cats, locs).execute();
    const ids = items.map((i: any) => i.id);
    const values = ids.length ? await db.selectFrom('item_values').selectAll().where('item_id', 'in', ids).orderBy('sort_order').execute() : [];
    return { items, values, cats, locs };
  }

  app.get('/export/objets.csv', async (req, reply) => {
    const { items, values, cats, locs } = await exportRows(req.query as Record<string, unknown>);
    const names: string[] = [];
    for (const v of values) if (!names.includes(v.name)) names.push(v.name);
    const byItem = new Map<number, Map<string, string>>();
    for (const v of values) {
      if (!byItem.has(v.item_id)) byItem.set(v.item_id, new Map());
      // Valeurs exportées en brut (nombres sans unité) pour être réimportables.
      const raw = v.type === 'number' ? (v.value_number === null ? '' : String(Number(v.value_number)).replace('.', ',')) : v.type === 'boolean' ? (v.value_bool === null ? '' : v.value_bool ? 'Oui' : 'Non') : v.type === 'date' ? (v.value_date ?? '') : (v.value_text ?? '');
      byItem.get(v.item_id)!.set(v.name, raw);
    }
    const unitOf = new Map(values.filter((v) => v.unit).map((v) => [v.name, v.unit]));
    const head = ['ID', 'Nom', 'Marque', 'Modèle', 'N° de série', 'Quantité', 'Statut', 'Catégorie', 'Emplacement', 'Notes', ...names.map((n) => (unitOf.get(n) ? `${n} (${unitOf.get(n)})` : n))];
    // Neutralise les formules (injection CSV) et protège les séparateurs.
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.map(cell).join(';')];
    for (const i of items as any[]) {
      const m = byItem.get(i.id) ?? new Map();
      lines.push(
        [i.id, i.name, i.brand, i.model, i.serial, i.quantity, i.status_name, i.category_id ? cats.byId.get(i.category_id)?.path : '', i.location_id ? locs.byId.get(i.location_id)?.path : '', i.notes, ...names.map((n) => m.get(n) ?? '')]
          .map(cell)
          .join(';'),
      );
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="inventaire-${stamp}.csv"`)
      .send('﻿' + lines.join('\r\n') + '\r\n');
  });

  app.get('/export/inventaire.json', async (req, reply) => {
    const [items, values, locations, categories, defs, statuses, links, maintenance, attachments] = await Promise.all([
      db.selectFrom('items').selectAll().orderBy('id').execute(),
      db.selectFrom('item_values').selectAll().orderBy('id').execute(),
      db.selectFrom('locations').selectAll().orderBy('id').execute(),
      db.selectFrom('categories').selectAll().orderBy('id').execute(),
      db.selectFrom('attribute_defs').selectAll().orderBy('id').execute(),
      db.selectFrom('statuses').selectAll().orderBy('id').execute(),
      db.selectFrom('item_links').selectAll().orderBy('id').execute(),
      db.selectFrom('maintenance').selectAll().orderBy('id').execute(),
      db.selectFrom('attachments').select(['id', 'item_id', 'kind', 'original_name', 'mime', 'size', 'sha256', 'created_at']).orderBy('id').execute(),
    ]);
    const data = {
      format: 'inventaire-export',
      version: 1,
      exporte_le: new Date().toISOString(),
      statuts: statuses,
      emplacements: locations,
      categories: categories.map((c) => ({ ...c, caracteristiques: defs.filter((d) => d.category_id === c.id).map((d) => ({ ...d, options: parseOptions(d.options) })) })),
      objets: items.map((i) => ({
        ...i,
        caracteristiques: values.filter((v) => v.item_id === i.id).map((v) => ({ nom: v.name, type: v.type, unite: v.unit, valeur: displayValue(v), def_id: v.def_id })),
        fichiers: attachments.filter((a) => a.item_id === i.id),
        entretien: maintenance.filter((m) => m.item_id === i.id),
      })),
      liens: links,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="inventaire-${stamp}.json"`)
      .send(JSON.stringify(data, null, 2));
  });

  // ---- Étiquettes QR ----
  app.get('/etiquettes', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const f = parseFilters(q);
    const [cats, locs] = await Promise.all([loadTree('categories'), loadTree('locations')]);
    await resolveFilters(f, cats);
    const items = (await orderItems(buildItemQuery(f, cats, locs), f, cats, locs).limit(500).execute()) as any[];
    const labels: { title: string; sub: string; code: string; svg: string }[] = [];
    for (const i of items) {
      labels.push({ title: i.name, sub: [i.brand, i.model].filter(Boolean).join(' '), code: `#${i.id}`, svg: await qrSvg(`${config.publicUrl}/objets/${i.id}`) });
    }
    const back = f.etiquette === 'jamais' && !f.ids.length ? '/' : '/objets';
    return render(req, reply, 'labels', { title: 'Étiquettes', labels, itemIds: items.map((i) => i.id), back, truncated: items.length === 500 });
  });

  app.get('/objets/:id/etiquette', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const i = itemId ? await db.selectFrom('items').select(['id', 'name', 'brand', 'model']).where('id', '=', itemId).executeTakeFirst() : undefined;
    if (!i) return reply.callNotFound();
    const labels = [{ title: i.name, sub: [i.brand, i.model].filter(Boolean).join(' '), code: `#${i.id}`, svg: await qrSvg(`${config.publicUrl}/objets/${i.id}`) }];
    return render(req, reply, 'labels', { title: `Étiquette ${i.name}`, labels, itemIds: [i.id], back: `/objets/${i.id}`, truncated: false });
  });

  app.get('/emplacements/:id/etiquette', async (req, reply) => {
    const lid = id((req.params as Body).id);
    const locs = await loadTree('locations');
    const l = lid ? locs.byId.get(lid) : undefined;
    if (!l) return reply.callNotFound();
    const labels = [{ title: l.name, sub: l.path, code: `E${l.id}`, svg: await qrSvg(`${config.publicUrl}/emplacements/${l.id}`) }];
    return render(req, reply, 'labels', { title: `Étiquette ${l.name}`, labels, itemIds: [], back: `/emplacements/${l.id}`, truncated: false });
  });

  // Marque des étiquettes comme imprimées (appelé par le bouton « Imprimer »).
  app.post('/etiquettes/imprimees', async (req, reply) => {
    const raw = String(((req.body ?? {}) as Body).ids ?? '');
    const ids = [...new Set(raw.split(',').map((x) => id(x)).filter((x): x is number => x !== null))].slice(0, 2000);
    if (ids.length) {
      await db.updateTable('items').set({ label_printed_at: new Date() }).where('id', 'in', ids).execute();
      await audit(req, 'objet', null, 'etiquettes', `${ids.length} étiquette(s) imprimée(s)`);
    }
    return reply.code(204).send();
  });
}
