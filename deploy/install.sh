#!/usr/bin/env bash
# Installation et mise à jour de l'Inventaire sur Debian 13 (conteneur LXC).
# Usage (root, depuis le dossier décompressé de l'archive) : ./deploy/install.sh
#
# Première installation : le script pose les questions nécessaires. Variables pour une installation sans questions :
#   PUBLIC_URL     adresse publique, ex. https://inventaire.example.com
#   BACKUP_IP      IP du serveur de sauvegarde (vide = pas d'accès de sauvegarde distant)
#   BACKUP_PUBKEY  clé publique SSH du serveur de sauvegarde (rsync en lecture seule)
#   ADMIN_USER     identifiant du compte à créer
#   LISTEN_PORT    port d'écoute (défaut 3000)
#
# Mise à jour : relancer le même script depuis la nouvelle archive. Configuration, base et fichiers sont conservés,
# et une sauvegarde de la base est faite avant toute modification (/var/backups/inventory).
set -euo pipefail

LISTEN_PORT="${LISTEN_PORT:-3000}"
APP_DIR=/opt/inventory
DATA_DIR=/var/lib/inventory
ENV_DIR=/etc/inventory
ENV_FILE=$ENV_DIR/inventory.env
CRED_FILE=/root/inventory-identifiants.txt
BACKUP_DIR=/var/backups/inventory
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_VERSION=$(grep -o '"version": *"[^"]*"' "$SRC_DIR/package.json" | head -1 | cut -d'"' -f4)
NODE_WANTED=22

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local var=$1 prompt=$2 def=${3:-}; local ans; read -rp "$prompt${def:+ [$def]} : " ans; printf -v "$var" '%s' "${ans:-$def}"; }

[[ $EUID -eq 0 ]] || die "lancez ce script en root."
. /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "13" ]] || echo "Attention : prévu pour Debian 13, système détecté : ${PRETTY_NAME:-inconnu}."
[[ -f "$SRC_DIR/package.json" && -d "$SRC_DIR/views" ]] || die "dossier de l'application introuvable ($SRC_DIR)."

UPDATE=0
[[ -f "$ENV_FILE" ]] && UPDATE=1

if [[ $UPDATE -eq 0 ]]; then
  say "Première installation (version $APP_VERSION)"
  [[ -n "${PUBLIC_URL:-}" ]] || ask PUBLIC_URL "Adresse publique de l'application (https://…)"
  [[ "$PUBLIC_URL" =~ ^https?://[^/]+$ ]] || die "adresse invalide : « $PUBLIC_URL » (attendu : https://nom.domaine, sans / final)."
  if [[ -z "${BACKUP_IP+x}" ]]; then ask BACKUP_IP "IP du serveur de sauvegarde (laisser vide pour aucun accès distant)"; fi
  [[ -z "$BACKUP_IP" || "$BACKUP_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "IP de sauvegarde invalide : « $BACKUP_IP »."
else
  say "Mise à jour vers la version $APP_VERSION"
fi

if [[ $UPDATE -eq 1 ]]; then
  say "Sauvegarde avant mise à jour"
  install -d -o root -g root -m 0700 "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  mariadb-dump --single-transaction --routines --triggers inventory | gzip -9 > "$BACKUP_DIR/base-avant-maj-$STAMP.sql.gz"
  tar czf "$BACKUP_DIR/appli-avant-maj-$STAMP.tar.gz" -C / opt/inventory/dist opt/inventory/views opt/inventory/public opt/inventory/package.json opt/inventory/package-lock.json etc/inventory 2>/dev/null || true
  # Conserve les 5 dernières sauvegardes de chaque type.
  ls -1t "$BACKUP_DIR"/base-avant-maj-*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
  ls -1t "$BACKUP_DIR"/appli-avant-maj-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
  echo "Base sauvegardée : $BACKUP_DIR/base-avant-maj-$STAMP.sql.gz"
  systemctl stop inventory 2>/dev/null || true
fi

say "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq mariadb-server rsync openssl ca-certificates gnupg nftables openssh-server build-essential python3 curl >/dev/null

# Node.js ${NODE_WANTED} LTS depuis le dépôt officiel NodeSource (Debian 13 ne fournit que Node 20, qui n'est plus maintenu en amont).
CURRENT_NODE=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( CURRENT_NODE < NODE_WANTED )); then
  say "Installation de Node.js ${NODE_WANTED} (dépôt NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg.tmp
  # Empreinte officielle de la clé NodeSource : refus si la clé téléchargée ne correspond pas.
  NODESOURCE_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
  GOT_FPR=$(gpg --show-keys --with-colons /etc/apt/keyrings/nodesource.gpg.tmp 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')
  if [[ "$GOT_FPR" != "$NODESOURCE_FPR" ]]; then
    rm -f /etc/apt/keyrings/nodesource.gpg.tmp
    die "empreinte de la clé NodeSource inattendue (${GOT_FPR:-aucune}, attendu ${NODESOURCE_FPR}). Installation interrompue."
  fi
  mv /etc/apt/keyrings/nodesource.gpg.tmp /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "Clé NodeSource vérifiée (${GOT_FPR})."
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_WANTED}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  # Le paquet nodejs vient toujours de NodeSource, jamais de Debian.
  cat > /etc/apt/preferences.d/nodesource <<PIN
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
PIN
  # Les paquets Debian npm / nodejs entrent en conflit avec celui de NodeSource (qui inclut npm).
  apt-get remove -y -qq npm nodejs >/dev/null 2>&1 || true
  apt-get autoremove -y -qq >/dev/null 2>&1 || true
  apt-get update -qq
fi
apt-get install -y -qq nodejs >/dev/null
hash -r
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= NODE_WANTED )) || die "Node.js ${NODE_WANTED} ou plus requis (trouvé : $(node -v))."
echo "Node.js $(node -v), $(mariadb --version | head -1)"

# Archive « Source code » de GitHub : pas de dossier dist/ (code non compilé). On compile dans un dossier temporaire.
if [[ ! -f "$SRC_DIR/dist/server.js" || ! -f "$SRC_DIR/public/vendor/htmx.min.js" ]]; then
  say "Compilation (archive source)"
  BUILD_DIR=$(mktemp -d /tmp/inventory-build.XXXXXX)
  trap 'rm -rf "$BUILD_DIR"' EXIT
  rsync -a --exclude node_modules --exclude dist "$SRC_DIR/" "$BUILD_DIR/"
  (cd "$BUILD_DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
  [[ -f "$BUILD_DIR/dist/server.js" ]] || die "la compilation a échoué."
  SRC_DIR="$BUILD_DIR"
fi

say "Utilisateur système et dossiers"
id inventory &>/dev/null || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin inventory
install -d -o inventory -g inventory -m 0750 "$DATA_DIR" "$DATA_DIR/uploads"
install -d -o root -g inventory -m 0750 "$ENV_DIR"

say "Copie de l'application dans $APP_DIR"
install -d -o root -g root -m 0755 "$APP_DIR"
rsync -a --delete --exclude node_modules \
  "$SRC_DIR/dist" "$SRC_DIR/views" "$SRC_DIR/public" "$SRC_DIR/deploy" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"
cd "$APP_DIR"
rm -rf "$APP_DIR/node_modules"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"

if [[ $UPDATE -eq 0 ]]; then
  say "MariaDB : base et compte applicatif"
  APP_DB_PASS=$(openssl rand -base64 33 | tr -dc 'A-Za-z0-9' | head -c 40)
  mariadb <<SQL
CREATE DATABASE IF NOT EXISTS inventory CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'inventory'@'localhost' IDENTIFIED BY '${APP_DB_PASS}';
ALTER USER 'inventory'@'localhost' IDENTIFIED BY '${APP_DB_PASS}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON inventory.* TO 'inventory'@'localhost';
DELETE FROM mysql.global_priv WHERE User='';
DROP DATABASE IF EXISTS test;
FLUSH PRIVILEGES;
SQL

  say "Configuration de l'application"
  umask 027
  cat > "$ENV_FILE" <<CONF
# Configuration de l'Inventaire (lue par systemd). Redémarrer après modification : systemctl restart inventory
PUBLIC_URL=${PUBLIC_URL}
LISTEN_HOST=0.0.0.0
LISTEN_PORT=${LISTEN_PORT}
COOKIE_SECURE=true
# Proxys autorisés à transmettre l'IP du client (X-Forwarded-For) : plages privées, sans IP fixe.
TRUSTED_PROXIES=127.0.0.1/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
APP_SECRET=$(openssl rand -hex 32)
APP_TIMEZONE=Europe/Paris
# Dépôt GitHub surveillé pour signaler les nouvelles versions (page Administration). Vide = désactivé.
#UPDATE_REPO=wek234/Inventory
DB_SOCKET=/run/mysqld/mysqld.sock
DB_USER=inventory
DB_PASSWORD=${APP_DB_PASS}
DB_NAME=inventory
DATA_DIR=${DATA_DIR}/uploads
MAX_UPLOAD_MB=20
SESSION_DAYS=7
SESSION_MAX_DAYS=30
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15
PASSWORD_MIN_LENGTH=12
# SSO OpenID Connect (désactivé). Callback à déclarer chez le fournisseur : ${PUBLIC_URL}/auth/oidc/callback
OIDC_ENABLED=false
OIDC_ISSUER=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_LABEL=SSO
OIDC_REQUIRE_LOCAL_TOTP=true
# Alertes Telegram (vides = désactivées) : jeton du bot (@BotFather) et identifiant de la conversation.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
CONF
  chown root:inventory "$ENV_FILE"
  chmod 0640 "$ENV_FILE"

  if [[ -n "$BACKUP_IP" ]]; then
    say "Accès de sauvegarde (lecture seule, depuis $BACKUP_IP uniquement)"
    BACKUP_DB_PASS=$(openssl rand -base64 33 | tr -dc 'A-Za-z0-9' | head -c 40)
    mariadb <<SQL
CREATE USER IF NOT EXISTS 'inventory_backup'@'${BACKUP_IP}' IDENTIFIED BY '${BACKUP_DB_PASS}';
ALTER USER 'inventory_backup'@'${BACKUP_IP}' IDENTIFIED BY '${BACKUP_DB_PASS}';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON inventory.* TO 'inventory_backup'@'${BACKUP_IP}';
FLUSH PRIVILEGES;
SQL
    cat > /etc/mysql/mariadb.conf.d/90-inventory.cnf <<CNF
[mysqld]
bind-address = 0.0.0.0
skip-name-resolve = ON
local-infile = 0
max_connect_errors = 20
CNF
    cat > /etc/nftables.conf <<NFT
#!/usr/sbin/nft -f
# Pare-feu de l'Inventaire : MariaDB (3306) réservé au serveur de sauvegarde, SSH (22) au réseau local.
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy accept;
    iif lo accept
    ct state established,related accept
    tcp dport 3306 ip saddr ${BACKUP_IP} accept
    tcp dport 3306 drop
    tcp dport 22 ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } accept
    tcp dport 22 drop
  }
}
NFT
    if nft -c -f /etc/nftables.conf 2>/dev/null && systemctl enable --now nftables >/dev/null 2>&1 && nft -f /etc/nftables.conf; then
      echo "Pare-feu actif."
    else
      echo "Attention : nftables indisponible dans ce conteneur (le compte MariaDB reste limité à ${BACKUP_IP})."
    fi
    systemctl restart mariadb

    id inventory-backup &>/dev/null || useradd --system --create-home --home-dir /var/lib/inventory-backup --shell /bin/sh -G inventory inventory-backup
    install -d -o inventory-backup -g inventory-backup -m 0700 /var/lib/inventory-backup/.ssh
    RRSYNC=$(command -v rrsync || echo /usr/bin/rrsync)
    if [[ -n "${BACKUP_PUBKEY:-}" ]]; then
      echo "from=\"${BACKUP_IP}\",restrict,command=\"${RRSYNC} -ro ${DATA_DIR}/uploads\" ${BACKUP_PUBKEY}" > /var/lib/inventory-backup/.ssh/authorized_keys
      chown inventory-backup:inventory-backup /var/lib/inventory-backup/.ssh/authorized_keys
      chmod 0600 /var/lib/inventory-backup/.ssh/authorized_keys
    fi
    umask 077
    LXC_IP=$(hostname -I | awk '{print $1}')
    cat > "$CRED_FILE" <<CRED
Identifiants de sauvegarde de l'Inventaire (générés le $(date '+%d/%m/%Y %H:%M')). À reporter dans votre script de sauvegarde puis à supprimer.

Base MariaDB (lecture seule, autorisée uniquement depuis ${BACKUP_IP})
  hôte         : ${LXC_IP}
  port         : 3306
  base         : inventory
  utilisateur  : inventory_backup
  mot de passe : ${BACKUP_DB_PASS}

Fichiers joints (rsync via SSH, lecture seule, uniquement depuis ${BACKUP_IP})
  rsync -a inventory-backup@${LXC_IP}: /destination/
  Clé à placer (si non fournie à l'installation) dans /var/lib/inventory-backup/.ssh/authorized_keys :
  from="${BACKUP_IP}",restrict,command="${RRSYNC} -ro ${DATA_DIR}/uploads" ssh-ed25519 AAAA...
CRED
    echo "Identifiants de sauvegarde écrits dans $CRED_FILE (lisible par root uniquement)."
  fi
fi

# Mise à jour : ajoute au fichier de configuration les réglages apparus depuis (sans modifier les existants).
ensure_env() {
  local key=$1 value=$2 comment=$3
  if ! grep -qE "^#?${key}=" "$ENV_FILE"; then
    printf '\n# %s\n%s=%s\n' "$comment" "$key" "$value" >> "$ENV_FILE"
    echo "Configuration : ${key} ajouté."
  fi
}
if [[ $UPDATE -eq 1 ]]; then
  ensure_env SESSION_MAX_DAYS 30 "Durée de vie maximale d'une session (jours), même utilisée chaque jour."
  ensure_env TELEGRAM_BOT_TOKEN "" "Alertes Telegram (vides = désactivées) : jeton du bot (@BotFather)."
  ensure_env TELEGRAM_CHAT_ID "" "Alertes Telegram : identifiant de la conversation."
fi

# Exécute une commande d'administration sous l'utilisateur de l'application, avec sa configuration.
cli() { runuser -u inventory -- bash -c 'set -a; . /etc/inventory/inventory.env; set +a; exec node /opt/inventory/dist/cli.js "$@"' cli "$@"; }

say "Schéma de la base"
cli migrate
cli seed
cli photos

say "Service systemd"
install -m 0644 "$SRC_DIR/deploy/inventory.service" /etc/systemd/system/inventory.service
systemctl daemon-reload
systemctl enable inventory >/dev/null 2>&1
systemctl restart inventory
sleep 3
if ! systemctl is-active --quiet inventory; then
  if journalctl -u inventory -n 20 --no-pager | grep -q 'status=226'; then
    echo "Le conteneur n'autorise pas l'isolation systemd (option « nesting » désactivée) : durcissement réduit appliqué."
    install -d /etc/systemd/system/inventory.service.d
    cat > /etc/systemd/system/inventory.service.d/lxc.conf <<OVR
[Service]
PrivateTmp=no
PrivateDevices=no
ProtectSystem=no
ProtectHome=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectKernelLogs=no
ProtectControlGroups=no
ProtectClock=no
ProtectHostname=no
RestrictNamespaces=no
OVR
    systemctl daemon-reload
    systemctl restart inventory
    sleep 3
  fi
fi
if ! systemctl is-active --quiet inventory; then
  journalctl -u inventory -n 30 --no-pager
  [[ $UPDATE -eq 1 ]] && echo "Pour revenir à la version précédente : voir « Revenir en arrière » dans le README ($BACKUP_DIR)."
  die "le service ne démarre pas."
fi
curl -fsS "http://127.0.0.1:${LISTEN_PORT}/health" >/dev/null && echo "Service démarré, santé OK."

# Compte créé dès qu'aucun utilisateur n'existe (y compris si une installation précédente s'est interrompue).
if [[ "$(mariadb -N inventory -e 'SELECT COUNT(*) FROM users')" == "0" ]]; then
  say "Création de votre compte"
  USERNAME="${ADMIN_USER:-}"
  while [[ -z "$USERNAME" ]]; do read -rp "Identifiant : " USERNAME; done
  cli create-user "$USERNAME"
fi

say "Terminé (version $APP_VERSION)"
if [[ $UPDATE -eq 1 ]]; then
  echo "Mise à jour appliquée : configuration, base et fichiers conservés."
else
  set -a; . "$ENV_FILE"; set +a
  echo "Application : http://$(hostname -I | awk '{print $1}'):${LISTEN_PORT} (à publier derrière votre reverse proxy HTTPS sur ${PUBLIC_URL})"
  echo "À la première connexion, l'application vous fera configurer la double authentification (TOTP)."
  [[ -f "$CRED_FILE" ]] && echo "Identifiants de sauvegarde : $CRED_FILE"
fi
