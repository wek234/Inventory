# Inventaire

Application web auto-hébergée pour inventorier du matériel : objets ou lots, emplacements et catégories en arborescence, caractéristiques typées ajoutables à la volée, photos, factures et documents, liens entre objets, entretien et réparations, historique complet, étiquettes QR, import Excel/CSV et export.

Stack : Node.js 22 (Fastify, TypeScript), pages rendues côté serveur avec HTMX, MariaDB. Aucune ressource externe (pas de CDN). Interface en français.

## 1. Préparer le conteneur LXC (Proxmox)

- Modèle **Debian 13**, conteneur **non privilégié**, option **nesting** cochée (permet le durcissement systemd complet ; sans elle, le script applique un durcissement réduit).
- Ressources conseillées : 1 vCPU, 1 Go de RAM, 8 Go de disque **plus** la place prévue pour les photos et documents.
- Une **IP fixe** (réservation DHCP ou IP statique) : le reverse proxy et le serveur de sauvegarde doivent toujours la retrouver.

## 2. Installer

Copiez l'archive dans le conteneur, puis en root :

```bash
tar xzf inventory-X.Y.Z.tar.gz
cd inventory-X.Y.Z
bash deploy/install.sh
```

Le script demande l'adresse publique (ex. `https://inventaire.example.com`), l'IP du serveur de sauvegarde (facultative) puis l'identifiant et le mot de passe de votre compte. Pour une installation sans questions :

```bash
PUBLIC_URL=https://inventaire.example.com BACKUP_IP=10.0.0.50 \
BACKUP_PUBKEY="ssh-ed25519 AAAA... backup@serveur" ADMIN_USER=admin bash deploy/install.sh
```

Le script :

1. installe MariaDB, rsync et nftables depuis les dépôts Debian, et **Node.js 22 LTS** depuis le dépôt officiel NodeSource (signé) : Debian 13 ne fournit que Node 20, qui n'est plus maintenu en amont ;
2. crée l'utilisateur système `inventory`, copie l'application dans `/opt/inventory` (lecture seule pour le service) et les données dans `/var/lib/inventory` ;
3. crée la base `inventory` et un compte applicatif (socket local uniquement) ; si une IP de sauvegarde est donnée, un compte **lecture seule** autorisé uniquement depuis cette IP ;
4. génère les secrets dans `/etc/inventory/inventory.env` (droits 640, root:inventory) ;
5. installe le service systemd durci `inventory` et le démarre ;
6. vous fait créer votre compte (mot de passe de 12 caractères minimum).

Les identifiants de sauvegarde sont écrits dans `/root/inventory-identifiants.txt` : reportez-les dans votre script de sauvegarde puis supprimez ce fichier.

## 3. Publier derrière un reverse proxy

Créez un hôte HTTPS (Zoraxy, Nginx Proxy Manager, Caddy, Traefik…) vers `http://IP_DU_CONTENEUR:3000`.

L'application fait confiance aux en-têtes `X-Forwarded-*` venant d'une adresse privée (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) : l'IP du proxy peut changer sans reconfiguration. Pour restreindre, modifiez `TRUSTED_PROXIES` dans `/etc/inventory/inventory.env` puis `systemctl restart inventory`.

Les cookies de session ne circulent qu'en HTTPS : passez toujours par l'adresse publique, pas par `http://IP:3000`.

## 4. Première connexion

À la première connexion, l'application impose la double authentification (QR code à scanner avec Aegis, 2FAS, Bitwarden, Google Authenticator…). Ensuite, chaque connexion demande le mot de passe puis le code à 6 chiffres.

## 5. Mettre à jour sans perte de données

L'archive « Source code (tar.gz) » d'une release GitHub convient : si le code n'est pas compilé (pas de dossier `dist/`), le script le compile lui-même. Lancez-le avec `bash` (GitHub ne conserve pas toujours le droit d'exécution).

```bash
tar xzf inventory-X.Y.Z.tar.gz
cd inventory-X.Y.Z
bash deploy/install.sh
```

Le script détecte une installation existante et :

1. **sauvegarde la base** (`/var/backups/inventory/base-avant-maj-DATE.sql.gz`) et l'application en place (`appli-avant-maj-DATE.tar.gz`, configuration comprise), en gardant les 5 dernières ;
2. arrête le service, remplace le code dans `/opt/inventory`, installe les dépendances ;
3. passe à Node.js 22 si besoin, réinstalle les dépendances, applique les éventuelles migrations de schéma (elles ne suppriment jamais de données) ;
4. redémarre le service et vérifie qu'il répond.

Ne sont jamais touchés : `/etc/inventory/inventory.env` (secrets et réglages), la base de données, les fichiers joints (`/var/lib/inventory/uploads`) et les accès de sauvegarde.

### Revenir en arrière

```bash
systemctl stop inventory
gunzip -c /var/backups/inventory/base-avant-maj-DATE.sql.gz | mariadb inventory
tar xzf /var/backups/inventory/appli-avant-maj-DATE.tar.gz -C /
cd /opt/inventory && npm ci --omit=dev
systemctl start inventory
```

## 6. Sauvegardes

Si une IP de sauvegarde a été donnée, le script externe récupère :

- **la base** : `mariadb-dump --single-transaction` avec le compte `inventory_backup` (lecture seule, refusé depuis toute autre IP, port 3306 filtré par nftables) ;
- **les fichiers joints** : `rsync -a inventory-backup@IP_DU_CONTENEUR: destination/`. Le compte `inventory-backup` est enfermé par `rrsync` en lecture seule sur le dossier des fichiers et n'accepte que la clé déclarée, depuis l'IP de sauvegarde.

`deploy/backup-exemple.sh` est un script complet à adapter (dump compressé, copie incrémentale des fichiers, rétention de 7 jours).

Ajouter la clé SSH après coup :

```bash
echo 'from="IP_SAUVEGARDE",restrict,command="/usr/bin/rrsync -ro /var/lib/inventory/uploads" ssh-ed25519 AAAA...' \
  > /var/lib/inventory-backup/.ssh/authorized_keys
chown inventory-backup: /var/lib/inventory-backup/.ssh/authorized_keys && chmod 600 /var/lib/inventory-backup/.ssh/authorized_keys
```

Restauration complète :

```bash
gunzip -c inventory-AAAA-MM-JJ_HHMM.sql.gz | mariadb inventory
rsync -a sauvegarde/fichiers/AAAA-MM-JJ_HHMM/ /var/lib/inventory/uploads/
chown -R inventory:inventory /var/lib/inventory/uploads
systemctl restart inventory
```

## 7. Commandes d’administration

```bash
cli() { runuser -u inventory -- bash -c 'set -a; . /etc/inventory/inventory.env; set +a; exec node /opt/inventory/dist/cli.js "$@"' cli "$@"; }
cli reset-password IDENTIFIANT   # nouveau mot de passe, ferme les sessions
cli reset-totp IDENTIFIANT       # nouveau QR code à la prochaine connexion (téléphone perdu)
cli unlock IDENTIFIANT           # déverrouille après 5 échecs
cli list-users
```

Journaux : `journalctl -u inventory -f`. Toutes les actions (connexions, échecs, modifications, imports) figurent aussi dans la page **Historique**.

## 8. Tableau de bord et administration

- **À traiter** : objets dont le statut est coché « à traiter » (page Statuts), objets dans « À classer », sans emplacement, sans catégorie ou sans statut.
- **Fiches incomplètes** : objets sans photo, sans n° de série, ou auxquels il manque des caractéristiques de leur catégorie. Une caractéristique cochée « facultative » sur sa catégorie n'est jamais comptée ; sur une fiche, le bouton « Sans objet » retire une information qui n'existe pas pour cet objet (rétablissable).
- **Étiquettes jamais imprimées** : l'application retient les étiquettes imprimées depuis le bouton « Imprimer ».
- **Administration** : versions (application, Node.js, MariaDB, système), mémoire, disque, taille des fichiers et de la base, sessions, échecs de connexion, et nouvelle version disponible sur GitHub. Le dépôt surveillé se règle avec `UPDATE_REPO` dans `/etc/inventory/inventory.env` (vide pour désactiver) ; la vérification nécessite que le conteneur puisse joindre `api.github.com`.

## 9. Sécurité en résumé

- Mots de passe hachés en argon2id ; TOTP obligatoire avec protection contre le rejeu ; secret TOTP chiffré en base (AES-256-GCM).
- Verrouillage du compte 15 minutes après 5 échecs, plus une limite par adresse IP.
- Sessions stockées en base (identifiant haché), cookies `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, 7 jours prolongés à l'usage, rotation à chaque étape de connexion, sessions actives visibles et révocables.
- Jeton CSRF sur toutes les actions et contrôle de l'origine ; politique de sécurité du contenu stricte (aucun script ni style en ligne) ; HSTS et en-têtes de sécurité.
- Requêtes SQL paramétrées ; sorties HTML échappées ; export CSV protégé contre l'injection de formules.
- Fichiers joints : 20 Mo max., type vérifié sur le contenu réel (images et PDF), stockés hors du dossier web sous un nom aléatoire, servis après authentification, PDF isolés (`sandbox`).
- Service systemd non privilégié, système de fichiers en lecture seule hors de `/var/lib/inventory`, appels système filtrés.
- SSO OpenID Connect intégré mais désactivé (`OIDC_ENABLED=false`). Pour l'activer : renseigner `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, passer `OIDC_ENABLED=true`, redémarrer, puis associer votre compte dans « Mon compte ». Par défaut, le code TOTP local reste demandé après le SSO (`OIDC_REQUIRE_LOCAL_TOTP=true`).

## 10. Import de fichiers Excel / CSV

Menu **Import** : l'application lit toutes les feuilles du classeur et détecte la disposition (un objet par ligne, ou un objet par colonne avec une colonne d'intitulés, même décalée). Pour chaque feuille, choisissez la catégorie et ce que devient chaque colonne, puis corrigez l'aperçu ligne par ligne avant de valider. Les découpages incertains (marque d'un seul mot, stockage sans capacité, année extraite d'un texte, mémoire en Mo convertie) sont signalés en jaune. Rien n'est enregistré avant la validation finale.

## 11. Développement

```bash
npm ci
npm run build      # compile TypeScript dans dist/ et copie htmx dans public/vendor
npm run dev        # rechargement automatique (variables d'environnement requises, voir src/config.ts)
```
