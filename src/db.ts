import { Kysely, MysqlDialect, Generated, Selectable } from 'kysely';
import { createPool } from 'mysql2';
import { config } from './config.js';

export type AttrType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface UsersTable {
  id: Generated<number>;
  username: string;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  oidc_sub: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  password_changed_at: Date;
  created_at: Generated<Date>;
}
export interface SessionsTable {
  id: string;
  user_id: number;
  state: 'pending_totp' | 'pending_enroll' | 'active';
  csrf: string;
  enroll_secret_enc: string | null;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  ip: string | null;
  user_agent: string | null;
}
export interface TreeTable {
  id: Generated<number>;
  parent_id: number | null;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AttributeDefsTable {
  id: Generated<number>;
  category_id: number;
  name: string;
  type: AttrType;
  unit: string | null;
  options: string | null; // JSON array pour le type select
  sort_order: number;
  optional: Generated<number>;
}
export interface StatusesTable {
  id: Generated<number>;
  name: string;
  color: string;
  sort_order: number;
  to_handle: Generated<number>;
}
export interface ItemsTable {
  id: Generated<number>;
  name: string;
  brand: string | null;
  model: string | null;
  serial: string | null;
  quantity: number;
  status_id: number | null;
  category_id: number | null;
  location_id: number | null;
  notes: string | null;
  label_printed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ItemNaTable {
  item_id: number;
  field: string; // 'serial' | 'photo' | 'attr:<nom>'
  created_at: Generated<Date>;
}
export interface ItemValuesTable {
  id: Generated<number>;
  item_id: number;
  def_id: number | null;
  name: string;
  type: AttrType;
  unit: string | null;
  value_text: string | null;
  value_number: string | null; // DECIMAL renvoyé en chaîne par mysql2
  value_date: string | null;
  value_bool: number | null;
  sort_order: number;
}
export interface ItemLinksTable {
  id: Generated<number>;
  parent_item_id: number;
  child_item_id: number;
  label: string | null;
  created_at: Generated<Date>;
}
export interface MaintenanceTable {
  id: Generated<number>;
  item_id: number;
  date: string;
  title: string;
  description: string | null;
  created_at: Generated<Date>;
}
export interface AttachmentsTable {
  id: Generated<number>;
  item_id: number;
  kind: 'photo' | 'facture' | 'document';
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: Generated<Date>;
}
export interface AuditLogTable {
  id: Generated<number>;
  user_id: number | null;
  entity: string;
  entity_id: number | null;
  action: string;
  summary: string;
  changes: string | null;
  ip: string | null;
  created_at: Generated<Date>;
}
export interface ImportBatchesTable {
  id: string;
  user_id: number;
  payload: string;
  created_at: Date;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  locations: TreeTable;
  categories: TreeTable;
  attribute_defs: AttributeDefsTable;
  statuses: StatusesTable;
  items: ItemsTable;
  item_values: ItemValuesTable;
  item_links: ItemLinksTable;
  maintenance: MaintenanceTable;
  attachments: AttachmentsTable;
  audit_log: AuditLogTable;
  import_batches: ImportBatchesTable;
  item_na: ItemNaTable;
}

export type User = Selectable<UsersTable>;
export type Item = Selectable<ItemsTable>;
export type ItemValue = Selectable<ItemValuesTable>;
export type AttributeDef = Selectable<AttributeDefsTable>;
export type TreeNode = Selectable<TreeTable>;
export type Status = Selectable<StatusesTable>;

export const pool = createPool({
  host: config.db.socketPath ? undefined : config.db.host,
  port: config.db.port,
  socketPath: config.db.socketPath,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: 'utf8mb4_unicode_ci',
  connectionLimit: 10,
  timezone: 'Z',
  dateStrings: ['DATE'],
  supportBigNumbers: true,
});

// Toutes les dates sont en UTC, y compris les valeurs par défaut CURRENT_TIMESTAMP calculées par MariaDB.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
