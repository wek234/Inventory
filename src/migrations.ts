// Migrations du schéma. Chaque migration est appliquée une seule fois (table kysely_migration).
import { Kysely, sql } from 'kysely';
import { Migrator, Migration, MigrationProvider } from 'kysely/migration';

const m001: Migration = {
  async up(db: Kysely<any>) {
    const stmts = [
      sql`CREATE TABLE users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        totp_secret_enc VARCHAR(255) NULL,
        totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
        totp_last_step BIGINT NULL,
        oidc_sub VARCHAR(255) NULL UNIQUE,
        failed_attempts INT NOT NULL DEFAULT 0,
        locked_until DATETIME NULL,
        password_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE sessions (
        id CHAR(64) NOT NULL PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        state ENUM('pending_totp','pending_enroll','active') NOT NULL,
        csrf VARCHAR(64) NOT NULL,
        enroll_secret_enc VARCHAR(255) NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        last_seen_at DATETIME NOT NULL,
        ip VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE locations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        parent_id INT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        description TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_locations_parent (parent_id),
        CONSTRAINT fk_locations_parent FOREIGN KEY (parent_id) REFERENCES locations(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE categories (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        parent_id INT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        description TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_categories_parent (parent_id),
        CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE attribute_defs (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category_id INT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        type ENUM('text','number','date','boolean','select') NOT NULL,
        unit VARCHAR(32) NULL,
        options TEXT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_def (category_id, name),
        CONSTRAINT fk_defs_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE statuses (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(60) NOT NULL UNIQUE,
        color VARCHAR(16) NOT NULL DEFAULT 'gris',
        sort_order INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE items (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        brand VARCHAR(120) NULL,
        model VARCHAR(200) NULL,
        serial VARCHAR(120) NULL,
        quantity INT UNSIGNED NOT NULL DEFAULT 1,
        status_id INT UNSIGNED NULL,
        category_id INT UNSIGNED NULL,
        location_id INT UNSIGNED NULL,
        notes TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_items_name (name),
        KEY idx_items_brand (brand),
        KEY idx_items_serial (serial),
        KEY idx_items_updated (updated_at),
        CONSTRAINT fk_items_status FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE SET NULL,
        CONSTRAINT fk_items_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
        CONSTRAINT fk_items_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE item_values (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        item_id INT UNSIGNED NOT NULL,
        def_id INT UNSIGNED NULL,
        name VARCHAR(120) NOT NULL,
        type ENUM('text','number','date','boolean','select') NOT NULL,
        unit VARCHAR(32) NULL,
        value_text TEXT NULL,
        value_number DECIMAL(24,6) NULL,
        value_date DATE NULL,
        value_bool TINYINT(1) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_item_value (item_id, name),
        KEY idx_values_name (name),
        KEY idx_values_def (def_id),
        CONSTRAINT fk_values_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
        CONSTRAINT fk_values_def FOREIGN KEY (def_id) REFERENCES attribute_defs(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE item_links (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        parent_item_id INT UNSIGNED NOT NULL,
        child_item_id INT UNSIGNED NOT NULL,
        label VARCHAR(120) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_link (parent_item_id, child_item_id),
        CONSTRAINT fk_links_parent FOREIGN KEY (parent_item_id) REFERENCES items(id) ON DELETE CASCADE,
        CONSTRAINT fk_links_child FOREIGN KEY (child_item_id) REFERENCES items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE maintenance (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        item_id INT UNSIGNED NOT NULL,
        date DATE NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_maintenance_item (item_id, date),
        CONSTRAINT fk_maintenance_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE attachments (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        item_id INT UNSIGNED NOT NULL,
        kind ENUM('photo','facture','document') NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(80) NOT NULL UNIQUE,
        mime VARCHAR(100) NOT NULL,
        size INT UNSIGNED NOT NULL,
        sha256 CHAR(64) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_attachments_item (item_id),
        CONSTRAINT fk_attachments_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE audit_log (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNSIGNED NULL,
        entity VARCHAR(32) NOT NULL,
        entity_id INT UNSIGNED NULL,
        action VARCHAR(32) NOT NULL,
        summary VARCHAR(255) NOT NULL,
        changes LONGTEXT NULL,
        ip VARCHAR(64) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_audit_entity (entity, entity_id),
        KEY idx_audit_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      sql`CREATE TABLE import_batches (
        id CHAR(32) NOT NULL PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        payload LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        CONSTRAINT fk_import_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
    for (const s of stmts) await s.execute(db);
  },
  async down() {
    throw new Error('Pas de retour arrière automatique');
  },
};

// 1.3.0 : statuts « à traiter », caractéristiques facultatives, informations « sans objet », suivi des étiquettes.
const m002: Migration = {
  async up(db: Kysely<any>) {
    const stmts = [
      sql`ALTER TABLE statuses ADD COLUMN to_handle TINYINT(1) NOT NULL DEFAULT 0`,
      sql`UPDATE statuses SET to_handle = 1 WHERE name IN ('À réparer', 'En réparation')`,
      sql`ALTER TABLE attribute_defs ADD COLUMN optional TINYINT(1) NOT NULL DEFAULT 0`,
      sql`ALTER TABLE items ADD COLUMN label_printed_at DATETIME NULL`,
      sql`CREATE TABLE item_na (
        item_id INT UNSIGNED NOT NULL,
        field VARCHAR(130) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (item_id, field),
        CONSTRAINT fk_na_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
    for (const s of stmts) await s.execute(db);
  },
  async down() {
    throw new Error('Pas de retour arrière automatique');
  },
};

class Provider implements MigrationProvider {
  async getMigrations() {
    return { '001_init': m001, '002_dashboard': m002 };
  }
}

export async function migrate(db: Kysely<any>) {
  const migrator = new Migrator({ db, provider: new Provider() });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    console.log(`migration ${r.migrationName} : ${r.status === 'Success' ? 'appliquée' : r.status}`);
  }
  if (error) throw error;
}
