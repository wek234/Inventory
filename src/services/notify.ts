// Alertes Telegram (bot) : événements de sécurité et nouvelles versions. Désactivé si le jeton n'est pas configuré.
import { config } from '../config.js';
import { db } from '../db.js';

const recent: number[] = [];

export function telegramEnabled() {
  return !!(config.telegram.token && config.telegram.chatId);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Envoie un message (HTML Telegram). Jamais bloquant pour l'appelant ; limité à 20 messages par minute.
export async function notify(title: string, lines: string[] = []): Promise<{ ok: boolean; error?: string }> {
  if (!telegramEnabled()) return { ok: false, error: 'Telegram non configuré' };
  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= 20) return { ok: false, error: 'Trop de messages, envoi limité' };
  recent.push(now);
  const host = new URL(config.publicUrl).host;
  const text = [`<b>${esc(title)}</b>`, ...lines.map(esc), `<i>${esc(host)}</i>`].join('\n').slice(0, 4000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, error: `Telegram a répondu ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Telegram injoignable depuis le serveur' };
  }
}

// Variante « tirer et oublier » pour les événements : n'interrompt jamais une requête.
export function alert(title: string, lines: string[] = []) {
  if (!telegramEnabled()) return;
  void notify(title, lines).catch(() => undefined);
}

// Série d'échecs de connexion : une alerte au plus par heure, au-delà de 10 échecs en 15 minutes.
const failures: number[] = [];
export function recordLoginFailure(ip: string) {
  const now = Date.now();
  failures.push(now);
  while (failures.length && now - failures[0] > 15 * 60_000) failures.shift();
  if (failures.length >= 10) void burstAlert(ip, failures.length);
}
async function burstAlert(ip: string, count: number) {
  const last = await getMeta('alert_failures_at');
  if (last && Date.now() - Number(last) < 3600_000) return;
  await setMeta('alert_failures_at', String(Date.now()));
  alert('Série d’échecs de connexion', [`${count} échecs en 15 minutes`, `Dernière adresse : ${ip}`]);
}

export async function getMeta(k: string): Promise<string | null> {
  const r = await db.selectFrom('app_meta').select('v').where('k', '=', k).executeTakeFirst();
  return r?.v ?? null;
}
export async function setMeta(k: string, v: string) {
  await db.insertInto('app_meta').values({ k, v }).onDuplicateKeyUpdate({ v }).execute();
}
