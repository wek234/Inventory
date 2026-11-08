#!/bin/bash
# Mise à jour de l'inventaire depuis les releases GitHub.
# Usage : bash update.sh            -> dernière version publiée
#         bash update.sh 1.5.0      -> version précise
#         bash update.sh --force    -> réinstalle même si la version est déjà en place
set -euo pipefail

ENV_FILE=/etc/inventory/inventory.env
APP_DIR=/opt/inventory

[ "$(id -u)" -eq 0 ] || { echo "À lancer en root."; exit 1; }
command -v curl >/dev/null || { echo "curl est requis : apt install curl"; exit 1; }

FORCE=0; WANTED=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    *) WANTED="${a#v}" ;;
  esac
done

# Dépôt : UPDATE_REPO du fichier de configuration s'il est renseigné, sinon le dépôt par défaut.
REPO=$(grep -E '^UPDATE_REPO=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)
REPO=${REPO:-wek234/Inventory}

CURRENT=$(grep -o '"version": *"[^"]*"' "$APP_DIR/package.json" 2>/dev/null | head -1 | cut -d'"' -f4 || true)

if [ -n "$WANTED" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/v$WANTED"
  curl -fsS -o /dev/null "$API" 2>/dev/null || API="https://api.github.com/repos/$REPO/releases/tags/$WANTED"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi

JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API") || { echo "Release introuvable sur $REPO."; exit 1; }
TAG=$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
VERSION=${TAG#v}

echo "Version installée : ${CURRENT:-aucune}"
echo "Version visée     : $VERSION ($REPO)"
if [ "$VERSION" = "$CURRENT" ] && [ "$FORCE" -eq 0 ]; then
  echo "Déjà à jour. (--force pour réinstaller)"
  exit 0
fi

# Archive jointe à la release (inventory-X.Y.Z.tar.gz, déjà compilée) si elle existe, sinon le code source.
URL=$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*inventory-[^"]*\.tar\.gz"' | head -1 | cut -d'"' -f4 || true)
[ -n "$URL" ] || URL=$(printf '%s' "$JSON" | grep -o '"tarball_url": *"[^"]*"' | head -1 | cut -d'"' -f4)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Téléchargement : $URL"
curl -fsSL -o "$TMP/release.tar.gz" "$URL"
mkdir "$TMP/src"
tar xzf "$TMP/release.tar.gz" -C "$TMP/src" --strip-components=1
[ -f "$TMP/src/deploy/install.sh" ] || { echo "Archive inattendue : deploy/install.sh absent."; exit 1; }

# install.sh sauvegarde la base et l'application avant de remplacer quoi que ce soit.
cd "$TMP/src"
bash deploy/install.sh