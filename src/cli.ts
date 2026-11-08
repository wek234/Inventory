// Commandes d'administration : node dist/cli.js <commande>
import readline from 'node:readline';
import { db } from './db.js';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { hashPassword, passwordProblems } from './security.js';

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
        else if (s === '\r\n' || s === '\n') out.output.write('\n');
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a);
    });
  });
}

async function askPassword(username: string): Promise<string> {
  const fromEnv = process.env.INVENTORY_PASSWORD;
  if (fromEnv) {
    const p = passwordProblems(fromEnv, username);
    if (p) throw new Error(p);
    return fromEnv;
  }
  for (;;) {
    const a = await ask('Mot de passe : ', true);
    const p = passwordProblems(a, username);
    if (p) {
      console.log(p);
      continue;
    }
    const b = await ask('Confirmez le mot de passe : ', true);
    if (a !== b) {
      console.log('Les deux saisies ne correspondent pas.');
      continue;
    }
    return a;
  }
}

async function userByName(name: string) {
  const u = await db.selectFrom('users').selectAll().where('username', '=', name).executeTakeFirst();
  if (!u) throw new Error(`Utilisateur « ${name} » introuvable.`);
  return u;
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async migrate() {
    await migrate(db);
  },
  async seed() {
    await seed();
  },
  async 'create-user'([name]) {
    const username = (name ?? (await ask('Identifiant : '))).trim();
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error('Identifiant invalide (3 à 64 caractères : lettres, chiffres, . _ -).');
    if (await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()) throw new Error('Cet identifiant existe déjà.');
    const pw = await askPassword(username);
    await db.insertInto('users').values({ username, password_hash: await hashPassword(pw), totp_enabled: 0, failed_attempts: 0, password_changed_at: new Date() }).execute();
    console.log(`Compte « ${username} » créé. Le TOTP sera configuré à la première connexion.`);
  },
  async 'reset-password'([name]) {
    const u = await userByName(name);
    const pw = await askPassword(u.username);
    await db.updateTable('users').set({ password_hash: await hashPassword(pw), password_changed_at: new Date(), failed_attempts: 0, locked_until: null }).where('id', '=', u.id).execute();
    await db.deleteFrom('sessions').where('user_id', '=', u.id).execute();
    console.log('Mot de passe réinitialisé, sessions fermées.');
  },
  async 'reset-totp'([name]) {
    const u = await userByName(name);
    await db.updateTable('users').set({ totp_secret_enc: null, totp_enabled: 0, totp_last_step: null }).where('id', '=', u.id).execute();
    await db.deleteFrom('sessions').where('user_id', '=', u.id).execute();
    console.log('TOTP réinitialisé : un nouvel enrôlement sera demandé à la prochaine connexion.');
  },
  async unlock([name]) {
    const u = await userByName(name);
    await db.updateTable('users').set({ failed_attempts: 0, locked_until: null }).where('id', '=', u.id).execute();
    console.log('Compte déverrouillé.');
  },
  // Photos envoyées avant la 1.4 : métadonnées (EXIF, GPS) supprimées, vignettes et photo principale créées.
  async photos() {
    const { processImage } = await import('./services/images.js');
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('./config.js');
    const { randomToken, sha256 } = await import('./security.js');
    const rows = await db.selectFrom('attachments').selectAll().where('mime', 'like', 'image/%').where('thumb_name', 'is', null).execute();
    let done = 0;
    for (const a of rows) {
      const file = path.join(config.dataDir, a.stored_name.slice(0, 2), a.stored_name);
      try {
        const img = await processImage(await fs.readFile(file), a.mime);
        const thumb = `${randomToken(24)}.webp`;
        const thumbFile = path.join(config.dataDir, thumb.slice(0, 2), thumb);
        await fs.mkdir(path.dirname(thumbFile), { recursive: true, mode: 0o750 });
        await fs.writeFile(thumbFile, img.thumb, { mode: 0o640 });
        await fs.writeFile(file + '.tmp', img.buf, { mode: 0o640 });
        await fs.rename(file + '.tmp', file);
        await db.updateTable('attachments').set({ thumb_name: thumb, size: img.buf.length, sha256: sha256(img.buf) }).where('id', '=', a.id).execute();
        done++;
      } catch (e: any) {
        console.log(`Photo ${a.id} (${a.original_name}) ignorée : ${e?.message ?? e}`);
      }
    }
    // Une photo principale par objet (la plus récente) si aucune n'est définie.
    const items = await db.selectFrom('attachments').select('item_id').distinct().where('kind', '=', 'photo').execute();
    for (const { item_id } of items) {
      const has = await db.selectFrom('attachments').select('id').where('item_id', '=', item_id).where('kind', '=', 'photo').where('is_primary', '=', 1).executeTakeFirst();
      if (!has) {
        const last = await db.selectFrom('attachments').select('id').where('item_id', '=', item_id).where('kind', '=', 'photo').orderBy('created_at', 'desc').executeTakeFirst();
        if (last) await db.updateTable('attachments').set({ is_primary: 1 }).where('id', '=', last.id).execute();
      }
    }
    console.log(`${done} image(s) traitée(s).`);
  },
  async 'list-users'() {
    const rows = await db.selectFrom('users').select(['username', 'role', 'totp_enabled', 'locked_until', 'created_at']).execute();
    for (const r of rows) console.log(`${r.username}\t${r.role === 'admin' ? 'administrateur' : 'lecture seule'}\tTOTP: ${r.totp_enabled ? 'oui' : 'non'}\t${r.locked_until && new Date(r.locked_until) > new Date() ? 'VERROUILLÉ' : ''}`);
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.log('Commandes : ' + Object.keys(commands).join(', '));
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd](args);
  await db.destroy();
} catch (e: any) {
  console.error('Erreur : ' + (e?.message ?? e));
  await db.destroy();
  process.exit(1);
}
