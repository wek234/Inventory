#!/usr/bin/env bash
# Exemple de script de sauvegarde à lancer depuis le serveur de sauvegarde (celui dont l'IP a été donnée à l'installation),
# par exemple chaque nuit via cron :
#   15 3 * * * /usr/local/bin/backup-inventaire.sh >> /var/log/backup-inventaire.log 2>&1
# Prérequis sur le serveur de sauvegarde : client MariaDB (mariadb-dump), rsync, ssh, et une clé SSH déclarée dans le LXC.
set -euo pipefail

LXC=IP_DU_CONTENEUR             # IP du conteneur de l'Inventaire
DEST=/srv/backups/inventaire    # dossier de destination
RETENTION_DAYS=7
DB_USER=inventory_backup
DB_PASS_FILE=/root/.inventaire-db-pass   # fichier (chmod 600) contenant le mot de passe de inventory_backup
SSH_KEY=/root/.ssh/id_ed25519_inventaire

STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$DEST/db" "$DEST/fichiers"

# 1. Base de données (cohérente, sans verrouiller l'application)
MYSQL_PWD="$(cat "$DB_PASS_FILE")" mariadb-dump --host="$LXC" --user="$DB_USER" \
  --single-transaction --skip-lock-tables --routines --triggers --hex-blob inventory \
  | gzip -9 > "$DEST/db/inventory-$STAMP.sql.gz.tmp"
mv "$DEST/db/inventory-$STAMP.sql.gz.tmp" "$DEST/db/inventory-$STAMP.sql.gz"

# 2. Fichiers joints : copie incrémentale par jour (liens physiques vers la veille, donc peu d'espace)
PREV=$(ls -1d "$DEST"/fichiers/20* 2>/dev/null | tail -1 || true)
rsync -a --delete -e "ssh -i $SSH_KEY -o BatchMode=yes" ${PREV:+--link-dest="$PREV"} \
  "inventory-backup@$LXC:" "$DEST/fichiers/$STAMP/"

# 3. Rétention : 7 jours
find "$DEST/db" -name 'inventory-*.sql.gz' -mtime +$((RETENTION_DAYS - 1)) -delete
find "$DEST/fichiers" -mindepth 1 -maxdepth 1 -type d -mtime +$((RETENTION_DAYS - 1)) -exec rm -rf {} +

echo "$(date '+%F %T') sauvegarde OK : $STAMP"
