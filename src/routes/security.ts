// Clés d'accès (passkeys), gestion des comptes (administrateurs) et jetons d'API.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import { db } from '../db.js';
import { render, redirect, setFlash } from '../views.js';
import { audit } from '../services/audit.js';
import { alert } from '../services/notify.js';
import { Body, str, id, intIn } from '../services/forms.js';
import { hashPassword, passwordProblems, randomToken, sha256 } from '../security.js';
import { createSession, completeLoginFromPasskey } from '../auth.js';

const rpID = () => new URL(config.publicUrl).hostname;
const origin = () => new URL(config.publicUrl).origin;
const WA_COOKIE = 'inv_wa';

function setChallenge(reply: FastifyReply, kind: 'register' | 'login', challenge: string) {
  reply.setCookie(WA_COOKIE, JSON.stringify({ kind, challenge, exp: Date.now() + 5 * 60_000 }), {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    signed: true,
    maxAge: 300,
  });
}
function takeChallenge(req: FastifyRequest, reply: FastifyReply, kind: 'register' | 'login'): string | null {
  const raw = req.cookies[WA_COOKIE];
  reply.clearCookie(WA_COOKIE, { path: '/' });
  if (!raw) return null;
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return null;
  try {
    const v = JSON.parse(un.value) as { kind: string; challenge: string; exp: number };
    return v.kind === kind && v.exp > Date.now() ? v.challenge : null;
  } catch {
    return null;
  }
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== 'admin') {
    reply.code(403).type('text/plain; charset=utf-8').send('Réservé aux administrateurs.');
    return false;
  }
  return true;
}

async function adminCount() {
  return Number((await db.selectFrom('users').select(db.fn.countAll<number>().as('n')).where('role', '=', 'admin').executeTakeFirstOrThrow()).n);
}

export async function securityRoutes(app: FastifyInstance) {
  // ================= Passkeys : enregistrement (compte connecté) =================
  app.post('/compte/passkeys/options', async (req, reply) => {
    const user = await db.selectFrom('users').select(['id', 'username']).where('id', '=', req.user!.id).executeTakeFirstOrThrow();
    const existing = await db.selectFrom('webauthn_credentials').select(['credential_id', 'transports']).where('user_id', '=', user.id).execute();
    const options = await generateRegistrationOptions({
      rpName: 'Inventaire',
      rpID: rpID(),
      userName: user.username,
      userID: new TextEncoder().encode(`inventaire-${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports ? (c.transports.split(',') as any) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    setChallenge(reply, 'register', options.challenge);
    return reply.send(options);
  });

  app.post('/compte/passkeys/verifier', async (req, reply) => {
    const body = req.body as Body;
    const challenge = takeChallenge(req, reply, 'register');
    if (!challenge) return reply.code(400).send({ erreur: 'Demande expirée, recommencez.' });
    const name = str(body, 'name', 100) || 'Clé d’accès';
    try {
      const v = await verifyRegistrationResponse({
        response: body.response as any,
        expectedChallenge: challenge,
        expectedOrigin: origin(),
        expectedRPID: rpID(),
        requireUserVerification: true,
      });
      if (!v.verified || !v.registrationInfo) throw new Error('non vérifiée');
      const c = v.registrationInfo.credential;
      await db
        .insertInto('webauthn_credentials')
        .values({
          user_id: req.user!.id,
          credential_id: c.id,
          public_key: Buffer.from(c.publicKey).toString('base64url'),
          counter: c.counter,
          transports: c.transports?.join(',') ?? null,
          name,
        })
        .execute();
      await audit(req, 'compte', req.user!.id, 'passkey', `Clé d’accès ajoutée : ${name}`);
      alert('Clé d’accès ajoutée', [`Compte : ${req.user!.username}`, `Nom : ${name}`, `Adresse : ${req.ip}`]);
      return reply.send({ ok: true });
    } catch (e) {
      req.log.warn({ err: e }, 'échec enregistrement passkey');
      return reply.code(400).send({ erreur: 'La clé d’accès n’a pas pu être vérifiée.' });
    }
  });

  app.post('/compte/passkeys/:pid/supprimer', async (req, reply) => {
    const pid = id((req.params as Body).pid);
    const c = pid ? await db.selectFrom('webauthn_credentials').selectAll().where('id', '=', pid).where('user_id', '=', req.user!.id).executeTakeFirst() : undefined;
    if (!c) return reply.callNotFound();
    await db.deleteFrom('webauthn_credentials').where('id', '=', c.id).execute();
    await audit(req, 'compte', req.user!.id, 'passkey', `Clé d’accès supprimée : ${c.name}`);
    alert('Clé d’accès supprimée', [`Compte : ${req.user!.username}`, `Nom : ${c.name}`, `Adresse : ${req.ip}`]);
    setFlash(reply, 'ok', 'Clé d’accès supprimée.');
    return redirect(req, reply, '/compte#passkeys');
  });

  // ================= Passkeys : connexion (anonyme) =================
  app.post('/login/passkey/options', async (req, reply) => {
    const options = await generateAuthenticationOptions({ rpID: rpID(), userVerification: 'required', allowCredentials: [] });
    setChallenge(reply, 'login', options.challenge);
    return reply.send(options);
  });

  app.post('/login/passkey/verifier', async (req, reply) => {
    const body = req.body as Body;
    const challenge = takeChallenge(req, reply, 'login');
    const fail = async (why: string) => {
      await audit(req, 'connexion', null, 'echec', `Échec de connexion par clé d’accès (${why})`);
      return reply.code(401).send({ erreur: 'Connexion par clé d’accès impossible.' });
    };
    if (!challenge) return fail('demande expirée');
    const response = body.response as any;
    const credId = typeof response?.id === 'string' ? response.id.slice(0, 512) : '';
    const cred = credId
      ? await db
          .selectFrom('webauthn_credentials')
          .innerJoin('users', 'users.id', 'webauthn_credentials.user_id')
          .select(['webauthn_credentials.id', 'webauthn_credentials.credential_id', 'webauthn_credentials.public_key', 'webauthn_credentials.counter', 'webauthn_credentials.transports', 'webauthn_credentials.name', 'users.id as uid', 'users.locked_until'])
          .where('webauthn_credentials.credential_id', '=', credId)
          .executeTakeFirst()
      : undefined;
    if (!cred) return fail('clé inconnue');
    if (cred.locked_until && new Date(cred.locked_until).getTime() > Date.now()) return fail('compte verrouillé');
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin(),
        expectedRPID: rpID(),
        requireUserVerification: true,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
          counter: Number(cred.counter),
          transports: cred.transports ? (cred.transports.split(',') as any) : undefined,
        },
      });
      if (!v.verified) return fail('signature invalide');
      await db
        .updateTable('webauthn_credentials')
        .set({ counter: v.authenticationInfo.newCounter, last_used_at: new Date() })
        .where('id', '=', cred.id)
        .execute();
      const next = await completeLoginFromPasskey(req, reply, cred.uid, cred.name);
      return reply.send({ ok: true, next });
    } catch (e) {
      req.log.warn({ err: e }, 'échec connexion passkey');
      return fail('vérification impossible');
    }
  });

  // ================= Jetons d'API (Mon compte) =================
  app.post('/compte/jetons', async (req, reply) => {
    const body = req.body as Body;
    const name = str(body, 'name', 100);
    if (!name) {
      setFlash(reply, 'erreur', 'Donnez un nom au jeton (ex. Home Assistant).');
      return redirect(req, reply, '/compte#jetons');
    }
    const scope = req.user!.role === 'admin' && str(body, 'scope') === 'ecriture' ? 'ecriture' : 'lecture';
    const days = intIn(body.days, 0, 3650, 0);
    const token = `inv_${randomToken(32)}`;
    await db
      .insertInto('api_tokens')
      .values({ user_id: req.user!.id, name, prefix: token.slice(0, 12), token_hash: sha256(token), scope, expires_at: days ? new Date(Date.now() + days * 86400_000) : null })
      .execute();
    await audit(req, 'compte', req.user!.id, 'jeton', `Jeton d’API créé : ${name} (${scope})`);
    alert('Jeton d’API créé', [`Compte : ${req.user!.username}`, `Nom : ${name} (${scope})`, `Adresse : ${req.ip}`]);
    // Le jeton n'est affiché qu'une seule fois (seule son empreinte est conservée).
    setFlash(reply, 'info', `Jeton « ${name} » créé. Copiez-le maintenant, il ne sera plus affiché : ${token}`);
    return redirect(req, reply, '/compte#jetons');
  });

  app.post('/compte/jetons/:tid/supprimer', async (req, reply) => {
    const tid = id((req.params as Body).tid);
    const t = tid ? await db.selectFrom('api_tokens').selectAll().where('id', '=', tid).where('user_id', '=', req.user!.id).executeTakeFirst() : undefined;
    if (!t) return reply.callNotFound();
    await db.deleteFrom('api_tokens').where('id', '=', t.id).execute();
    await audit(req, 'compte', req.user!.id, 'jeton', `Jeton d’API révoqué : ${t.name}`);
    setFlash(reply, 'ok', 'Jeton révoqué.');
    return redirect(req, reply, '/compte#jetons');
  });

  // ================= Gestion des comptes (administrateurs) =================
  app.get('/administration/comptes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const users = await db
      .selectFrom('users')
      .select(['id', 'username', 'role', 'totp_enabled', 'locked_until', 'created_at', 'oidc_sub'])
      .orderBy('username')
      .execute();
    const pk = await db.selectFrom('webauthn_credentials').select(['user_id', db.fn.countAll<number>().as('n')]).groupBy('user_id').execute();
    const lastLogin = await db
      .selectFrom('audit_log')
      .select(['entity_id', db.fn.max('created_at').as('at')])
      .where('entity', '=', 'connexion')
      .where('action', '=', 'succes')
      .groupBy('entity_id')
      .execute();
    return render(req, reply, 'accounts', {
      title: 'Comptes',
      users: users.map((u) => ({
        ...u,
        passkeys: Number(pk.find((p) => p.user_id === u.id)?.n ?? 0),
        lastLogin: lastLogin.find((l) => l.entity_id === u.id)?.at ?? null,
        locked: !!u.locked_until && new Date(u.locked_until).getTime() > Date.now(),
      })),
      minLength: config.passwordMinLength,
    });
  });

  app.post('/administration/comptes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body as Body;
    const username = str(body, 'username', 64);
    const role = str(body, 'role') === 'admin' ? 'admin' : 'lecture';
    const password = String(body.password ?? '').slice(0, 300);
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) setFlash(reply, 'erreur', 'Identifiant invalide (3 à 64 caractères : lettres, chiffres, . _ -).');
    else if (await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()) setFlash(reply, 'erreur', 'Cet identifiant existe déjà.');
    else if (passwordProblems(password, username)) setFlash(reply, 'erreur', passwordProblems(password, username)!);
    else {
      const r = await db
        .insertInto('users')
        .values({ username, role, password_hash: await hashPassword(password), totp_enabled: 0, failed_attempts: 0, password_changed_at: new Date() })
        .executeTakeFirstOrThrow();
      await audit(req, 'compte', Number(r.insertId), 'creation', `Compte « ${username} » créé (${role === 'admin' ? 'administrateur' : 'lecture seule'})`);
      alert('Nouveau compte', [`Compte : ${username} (${role === 'admin' ? 'administrateur' : 'lecture seule'})`, `Créé par : ${req.user!.username}`]);
      setFlash(reply, 'ok', `Compte « ${username} » créé. La double authentification sera configurée à sa première connexion.`);
    }
    return redirect(req, reply, '/administration/comptes');
  });

  app.post('/administration/comptes/:uid', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const uid = id((req.params as Body).uid);
    const u = uid ? await db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirst() : undefined;
    if (!u) return reply.callNotFound();
    const body = req.body as Body;
    const action = str(body, 'action');
    const back = () => redirect(req, reply, '/administration/comptes');
    switch (action) {
      case 'rename': {
        const username = str(body, 'username', 64);
        if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
          setFlash(reply, 'erreur', 'Identifiant invalide (3 à 64 caractères : lettres, chiffres, . _ -).');
          return back();
        }
        if (username === u.username) {
          setFlash(reply, 'ok', 'Identifiant inchangé.');
          return back();
        }
        const taken = await db.selectFrom('users').select('id').where('username', '=', username).where('id', '!=', u.id).executeTakeFirst();
        if (taken) {
          setFlash(reply, 'erreur', `L’identifiant « ${username} » est déjà utilisé.`);
          return back();
        }
        await db.updateTable('users').set({ username }).where('id', '=', u.id).execute();
        await audit(req, 'compte', u.id, 'renommage', `Compte « ${u.username} » renommé en « ${username} » par ${req.user!.username}`, { Identifiant: { avant: u.username, apres: username } });
        alert('Compte renommé', [`Ancien identifiant : ${u.username}`, `Nouvel identifiant : ${username}`, `Par : ${req.user!.username}`]);
        setFlash(reply, 'ok', u.id === req.user!.id ? `Votre identifiant est maintenant « ${username} » : utilisez-le à la prochaine connexion.` : `« ${u.username} » renommé en « ${username} ».`);
        return back();
      }
      case 'role': {
        const role = str(body, 'role') === 'admin' ? 'admin' : 'lecture';
        if (u.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) {
          setFlash(reply, 'erreur', 'Impossible : il doit rester au moins un administrateur.');
          return back();
        }
        await db.updateTable('users').set({ role }).where('id', '=', u.id).execute();
        if (role === 'lecture') await db.updateTable('api_tokens').set({ scope: 'lecture' }).where('user_id', '=', u.id).execute();
        await audit(req, 'compte', u.id, 'role', `Rôle de « ${u.username} » : ${role === 'admin' ? 'administrateur' : 'lecture seule'}`);
        alert('Rôle modifié', [`Compte : ${u.username}`, `Nouveau rôle : ${role === 'admin' ? 'administrateur' : 'lecture seule'}`, `Par : ${req.user!.username}`]);
        setFlash(reply, 'ok', 'Rôle modifié.');
        return back();
      }
      case 'password': {
        const pw = String(body.password ?? '').slice(0, 300);
        const problem = passwordProblems(pw, u.username);
        if (problem) {
          setFlash(reply, 'erreur', problem);
          return back();
        }
        await db.updateTable('users').set({ password_hash: await hashPassword(pw), password_changed_at: new Date(), failed_attempts: 0, locked_until: null }).where('id', '=', u.id).execute();
        if (u.id !== req.user!.id) await db.deleteFrom('sessions').where('user_id', '=', u.id).execute();
        await audit(req, 'compte', u.id, 'mot-de-passe', `Mot de passe de « ${u.username} » réinitialisé par ${req.user!.username}`);
        alert('Mot de passe réinitialisé', [`Compte : ${u.username}`, `Par : ${req.user!.username}`]);
        setFlash(reply, 'ok', 'Mot de passe réinitialisé, sessions de ce compte fermées.');
        return back();
      }
      case 'totp': {
        if (u.id === req.user!.id) {
          setFlash(reply, 'erreur', 'Pour votre propre compte, utilisez « Mon compte ».');
          return back();
        }
        await db.updateTable('users').set({ totp_secret_enc: null, totp_enabled: 0, totp_last_step: null }).where('id', '=', u.id).execute();
        await db.deleteFrom('sessions').where('user_id', '=', u.id).execute();
        await audit(req, 'compte', u.id, 'totp', `TOTP de « ${u.username} » réinitialisé par ${req.user!.username}`);
        alert('TOTP réinitialisé', [`Compte : ${u.username}`, `Par : ${req.user!.username}`]);
        setFlash(reply, 'ok', 'TOTP réinitialisé : nouvel enrôlement à la prochaine connexion.');
        return back();
      }
      case 'unlock': {
        await db.updateTable('users').set({ failed_attempts: 0, locked_until: null }).where('id', '=', u.id).execute();
        await audit(req, 'compte', u.id, 'deverrouillage', `Compte « ${u.username} » déverrouillé par ${req.user!.username}`);
        setFlash(reply, 'ok', 'Compte déverrouillé.');
        return back();
      }
      case 'delete': {
        if (u.id === req.user!.id) {
          setFlash(reply, 'erreur', 'Vous ne pouvez pas supprimer votre propre compte.');
          return back();
        }
        if (u.role === 'admin' && (await adminCount()) <= 1) {
          setFlash(reply, 'erreur', 'Impossible : il doit rester au moins un administrateur.');
          return back();
        }
        await db.deleteFrom('users').where('id', '=', u.id).execute();
        await audit(req, 'compte', u.id, 'suppression', `Compte « ${u.username} » supprimé par ${req.user!.username}`);
        alert('Compte supprimé', [`Compte : ${u.username}`, `Par : ${req.user!.username}`]);
        setFlash(reply, 'ok', `Compte « ${u.username} » supprimé.`);
        return back();
      }
    }
    return reply.code(400).send('Action inconnue');
  });
}

export { createSession };
