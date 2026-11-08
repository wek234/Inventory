// Page Administration : état du système, de l'application, de la base, et nouvelle version disponible sur GitHub.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { db } from '../db.js';
import { config } from '../config.js';
import { render, redirect, setFlash } from '../views.js';
import { audit } from '../services/audit.js';
import { notify, telegramEnabled, getMeta, setMeta } from '../services/notify.js';

const pkg = JSON.parse(await fs.readFile(path.join(config.appRoot, 'package.json'), 'utf8')) as { version: string };
export const APP_VERSION = pkg.version;
const startedAt = new Date();

interface ReleaseInfo {
  checkedAt: Date;
  ok: boolean;
  error?: string;
  tag?: string;
  version?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  notes?: string;
}
let releaseCache: ReleaseInfo | null = null;
const CACHE_MS = 6 * 3600_000;

// Compare deux versions « 1.2.10 » : >0 si a est plus récente que b.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Numéro de version tiré du tag, même mal saisi : « v1.5.3 », « 1.5.3 », « v.1.5.3 », « release-1.5.3 » donnent 1.5.3.
export function versionFromTag(tag: string): string {
  const m = /(\d+(?:\.\d+)+)/.exec(tag);
  return m ? m[1] : tag.replace(/^v/i, '');
}

async function latestRelease(force = false): Promise<ReleaseInfo | null> {
  if (!config.updateRepo) return null;
  if (!force && releaseCache && Date.now() - releaseCache.checkedAt.getTime() < CACHE_MS) return releaseCache;
  try {
    const res = await fetch(`https://api.github.com/repos/${config.updateRepo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'inventaire-verification-version', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 404) releaseCache = { checkedAt: new Date(), ok: false, error: 'Aucune release publiée sur ce dépôt.' };
    else if (!res.ok) releaseCache = { checkedAt: new Date(), ok: false, error: `GitHub a répondu ${res.status}.` };
    else {
      const j = (await res.json()) as { tag_name?: string; name?: string; html_url?: string; published_at?: string; body?: string };
      const tag = String(j.tag_name ?? '');
      releaseCache = {
        checkedAt: new Date(),
        ok: true,
        tag,
        version: versionFromTag(tag),
        name: String(j.name || tag),
        url: typeof j.html_url === 'string' && j.html_url.startsWith('https://github.com/') ? j.html_url : `https://github.com/${config.updateRepo}/releases`,
        publishedAt: j.published_at,
        notes: String(j.body ?? '').slice(0, 4000),
      };
    }
  } catch (e: any) {
    releaseCache = { checkedAt: new Date(), ok: false, error: e?.name === 'TimeoutError' ? 'GitHub ne répond pas (délai dépassé).' : 'GitHub injoignable depuis le serveur.' };
  }
  return releaseCache;
}

async function readOsName() {
  try {
    const txt = await fs.readFile('/etc/os-release', 'utf8');
    return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(txt)?.[1] ?? `${os.type()} ${os.release()}`;
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        bytes += (await fs.stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

const duration = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d ? `${d} j` : '', h ? `${h} h` : '', `${m} min`].filter(Boolean).join(' ');
};
export const bytes = (n: number) => {
  if (!Number.isFinite(n)) return '?';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString('fr-FR', { maximumFractionDigits: i ? 1 : 0 })} ${u[i]}`;
};

export async function adminRoutes(app: FastifyInstance) {
  app.get('/administration', async (req, reply) => {
    const [osName, release, mariadbVersion, dbSize, migrations, counts, failures, lastImport, uploads] = await Promise.all([
      readOsName(),
      latestRelease(),
      sql<{ v: string }>`SELECT VERSION() AS v`.execute(db).then((r) => r.rows[0]?.v ?? '?'),
      sql<{ size: string }>`SELECT COALESCE(SUM(data_length + index_length), 0) AS size FROM information_schema.tables WHERE table_schema = DATABASE()`
        .execute(db)
        .then((r) => Number(r.rows[0]?.size ?? 0)),
      sql<{ name: string; timestamp: string }>`SELECT name, timestamp FROM kysely_migration ORDER BY name`.execute(db).then((r) => r.rows),
      Promise.all(
        (['items', 'item_values', 'attachments', 'locations', 'categories', 'statuses', 'maintenance', 'item_links', 'audit_log', 'users'] as const).map(async (t) => [
          t,
          Number((await db.selectFrom(t).select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n),
        ]),
      ).then((e) => Object.fromEntries(e) as Record<string, number>),
      db
        .selectFrom('audit_log')
        .select(db.fn.countAll<number>().as('n'))
        .where('entity', '=', 'connexion')
        .where('action', '=', 'echec')
        .where('created_at', '>', new Date(Date.now() - 86400_000))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      db.selectFrom('audit_log').select(['created_at', 'summary']).where('entity', '=', 'import').orderBy('id', 'desc').limit(1).executeTakeFirst(),
      dirSize(config.dataDir),
    ]);
    const sessions = Number(
      (await db.selectFrom('sessions').select(db.fn.countAll<number>().as('n')).where('state', '=', 'active').where('expires_at', '>', new Date()).executeTakeFirstOrThrow()).n,
    );
    let disk: { total: number; free: number } | null = null;
    try {
      const s = await fs.statfs(config.dataDir);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
    const cpus = os.cpus();
    const mem = process.memoryUsage();
    return render(req, reply, 'admin', {
      title: 'Administration',
      app: {
        version: APP_VERSION,
        node: process.version,
        startedAt,
        uptime: duration(process.uptime()),
        rss: bytes(mem.rss),
        heap: bytes(mem.heapUsed),
        publicUrl: config.publicUrl,
        port: config.listenPort,
        proxies: config.trustedProxies.join(', '),
        sessionDays: config.sessionDays,
        uploadMb: config.maxUploadBytes / 1024 / 1024,
        loginMax: config.loginMaxAttempts,
        lockMin: config.loginLockMinutes,
        oidc: config.oidc.enabled,
        timezone: config.timezone,
        updateRepo: config.updateRepo,
      },
      system: {
        host: os.hostname(),
        os: osName,
        kernel: os.release(),
        arch: os.arch(),
        cpu: cpus.length ? `${cpus.length} × ${cpus[0].model.trim()}` : '?',
        load: os.loadavg().map((l) => l.toFixed(2)).join(' / '),
        uptime: duration(os.uptime()),
        memTotal: os.totalmem(),
        memUsed: os.totalmem() - os.freemem(),
      },
      storage: { disk, uploads, dbSize },
      database: { version: mariadbVersion, migrations, counts },
      activity: { sessions, failures, lastImport },
      release,
      telegram: telegramEnabled(),
      newer: release?.ok && release.version ? compareVersions(release.version, APP_VERSION) > 0 : false,
      fmt: { bytes },
    });
  });

  app.post('/administration/telegram/test', async (req, reply) => {
    const r = await notify('Message de test', [`Envoyé depuis la page Administration par ${req.user!.username}.`]);
    setFlash(reply, r.ok ? 'ok' : 'erreur', r.ok ? 'Message de test envoyé sur Telegram.' : `Échec de l’envoi : ${r.error}.`);
    return redirect(req, reply, '/administration#alertes');
  });

  app.post('/administration/verifier', async (req, reply) => {
    const r = await latestRelease(true);
    await audit(req, 'compte', req.user!.id, 'version', 'Vérification manuelle des mises à jour');
    if (!r) setFlash(reply, 'info', 'Vérification des mises à jour désactivée (UPDATE_REPO vide).');
    else if (!r.ok) setFlash(reply, 'erreur', r.error ?? 'Vérification impossible.');
    else setFlash(reply, 'ok', compareVersions(r.version!, APP_VERSION) > 0 ? `Nouvelle version disponible : ${r.version}.` : 'Vous utilisez la dernière version.');
    return redirect(req, reply, '/administration#version');
  });
}

// Vérification périodique des nouvelles versions : alerte Telegram une seule fois par version.
export function startVersionWatcher(log: { warn: (o: unknown, m?: string) => void }) {
  const run = async () => {
    try {
      const r = await latestRelease(true);
      if (!r?.ok || !r.version || compareVersions(r.version, APP_VERSION) <= 0) return;
      if ((await getMeta('notified_version')) === r.version) return;
      const sent = await notify(`Nouvelle version disponible : ${r.version}`, [`Version installée : ${APP_VERSION}`, r.url ?? '']);
      if (sent.ok) await setMeta('notified_version', r.version);
    } catch (e) {
      log.warn(e, 'vérification de version');
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, CACHE_MS).unref();
}
