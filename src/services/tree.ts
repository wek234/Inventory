// Outils pour les arborescences (emplacements et catégories).
import { db, TreeNode } from '../db.js';

export type TreeTableName = 'locations' | 'categories';

export interface TreeEntry extends TreeNode {
  depth: number;
  path: string; // "Maison > Bureau > Étagère"
  ancestors: number[]; // du parent racine au parent direct
  children: TreeEntry[];
}

export interface Tree {
  roots: TreeEntry[];
  byId: Map<number, TreeEntry>;
  flat: TreeEntry[]; // ordre d'affichage (parcours en profondeur, tri alphabétique)
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

export async function loadTree(table: TreeTableName): Promise<Tree> {
  const rows = await db.selectFrom(table).selectAll().execute();
  const byId = new Map<number, TreeEntry>();
  for (const r of rows) byId.set(r.id, { ...r, depth: 0, path: r.name, ancestors: [], children: [] });
  const roots: TreeEntry[] = [];
  for (const e of byId.values()) {
    const p = e.parent_id ? byId.get(e.parent_id) : undefined;
    if (p) p.children.push(e);
    else roots.push(e);
  }
  const flat: TreeEntry[] = [];
  const walk = (list: TreeEntry[], depth: number, anc: number[], prefix: string) => {
    list.sort((a, b) => {
      // « À classer » toujours en dernier parmi les racines
      if (depth === 0 && (a.name === 'À classer') !== (b.name === 'À classer')) return a.name === 'À classer' ? 1 : -1;
      return collator.compare(a.name, b.name);
    });
    for (const e of list) {
      e.depth = depth;
      e.ancestors = anc;
      e.path = prefix ? `${prefix} > ${e.name}` : e.name;
      flat.push(e);
      walk(e.children, depth + 1, [...anc, e.id], e.path);
    }
  };
  walk(roots, 0, [], '');
  return { roots, byId, flat };
}

export function descendantIds(tree: Tree, id: number): number[] {
  const out: number[] = [];
  const start = tree.byId.get(id);
  if (!start) return out;
  const stack = [start];
  while (stack.length) {
    const e = stack.pop()!;
    out.push(e.id);
    stack.push(...e.children);
  }
  return out;
}

// Chaîne des ancêtres + le nœud lui-même, de la racine vers le nœud.
export function lineage(tree: Tree, id: number | null | undefined): TreeEntry[] {
  if (!id) return [];
  const e = tree.byId.get(id);
  if (!e) return [];
  return [...e.ancestors.map((a) => tree.byId.get(a)!), e];
}

export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function nameTakenAmongSiblings(table: TreeTableName, parentId: number | null, name: string, exceptId?: number) {
  let q = db.selectFrom(table).select(['id', 'name']);
  q = parentId === null ? q.where('parent_id', 'is', null) : q.where('parent_id', '=', parentId);
  const rows = await q.execute();
  const n = normalizeName(name);
  return rows.some((r) => r.id !== exceptId && normalizeName(r.name) === n);
}
