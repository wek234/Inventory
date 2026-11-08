// Lecture sûre des champs de formulaire (application/x-www-form-urlencoded).
export type Body = Record<string, unknown>;

export function str(body: Body, key: string, max = 1000): string {
  const v = body?.[key];
  const s = Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? '' : String(v);
  return s.trim().slice(0, max);
}
export function strs(body: Body, key: string, max = 5000): string[] {
  const v = body?.[key];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x ?? '').trim().slice(0, max));
}
export function optStr(body: Body, key: string, max = 1000): string | null {
  const s = str(body, key, max);
  return s === '' ? null : s;
}
export function id(v: unknown): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}
export function intIn(v: unknown, min: number, max: number, def: number): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}
export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
