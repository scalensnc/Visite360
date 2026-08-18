import { resolve } from "node:path";
import { parseArguments, stringArgument } from "./lib/cli.ts";
import { S3Uploader } from "./lib/s3-upload.ts";

const args = parseArguments();

if (args.help) {
  console.log(`Usage:
  npm run viewer:build
  npm run viewer:publish -- --bucket <bucket> --region <région> [--dir dist-static] [--version v1]`);
  process.exit(0);
}

const bucket = stringArgument(args, "bucket", { required: true })!;
const region = stringArgument(args, "region", {
  fallback: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
});
if (!region) throw new Error("Indiquez --region ou définissez AWS_REGION.");
const directory = resolve(stringArgument(args, "dir", { fallback: "dist-static" })!);
const version = stringArgument(args, "version", { fallback: "v1" })!;
if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error("La version du visualiseur est invalide.");

const uploader = new S3Uploader({ bucket, region });
const count = await uploader.uploadDirectory(
  directory,
  `viewer/${version}`,
  (path) => path.endsWith("index.html")
    ? "no-cache, max-age=0, must-revalidate"
    : "public, max-age=31536000, immutable",
);

console.log(`${count} fichier(s) du visualiseur publiés dans s3://${bucket}/viewer/${version}/`);
