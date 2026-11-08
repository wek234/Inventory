// Configuration lue dans les variables d'environnement (fichier /etc/inventory/inventory.env chargé par systemd).
import path from 'node:path';

function env(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (def === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
    return def;
  }
  return v;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(v.toLowerCase());
}
function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Valeur entière invalide pour ${name}`);
  return n;
}

const appSecret = env('APP_SECRET');
if (!/^[0-9a-f]{64}$/i.test(appSecret)) {
  throw new Error('APP_SECRET doit contenir 64 caractères hexadécimaux (32 octets). Générez-le avec : openssl rand -hex 32');
}

export const config = {
  appRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  listenHost: env('LISTEN_HOST', '0.0.0.0'),
  listenPort: int('LISTEN_PORT', 3000),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  // Proxys de confiance pour X-Forwarded-For / X-Forwarded-Proto (liste d'IP ou de plages CIDR).
  trustedProxies: env('TRUSTED_PROXIES', '127.0.0.1/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16')
    .split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: bool('COOKIE_SECURE', true),
  appSecret: Buffer.from(appSecret, 'hex'),
  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: env('DB_USER', 'inventory'),
    password: env('DB_PASSWORD'),
    database: env('DB_NAME', 'inventory'),
    socketPath: process.env.DB_SOCKET || undefined,
  },
  dataDir: env('DATA_DIR', '/var/lib/inventory/uploads'),
  maxUploadBytes: int('MAX_UPLOAD_MB', 20) * 1024 * 1024,
  sessionDays: int('SESSION_DAYS', 7),
  // Durée de vie maximale d'une session, même utilisée chaque jour.
  sessionMaxDays: int('SESSION_MAX_DAYS', 30),
  loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
  loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  passwordMinLength: int('PASSWORD_MIN_LENGTH', 12),
  oidc: {
    enabled: bool('OIDC_ENABLED', false),
    issuer: process.env.OIDC_ISSUER || '',
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    scopes: process.env.OIDC_SCOPES || 'openid profile email',
    label: process.env.OIDC_LABEL || 'SSO',
    // Si vrai, le code TOTP local est aussi demandé après une connexion SSO.
    requireLocalTotp: bool('OIDC_REQUIRE_LOCAL_TOTP', true),
  },
  timezone: env('APP_TIMEZONE', 'Europe/Paris'),
  // Alertes Telegram : jeton du bot (@BotFather) et identifiant de la conversation. Vides = désactivé.
  telegram: {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
  },
  // Dépôt GitHub « propriétaire/nom » interrogé pour signaler les nouvelles versions (vide = désactivé).
  updateRepo: (process.env.UPDATE_REPO ?? 'wek234/Inventory').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/(releases\/?)?$/, ''),
  logLevel: env('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
