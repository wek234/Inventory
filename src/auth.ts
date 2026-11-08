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
    user: Pick<User, 'id' | 'username'> | null;
    anonCsrf: string | null;
    rawSessionToken: string | null;
  }
}

const SESSION_COOKIE = config.cookieSecure ? '__Host-inv_sid' : 'inv_sid';
const ANON_CSRF_COOKIE = config.cookieSecure ? '__Host-inv_csrf' : 'inv_csrf';
const PENDING_MINUTES = 10;

function isPublic(url: string) {
  const p = url.split('?')[0];
  return p === '/login' || p.startsWith('/login/') || p === '/auth/oidc' || p.startsWith('/auth/oidc/') || p.startsWith('/static/') || p === '/health' || p === '/favicon.ico';
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
  if (user) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= config.loginMaxAttempts ? new Date(Date.now() + config.loginLockMinutes * 60_000) : null;
    await db
      .updateTable('users')
      .set({ failed_attempts: lock ? 0 : attempts, locked_until: lock ?? user.locked_until })
      .where('id', '=', user.id)
      .execute();
    await audit(req, 'connexion', user.id, 'echec', `Échec de connexion (${reason})${lock ? ', compte verrouillé' : ''}`);
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
  req.user = { id: user.id, username: user.username };
  await audit(req, 'connexion', user.id, 'succes', `Connexion réussie (${method})`);
  return reply.redirect(takeNext(req, reply), 303);
}

async function authPluginImpl(app: FastifyInstance) {
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  app.decorateRequest('anonCsrf', null);
  app.decorateRequest('rawSessionToken', null);

  // Chargement de la session sur chaque requête.
  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token && token.length <= 64) {
      const row = await db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select(['sessions.id', 'sessions.user_id', 'sessions.state', 'sessions.csrf', 'sessions.enroll_secret_enc', 'sessions.expires_at', 'sessions.last_seen_at', 'users.username'])
        .where('sessions.id', '=', sha256(token))
        .executeTakeFirst();
      if (row && new Date(row.expires_at).getTime() > Date.now()) {
        req.rawSessionToken = token;
        req.session = row;
        if (row.state === 'active') {
          req.user = { id: row.user_id, username: row.username };
          // Session glissante : prolongée à l'usage (au plus une écriture par heure).
          if (Date.now() - new Date(row.last_seen_at).getTime() > 3600_000) {
            const exp = new Date(Date.now() + config.sessionDays * 86400_000);
            await db.updateTable('sessions').set({ last_seen_at: new Date(), expires_at: exp }).where('id', '=', row.id).execute();
            reply.setCookie(SESSION_COOKIE, token, cookieOpts(config.sessionDays * 86400));
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
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin) {
      const allowed = [new URL(config.publicUrl).origin, `${req.protocol}://${req.host}`];
      if (!allowed.includes(origin)) return reply.code(403).send('Origine refusée');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const sent = String(req.headers['x-csrf-token'] ?? body._csrf ?? query._csrf ?? '');
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
    const fail = (msg = 'Identifiant ou mot de passe incorrect.') => render(req, reply, 'auth/login', { error: msg, username }, 401);
    if (ipBlocked(req.ip)) return fail('Trop de tentatives depuis votre adresse. Réessayez dans 15 minutes.');
    const user = await db.selectFrom('users').selectAll().where('username', '=', String(username).trim()).executeTakeFirst();
    if (!user) {
      await dummyVerify(String(password));
      await registerFailure(req, undefined, 'identifiant inconnu');
      return fail();
    }
    if (isLocked(user)) {
      await dummyVerify(String(password));
      return fail(`Compte temporairement verrouillé après ${config.loginMaxAttempts} échecs. Réessayez plus tard.`);
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
      return render(req, reply, 'auth/login', { error: 'Compte temporairement verrouillé. Réessayez plus tard.' }, 401);
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
    if (isLocked(user)) return render(req, reply, 'auth/login', { error: 'Compte temporairement verrouillé.' }, 403);
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
