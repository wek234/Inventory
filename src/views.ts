// Rendu des pages (Eta, échappement HTML automatique) et utilitaires communs aux gabarits.
import path from 'node:path';
import { Eta } from 'eta';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { displayValue, formatNumber, rawValue, ATTR_TYPES } from './services/attributes.js';
import { icon } from './icons.js';

const eta = new Eta({
  views: path.join(config.appRoot, 'views'),
  cache: process.env.NODE_ENV === 'production',
  autoEscape: true,
  autoTrim: false,
});

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: config.timezone });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' });

export const helpers = {
  dateTime: (d: Date | string | null) => (d ? dateFmt.format(new Date(d)) : ''),
  day: (d: string | null) => (d ? dayFmt.format(new Date(d + 'T00:00:00Z')) : ''),
  num: formatNumber,
  value: displayValue,
  raw: rawValue,
  attrTypes: ATTR_TYPES,
  attrTypeLabel: (t: string) => ATTR_TYPES.find((x) => x.value === t)?.label ?? t,
  // Construit une query string en conservant les filtres courants.
  qs: (params: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...overrides })) {
      if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : '';
  },
  plural: (n: number, one: string, many: string) => `${formatNumber(n)} ${Math.abs(n) > 1 ? many : one}`,
  icon,
  indent: (depth: number) => '   '.repeat(depth),
};

export interface Flash {
  type: 'ok' | 'erreur' | 'info';
  msg: string;
}

export function setFlash(reply: FastifyReply, type: Flash['type'], msg: string) {
  reply.setCookie('inv_flash', JSON.stringify({ type, msg }), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    signed: true,
    maxAge: 60,
  });
}

function readFlash(req: FastifyRequest, reply: FastifyReply): Flash | null {
  const raw = req.cookies['inv_flash'];
  if (!raw) return null;
  reply.clearCookie('inv_flash', { path: '/' });
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return null;
  try {
    return JSON.parse(un.value);
  } catch {
    return null;
  }
}

export function render(req: FastifyRequest, reply: FastifyReply, template: string, data: Record<string, unknown> = {}, status = 200) {
  const theme = ['light', 'dark'].includes(req.cookies['inv_theme'] ?? '') ? req.cookies['inv_theme'] : 'auto';
  const html = eta.render(template, {
    ...data,
    user: req.user ?? null,
    csrf: req.session?.csrf ?? req.anonCsrf ?? '',
    theme,
    path: req.url.split('?')[0],
    flash: readFlash(req, reply),
    oidc: { enabled: config.oidc.enabled, label: config.oidc.label },
    h: helpers,
  });
  return reply.code(status).type('text/html; charset=utf-8').send(html);
}

export function isHtmx(req: FastifyRequest) {
  return req.headers['hx-request'] === 'true';
}

// Redirection compatible HTMX.
export function redirect(req: FastifyRequest, reply: FastifyReply, url: string) {
  if (isHtmx(req)) return reply.header('HX-Redirect', url).code(204).send();
  return reply.redirect(url, 303);
}
