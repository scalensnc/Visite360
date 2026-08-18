import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type UploadOptions = {
  bucket: string;
  region: string;
};

function contentType(path: string) {
  switch (extname(path).toLocaleLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function filesInside(root: string) {
  const files: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return visit(path);
      if (entry.isFile()) files.push(path);
    }));
  }
  await visit(root);
  return files.sort();
}

export class S3Uploader {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(options: UploadOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({ region: options.region });
  }

  async uploadFile(path: string, key: string, cacheControl: string) {
    const details = await stat(path);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: createReadStream(path),
      ContentLength: details.size,
      ContentType: contentType(path),
      CacheControl: cacheControl,
    }));
  }

  async uploadDirectory(root: string, keyPrefix: string, cacheControl: (path: string) => string) {
    const files = await filesInside(root);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(6, files.length) }, async () => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        const file = files[index];
        const relativePath = relative(root, file).split(sep).join("/");
        await this.uploadFile(file, `${keyPrefix.replace(/\/$/, "")}/${relativePath}`, cacheControl(file));
      }
    });
    await Promise.all(workers);
    return files.length;
  }
}
