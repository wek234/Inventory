// Données initiales (exemples modifiables dans l'interface). N'insère rien si les tables contiennent déjà des données.
import { db, AttrType } from './db.js';

export const STATUS_COLORS = ['gris', 'vert', 'jaune', 'orange', 'rouge', 'bleu', 'violet'] as const;

const STATUSES: [string, string][] = [
  ['OK', 'vert'],
  ['SEMI-HS', 'orange'],
  ['HS', 'rouge'],
  ['À réparer', 'jaune'],
  ['En réparation', 'bleu'],
  ['Prêté', 'violet'],
  ['Vendu', 'gris'],
  ['Donné', 'gris'],
];

// Un seul emplacement de départ : les autres se créent dans l'interface (Emplacements).
const LOCATIONS = ['À classer'];

type DefSeed = [string, AttrType, string | null, string[] | null];
interface CatSeed {
  name: string;
  defs?: DefSeed[];
  children?: CatSeed[];
}

const STORAGE_TYPES = ['HDD', 'SSD', 'NVMe', 'SSHD', 'SAS', 'IDE'];
const storage = (n: number): DefSeed[] => [
  [`Stockage ${n} capacité`, 'number', 'Go', null],
  [`Stockage ${n} type`, 'select', null, STORAGE_TYPES],
  [`Stockage ${n} modèle`, 'text', null, null],
];

const CATEGORIES: CatSeed[] = [
  {
    name: 'Hi-Fi',
    defs: [['Année', 'number', null, null]],
    children: [
      { name: 'Amplis', children: [{ name: 'Ampli' }, { name: 'Ampli-tuner' }, { name: 'Chaîne compacte' }] },
      { name: 'Sources', children: [{ name: 'Lecteur CD' }, { name: 'Platine K7' }, { name: 'Tuner' }, { name: 'Platine vinyle' }] },
      { name: 'Enceintes', children: [{ name: 'Bibliothèque' }, { name: 'Medium' }] },
    ],
  },
  { name: 'TV' },
  {
    name: 'Informatique',
    defs: [
      ['Processeur', 'text', null, null],
      ['RAM', 'number', 'Go', null],
      ['Type RAM', 'text', null, null],
      ['Carte mère', 'text', null, null],
      ['Graphique', 'text', null, null],
      ['Réseau', 'text', null, null],
      ['Son', 'text', null, null],
      ...storage(1),
      ...storage(2),
      ['Lecteur optique', 'text', null, null],
      ['Écran', 'text', null, null],
      ['Dispositif de pointage', 'text', null, null],
      ['OS', 'text', null, null],
      ['Année', 'number', null, null],
    ],
    children: [{ name: 'Portables' }, { name: 'Fixes' }, { name: 'Serveurs' }],
  },
];

async function isEmpty(table: 'statuses' | 'locations' | 'categories') {
  const r = await db.selectFrom(table).select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  return Number(r.n) === 0;
}

export async function seed() {
  if (await isEmpty('statuses')) {
    await db
      .insertInto('statuses')
      .values(STATUSES.map(([name, color], i) => ({ name, color, sort_order: i, to_handle: ['À réparer', 'En réparation'].includes(name) ? 1 : 0 })))
      .execute();
    console.log(`${STATUSES.length} statut(s) créé(s)`);
  }
  if (await isEmpty('locations')) {
    for (const name of LOCATIONS) await db.insertInto('locations').values({ name, parent_id: null }).execute();
    console.log(`${LOCATIONS.length} emplacement(s) créé(s)`);
  }
  if (await isEmpty('categories')) {
    const insert = async (c: CatSeed, parent: number | null) => {
      const r = await db.insertInto('categories').values({ name: c.name, parent_id: parent }).executeTakeFirstOrThrow();
      const id = Number(r.insertId);
      for (const [i, [name, type, unit, options]] of (c.defs ?? []).entries()) {
        await db
          .insertInto('attribute_defs')
          .values({ category_id: id, name, type, unit, options: options ? JSON.stringify(options) : null, sort_order: i })
          .execute();
      }
      for (const ch of c.children ?? []) await insert(ch, id);
    };
    for (const c of CATEGORIES) await insert(c, null);
    console.log('catégories et caractéristiques créées');
  }
}
