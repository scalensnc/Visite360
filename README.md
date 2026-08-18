# Panorama 360

Application de création et de partage de visites 360°. Le studio permet à un
utilisateur de créer son compte, importer jusqu’à 100 panoramas
équirectangulaires, les publier et copier un lien destiné à son client. Le
visualiseur WebGL fournit ensuite la navigation par hotspots et le parcours 3D.

## Première étape : application locale

```powershell
npm install
npm run studio:dev
```

Le studio est disponible sur `http://localhost:3100/studio/v1/`. En local, un
mode de démonstration est automatiquement utilisé : aucune ressource AWS et
aucun coût cloud ne sont créés.

Le déploiement cible repose entièrement sur AWS :

- Cognito pour l’inscription et la connexion par e-mail ;
- API Gateway et Lambda pour l’API sécurisée ;
- DynamoDB pour les visites et leurs métadonnées ;
- S3 privé pour les panoramas et les applications statiques ;
- CloudFront pour les liens clients et la distribution mondiale.

## Fonctionnement des visites publiées

Une URL client reste stable :

```text
https://visites.example.com/v/client-batiment-a/
```

CloudFront sert le visualiseur partagé depuis `viewer/v1`. Celui-ci lit ensuite
`tours/client-batiment-a/current.json`, puis le manifeste d’une release
immuable :

```text
viewer/v1/index.html
viewer/v1/assets/*
tours/client-batiment-a/current.json
tours/client-batiment-a/releases/20260811T120000Z/manifest.json
tours/client-batiment-a/releases/20260811T120000Z/panoramas/*.webp
```

Les images et manifestes de release ont un cache d’un an. `current.json` n’est
pas mis en cache et il est toujours envoyé en dernier, après les panoramas.

## Générer une visite localement

Node.js `>=22.13.0` est requis.

```powershell
npm install
npm run visite:build -- --source "D:\Projets\Client\Panoramas" --slug "client-batiment-a" --title "Bâtiment A"
```

Le générateur :

- détecte le CSV de poses NavVis lorsqu’il est présent ;
- vérifie que toutes les images référencées existent et sont proches du ratio 2:1 ;
- reconstruit les positions, niveaux et voisins ;
- redimensionne au maximum en 8192×4096 et convertit en WebP qualité 82 ;
- écrit la release dans `outputs/published-tours`.

Sans CSV, les images sont triées naturellement et un parcours séquentiel est
créé. Les options disponibles sont affichées avec `npm run visite:build -- --help`.

## Créer l’hébergement AWS

La pile CDK crée l’ensemble de l’architecture ci-dessus, les en-têtes de
sécurité et les réécritures `/studio/` et `/v/<identifiant>/`. Les téléversements
se font directement du navigateur vers S3 avec une URL signée temporaire.

Pré-requis : des identifiants AWS disponibles via `AWS_PROFILE` (ou la chaîne
standard du SDK) et une région configurée.

Sans domaine personnalisé :

```powershell
$env:AWS_PROFILE="mon-profil"
$env:AWS_REGION="eu-central-2"
npx cdk bootstrap
npm run infra:deploy
```

La région par défaut est Zurich (`eu-central-2`). Elle peut être remplacée avec
`-c region=eu-central-1` si nécessaire.

Pour créer en même temps une alerte de coût mensuelle à 80 % et 100 % :

```powershell
npm run infra:deploy -- `
  -c budgetEmail=alertes@example.com `
  -c budgetAmount=50
```

Avec un domaine et un certificat ACM déjà créés dans `us-east-1` :

```powershell
npm run infra:deploy -- `
  -c domainName=visites.example.com `
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx `
  -c hostedZoneId=Z0123456789 `
  -c hostedZoneName=example.com
```

Les sorties CDK indiquent `BucketName`, `DistributionDomainName` et `BaseUrl`.
Un nom de bucket explicite peut être fourni avec `-c bucketName=...`.

## Publier le studio et le visualiseur

```powershell
npm run viewer:build
npm run viewer:publish -- --bucket "nom-du-bucket" --region "eu-central-2"

npm run studio:build
npm run studio:publish -- --bucket "nom-du-bucket" --region "eu-central-2"
```

L’utilisateur peut ensuite créer et publier ses visites directement depuis le
studio. Les scripts historiques restent disponibles pour publier une visite
depuis la ligne de commande :

```powershell
npm run visite:publish -- `
  --source "D:\Projets\Client\Panoramas" `
  --slug "client-batiment-a" `
  --title "Bâtiment A" `
  --bucket "nom-du-bucket" `
  --region "eu-central-2" `
  --base-url "https://visites.example.com"
```

La commande affiche le lien client final. Les identifiants AWS ne sont jamais
stockés dans le projet.

## Ouvrir un dossier sans publication

Dans le menu du visualiseur, **Ouvrir un dossier** permet toujours de charger
les images uniquement dans le navigateur. Aucune image n’est téléversée.

## Développement et vérification

```powershell
npm run dev
npm run build
npm run viewer:build
npm test
npm run lint
npm run infra:synth
```

La page d’accueil ne charge aucune visite par défaut : elle demande d’abord à
l’utilisateur de sélectionner son dossier de panoramas.
