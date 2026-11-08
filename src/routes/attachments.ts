// Fichiers joints : photos, factures, documents. Type vérifié sur le contenu réel, stockage hors du dossier web.
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { config } from '../config.js';
import { db } from '../db.js';
import { randomToken, sha256 } from '../security.js';
import { audit } from '../services/audit.js';
import { setFlash, redirect } from '../views.js';
import { id, Body } from '../services/forms.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const ALLOWED: Record<string, string[]> = {
  photo: IMAGE_TYPES,
  facture: [...IMAGE_TYPES, 'application/pdf'],
  document: [...IMAGE_TYPES, 'application/pdf'],
};
const KIND_LABEL: Record<string, string> = { photo: 'photo', facture: 'facture', document: 'document' };

function storedPath(stored: string) {
  // Les noms stockés sont générés par l'application (base64url + extension) : pas de traversée possible.
  if (!/^[A-Za-z0-9_-]{20,64}\.[a-z0-9]{2,5}$/.test(stored)) throw new Error('nom de fichier invalide');
  return path.join(config.dataDir, stored.slice(0, 2), stored);
}

export async function removeStoredFiles(names: string[]) {
  for (const n of names) {
    try {
      await fs.unlink(storedPath(n));
    } catch {
      /* déjà absent */
    }
  }
}

function cleanName(name: string) {
  const base = path.basename(name || 'fichier').replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').trim();
  return (base || 'fichier').slice(0, 200);
}

export async function attachmentRoutes(app: FastifyInstance) {
  app.post('/objets/:id/fichiers', async (req, reply) => {
    const itemId = id((req.params as Body).id);
    const item = itemId ? await db.selectFrom('items').select(['id', 'name']).where('id', '=', itemId).executeTakeFirst() : undefined;
    if (!item) return reply.callNotFound();
    if (!req.isMultipart()) return reply.code(400).send('Formulaire invalide');

    let kind = 'photo';
    const saved: string[] = [];
    const errors: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'kind' && typeof part.value === 'string' && part.value in ALLOWED) kind = part.value;
          continue;
        }
        if (!part.filename) {
          await part.toBuffer();
          continue;
        }
        const buf = await part.toBuffer(); // lève une erreur au-delà de la taille maximale
        const original = cleanName(part.filename);
        if (!buf.length) continue;
        const ft = await fileTypeFromBuffer(buf);
        if (!ft || !ALLOWED[kind].includes(ft.mime)) {
          errors.push(`« ${original} » : type non accepté pour une ${KIND_LABEL[kind]} (${kind === 'photo' ? 'images JPEG, PNG, WebP, GIF, AVIF' : 'images ou PDF'})`);
          continue;
        }
        const stored = `${randomToken(24)}.${ft.ext}`;
        const dest = storedPath(stored);
        await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
        await fs.writeFile(dest, buf, { mode: 0o640, flag: 'wx' });
        await db
          .insertInto('attachments')
          .values({ item_id: item.id, kind: kind as 'photo', original_name: original, stored_name: stored, mime: ft.mime, size: buf.length, sha256: sha256(buf) })
          .execute();
        saved.push(original);
      }
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413) errors.push(`Fichier trop volumineux (${config.maxUploadBytes / 1024 / 1024} Mo maximum).`);
      else if (e?.code === 'FST_FILES_LIMIT') errors.push('10 fichiers maximum par envoi.');
      else throw e;
    }
    if (saved.length) await audit(req, 'objet', item.id, 'fichier', `Ajout ${saved.length > 1 ? 'des fichiers' : 'du fichier'} (${KIND_LABEL[kind]}) : ${saved.join(', ')}`);
    if (errors.length) setFlash(reply, 'erreur', errors.join(' '));
    else if (saved.length) setFlash(reply, 'ok', saved.length > 1 ? `${saved.length} fichiers ajoutés.` : 'Fichier ajouté.');
    else setFlash(reply, 'info', 'Aucun fichier sélectionné.');
    return redirect(req, reply, `/objets/${item.id}#${kind === 'photo' ? 'photos' : 'documents'}`);
  });

  app.get('/fichiers/:id', async (req, reply) => {
    const fid = id((req.params as Body).id);
    const a = fid ? await db.selectFrom('attachments').selectAll().where('id', '=', fid).executeTakeFirst() : undefined;
    if (!a) return reply.callNotFound();
    const download = (req.query as Body).dl === '1';
    const encoded = encodeURIComponent(a.original_name);
    const ascii = a.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    reply
      .header('Content-Type', a.mime)
      .header('Content-Length', a.size)
      .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`)
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff');
    if (a.mime === 'application/pdf') reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    return reply.send(createReadStream(storedPath(a.stored_name)));
  });

  app.post('/fichiers/:id/supprimer', async (req, reply) => {
    const fid = id((req.params as Body).id);
    const a = fid ? await db.selectFrom('attachments').selectAll().where('id', '=', fid).executeTakeFirst() : undefined;
    if (!a) return reply.callNotFound();
    await db.deleteFrom('attachments').where('id', '=', a.id).execute();
    await removeStoredFiles([a.stored_name]);
    await audit(req, 'objet', a.item_id, 'fichier', `Suppression du fichier « ${a.original_name} »`);
    setFlash(reply, 'ok', 'Fichier supprimé.');
    return redirect(req, reply, `/objets/${a.item_id}#${a.kind === 'photo' ? 'photos' : 'documents'}`);
  });
}
