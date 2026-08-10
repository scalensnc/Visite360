# Panorama 360

Visionneuse web de panoramas équirectangulaires. Elle peut ouvrir directement
un dossier local sans envoyer les images vers un serveur.

## Ouvrir un dossier

1. Lancez le site et ouvrez le menu.
2. Choisissez **Ouvrir un dossier**.
3. Sélectionnez le dossier complet qui contient les panoramas.

Le format NavVis est détecté automatiquement lorsqu’un fichier
`pano-poses.csv` (ou un nom voisin contenant `pano` et `poses`) accompagne les
images. Les positions, orientations, niveaux et liens du parcours sont alors
reconstruits à partir des poses.

Sans fichier de poses, les images `.jpg`, `.jpeg`, `.png`, `.webp` ou `.avif`
sont triées naturellement et présentées comme un parcours séquentiel. Les
fichiers auxiliaires tels que `qualitymap.png`, les miniatures et les aperçus
sont ignorés.

Les données choisies restent dans le navigateur et ne sont pas téléversées. Un
nouveau dossier peut être ouvert à tout moment depuis le menu.

## Développement

Node.js `>=22.13.0` est requis.

```bash
npm install
npm run dev
npm run build
npm test
```

La visite intégrée dans `public/panoramas` reste disponible comme exemple au
premier chargement.
