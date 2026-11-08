// Formats d'étiquettes : rouleaux (Brother, Dymo) imprimés une étiquette par page, ou planches A4.
export interface LabelFormat {
  key: string;
  label: string;
  w: number; // largeur d'une étiquette (mm)
  h: number; // hauteur (mm)
  sheet?: { cols: number; rows: number; marginTop: number; marginLeft: number; gapX: number; gapY: number };
}

export const LABEL_FORMATS: LabelFormat[] = [
  { key: 'brother-62x29', label: 'Brother QL : 62 × 29 mm (DK-11209)', w: 62, h: 29 },
  { key: 'brother-62x100', label: 'Brother QL : 62 × 100 mm (DK-11202)', w: 62, h: 100 },
  { key: 'brother-29x90', label: 'Brother QL : 29 × 90 mm (DK-11201)', w: 90, h: 29 },
  { key: 'dymo-89x36', label: 'Dymo LabelWriter : 89 × 36 mm (99012)', w: 89, h: 36 },
  { key: 'dymo-54x25', label: 'Dymo LabelWriter : 54 × 25 mm (11352)', w: 54, h: 25 },
  { key: 'a4-70x37', label: 'Planche A4 : 3 × 8, 70 × 37 mm (type Avery 3474)', w: 70, h: 37, sheet: { cols: 3, rows: 8, marginTop: 0.5, marginLeft: 0, gapX: 0, gapY: 0 } },
  { key: 'a4-63x38', label: 'Planche A4 : 3 × 7, 63,5 × 38,1 mm (type Avery L7160)', w: 63.5, h: 38.1, sheet: { cols: 3, rows: 7, marginTop: 15.15, marginLeft: 7.2, gapX: 2.5, gapY: 0 } },
  { key: 'a4-48x25', label: 'Planche A4 : 4 × 10, 48,5 × 25,4 mm (type Avery L4736)', w: 48.5, h: 25.4, sheet: { cols: 4, rows: 10, marginTop: 21.5, marginLeft: 8, gapX: 0, gapY: 0 } },
];

export function resolveFormat(key: string, w?: number, h?: number): LabelFormat {
  if (key === 'perso') {
    const cw = Number.isFinite(w) ? Math.min(200, Math.max(20, w!)) : 62;
    const ch = Number.isFinite(h) ? Math.min(200, Math.max(12, h!)) : 29;
    return { key: 'perso', label: `Personnalisé : ${cw} × ${ch} mm`, w: cw, h: ch };
  }
  return LABEL_FORMATS.find((f) => f.key === key) ?? LABEL_FORMATS[0];
}

const mm = (n: number) => `${Math.round(n * 100) / 100}mm`;

// Feuille de style propre au format (servie comme fichier : compatible avec la CSP stricte).
export function formatCss(f: LabelFormat): string {
  const pad = Math.min(2, f.h * 0.07);
  const qr = Math.max(8, Math.min(f.h - 2 * pad, f.w * 0.45));
  const titleSize = Math.max(6, Math.min(12, f.h * 0.33));
  const subSize = Math.max(5, Math.min(9, f.h * 0.24));
  const common = `
.label-card { width: ${mm(f.w)}; height: ${mm(f.h)}; padding: ${mm(pad)}; grid-template-columns: ${mm(qr)} 1fr; gap: ${mm(pad)}; }
.label-card svg { width: ${mm(qr)}; height: ${mm(qr)}; }
.label-card .t { font-size: ${titleSize.toFixed(1)}pt; }
.label-card .s { font-size: ${subSize.toFixed(1)}pt; }
.label-card .c { font-size: ${Math.max(5, subSize - 0.5).toFixed(1)}pt; }
.labels { grid-template-columns: repeat(auto-fill, ${mm(f.w)}); }`;
  if (f.sheet) {
    const s = f.sheet;
    return `${common}
@media print {
  @page { size: A4 portrait; margin: 0; }
  .labels { display: grid; grid-template-columns: repeat(${s.cols}, ${mm(f.w)}); grid-auto-rows: ${mm(f.h)}; column-gap: ${mm(s.gapX)}; row-gap: ${mm(s.gapY)}; padding: ${mm(s.marginTop)} 0 0 ${mm(s.marginLeft)}; gap: ${mm(s.gapY)} ${mm(s.gapX)}; }
  .label-card { border: 0 !important; border-radius: 0; break-inside: avoid; }
  .label-card:nth-child(${s.cols * s.rows}n) { break-after: page; }
}`;
  }
  return `${common}
@media print {
  @page { size: ${mm(f.w)} ${mm(f.h)}; margin: 0; }
  .labels { display: block; }
  .label-card { border: 0 !important; border-radius: 0; break-after: page; page-break-after: always; }
}`;
}
