#!/bin/bash
# Mise à jour de l'inventaire depuis les releases GitHub.
# Usage : bash /opt/inventory/deploy/update.sh            -> dernière version publiée
#         bash /opt/inventory/deploy/update.sh 1.5.0      -> version précise
#         bash /opt/inventory/deploy/update.sh --force    -> réinstalle même si la version est déjà en place
# À la fin, le script liste les anciennes archives et dossiers extraits de l'application
# (dans le dossier courant et dans le dossier personnel) et propose de les supprimer.
set -euo pipefail

LAUNCH_DIR=$(pwd)

ENV_FILE=/etc/inventory/inventory.env
APP_DIR=/opt/inventory

[ "$(id -u)" -eq 0 ] || { echo "À lancer en root."; exit 1; }

# Une archive ou un dossier est retenu seulement s'il contient bien l'application (deploy/install.sh).
is_app_dir() { [ -f "$1/deploy/install.sh" ] && grep -q '"name": *"inventory"' "$1/package.json" 2>/dev/null; }
# (liste lue en entier avant le test : avec « grep -q » dans un tube, tar est interrompu et
#  pipefail fait échouer le test sur les grosses archives)
is_app_archive() { local list; list=$(tar tzf "$1" 2>/dev/null) || return 1; grep -qE '^(\./)?[^/]+/deploy/install\.sh$' <<< "$list"; }

cleanup_old() {
  local dirs=() parent d f found=()
  dirs+=("$LAUNCH_DIR")
  # Lancé depuis un dossier extrait : on regarde aussi à côté.
  if is_app_dir "$LAUNCH_DIR"; then parent=$(dirname "$LAUNCH_DIR"); dirs+=("$parent"); fi
  [ -n "${HOME:-}" ] && dirs+=("$HOME")
  local seen=""
  for d in "${dirs[@]}"; do
    d=$(cd "$d" 2>/dev/null && pwd) || continue
    case " $seen " in *" $d "*) continue ;; esac
    seen="$seen $d"
    [ "$d" = "$APP_DIR" ] && continue
    shopt -s nullglob nocaseglob
    for f in "$d"/inventory-* "$d"/v[0-9]*.tar.gz; do
      [ "$f" = "$APP_DIR" ] && continue
      if [ -d "$f" ] && [ ! -L "$f" ]; then
        if [ -e "$f/.git" ]; then echo "Ignoré (dépôt git) : $f"; continue; fi
        is_app_dir "$f" && found+=("$f")
      elif [ -f "$f" ] && [[ "$f" == *.tar.gz ]]; then
        is_app_archive "$f" && found+=("$f")
      fi
    done
    shopt -u nullglob nocaseglob
  done
  [ "$LAUNCH_DIR" != "$APP_DIR" ] && is_app_dir "$LAUNCH_DIR" && [ ! -e "$LAUNCH_DIR/.git" ] && found+=("$LAUNCH_DIR")
  # Dédoublonnage
  local uniq=() x y dup
  for x in "${found[@]}"; do dup=0; for y in "${uniq[@]}"; do [ "$x" = "$y" ] && dup=1; done; [ $dup -eq 0 ] && uniq+=("$x"); done
  if [ ${#uniq[@]} -eq 0 ]; then echo "Aucune ancienne version à nettoyer."; return 0; fi
  echo
  echo "Anciennes versions trouvées :"
  for x in "${uniq[@]}"; do printf '  %s\n' "$x"; done
  if ! { : < /dev/tty; } 2>/dev/null; then echo "Pas de terminal : rien n'est supprimé."; return 0; fi
  local ans=""
  read -r -p "Supprimer ces ${#uniq[@]} élément(s) ? [o/N] " ans < /dev/tty || ans=""
  case "$ans" in
    o|O|oui|OUI|Oui)
      cd /
      for x in "${uniq[@]}"; do rm -rf -- "$x" && echo "Supprimé : $x"; done
      ;;
    *) echo "Rien n'a été supprimé." ;;
  esac
}
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
  cleanup_old
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
cd /

# Mise à jour réussie (le script s'arrête à la première erreur) : nettoyage proposé.
cleanup_old
