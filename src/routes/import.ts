// Import Excel / CSV en trois étapes : envoi du fichier, correspondance des colonnes, aperçu modifiable puis import.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, AttrType } from '../db.js';
import { render, redirect, setFlash } from '../views.js';
import { randomToken } from '../security.js';
import { loadTree, Tree } from '../services/tree.js';
import { effectiveDefs, parseValue, ValueInput, replaceItemValues, EffectiveDef } from '../services/attributes.js';
import { audit } from '../services/audit.js';
import { Body, str, id } from '../services/forms.js';
import { readWorkbook, detectLayout, zipInfo } from '../importer/read.js';
import { checkMultipartCsrf } from '../auth.js';
import { Batch, BuildCtx, buildRows, initialConfig, refreshConfig, samples, recordCount, TARGETS, VALUE_MAP_TARGETS, PreviewRow } from '../importer/transform.js';

const DEFAULT_REPLACEMENTS = '';

async function context(): Promise<BuildCtx & { defCache: Map<number | null, EffectiveDef[]> }> {
  const [cats, locs, statuses] = await Promise.all([
    loadTree('categories'),
    loadTree('locations'),
    db.selectFrom('statuses').selectAll().orderBy('sort_order').orderBy('name').execute(),
  ]);
  // Précharge les définitions effectives de chaque catégorie (accès synchrone pendant la construction).
  const defCache = new Map<number | null, EffectiveDef[]>([[null, []]]);
  for (const c of cats.flat) defCache.set(c.id, await effectiveDefs(cats, c.id));
  return { cats, locs, statuses, defsFor: (cid) => defCache.get(cid ?? null) ?? [], defCache };
}

async function loadBatch(req: FastifyRequest): Promise<{ id: string; batch: Batch } | null> {
  const bid = String((req.params as Body).id ?? '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(bid)) return null;
  const row = await db.selectFrom('import_batches').selectAll().where('id', '=', bid).where('user_id', '=', req.user!.id).executeTakeFirst();
  return row ? { id: row.id, batch: JSON.parse(row.payload) } : null;
}
async function saveBatch(bid: string, batch: Batch) {
  await db.updateTable('import_batches').set({ payload: JSON.stringify(batch) }).where('id', '=', bid).execute();
}

function statusOptions(ctx: BuildCtx, rows: PreviewRow[]) {
  const news = [...new Set(rows.map((r) => r.statusKey).filter((k) => k.startsWith('new:')))].map((k) => ({ key: k, label: `${k.slice(4)} (nouveau)` }));
  return [...ctx.statuses.map((s) => ({ key: `id:${s.id}`, label: s.name })), ...news];
}

async function renderPreview(req: FastifyRequest, reply: FastifyReply, bid: string, batch: Batch, errors: Record<number, string[]> = {}, status = 200) {
  const ctx = await context();
  const rows = batch.rows ?? [];
  return render(
    req,
    reply,
    'import/preview',
    {
      title: 'Import : aperçu',
      bid,
      rows,
      errors,
      cats: ctx.cats.flat,
      locs: ctx.locs.flat,
      statusOpts: statusOptions(ctx, rows),
      included: rows.filter((r) => r.include).length,
      warned: rows.filter((r) => r.warnings.length).length,
    },
    status,
  );
}

function applyPreviewEdits(batch: Batch, body: Body) {
  (batch.rows ?? []).forEach((r, i) => {
    const p = `r${i}_`;
    if (!(`${p}name` in body)) return;
    r.include = str(body, `${p}inc`) === '1';
    r.name = str(body, `${p}name`, 200);
    r.brand = str(body, `${p}brand`, 120);
    r.model = str(body, `${p}model`, 200);
    r.serial = str(body, `${p}serial`, 120);
    r.quantity = str(body, `${p}qty`, 10) || '1';
    r.categoryId = id(body[`${p}cat`]);
    r.locationId = id(body[`${p}loc`]);
    const sk = str(body, `${p}status`, 80);
    r.statusKey = /^(id:\d+|new:.+)?$/.test(sk) ? sk : '';
    r.notes = str(body, `${p}notes`, 20000);
    r.values.forEach((v, j) => {
      if (`${p}v${j}` in body) v.raw = str(body, `${p}v${j}`, 5000);
    });
  });
}

export async function importRoutes(app: FastifyInstance) {
  app.get('/import', async (req, reply) => render(req, reply, 'import/upload', { title: 'Import' }));

  // Étape 1 : envoi du fichier
  app.post('/import', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send('Formulaire invalide');
    let file: { name: string; buf: Buffer } | null = null;
    let csrfOk = false;
    try {
      for await (const part of req.parts()) {
        // Jeton CSRF en premier champ, vérifié avant de lire le fichier.
        if (!csrfOk) {
          if (part.type === 'field' && part.fieldname === '_csrf' && checkMultipartCsrf(req, part.value)) {
            csrfOk = true;
            continue;
          }
          return reply.code(403).type('text/plain; charset=utf-8').send('Jeton de sécurité invalide ou expiré. Rechargez la page et recommencez.');
        }
        if (part.type === 'file' && part.fieldname === 'file' && part.filename) file = { name: part.filename.slice(0, 200), buf: await part.toBuffer() };
        else if (part.type === 'file') await part.toBuffer();
      }
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE') {
        setFlash(reply, 'erreur', 'Fichier trop volumineux.');
        return redirect(req, reply, '/import');
      }
      throw e;
    }
    if (!file || !file.buf.length) {
      setFlash(reply, 'erreur', 'Choisissez un fichier .xlsx ou .csv.');
      return redirect(req, reply, '/import');
    }
    const lower = file.name.toLowerCase();
    const isXlsx = lower.endsWith('.xlsx') && file.buf.subarray(0, 2).toString('latin1') === 'PK';
    const isCsv = (lower.endsWith('.csv') || lower.endsWith('.txt')) && !file.buf.subarray(0, 1024).includes(0);
    if (!isXlsx && !isCsv) {
      setFlash(reply, 'erreur', 'Format non pris en charge : utilisez un classeur Excel .xlsx ou un fichier .csv.');
      return redirect(req, reply, '/import');
    }
    // Protection contre les « bombes de décompression » : taille décompressée annoncée vérifiée avant toute lecture.
    if (isXlsx) {
      const z = zipInfo(file.buf);
      if (!z.ok) {
        setFlash(reply, 'erreur', z.error);
        return redirect(req, reply, '/import');
      }
    }
    let sheets;
    try {
      sheets = await readWorkbook(file.buf, file.name);
    } catch (e) {
      req.log.warn(e, 'lecture du fichier importé impossible');
      setFlash(reply, 'erreur', 'Impossible de lire ce fichier.');
      return redirect(req, reply, '/import');
    }
    sheets = sheets.filter((s) => s.grid.some((r) => r.some((c) => c !== null)));
    if (!sheets.length) {
      setFlash(reply, 'erreur', 'Le fichier ne contient aucune donnée.');
      return redirect(req, reply, '/import');
    }
    const ctx = await context();
    const batch: Batch = {
      filename: file.name,
      sheets,
      configs: sheets.map((s) => initialConfig(s, detectLayout(s.grid), ctx)),
      replacements: DEFAULT_REPLACEMENTS,
    };
    // Feuilles sans aucun enregistrement exploitable : décochées.
    batch.configs.forEach((c, i) => {
      if (recordCount(sheets[i], c) === 0) c.include = false;
    });
    const bid = randomToken(24);
    await db.insertInto('import_batches').values({ id: bid, user_id: req.user!.id, payload: JSON.stringify(batch), created_at: new Date() }).execute();
    return redirect(req, reply, `/import/${bid}`);
  });

  // Étape 2 : correspondances
  app.get('/import/:id', async (req, reply) => {
    const b = await loadBatch(req);
    if (!b) return reply.callNotFound();
    const ctx = await context();
    const sheets = b.batch.sheets.map((s, i) => {
      const cfg = b.batch.configs[i];
      const defs = ctx.defsFor(cfg.categoryId);
      return { sheet: s, cfg, samples: samples(s, cfg), count: recordCount(s, cfg), defs, i };
    });
    return render(req, reply, 'import/mapping', {
      title: 'Import : correspondances',
      bid: b.id,
      filename: b.batch.filename,
      sheets,
      replacements: b.batch.replacements,
      targets: TARGETS,
      valueMapTargets: VALUE_MAP_TARGETS,
      cats: ctx.cats.flat,
      locs: ctx.locs.flat,
      statuses: ctx.statuses,
    });
  });

  app.post('/import/:id', async (req, reply) => {
    const b = await loadBatch(req);
    if (!b) return reply.callNotFound();
    const body = req.body as Body;
    const ctx = await context();
    const validTarget = (t: string) => TARGETS.some((x) => x.value === t) || t.startsWith('attr:');
    b.batch.replacements = str(body, 'replacements', 5000);
    b.batch.configs.forEach((cfg, si) => {
      const p = `s${si}_`;
      cfg.include = str(body, `${p}include`) === '1';
      const layout = str(body, `${p}layout`) === 'columns' ? 'columns' : 'rows';
      const header = str(body, `${p}header`) === '1';
      const layoutChanged = layout !== cfg.layout || header !== cfg.header;
      cfg.layout = layout;
      cfg.header = header;
      const cat = id(body[`${p}cat`]);
      cfg.categoryId = cat && ctx.cats.byId.has(cat) ? cat : null;
      const loc = id(body[`${p}loc`]);
      cfg.locationId = loc && ctx.locs.byId.has(loc) ? loc : null;
      const st = str(body, `${p}status`);
      cfg.statusKey = /^id:\d+$/.test(st) && ctx.statuses.some((s) => `id:${s.id}` === st) ? st : '';
      cfg.forcedBrand = str(body, `${p}brand`, 120);
      if (!layoutChanged) {
        cfg.columns.forEach((col, ci) => {
          const t = str(body, `${p}col${ci}`, 200);
          if (t && validTarget(t)) col.target = t;
          const map = cfg.valueMaps[col.source];
          if (map) {
            Object.keys(map).forEach((v, vi) => {
              const k = str(body, `${p}map${ci}_${vi}`, 40);
              if (/^(id:\d+|new)?$/.test(k)) map[v] = k;
            });
          }
        });
      }
      refreshConfig(b.batch.sheets[si], cfg, ctx, layoutChanged);
    });
    const action = str(body, 'action');
    if (action === 'preview') {
      if (!b.batch.configs.some((c) => c.include)) {
        await saveBatch(b.id, b.batch);
        setFlash(reply, 'erreur', 'Cochez au moins une feuille à importer.');
        return redirect(req, reply, `/import/${b.id}`);
      }
      b.batch.rows = buildRows(b.batch, ctx);
      await saveBatch(b.id, b.batch);
      return redirect(req, reply, `/import/${b.id}/apercu`);
    }
    await saveBatch(b.id, b.batch);
    return redirect(req, reply, `/import/${b.id}#s${str(body, 'anchor', 5)}`);
  });

  // Étape 3 : aperçu modifiable
  app.get('/import/:id/apercu', async (req, reply) => {
    const b = await loadBatch(req);
    if (!b || !b.batch.rows) return reply.callNotFound();
    return renderPreview(req, reply, b.id, b.batch);
  });

  app.post('/import/:id/apercu', async (req, reply) => {
    const b = await loadBatch(req);
    if (!b || !b.batch.rows) return reply.callNotFound();
    const body = req.body as Body;
    applyPreviewEdits(b.batch, body);
    await saveBatch(b.id, b.batch);
    if (str(body, 'action') === 'back') return redirect(req, reply, `/import/${b.id}`);
    if (str(body, 'action') !== 'confirm') return redirect(req, reply, `/import/${b.id}/apercu`);

    const ctx = await context();
    const statusIds = new Set(ctx.statuses.map((s) => s.id));
    const errors: Record<number, string[]> = {};
    const prepared: { row: PreviewRow; qty: number; values: ValueInput[] }[] = [];
    b.batch.rows.forEach((row, i) => {
      if (!row.include) return;
      const errs: string[] = [];
      if (!row.name) errs.push('nom manquant');
      const qty = Number(row.quantity);
      if (!Number.isInteger(qty) || qty < 1) errs.push('quantité invalide');
      if (row.categoryId && !ctx.cats.byId.has(row.categoryId)) errs.push('catégorie inconnue');
      if (row.locationId && !ctx.locs.byId.has(row.locationId)) errs.push('emplacement inconnu');
      if (row.statusKey.startsWith('id:') && !statusIds.has(Number(row.statusKey.slice(3)))) errs.push('statut inconnu');
      const defs = ctx.defsFor(row.categoryId);
      const values: ValueInput[] = [];
      const seen = new Set<string>();
      row.values.forEach((v, j) => {
        const def = defs.find((d) => d.name.toLowerCase() === v.name.toLowerCase());
        const type: AttrType = def ? def.type : v.type === 'select' ? 'text' : v.type;
        const p = parseValue(type, v.raw, def?.optionList ?? []);
        if (!p.ok) errs.push(`${v.name} : ${p.error}`);
        else if (p.v && !seen.has(v.name.toLowerCase())) {
          seen.add(v.name.toLowerCase());
          values.push({ defId: def?.id ?? null, name: def?.name ?? v.name, type, unit: def ? def.unit : v.unit, parsed: p.v, sort: j });
        }
      });
      if (errs.length) errors[i] = errs;
      else prepared.push({ row, qty, values });
    });
    if (Object.keys(errors).length) return renderPreview(req, reply, b.id, b.batch, errors, 422);
    if (!prepared.length) {
      setFlash(reply, 'erreur', 'Aucune ligne cochée.');
      return redirect(req, reply, `/import/${b.id}/apercu`);
    }

    const created = await db.transaction().execute(async (trx) => {
      const newStatus = new Map<string, number>();
      for (const key of new Set(prepared.map((p) => p.row.statusKey).filter((k) => k.startsWith('new:')))) {
        const name = key.slice(4).trim().slice(0, 60);
        const existing = await trx.selectFrom('statuses').select('id').where('name', '=', name).executeTakeFirst();
        if (existing) newStatus.set(key, existing.id);
        else {
          const r = await trx.insertInto('statuses').values({ name, color: 'gris', sort_order: 100 }).executeTakeFirstOrThrow();
          newStatus.set(key, Number(r.insertId));
          await audit(req, 'statut', Number(r.insertId), 'creation', `Statut « ${name} » créé par l'import`, undefined, trx);
        }
      }
      let n = 0;
      for (const p of prepared) {
        const r = p.row;
        const statusId = r.statusKey.startsWith('id:') ? Number(r.statusKey.slice(3)) : r.statusKey.startsWith('new:') ? newStatus.get(r.statusKey)! : null;
        const ins = await trx
          .insertInto('items')
          .values({
            name: r.name,
            brand: r.brand || null,
            model: r.model || null,
            serial: r.serial || null,
            quantity: p.qty,
            category_id: r.categoryId,
            location_id: r.locationId,
            status_id: statusId,
            notes: r.notes || null,
          })
          .executeTakeFirstOrThrow();
        const itemId = Number(ins.insertId);
        await replaceItemValues(trx, itemId, p.values);
        await audit(req, 'objet', itemId, 'creation', `Création de « ${r.name} » (import ${b.batch.filename}, feuille ${r.sheet})`, undefined, trx);
        n++;
      }
      await audit(req, 'import', null, 'import', `Import de ${n} objet(s) depuis ${b.batch.filename}`, undefined, trx);
      await trx.deleteFrom('import_batches').where('id', '=', b.id).execute();
      return n;
    });
    setFlash(reply, 'ok', `${created} objet(s) importé(s).`);
    return redirect(req, reply, '/objets?sort=created&dir=desc');
  });
}

export type { Tree };
