import { parseArguments, numberArgument, stringArgument } from "./lib/cli.ts";
import { buildTour } from "./lib/tour-builder.ts";

const args = parseArguments();

if (args.help) {
  console.log(`Usage:
  npm run visite:build -- --source <dossier> --slug <slug> [options]

Options:
  --title <titre>       Titre affiché dans la visite
  --release <id>        Identifiant immuable (date UTC par défaut)
  --out <dossier>       Destination locale (outputs/published-tours)
  --quality <1-100>     Qualité WebP (82)
  --max-width <px>      Largeur maximale (8192)
  --max-height <px>     Hauteur maximale (4096)`);
  process.exit(0);
}

const result = await buildTour({
  source: stringArgument(args, "source", { required: true })!,
  slug: stringArgument(args, "slug", { required: true })!,
  title: stringArgument(args, "title"),
  release: stringArgument(args, "release"),
  outputRoot: stringArgument(args, "out"),
  quality: numberArgument(args, "quality", 82),
  maxWidth: numberArgument(args, "max-width", 8192),
  maxHeight: numberArgument(args, "max-height", 4096),
});

console.log(`Visite générée : ${result.manifest.site.panoramaCount} panorama(s)`);
console.log(`Release : ${result.release}`);
console.log(`Manifest : ${result.manifestPath}`);
result.warnings.forEach((warning) => console.warn(`Avertissement : ${warning}`));
