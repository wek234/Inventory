// Recherche « début de mot » : « hp » trouve « HP EliteBook » ou « Carte HP-UX », pas « touchpad ».
// Insensible à la casse et aux accents (« ecran » trouve « Écran »).
import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';

const VARIANTS: Record<string, string> = {
  a: 'aàâäáãå', c: 'cç', e: 'eéèêë', i: 'iîïíì', o: 'oôöóòõ', u: 'uùûüú', y: 'yÿý', n: 'nñ',
};
const BASE: Record<string, string> = {};
for (const [b, list] of Object.entries(VARIANTS)) for (const ch of list) BASE[ch] = b;

function charPattern(ch: string): string {
  const lower = ch.toLowerCase();
  const base = BASE[lower];
  if (base) {
    const list = VARIANTS[base];
    return `[${list}${list.toUpperCase()}]`;
  }
  if (/\s/.test(ch)) return '\\s+';
  return /[\\^$.|?*+()[\]{}\-\/#]/.test(ch) ? '\\' + ch : ch;
}

/** Motif PCRE (MariaDB REGEXP) : le texte cherché au début d'un mot. */
export function wordStartPattern(q: string): string {
  const t = q.trim().replace(/\s+/g, ' ');
  return '(?i)(?<![\\p{L}\\p{N}])' + [...t].map(charPattern).join('');
}

/** Condition SQL « colonne REGEXP motif ». */
export function wordStart(col: Expression<unknown> | RawBuilder<unknown>, pattern: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`${col} REGEXP ${pattern}`;
}

const strip = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');

/** Même règle côté serveur, pour filtrer des listes déjà chargées (emplacements, catégories, pages). */
export function matchesWordStart(text: string, q: string): boolean {
  const t = strip(q.trim().replace(/\s+/g, ' '));
  if (!t) return false;
  const esc = t.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp('(?<![\\p{L}\\p{N}])' + esc, 'iu').test(strip(text));
}
