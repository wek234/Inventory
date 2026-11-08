import path from 'node:path';
import { mkdirSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import { config } from './config.js';
import { db } from './db.js';
import { authPlugin } from './auth.js';
import { render } from './views.js';
import { registerRoutes } from './routes/index.js';
import { sql } from 'kysely';

mkdirSync(config.dataDir, { recursive: true });

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    serializers: {
      // N'enregistre pas les paramètres de requête (le jeton CSRF peut y figurer pour les envois de fichiers).
      req: (r) => ({ method: r.method, url: r.url.split('?')[0], ip: r.ip }),
    },
  },
  trustProxy: config.trustedProxies,
  bodyLimit: 2 * 1024 * 1024,
  routerOptions: { ignoreTrailingSlash: true },
});

await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' },
  strictTransportSecurity: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: false } : false,
});
app.addHook('onSend', async (_req, reply) => {
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
});

await app.register(cookie, { secret: config.appSecret.toString('hex') });
await app.register(formbody, { bodyLimit: 8 * 1024 * 1024 });
await app.register(multipart, {
  limits: { fileSize: config.maxUploadBytes, files: 10, fields: 20, fieldSize: 10_000 },
});
await app.register(fastifyStatic, {
  root: path.join(config.appRoot, 'public'),
  prefix: '/static/',
  maxAge: '365d',
  immutable: true,
  cacheControl: true,
});

app.get('/favicon.ico', async (_req, reply) => reply.code(204).header('Cache-Control', 'public, max-age=86400').send());
app.get('/health', async (_req, reply) => {
  await sql`SELECT 1`.execute(db);
  return reply.type('text/plain').send('ok');
});

await app.register(authPlugin);
await app.register(registerRoutes);

app.setNotFoundHandler((req, reply) => render(req, reply, 'error', { title: 'Page introuvable', message: 'Cette page n’existe pas.' }, 404));
app.setErrorHandler((err: any, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (status === 500) req.log.error(err);
  let message = 'Une erreur interne est survenue.';
  if (status === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE') message = `Fichier trop volumineux (${config.maxUploadBytes / 1024 / 1024} Mo maximum).`;
  else if (status < 500) message = 'Requête invalide.';
  return render(req, reply, 'error', { title: 'Erreur', message }, status === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : status);
});

// Ménage périodique : sessions expirées et imports abandonnés.
setInterval(async () => {
  try {
    await db.deleteFrom('sessions').where('expires_at', '<', new Date()).execute();
    await db.deleteFrom('import_batches').where('created_at', '<', new Date(Date.now() - 24 * 3600_000)).execute();
  } catch (e) {
    app.log.warn(e);
  }
}, 15 * 60_000).unref();

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.listenHost, port: config.listenPort });
