// Lecture d'un classeur Excel (.xlsx) ou d'un CSV en grilles de chaînes, puis extraction d'enregistrements.
import readXlsxFile from 'read-excel-file/node';
import { parse as parseCsv } from 'csv-parse/sync';

export type Grid = (string | null)[][];
export interface RawSheet {
  name: string;
  grid: Grid;
}

function cellToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10)));
  }
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellToString(o.result);
    if ('richText' in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('') || null;
    if ('text' in o) return cellToString(o.text);
    if ('error' in o) return null;
    return null;
  }
  const s = String(v).replace(/ /g, ' ');
  return s.trim() === '' ? null : s;
}

export async function readWorkbook(buf: Buffer, filename: string): Promise<RawSheet[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    let text = buf.toString('utf8');
    if (text.includes('�')) text = buf.toString('latin1');
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
    const rows = parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: false, bom: true }) as string[][];
    if (rows.length > 20000) throw new Error('Fichier trop long (20 000 lignes maximum).');
    return [{ name: filename.replace(/\.[^.]+$/, '').slice(0, 60) || 'CSV', grid: rows.map((r) => r.map(cellToString)) }];
  }
  const book = await readXlsxFile(buf);
  return book.map((ws) => ({
    name: String(ws.sheet).slice(0, 60),
    grid: ws.data.slice(0, 20000).map((row) => row.slice(0, 200).map(cellToString)),
  }));
}

// Lit le répertoire central d'une archive ZIP (.xlsx) sans rien décompresser.
// Refuse les archives dont la taille décompressée totale ou le taux de compression sont anormaux.
const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_RATIO = 500;
export function zipInfo(buf: Buffer): { ok: true; total: number } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  // Fin du répertoire central (EOCD) : signature 0x06054b50 dans les 64 derniers Ko.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return bad('Fichier .xlsx invalide (archive illisible).');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) return bad('Archive ZIP64 non prise en charge.');
  if (entries > MAX_ENTRIES) return bad('Fichier .xlsx refusé : trop de fichiers internes.');
  if (cdOffset + cdSize > buf.length) return bad('Fichier .xlsx invalide (répertoire central hors limites).');
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return bad('Fichier .xlsx invalide (répertoire central corrompu).');
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff || compressed === 0xffffffff) return bad('Archive ZIP64 non prise en charge.');
    if (compressed > 0 && size / compressed > MAX_RATIO && size > 1024 * 1024) return bad('Fichier .xlsx refusé : taux de compression anormal (bombe de décompression ?).');
    total += size;
    if (total > MAX_UNCOMPRESSED) return bad('Fichier .xlsx refusé : plus de 100 Mo une fois décompressé.');
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { ok: true, total };
}

const AUTO_HEADER = /^(colonne|column)\s*\d+$/i;
const colLetter = (i: number) => {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

export interface Extracted {
  headers: string[];
  synthetic: Set<string>; // en-têtes générés (colonne sans titre)
  records: Record<string, string | null>[];
}

const isBlank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} (${n})` : h;
  });
}

// Disposition « lignes » : une ligne d'en-têtes puis un objet par ligne.
export function extractRows(grid: Grid, hasHeader: boolean): Extracted {
  const rows = grid.filter((r) => r.some((c) => !isBlank(c)));
  if (!rows.length) return { headers: [], synthetic: new Set(), records: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const used: number[] = [];
  for (let c = 0; c < width; c++) if (rows.some((r) => !isBlank(r[c]))) used.push(c);
  const headerRow = hasHeader ? rows[0] : null;
  const synthetic = new Set<string>();
  const rawHeaders = used.map((c) => {
    const h = headerRow?.[c]?.trim();
    if (h && !AUTO_HEADER.test(h)) return h.slice(0, 120);
    const s = `Colonne ${colLetter(c)}`;
    synthetic.add(s);
    return s;
  });
  const headers = uniqueHeaders(rawHeaders);
  const data = hasHeader ? rows.slice(1) : rows;
  const records = data.map((r) => Object.fromEntries(used.map((c, i) => [headers[i], isBlank(r[c]) ? null : r[c]!.trim()])));
  return { headers, synthetic, records };
}

// Disposition « colonnes » : une colonne d'intitulés (Nom, Machine, Processeur…) puis un objet par colonne.
// Les intitulés peuvent être décalés (cellules vides ou « Colonne N » avant) : on prend la première vraie cellule.
export function extractColumns(grid: Grid): Extracted {
  const lines: { label: string; values: (string | null)[] }[] = [];
  for (const r of grid) {
    let i = 0;
    while (i < r.length && (isBlank(r[i]) || AUTO_HEADER.test(r[i]!.trim()))) i++;
    if (i >= r.length) continue;
    const label = r[i]!.trim().slice(0, 120);
    const values = r.slice(i + 1).map((v) => (isBlank(v) ? null : v!.trim()));
    lines.push({ label, values });
  }
  const headers = uniqueHeaders(lines.map((l) => l.label));
  const count = Math.max(0, ...lines.map((l) => {
    let n = l.values.length;
    while (n > 0 && l.values[n - 1] === null) n--;
    return n;
  }));
  const records: Record<string, string | null>[] = [];
  for (let j = 0; j < count; j++) records.push(Object.fromEntries(lines.map((l, k) => [headers[k], l.values[j] ?? null])));
  return { headers, synthetic: new Set(), records };
}

const KNOWN_LABELS = ['nom', 'machine', 'processeur', 'memoire', 'ram', 'stockage 1', 'o s', 'os', 'annee', 'marque', 'modele'];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Devine la disposition d'une feuille.
export function detectLayout(grid: Grid): { layout: 'rows' | 'columns'; header: boolean } {
  const labels: string[] = [];
  for (const r of grid) {
    let i = 0;
    while (i < r.length && (isBlank(r[i]) || AUTO_HEADER.test(r[i]!.trim()))) i++;
    if (i < r.length) labels.push(norm(r[i]!));
  }
  const firstColHits = labels.filter((l) => ['nom', 'machine', 'processeur', 'memoire', 'stockage 1', 'o s'].includes(l)).length;
  if (firstColHits >= 3) return { layout: 'columns', header: true };
  const first = grid.find((r) => r.some((c) => !isBlank(c))) ?? [];
  const headerHits = first.filter((c) => c && KNOWN_LABELS.concat(['lieu', 'type', 'etat', 'description', 'date', 'statut', 'emplacement', 'categorie', 'notes', 'quantite', 'id']).includes(norm(c))).length;
  return { layout: 'rows', header: headerHits >= 1 };
}

export { norm, isBlank };
