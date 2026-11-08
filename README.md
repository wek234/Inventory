# Inventaire

Application web auto-hébergée pour inventorier du matériel : objets ou lots, emplacements et catégories en arborescence, caractéristiques typées ajoutables à la volée, photos, factures et documents, liens entre objets, entretien et réparations, attribution à des personnes, chronologie et historique complet, étiquettes QR et mode rangement, corbeille, import Excel/CSV, export et API. Installable sur téléphone (PWA).

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

1. installe MariaDB, rsync et nftables depuis les dépôts Debian, et **Node.js 22 LTS** depuis le dépôt officiel NodeSource : Debian 13 ne fournit que Node 20, qui n'est plus maintenu en amont. L'empreinte de la clé de signature NodeSource est vérifiée avant de faire confiance au dépôt (`6F71 F525 2828 41EE DAF8  51B4 2F59 B5F9 9B1B E0B4`) ; l'installation s'arrête si elle ne correspond pas ;
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

**Clés d'accès (passkeys)** : dans « Mon compte », ajoutez une clé d'accès (téléphone, Windows Hello, Touch ID, clé de sécurité). Le bouton « Se connecter avec une clé d'accès » de la page de connexion suffit alors, sans mot de passe ni code : la clé exige déjà votre empreinte, votre visage ou votre code PIN. Les clés ne fonctionnent que sur l'adresse publique (`PUBLIC_URL`), en HTTPS.

**Autres comptes** : Administration > Comptes. Deux rôles :

- **Administrateur** : tous les droits ;
- **Lecture seule** : tableau de bord et objets uniquement (liste, recherche, fiches), sans rien pouvoir modifier, ni exporter, ni imprimer d'étiquettes. Les espaces Paramètres et Administration, l'historique et les outils lui sont fermés.

**Organisation du menu** :

- **Tableau de bord**, **Objets** ;
- **Outils** (groupe repliable, retenu ouvert ou fermé) : rangement, corbeille, historique, import, export ;
- **Paramètres** : catégories (et leurs caractéristiques), emplacements, statuts ;
- en bas, **Rechercher** (`Ctrl+K`) et le bouton du compte (initiale et identifiant) : il ouvre **Mon compte**, **Administration** (système, comptes, personnes ; administrateurs uniquement), le choix du **thème** et **Se déconnecter**.

Dans **Mon compte**, le TOTP et les clés d'accès sont regroupés dans la même carte. Dans Administration > Comptes, le menu « Actions » d'un compte permet de le renommer (y compris le vôtre : la session reste ouverte, le nouvel identifiant sert à la connexion suivante).

Chaque compte configure son TOTP à sa première connexion. L'application garde toujours au moins un administrateur.

## 5. Mettre à jour sans perte de données

À partir de la 1.5.2, une seule commande suffit (la page Administration l'affiche quand une nouvelle version est publiée) :

```bash
bash /opt/inventory/deploy/update.sh            # dernière version publiée
bash /opt/inventory/deploy/update.sh 1.5.2      # version précise
bash /opt/inventory/deploy/update.sh --force    # réinstalle la version en place
```

Le script télécharge la release GitHub (l'archive jointe si elle existe, sinon le code source), lance `deploy/install.sh` (sauvegarde, installation, migrations, redémarrage), puis liste les anciennes archives et dossiers extraits de l'application trouvés dans le dossier courant et le dossier personnel, et demande confirmation (`o/N`) avant de les supprimer. Seuls les dossiers et archives qui contiennent réellement l'application sont proposés ; les dépôts git et les autres fichiers ne sont jamais touchés.

Méthode manuelle, toujours possible :

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
cli list-users                   # comptes, rôle, TOTP, verrouillage
cli photos                       # retire les métadonnées des photos envoyées avant la 1.4 et crée les vignettes
```

Après une mise à jour vers la 1.4, lancez une fois `cli photos` (le script d'installation le fait déjà).

Journaux : `journalctl -u inventory -f`. Toutes les actions (connexions, échecs, modifications, imports) figurent aussi dans la page **Historique**.

## 8. Tableau de bord et administration

- **À traiter** : objets dont le statut est coché « à traiter » (page Statuts), objets dans « À classer », sans emplacement, sans catégorie ou sans statut.
- **Fiches incomplètes** : objets sans photo, sans n° de série, ou auxquels il manque des caractéristiques de leur catégorie. Une caractéristique cochée « facultative » sur sa catégorie n'est jamais comptée ; sur une fiche, le bouton « Sans objet » retire une information qui n'existe pas pour cet objet (rétablissable).
- **Étiquettes jamais imprimées** : l'application retient les étiquettes imprimées depuis le bouton « Imprimer ».
- **Administration** : versions (application, Node.js, MariaDB, système), mémoire, disque, taille des fichiers et de la base, sessions, échecs de connexion, et nouvelle version disponible sur GitHub. Le dépôt surveillé se règle avec `UPDATE_REPO` dans `/etc/inventory/inventory.env` (vide pour désactiver) ; la vérification nécessite que le conteneur puisse joindre `api.github.com`.

### Alertes Telegram

L'application peut prévenir sur Telegram d'une nouvelle version publiée sur GitHub et des événements de sécurité (compte verrouillé, série d'échecs de connexion, compte créé ou supprimé, changement de mot de passe ou de TOTP, clé d'accès ou jeton d'API ajouté ou supprimé).

1. Sur Telegram, écrivez à **@BotFather**, commande `/newbot`, et notez le jeton (`123456:ABC…`).
2. Envoyez un message quelconque à votre nouveau bot, puis ouvrez `https://api.telegram.org/botJETON/getUpdates` : l'identifiant de la conversation est la valeur `"chat":{"id": …}`.
3. Renseignez-les dans `/etc/inventory/inventory.env` :

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=123456789
   ```

4. `systemctl restart inventory`, puis bouton « Envoyer un message de test » dans Administration.

Le conteneur doit pouvoir joindre `api.telegram.org`. Une nouvelle version n'est signalée qu'une fois.

## 9. Sécurité en résumé

- Mots de passe hachés en argon2id ; TOTP obligatoire avec protection contre le rejeu ; secret TOTP chiffré en base (AES-256-GCM).
- Verrouillage du compte 15 minutes après 5 échecs, plus une limite par adresse IP.
- Clés d'accès WebAuthn (vérification de l'utilisateur obligatoire) ; même message d'erreur que le compte existe, que le mot de passe soit faux ou que le compte soit verrouillé.
- Sessions stockées en base (identifiant haché), cookies `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, 7 jours prolongés à l'usage mais jamais plus de 30 jours après la connexion (`SESSION_MAX_DAYS`), rotation à chaque étape de connexion, sessions actives visibles et révocables.
- Jeton CSRF sur toutes les actions et contrôle de l'origine ; politique de sécurité du contenu stricte (aucun script ni style en ligne) ; HSTS et en-têtes de sécurité.
- Requêtes SQL paramétrées ; sorties HTML échappées ; export CSV protégé contre l'injection de formules.
- Fichiers joints : 20 Mo max., type vérifié sur le contenu réel (images et PDF), stockés hors du dossier web sous un nom aléatoire, servis après authentification, PDF isolés (`sandbox`). Les photos sont réenregistrées sans leurs métadonnées (position GPS, appareil, date).
- Import : les classeurs dont la décompression dépasserait 100 Mo ou dont le taux de compression est anormal sont refusés avant lecture.
- Jetons d'API stockés sous forme d'empreinte uniquement, avec portée (lecture ou écriture) et expiration ; un compte en lecture seule ne peut créer que des jetons de lecture.
- Service systemd non privilégié, mémoire plafonnée (384 Mo freinés, 512 Mo maximum), système de fichiers en lecture seule hors de `/var/lib/inventory`, appels système filtrés.
- SSO OpenID Connect intégré mais désactivé (`OIDC_ENABLED=false`). Pour l'activer : renseigner `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, passer `OIDC_ENABLED=true`, redémarrer, puis associer votre compte dans « Mon compte ». Par défaut, le code TOTP local reste demandé après le SSO (`OIDC_REQUIRE_LOCAL_TOTP=true`).

## 10. Fonctions du quotidien

- **Recherche** : le texte est cherché au **début des mots**, sans tenir compte des majuscules ni des accents : « hp » trouve « HP ProBook » ou « HPs HS » mais pas « touchpad », « optip » trouve « Optiplex », « ecran » trouve « Écran ». La recherche simple propose catégorie, emplacement et statut ; « Recherche avancée » ajoute caractéristique, attribution, complétude, lots et étiquettes (le panneau s'ouvre de lui-même quand un de ces filtres est actif).
- **Recherche rapide** : `Ctrl+K` (ou `⌘K`) depuis n'importe quelle page : objets, emplacements, catégories, personnes et pages. Flèches pour choisir, Entrée pour ouvrir.
- **Modification en masse** : cochez des objets dans la liste, puis « Modifier la sélection » pour changer d'un coup le statut, l'emplacement, la catégorie ou la personne.
- **Dupliquer** : sur une fiche, crée un nouvel objet prérempli (caractéristiques comprises, sauf le n° de série).
- **Personnes** (Administration > Personnes) : des personnes sans compte, à qui attribuer un objet (« attribué à » et date). On crée les personnes uniquement dans cet espace ; une fiche objet propose de choisir parmi elles, et la page d'une personne permet de lui attribuer ou de lui retirer des objets. Filtre « Attribution » dans la recherche avancée.
- **Page d'une catégorie** : les caractéristiques héritées sont regroupées par catégorie d'origine. Les caractéristiques propres, le nom, la catégorie parente et la description se modifient librement puis s'enregistrent d'un seul bouton « Enregistrer la catégorie » ; « Ajouter une caractéristique » insère une ligne enregistrée avec le reste. Si une ligne est invalide (nom déjà utilisé dans la branche, liste sans option…), rien n'est enregistré et la page revient avec la saisie et les erreurs. Le bouton « Supprimer » d'une ligne agit immédiatement, après confirmation.
- **Photo principale** : l'étoile sur une photo la choisit ; elle s'affiche en vignette dans la liste et en tête de fiche.
- **Chronologie** : sur chaque fiche, modifications, déplacements, attributions et interventions dans l'ordre.
- **Caractéristique « Lien »** : adresse web cliquable (pilotes, manuel en ligne) ; seules les adresses `http(s)` sont acceptées.
- **Corbeille** : un objet supprimé y reste 30 jours (restaurable), puis il est effacé avec ses fichiers.
- **Rangement** : scannez l'étiquette d'un emplacement, puis celles des objets à y ranger avec la caméra du téléphone ; chaque objet est déplacé aussitôt. Saisie manuelle possible (`E12` pour un emplacement, `#42` pour un objet).
- **Formats d'étiquettes** : rouleaux Brother et Dymo, planches A4 (plusieurs tailles) ou format personnalisé ; le dernier format choisi est retenu.
- **Application sur téléphone** : depuis le navigateur du téléphone, « Ajouter à l'écran d'accueil ». Aucune donnée d'inventaire n'est conservée hors ligne.

## 11. API

Créez un jeton dans « Mon compte » > Jetons d'API (affiché une seule fois), puis :

```bash
curl -H "Authorization: Bearer inv_..." https://inventaire.example.com/api/v1/objets?q=ampli
```

| Route | Rôle |
|---|---|
| `GET /api/v1/` | Liste des routes |
| `GET /api/v1/objets` | Liste ; mêmes filtres que l'interface (`q`, `cat`, `loc`, `status`, `personne`, `manque`, `sort`, `dir`), `limit` (500 max.) et `offset` |
| `GET /api/v1/objets/:id` | Détail avec caractéristiques et fichiers |
| `POST /api/v1/objets` | Créer (jeton écriture) |
| `PATCH /api/v1/objets/:id` | Modifier les champs envoyés (jeton écriture) |
| `POST /api/v1/objets/:id/deplacer` | `{ "emplacement_id": 4 }` (jeton écriture) |
| `DELETE /api/v1/objets/:id` | Mettre à la corbeille (jeton écriture) |
| `GET /api/v1/emplacements`, `/categories`, `/statuts`, `/personnes` | Référentiels |

Champs d'un objet : `nom`, `marque`, `modele`, `numero_serie`, `quantite`, `categorie_id`, `emplacement_id`, `statut_id`, `notes`, `caracteristiques` (`{ "Puissance": 50 }` ; une valeur `null` supprime la caractéristique). Les modifications faites par l'API figurent dans l'historique.

## 12. Import de fichiers Excel / CSV

Menu **Import** : l'application lit toutes les feuilles du classeur et détecte la disposition (un objet par ligne, ou un objet par colonne avec une colonne d'intitulés, même décalée). Pour chaque feuille, choisissez la catégorie et ce que devient chaque colonne, puis corrigez l'aperçu ligne par ligne avant de valider. Les découpages incertains (marque d'un seul mot, stockage sans capacité, année extraite d'un texte, mémoire en Mo convertie) sont signalés en jaune. Rien n'est enregistré avant la validation finale.

## 13. Développement

```bash
npm ci
npm run build      # compile TypeScript dans dist/ et copie les bibliothèques navigateur dans public/vendor
npm run dev        # rechargement automatique (variables d'environnement requises, voir src/config.ts)
```
