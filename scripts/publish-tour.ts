import { parseArguments, numberArgument, stringArgument } from "./lib/cli.ts";
import { S3Uploader } from "./lib/s3-upload.ts";
import { buildTour } from "./lib/tour-builder.ts";

const args = parseArguments();

if (args.help) {
  console.log(`Usage:
  npm run visite:publish -- --source <dossier> --slug <slug> --bucket <bucket> --region <région> [options]

Options de visite:
  --title <titre> --release <id> --out <dossier>
  --quality <1-100> --max-width <px> --max-height <px>

Options AWS:
  --base-url <https://domaine>  URL CloudFront affichée à la fin

Les identifiants AWS sont lus dans AWS_PROFILE ou dans la chaîne standard du SDK.`);
  process.exit(0);
}

const bucket = stringArgument(args, "bucket", { required: true })!;
const region = stringArgument(args, "region", {
  fallback: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
});
if (!region) throw new Error("Indiquez --region ou définissez AWS_REGION.");

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

const uploader = new S3Uploader({ bucket, region });
const releaseKey = `tours/${result.slug}/releases/${result.release}`;
const uploaded = await uploader.uploadDirectory(
  result.releaseDirectory,
  releaseKey,
  () => "public, max-age=31536000, immutable",
);

// Le pointeur est publié en dernier : un client ne peut ainsi jamais recevoir
// un manifeste dont les panoramas ne sont pas encore disponibles.
await uploader.uploadFile(
  result.pointerPath,
  `tours/${result.slug}/current.json`,
  "no-cache, max-age=0, must-revalidate",
);

const baseUrl = stringArgument(args, "base-url")?.replace(/\/$/, "");
console.log(`${uploaded} fichier(s) immuable(s) publiés dans s3://${bucket}/${releaseKey}/`);
console.log(`Pointeur actif : s3://${bucket}/tours/${result.slug}/current.json`);
console.log(`Lien client : ${baseUrl ? `${baseUrl}/v/${result.slug}/` : `/v/${result.slug}/`}`);
result.warnings.forEach((warning) => console.warn(`Avertissement : ${warning}`));
