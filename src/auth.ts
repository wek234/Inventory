// Authentification : mot de passe + TOTP obligatoire, SSO OIDC optionnel, sessions en base, CSRF.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import fp from 'fastify-plugin';
import { checkTotp, newTotpSecret, totpUri } from './totp.js';
import { config } from './config.js';
import { db, User } from './db.js';
import { randomToken, sha256, safeEqual, encrypt, decrypt, verifyPassword, dummyVerify } from './security.js';
import { render, redirect, setFlash } from './views.js';
import { audit } from './services/audit.js';
import { alert, recordLoginFailure } from './services/notify.js';


export interface SessionRow {
  id: string;
  user_id: number;
  state: 'pending_totp' | 'pending_enroll' | 'active';
  csrf: string;
  enroll_secret_enc: string | null;
  expires_at: Date;
  last_seen_at: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
    user: { id: number; username: string; role: 'admin' | 'lecture' } | null;
    apiScope: 'lecture' | 'ecriture' | null;
    anonCsrf: string | null;
    rawSessionToken: string | null;
  }
}

const SESSION_COOKIE = config.cookieSecure ? '__Host-inv_sid' : 'inv_sid';
const ANON_CSRF_COOKIE = config.cookieSecure ? '__Host-inv_csrf' : 'inv_csrf';
const PENDING_MINUTES = 10;

// Routes acceptant un formulaire multipart (envoi de fichiers) : elles appellent checkMultipartCsrf().
const MULTIPART_ROUTES = [/^\/objets\/\d+\/fichiers$/, /^\/import$/];

// Vérifie le premier champ « _csrf » d'un formulaire multipart.
export function checkMultipartCsrf(req: FastifyRequest, value: unknown): boolean {
  const expected = req.session?.csrf ?? '';
  return typeof value === 'string' && !!expected && safeEqual(value, expected);
}

// Ce qu'un compte en lecture seule peut faire.
const READ_ONLY_DENY_GET = [/^\/parametres/, /^\/emplacements/, /^\/categories/, /^\/statuts/, /^\/personnes/, /^\/historique/, /^\/import/, /^\/export/, /^\/etiquettes/, /\/etiquette$/, /^\/administration/, /^\/corbeille/, /^\/rangement/, /^\/objets\/nouveau/, /^\/objets\/masse/, /^\/objets\/formulaire/, /\/modifier$/];
const READ_ONLY_ALLOW_POST = [/^\/logout$/, /^\/compte\//, /^\/login\//, /^\/auth\//];
function readOnlyAllowed(method: string, path: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return !READ_ONLY_DENY_GET.some((re) => re.test(path));
  return READ_ONLY_ALLOW_POST.some((re) => re.test(path));
}

const LOGIN_FAILED = 'Identifiant ou mot de passe incorrect, ou compte temporairement verrouillé après plusieurs échecs.';

function isPublic(url: string) {
  const p = url.split('?')[0];
  return p === '/login' || p.startsWith('/login/') || p === '/auth/oidc' || p.startsWith('/auth/oidc/') || p.startsWith('/static/') || p === '/health' || p === '/favicon.ico' || p === '/manifest.webmanifest' || p === '/sw.js';
}

function cookieOpts(maxAgeSec: number) {
  return { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' as const, maxAge: maxAgeSec };
}

async function createSession(req: FastifyRequest, reply: FastifyReply, userId: number, state: SessionRow['state'], enrollSecret?: string) {
  // Supprime l'éventuelle session précédente (rotation de l'identifiant à chaque étape).
  if (req.rawSessionToken) await db.deleteFrom('sessions').where('id', '=', sha256(req.rawSessionToken)).execute();
  const token = randomToken(32);
  const now = new Date();
  const ttl = state === 'active' ? config.sessionDays * 86400_000 : PENDING_MINUTES * 60_000;
  await db
    .insertInto('sessions')
    .values({
      id: sha256(token),
      user_id: userId,
      state,
      csrf: randomToken(32),
      enroll_secret_enc: enrollSecret ? encrypt(enrollSecret) : null,
      created_at: now,
      expires_at: new Date(now.getTime() + ttl),
      last_seen_at: now,
      ip: req.ip,
      user_agent: (req.headers['user-agent'] ?? '').slice(0, 255),
    })
    .execute();
  reply.setCookie(SESSION_COOKIE, token, cookieOpts(Math.floor(ttl / 1000)));
  req.rawSessionToken = token;
}

// Limitation par IP (en mémoire) en plus du verrouillage du compte.
const ipFailures = new Map<string, { count: number; until: number }>();
function ipBlocked(ip: string) {
  const e = ipFailures.get(ip);
  return !!e && e.until > Date.now() && e.count >= 20;
}
function ipFail(ip: string) {
  const e = ipFailures.get(ip);
  const until = Date.now() + 15 * 60_000;
  if (!e || e.until < Date.now()) ipFailures.set(ip, { count: 1, until });
  else ipFailures.set(ip, { count: e.count + 1, until });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipFailures) if (v.until < now) ipFailures.delete(k);
}, 60_000).unref();

async function registerFailure(req: FastifyRequest, user: User | undefined, reason: string) {
  ipFail(req.ip);
  recordLoginFailure(req.ip);
  if (user) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= config.loginMaxAttempts ? new Date(Date.now() + config.loginLockMinutes * 60_000) : null;
    await db
      .updateTable('users')
      .set({ failed_attempts: lock ? 0 : attempts, locked_until: lock ?? user.locked_until })
      .where('id', '=', user.id)
      .execute();
    await audit(req, 'connexion', user.id, 'echec', `Échec de connexion (${reason})${lock ? ', compte verrouillé' : ''}`);
    if (lock) alert('Compte verrouillé', [`Compte : ${user.username}`, `${config.loginMaxAttempts} échecs (${reason})`, `Adresse : ${req.ip}`]);
  } else {
    await audit(req, 'connexion', null, 'echec', `Échec de connexion (${reason})`);
  }
}

function isLocked(user: User) {
  return user.locked_until && new Date(user.locked_until).getTime() > Date.now();
}

function safeNext(n: unknown): string {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') && !n.startsWith('/login') ? n : '/';
}

function nextCookie(reply: FastifyReply, next: string) {
  reply.setCookie('inv_next', next, { ...cookieOpts(PENDING_MINUTES * 60), signed: true });
}
function takeNext(req: FastifyRequest, reply: FastifyReply): string {
  const raw = req.cookies['inv_next'];
  reply.clearCookie('inv_next', { path: '/' });
  if (!raw) return '/';
  const un = req.unsignCookie(raw);
  return un.valid ? safeNext(un.value) : '/';
}

async function completeLogin(req: FastifyRequest, reply: FastifyReply, user: User, method: string) {
  await db.updateTable('users').set({ failed_attempts: 0, locked_until: null }).where('id', '=', user.id).execute();
  await createSession(req, reply, user.id, 'active');
  req.user = { id: user.id, username: user.username, role: user.role };
  await audit(req, 'connexion', user.id, 'succes', `Connexion réussie (${method})`);
  return reply.redirect(takeNext(req, reply), 303);
}

// Connexion par clé d'accès (passkey vérifiée avec empreinte / code PIN) : vaut deux facteurs, pas de TOTP demandé.
export async function completeLoginFromPasskey(req: FastifyRequest, reply: FastifyReply, userId: number, keyName: string): Promise<string> {
  const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
  await db.updateTable('users').set({ failed_attempts: 0, locked_until: null }).where('id', '=', user.id).execute();
  await createSession(req, reply, user.id, 'active');
  req.user = { id: user.id, username: user.username, role: user.role };
  await audit(req, 'connexion', user.id, 'succes', `Connexion réussie (clé d’accès « ${keyName} »)`);
  return takeNext(req, reply);
}

async function authPluginImpl(app: FastifyInstance) {
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  app.decorateRequest('anonCsrf', null);
  app.decorateRequest('rawSessionToken', null);
  app.decorateRequest('apiScope', null);

  // Chargement de la session sur chaque requête.
  app.addHook('onRequest', async (req, reply) => {
    // API : uniquement par jeton (en-tête Authorization), jamais par cookie (pas de CSRF possible).
    if (req.url === '/api' || req.url.startsWith('/api/')) {
      const auth = String(req.headers.authorization ?? '');
      const m = /^Bearer\s+(inv_[A-Za-z0-9_-]{20,80})$/.exec(auth);
      const row = m
        ? await db
            .selectFrom('api_tokens')
            .innerJoin('users', 'users.id', 'api_tokens.user_id')
            .select(['api_tokens.id', 'api_tokens.scope', 'api_tokens.expires_at', 'users.id as uid', 'users.username', 'users.role'])
            .where('api_tokens.token_hash', '=', sha256(m[1]))
            .executeTakeFirst()
        : undefined;
      if (!row || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ erreur: 'Jeton d’API manquant, invalide ou expiré.' });
      }
      req.user = { id: row.uid, username: row.username, role: row.role };
      // Un compte en lecture seule ne peut pas écrire, quel que soit le jeton.
      req.apiScope = row.role === 'lecture' ? 'lecture' : row.scope;
      void db.updateTable('api_tokens').set({ last_used_at: new Date() }).where('id', '=', row.id).execute();
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token && token.length <= 64) {
      const row = await db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select(['sessions.id', 'sessions.user_id', 'sessions.state', 'sessions.csrf', 'sessions.enroll_secret_enc', 'sessions.expires_at', 'sessions.last_seen_at', 'sessions.created_at', 'users.username', 'users.role'])
        .where('sessions.id', '=', sha256(token))
        .executeTakeFirst();
      // Durée de vie absolue : au-delà de SESSION_MAX_DAYS, reconnexion obligatoire même si la session sert tous les jours.
      const absoluteEnd = row ? new Date(row.created_at).getTime() + config.sessionMaxDays * 86400_000 : 0;
      if (row && new Date(row.expires_at).getTime() > Date.now() && absoluteEnd > Date.now()) {
        req.rawSessionToken = token;
        req.session = row;
        if (row.state === 'active') {
          req.user = { id: row.user_id, username: row.username, role: row.role };
          // Session glissante : prolongée à l'usage (au plus une écriture par heure), sans dépasser la durée maximale.
          if (Date.now() - new Date(row.last_seen_at).getTime() > 3600_000) {
            const exp = new Date(Math.min(Date.now() + config.sessionDays * 86400_000, absoluteEnd));
            await db.updateTable('sessions').set({ last_seen_at: new Date(), expires_at: exp }).where('id', '=', row.id).execute();
            reply.setCookie(SESSION_COOKIE, token, cookieOpts(Math.floor((exp.getTime() - Date.now()) / 1000)));
          }
        }
      } else if (row) {
        await db.deleteFrom('sessions').where('id', '=', row.id).execute();
      }
    }

    // Jeton CSRF des formulaires anonymes (connexion) : double soumission par cookie.
    if (!req.session) {
      let anon = req.cookies[ANON_CSRF_COOKIE];
      if (!anon || anon.length !== 43) {
        anon = randomToken(32);
        reply.setCookie(ANON_CSRF_COOKIE, anon, { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' });
      }
      req.anonCsrf = anon;
    }

    const url = req.url;
    if (isPublic(url)) return;
    if (!req.user) {
      // Mémorise la page demandée (navigation uniquement : pas les ressources chargées automatiquement).
      const dest = req.headers['sec-fetch-dest'];
      const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
      if (req.method === 'GET' && wantsHtml && (!dest || dest === 'document') && req.headers['hx-request'] !== 'true') nextCookie(reply, safeNext(url));
      if (req.headers['hx-request'] === 'true') return reply.header('HX-Redirect', '/login').code(401).send();
      return reply.redirect('/login', 303);
    }
  });

  // Contrôle CSRF + origine sur toutes les requêtes qui modifient des données.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

    // API : le jeton fait foi ; l'écriture exige un jeton « écriture ».
    if (req.apiScope) {
      if (!safeMethod && req.apiScope !== 'ecriture') return reply.code(403).send({ erreur: 'Ce jeton est en lecture seule.' });
      return;
    }

    // Comptes en lecture seule : consultation uniquement.
    if (req.user?.role === 'lecture' && !readOnlyAllowed(req.method, path)) {
      if (req.headers['hx-request'] === 'true') return reply.code(403).send('Accès en lecture seule.');
      return reply.code(403).type('text/plain; charset=utf-8').send('Votre compte est en lecture seule : cette action n’est pas autorisée.');
    }

    if (safeMethod) return;
    const origin = req.headers.origin;
    if (origin) {
      const allowed = [new URL(config.publicUrl).origin, `${req.protocol}://${req.host}`];
      if (!allowed.includes(origin)) return reply.code(403).send('Origine refusée');
    }
    // Envois de fichiers : le jeton est le premier champ du formulaire, vérifié par la route avant de lire le moindre fichier.
    if (req.isMultipart()) {
      if (!MULTIPART_ROUTES.some((re) => re.test(path))) return reply.code(415).send('Type de contenu non accepté');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sent = String(req.headers['x-csrf-token'] ?? body._csrf ?? '');
    const expected = req.session?.csrf ?? req.anonCsrf ?? '';
    if (!sent || !expected || !safeEqual(sent, expected)) {
      return reply.code(403).type('text/plain; charset=utf-8').send('Jeton de sécurité invalide ou expiré. Rechargez la page et recommencez.');
    }
  });

  // ---- Connexion par mot de passe ----
  app.get('/login', async (req, reply) => {
    if (req.user) return reply.redirect('/', 303);
    return render(req, reply, 'auth/login', { error: null });
  });

  app.post('/login', async (req, reply) => {
    const { username = '', password = '' } = (req.body ?? {}) as Record<string, string>;
    // Message unique dans tous les cas d'échec : ne révèle ni l'existence du compte ni son verrouillage.
    const fail = () => render(req, reply, 'auth/login', { error: LOGIN_FAILED, username }, 401);
    if (ipBlocked(req.ip)) return fail();
    const user = await db.selectFrom('users').selectAll().where('username', '=', String(username).trim()).executeTakeFirst();
    if (!user) {
      await dummyVerify(String(password));
      await registerFailure(req, undefined, 'identifiant inconnu');
      return fail();
    }
    if (isLocked(user)) {
      await dummyVerify(String(password));
      await audit(req, 'connexion', user.id, 'echec', 'Tentative sur un compte verrouillé');
      return fail();
    }
    if (!(await verifyPassword(user.password_hash, String(password)))) {
      await registerFailure(req, user, 'mot de passe');
      return fail();
    }
    if (user.totp_enabled && user.totp_secret_enc) {
      await createSession(req, reply, user.id, 'pending_totp');
      return reply.redirect('/login/totp', 303);
    }
    await createSession(req, reply, user.id, 'pending_enroll', newTotpSecret());
    return reply.redirect('/login/enroll', 303);
  });

  // ---- Second facteur ----
  app.get('/login/totp', async (req, reply) => {
    if (req.session?.state !== 'pending_totp') return reply.redirect('/login', 303);
    return render(req, reply, 'auth/totp', { error: null });
  });

  app.post('/login/totp', async (req, reply) => {
    if (req.session?.state !== 'pending_totp') return reply.redirect('/login', 303);
    const user = await db.selectFrom('users').selectAll().where('id', '=', req.session.user_id).executeTakeFirstOrThrow();
    if (isLocked(user) || ipBlocked(req.ip)) {
      await db.deleteFrom('sessions').where('id', '=', req.session.id).execute();
      return render(req, reply, 'auth/login', { error: LOGIN_FAILED }, 401);
    }
    const code = String(((req.body ?? {}) as Record<string, string>).code ?? '');
    const step = checkTotp(decrypt(user.totp_secret_enc!), code, user.totp_last_step);
    if (step === null) {
      await registerFailure(req, user, 'code TOTP');
      return render(req, reply, 'auth/totp', { error: 'Code invalide.' }, 401);
    }
    await db.updateTable('users').set({ totp_last_step: step }).where('id', '=', user.id).execute();
    return completeLogin(req, reply, user, 'mot de passe + TOTP');
  });

  // ---- Enrôlement TOTP (obligatoire à la première connexion) ----
  app.get('/login/enroll', async (req, reply) => {
    if (req.session?.state !== 'pending_enroll' || !req.session.enroll_secret_enc) return reply.redirect('/login', 303);
    const user = await db.selectFrom('users').select(['username']).where('id', '=', req.session.user_id).executeTakeFirstOrThrow();
    const secret = decrypt(req.session.enroll_secret_enc);
    const host = new URL(config.publicUrl).host;
    const uri = totpUri(user.username, `Inventaire (${host})`, secret);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    return render(req, reply, 'auth/enroll', { qr, secret: secret.replace(/(.{4})/g, '$1 ').trim(), error: null });
  });

  app.post('/login/enroll', async (req, reply) => {
    if (req.session?.state !== 'pending_enroll' || !req.session.enroll_secret_enc) return reply.redirect('/login', 303);
    const user = await db.selectFrom('users').selectAll().where('id', '=', req.session.user_id).executeTakeFirstOrThrow();
    const secret = decrypt(req.session.enroll_secret_enc);
    const code = String(((req.body ?? {}) as Record<string, string>).code ?? '');
    const step = checkTotp(secret, code, null);
    if (step === null) {
      await registerFailure(req, user, 'code TOTP (enrôlement)');
      setFlash(reply, 'erreur', 'Code invalide. Vérifiez l’heure de votre téléphone et réessayez.');
      return reply.redirect('/login/enroll', 303);
    }
    await db
      .updateTable('users')
      .set({ totp_secret_enc: encrypt(secret), totp_enabled: 1, totp_last_step: step })
      .where('id', '=', user.id)
      .execute();
    await audit(req, 'compte', user.id, 'totp', 'Authentification à deux facteurs activée');
    alert('Double authentification configurée', [`Compte : ${user.username}`, `Adresse : ${req.ip}`]);
    return completeLogin(req, reply, user, 'mot de passe + TOTP');
  });

  app.post('/logout', async (req, reply) => {
    if (req.session) await db.deleteFrom('sessions').where('id', '=', req.session.id).execute();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return redirect(req, reply, '/login');
  });

  // ---- SSO OpenID Connect (désactivé par défaut) ----
  if (config.oidc.enabled) await registerOidc(app);
}

async function registerOidc(app: FastifyInstance) {
  const client = await import('openid-client');
  let oidcConfig: Awaited<ReturnType<typeof client.discovery>> | null = null;
  const getConfig = async () => {
    if (!oidcConfig) oidcConfig = await client.discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret);
    return oidcConfig;
  };
  const redirectUri = `${config.publicUrl}/auth/oidc/callback`;

  const start = async (req: FastifyRequest, reply: FastifyReply, mode: 'login' | 'link') => {
    const c = await getConfig();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    reply.setCookie('inv_oidc', JSON.stringify({ verifier, state, nonce, mode }), { ...cookieOpts(600), signed: true });
    const url = client.buildAuthorizationUrl(c, {
      redirect_uri: redirectUri,
      scope: config.oidc.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return reply.redirect(url.href, 303);
  };

  app.get('/auth/oidc', async (req, reply) => start(req, reply, 'login'));
  app.get('/compte/oidc/associer', async (req, reply) => start(req, reply, 'link'));

  app.get('/auth/oidc/callback', async (req, reply) => {
    const raw = req.cookies['inv_oidc'];
    reply.clearCookie('inv_oidc', { path: '/' });
    const un = raw ? req.unsignCookie(raw) : null;
    if (!un?.valid || !un.value) return render(req, reply, 'auth/login', { error: 'Session SSO expirée, recommencez.' }, 400);
    const saved = JSON.parse(un.value) as { verifier: string; state: string; nonce: string; mode: 'login' | 'link' };
    let sub: string;
    try {
      const c = await getConfig();
      const current = new URL(req.url, config.publicUrl);
      const tokens = await client.authorizationCodeGrant(c, current, {
        pkceCodeVerifier: saved.verifier,
        expectedState: saved.state,
        expectedNonce: saved.nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('sub absent');
      sub = claims.sub;
    } catch (e) {
      req.log.warn({ err: e }, 'échec OIDC');
      await audit(req, 'connexion', null, 'echec', 'Échec de connexion SSO');
      return render(req, reply, 'auth/login', { error: 'La connexion SSO a échoué.' }, 401);
    }

    if (saved.mode === 'link') {
      if (!req.user) return reply.redirect('/login', 303);
      await db.updateTable('users').set({ oidc_sub: sub }).where('id', '=', req.user.id).execute();
      await audit(req, 'compte', req.user.id, 'oidc', 'Compte SSO associé');
      setFlash(reply, 'ok', 'Compte SSO associé.');
      return reply.redirect('/compte', 303);
    }

    const user = await db.selectFrom('users').selectAll().where('oidc_sub', '=', sub).executeTakeFirst();
    if (!user) {
      await audit(req, 'connexion', null, 'echec', 'SSO : identité non associée à un compte');
      return render(req, reply, 'auth/login', { error: 'Cette identité SSO n’est associée à aucun compte.' }, 403);
    }
    if (isLocked(user)) return render(req, reply, 'auth/login', { error: LOGIN_FAILED }, 403);
    if (config.oidc.requireLocalTotp && user.totp_enabled) {
      await createSession(req, reply, user.id, 'pending_totp');
      return reply.redirect('/login/totp', 303);
    }
    return completeLogin(req, reply, user, 'SSO');
  });
}

// fastify-plugin : les hooks s'appliquent à TOUTE l'application, pas seulement à ce plugin.
export const authPlugin = fp(authPluginImpl, { name: 'auth' });

export { createSession, SESSION_COOKIE, checkTotp };
