// TOTP (RFC 6238) : codes à 6 chiffres, pas de 30 s, tolérance d'un pas, protection contre le rejeu.
import { generateSecret, generateURI, verifySync } from 'otplib';

export function newTotpSecret(): string {
  return generateSecret();
}

export function totpUri(account: string, issuer: string, secret: string): string {
  return generateURI({ issuer, label: account, secret });
}

// Renvoie le pas de temps utilisé si le code est valide et n'a jamais servi, sinon null.
export function checkTotp(secret: string, code: string, lastStep: number | null): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  try {
    const r = verifySync({ secret, token: clean, epochTolerance: 30, ...(lastStep !== null ? { afterTimeStep: lastStep } : {}) });
    return r.valid && typeof (r as { timeStep?: number }).timeStep === 'number' ? (r as { timeStep: number }).timeStep : null;
  } catch {
    return null;
  }
}
