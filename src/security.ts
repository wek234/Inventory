import crypto from 'node:crypto';
import argon2 from 'argon2';
import { config } from './config.js';

// Jetons aléatoires (identifiants de session, CSRF, noms de fichiers).
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Chiffrement AES-256-GCM des secrets TOTP au repos (clé dérivée de APP_SECRET).
const encKey = crypto.createHmac('sha256', config.appSecret).update('totp-encryption-v1').digest();
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
export function decrypt(payload: string): string {
  const [v, iv, tag, enc] = payload.split('.');
  if (v !== 'v1') throw new Error('format de secret inconnu');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// Hachage des mots de passe : argon2id (64 Mio, 3 passes).
export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}
export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}
// Hash factice pour garder un temps de réponse constant quand l'utilisateur n'existe pas.
let dummyHash: string | null = null;
export async function dummyVerify(pw: string) {
  if (!dummyHash) dummyHash = await hashPassword('inventaire-mot-de-passe-factice');
  await verifyPassword(dummyHash, pw);
}

export function passwordProblems(pw: string, username?: string): string | null {
  if (pw.length < config.passwordMinLength) return `Le mot de passe doit faire au moins ${config.passwordMinLength} caractères.`;
  if (pw.length > 256) return 'Le mot de passe est trop long (256 caractères maximum).';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "Le mot de passe ne doit pas contenir l'identifiant.";
  return null;
}
