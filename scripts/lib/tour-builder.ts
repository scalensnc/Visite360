import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import type { Manifest, Panorama } from "../../app/panorama-folder";

const IMAGE_EXTENSION = /\.(?:avif|jpe?g|png|tiff?|webp)$/i;
const EXCLUDED_FALLBACK_IMAGE = /(?:quality|site[-_ ]?map|thumbnail|preview)/i;
const FLOOR_HEIGHT_METERS = 3.1;

type SourceFile = {
  absolutePath: string;
  relativePath: string;
  name: string;
};

type PoseRow = {
  id: number;
  filename: string;
  timestamp: number;
  x: number;
  y: number;
  z: number;
  orientation: Panorama["orientation"];
  file: SourceFile;
};

export type BuildTourOptions = {
  source: string;
  slug: string;
  title?: string;
  release?: string;
  outputRoot?: string;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
};

export type TourPointer = {
  schemaVersion: 1;
  slug: string;
  release: string;
  manifest: string;
  generatedAt: string;
};

export type BuildTourResult = {
  slug: string;
  release: string;
  releaseDirectory: string;
  pointerPath: string;
  manifestPath: string;
  pointer: TourPointer;
  manifest: Manifest;
  warnings: string[];
};

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function displayName(sourceFolder: string) {
  const cleaned = sourceFolder
    .replace(/^(?:panorama|panoramas|pano)[-_ ]*/i, "")
    .replace(/^\d{3,}[-_ ]*/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Visite 360";
  return cleaned.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("fr-CH"));
}

function releaseIdentifier(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(root: string) {
  const files: SourceFile[] = [];

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) return visit(absolutePath);
      if (!entry.isFile()) return;
      files.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"),
        name: entry.name,
      });
    }));
  }

  await visit(root);
  return files.sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
}

function splitDelimitedLine(line: string, delimiter: string) {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field.trim());
  return fields;
}

function imageIndex(files: SourceFile[]) {
  const index = new Map<string, SourceFile>();
  files.filter((file) => IMAGE_EXTENSION.test(file.name)).forEach((file) => {
    index.set(normalizePath(file.relativePath), file);
    index.set(normalizePath(file.name), file);
  });
  return index;
}

async function poseRows(files: SourceFile[]) {
  const csvFiles = files.filter((file) => /\.csv$/i.test(file.name));
  let poseFile = csvFiles.find((file) => /pano.*poses|poses.*pano/i.test(file.name));

  if (!poseFile) {
    for (const candidate of csvFiles) {
      const header = (await readFile(candidate.absolutePath, "utf8")).slice(0, 600).toLocaleLowerCase();
      if (header.includes("pano_pos_x") && header.includes("pano_ori_w")) {
        poseFile = candidate;
        break;
      }
    }
  }
  if (!poseFile) return null;

  const text = (await readFile(poseFile.absolutePath, "utf8")).replace(/^\uFEFF/, "").trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Le fichier de poses est vide.");
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const indexedImages = imageIndex(files);
  const missingImages: string[] = [];
  const rows: PoseRow[] = [];

  lines.slice(1).forEach((line, rowIndex) => {
    const values = splitDelimitedLine(line, delimiter);
    if (values.length < 10) return;
    const numbers = [values[0], ...values.slice(2, 10)].map(Number);
    if (numbers.some((value) => !Number.isFinite(value))) {
      throw new Error(`La ligne ${rowIndex + 2} du fichier de poses est invalide.`);
    }
    const filename = values[1];
    const file = indexedImages.get(normalizePath(filename))
      ?? indexedImages.get(normalizePath(filename.split(/[\\/]/).at(-1) ?? filename));
    if (!file) {
      missingImages.push(filename);
      return;
    }
    rows.push({
      id: numbers[0],
      filename,
      timestamp: numbers[1],
      x: numbers[2],
      y: numbers[3],
      z: numbers[4],
      orientation: { w: numbers[5], x: numbers[6], y: numbers[7], z: numbers[8] },
      file,
    });
  });

  if (missingImages.length) {
    throw new Error(`${missingImages.length} image(s) référencée(s) sont introuvables : ${missingImages.slice(0, 3).join(", ")}.`);
  }
  if (!rows.length) throw new Error("Aucune pose de panorama valide n’a été trouvée.");
  if (rows.some((row) => !Number.isInteger(row.id) || row.id < 0)) {
    throw new Error("Les identifiants de panorama doivent être des entiers positifs ou nuls.");
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Le fichier de poses contient des identifiants en double.");
  }

  return {
    poseFile,
    rows: rows.sort((left, right) => left.timestamp - right.timestamp || left.id - right.id),
  };
}

async function fallbackRows(files: SourceFile[]) {
  const allImages = files
    .filter((file) => IMAGE_EXTENSION.test(file.name) && !EXCLUDED_FALLBACK_IMAGE.test(file.name))
    .sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
  const namedPanoramas = allImages.filter((file) => /pano(?:rama)?/i.test(file.name));
  const images = namedPanoramas.length ? namedPanoramas : allImages;
  if (!images.length) throw new Error("Ce dossier ne contient aucune image panoramique prise en charge.");

  const metadata = await Promise.all(images.map((file) => stat(file.absolutePath)));
  const numericIds = images.map((file) => Number(file.name.match(/\d+/)?.[0]));
  const idsAreUnique = numericIds.every(Number.isFinite) && new Set(numericIds).size === images.length;
  return {
    poseFile: null,
    rows: images.map((file, index): PoseRow => ({
      id: idsAreUnique ? numericIds[index] : index,
      filename: file.relativePath,
      timestamp: metadata[index].mtimeMs / 1000,
      x: index * 2.5,
      y: 0,
      z: 0,
      orientation: { w: 1, x: 0, y: 0, z: 0 },
      file,
    })),
  };
}

function distance(left: Panorama, right: Panorama) {
  return Math.hypot(
    right.position.x - left.position.x,
    right.position.y - left.position.y,
    right.position.z - left.position.z,
  );
}

function buildNeighbors(panoramas: Panorama[]) {
  const adjacency = panoramas.map(() => new Set<number>());
  const nearestDistances: number[] = [];
  const nearestByIndex: Array<Array<{ index: number; distance: number }>> = [];

  panoramas.forEach((panorama, index) => {
    const nearest = panoramas
      .map((candidate, candidateIndex) => ({
        index: candidateIndex,
        distance: candidateIndex === index ? Number.POSITIVE_INFINITY : distance(panorama, candidate),
      }))
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort((left, right) => left.distance - right.distance);
    nearestByIndex[index] = nearest;
    if (nearest[0]) nearestDistances.push(nearest[0].distance);
  });

  const orderedNearest = [...nearestDistances].sort((left, right) => left - right);
  const medianNearest = orderedNearest[Math.floor(orderedNearest.length / 2)] ?? 2.5;
  const localRadius = Math.max(4, Math.min(12, medianNearest * 2.8));
  const addEdge = (left: number, right: number) => {
    if (left === right) return;
    adjacency[left].add(right);
    adjacency[right].add(left);
  };

  nearestByIndex.forEach((nearest, index) => {
    nearest.slice(0, 3).forEach((candidate) => {
      if (candidate.distance <= localRadius) addEdge(index, candidate.index);
    });
  });
  for (let index = 1; index < panoramas.length; index += 1) {
    if (distance(panoramas[index - 1], panoramas[index]) <= localRadius * 1.5) {
      addEdge(index - 1, index);
    }
  }

  if (panoramas.length > 1) {
    const inTree = new Set([0]);
    while (inTree.size < panoramas.length) {
      let best: { left: number; right: number; distance: number } | null = null;
      inTree.forEach((left) => {
        nearestByIndex[left].forEach((candidate) => {
          if (inTree.has(candidate.index)) return;
          if (!best || candidate.distance < best.distance) {
            best = { left, right: candidate.index, distance: candidate.distance };
          }
        });
      });
      if (!best) break;
      const connection = best as { left: number; right: number; distance: number };
      addEdge(connection.left, connection.right);
      inTree.add(connection.right);
    }
  }

  panoramas.forEach((panorama, index) => {
    panorama.neighbors = [...adjacency[index]]
      .sort((left, right) => distance(panorama, panoramas[left]) - distance(panorama, panoramas[right]))
      .map((neighborIndex) => ({ id: panoramas[neighborIndex].id }));
  });
}

function capturedDate(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Date inconnue";
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat("fr-CH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Zurich",
  }).format(new Date(milliseconds));
}

function dominantElevation(rows: PoseRow[]) {
  const binSize = 0.75;
  const bins = new Map<number, number>();
  rows.forEach((row) => {
    const bin = Math.round(row.z / binSize);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  });
  const dominantBin = [...bins].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 0;
  const approximateElevation = dominantBin * binSize;
  const nearby = rows.filter((row) => Math.abs(row.z - approximateElevation) <= 1.1);
  return nearby.reduce((sum, row) => sum + row.z, 0) / Math.max(nearby.length, 1);
}

async function mapConcurrent<T>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<void>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function buildTour(options: BuildTourOptions): Promise<BuildTourResult> {
  const source = resolve(options.source);
  const sourceStats = await stat(source).catch(() => null);
  if (!sourceStats?.isDirectory()) throw new Error(`Le dossier source est introuvable : ${source}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.slug)) {
    throw new Error("Le slug doit contenir uniquement des minuscules, chiffres et tirets simples.");
  }

  const release = options.release ?? releaseIdentifier();
  if (!/^[A-Za-z0-9._-]+$/.test(release)) throw new Error("L’identifiant de release est invalide.");
  const quality = options.quality ?? 82;
  const maxWidth = options.maxWidth ?? 8192;
  const maxHeight = options.maxHeight ?? 4096;
  if (quality < 1 || quality > 100) throw new Error("La qualité WebP doit être comprise entre 1 et 100.");
  if (maxWidth < 512 || maxHeight < 256) throw new Error("Les dimensions maximales sont trop petites.");

  const outputRoot = resolve(options.outputRoot ?? "outputs/published-tours");
  const tourDirectory = resolve(outputRoot, options.slug);
  const releaseDirectory = resolve(tourDirectory, "releases", release);
  if (await exists(releaseDirectory)) {
    throw new Error(`La release ${release} existe déjà dans ${releaseDirectory}.`);
  }

  const files = await sourceFiles(source);
  const parsed = await poseRows(files) ?? await fallbackRows(files);
  const minX = Math.min(...parsed.rows.map((row) => row.x));
  const maxX = Math.max(...parsed.rows.map((row) => row.x));
  const minY = Math.min(...parsed.rows.map((row) => row.y));
  const maxY = Math.max(...parsed.rows.map((row) => row.y));
  const spanX = Math.max(maxX - minX, 0.001);
  const spanY = Math.max(maxY - minY, 0.001);
  const baseElevation = dominantElevation(parsed.rows);
  const panoramasDirectory = resolve(releaseDirectory, "panoramas");
  const warnings: string[] = [];
  await mkdir(panoramasDirectory, { recursive: true });

  const panoramas: Panorama[] = parsed.rows.map((row) => {
    const floor = Math.round((row.z - baseElevation) / FLOOR_HEIGHT_METERS);
    const imageName = `${String(row.id).padStart(5, "0")}.webp`;
    return {
      id: row.id,
      image: `/tours/${options.slug}/releases/${release}/panoramas/${imageName}`,
      label: row.filename.replace(/\.[^.]+$/, ""),
      area: floor === 0 ? "Niveau principal" : `Niveau ${floor}`,
      floor,
      position: {
        x: round(row.x - minX, 4),
        y: round(row.y - minY, 4),
        z: round(row.z, 4),
        mapX: round((row.x - minX) / spanX, 5),
        mapY: round((maxY - row.y) / spanY, 5),
      },
      orientation: row.orientation,
      neighbors: [],
      timestamp: row.timestamp,
    };
  });
  buildNeighbors(panoramas);

  await mapConcurrent(parsed.rows, 3, async (row) => {
    const imageName = `${String(row.id).padStart(5, "0")}.webp`;
    const pipeline = sharp(row.file.absolutePath, { limitInputPixels: false }).rotate();
    try {
      const metadata = await pipeline.metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error(`Dimensions illisibles pour ${row.file.relativePath}.`);
      }
      const ratio = metadata.width / metadata.height;
      if (ratio < 1.75 || ratio > 2.25) {
        throw new Error(`${row.file.relativePath} n’est pas un panorama équirectangulaire 2:1 (${metadata.width}×${metadata.height}).`);
      }
      if (ratio < 1.95 || ratio > 2.05) {
        warnings.push(`${row.file.relativePath} a un ratio inhabituel de ${ratio.toFixed(3)}.`);
      }
      await pipeline
        .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 5 })
        .toFile(resolve(panoramasDirectory, imageName));
    } finally {
      pipeline.destroy();
    }
  });

  const manifest: Manifest = {
    site: {
      name: options.title ?? displayName(basename(source)),
      captured: capturedDate(parsed.rows[0]?.timestamp),
      panoramaCount: panoramas.length,
      source: "remote-tour",
      sourceFolder: basename(source),
      poseSource: parsed.poseFile?.relativePath,
      poseConvention: parsed.poseFile
        ? "NavVis local X forward, Y right, Z up; quaternion local-to-dataset"
        : "Parcours séquentiel sans fichier de poses",
      bounds: { width: round(maxX - minX, 3), height: round(maxY - minY, 3) },
    },
    panoramas,
  };

  const manifestPath = resolve(releaseDirectory, "manifest.json");
  const pointerPath = resolve(tourDirectory, "current.json");
  const pointer: TourPointer = {
    schemaVersion: 1,
    slug: options.slug,
    release,
    manifest: `/tours/${options.slug}/releases/${release}/manifest.json`,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await mkdir(tourDirectory, { recursive: true });
  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");

  return {
    slug: options.slug,
    release,
    releaseDirectory,
    pointerPath,
    manifestPath,
    pointer,
    manifest,
    warnings,
  };
}
