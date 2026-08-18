export type Neighbor = {
  id: number;
};

export type Panorama = {
  id: number;
  image: string;
  label: string;
  area: string;
  floor: number;
  position: {
    x: number;
    y: number;
    z: number;
    mapX: number;
    mapY: number;
  };
  orientation: {
    w: number;
    x: number;
    y: number;
    z: number;
  };
  neighbors: Neighbor[];
  timestamp?: number;
};

export type Manifest = {
  site: {
    name: string;
    captured: string;
    panoramaCount: number;
    source?: "local-folder" | "remote-tour";
    sourceFolder?: string;
    poseSource?: string;
    poseConvention?: string;
    bounds?: {
      width: number;
      height: number;
    };
  };
  panoramas: Panorama[];
};

export type LoadedPanoramaFolder = {
  manifest: Manifest;
  objectUrls: string[];
  panoramaFiles: File[];
};

type PoseRow = {
  id: number;
  filename: string;
  timestamp: number;
  x: number;
  y: number;
  z: number;
  orientation: Panorama["orientation"];
  file: File;
};

const IMAGE_EXTENSION = /\.(?:avif|jpe?g|png|webp)$/i;
const EXCLUDED_FALLBACK_IMAGE = /(?:quality|site[-_ ]?map|thumbnail|preview)/i;
const FLOOR_HEIGHT_METERS = 3.1;

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
}

function relativePathInsideFolder(file: File) {
  const relativePath = file.webkitRelativePath || file.name;
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : relativePath;
}

function folderName(files: File[]) {
  const path = files.find((file) => file.webkitRelativePath)?.webkitRelativePath;
  return path?.split("/")[0] || "Dossier local";
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

function imageFileIndex(files: File[]) {
  const index = new Map<string, File>();
  files.filter((file) => IMAGE_EXTENSION.test(file.name)).forEach((file) => {
    const relativePath = normalizePath(file.webkitRelativePath || file.name);
    const insideFolder = normalizePath(relativePathInsideFolder(file));
    index.set(relativePath, file);
    index.set(insideFolder, file);
    index.set(normalizePath(file.name), file);
  });
  return index;
}

async function poseRows(files: File[]) {
  const csvFiles = files.filter((file) => /\.csv$/i.test(file.name));
  const namedPoseFile = csvFiles.find((file) => /pano.*poses|poses.*pano/i.test(file.name));
  let poseFile = namedPoseFile;

  if (!poseFile) {
    for (const candidate of csvFiles) {
      const header = (await candidate.slice(0, 600).text()).toLocaleLowerCase();
      if (header.includes("pano_pos_x") && header.includes("pano_ori_w")) {
        poseFile = candidate;
        break;
      }
    }
  }
  if (!poseFile) return null;

  const text = (await poseFile.text()).replace(/^\uFEFF/, "").trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Le fichier de poses est vide.");
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const imageIndex = imageFileIndex(files);
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
    const file = imageIndex.get(normalizePath(filename))
      ?? imageIndex.get(normalizePath(filename.split(/[\\/]/).at(-1) ?? filename));
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
      orientation: {
        w: numbers[5],
        x: numbers[6],
        y: numbers[7],
        z: numbers[8],
      },
      file,
    });
  });

  if (missingImages.length) {
    const example = missingImages.slice(0, 3).join(", ");
    throw new Error(`${missingImages.length} image(s) référencée(s) sont introuvables : ${example}.`);
  }
  if (!rows.length) throw new Error("Aucune pose de panorama valide n’a été trouvée.");
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Le fichier de poses contient des identifiants en double.");
  }

  return {
    poseFile,
    rows: rows.sort((left, right) => left.timestamp - right.timestamp || left.id - right.id),
  };
}

function fallbackRows(files: File[]): { poseFile: null; rows: PoseRow[] } {
  const allImages = files
    .filter((file) => IMAGE_EXTENSION.test(file.name) && !EXCLUDED_FALLBACK_IMAGE.test(file.name))
    .sort((left, right) => naturalCompare(relativePathInsideFolder(left), relativePathInsideFolder(right)));
  const panoramaImages = allImages.filter((file) => /pano(?:rama)?/i.test(file.name));
  const images = panoramaImages.length ? panoramaImages : allImages;
  if (!images.length) {
    throw new Error("Ce dossier ne contient aucune image panoramique prise en charge.");
  }

  const numericIds = images.map((file) => Number(file.name.match(/\d+/)?.[0]));
  const idsAreUnique = numericIds.every(Number.isFinite) && new Set(numericIds).size === images.length;
  return {
    poseFile: null,
    rows: images.map((file, index) => ({
      id: idsAreUnique ? numericIds[index] : index,
      filename: relativePathInsideFolder(file),
      timestamp: file.lastModified / 1000,
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

  const orderedNearestDistances = [...nearestDistances].sort((left, right) => left - right);
  const medianNearest = orderedNearestDistances[Math.floor(orderedNearestDistances.length / 2)] ?? 2.5;
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

  // A minimum spanning tree keeps isolated capture segments reachable while
  // favoring the shortest possible physical links between them.
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
      const connection = best as { left: number; right: number; distance: number } | null;
      if (!connection) break;
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

export async function loadPanoramaFolder(input: File[] | FileList): Promise<LoadedPanoramaFolder> {
  const files = Array.from(input);
  if (!files.length) throw new Error("Le dossier sélectionné est vide.");
  const parsed = await poseRows(files) ?? fallbackRows(files);
  const minX = Math.min(...parsed.rows.map((row) => row.x));
  const maxX = Math.max(...parsed.rows.map((row) => row.x));
  const minY = Math.min(...parsed.rows.map((row) => row.y));
  const maxY = Math.max(...parsed.rows.map((row) => row.y));
  const baseElevation = dominantElevation(parsed.rows);
  const spanX = Math.max(maxX - minX, 0.001);
  const spanY = Math.max(maxY - minY, 0.001);
  const sourceFolder = folderName(files);
  const objectUrls: string[] = [];

  try {
    const panoramas = parsed.rows.map((row) => {
      const image = URL.createObjectURL(row.file);
      objectUrls.push(image);
      const floor = Math.round((row.z - baseElevation) / FLOOR_HEIGHT_METERS);
      return {
        id: row.id,
        image,
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
      } satisfies Panorama;
    });
    buildNeighbors(panoramas);

    return {
      objectUrls,
      panoramaFiles: parsed.rows.map((row) => row.file),
      manifest: {
        site: {
          name: displayName(sourceFolder),
          captured: capturedDate(parsed.rows[0]?.timestamp),
          panoramaCount: panoramas.length,
          source: "local-folder",
          sourceFolder,
          poseSource: parsed.poseFile?.name,
          poseConvention: parsed.poseFile
            ? "NavVis local X forward, Y right, Z up; quaternion local-to-dataset"
            : "Parcours séquentiel sans fichier de poses",
          bounds: {
            width: round(maxX - minX, 3),
            height: round(maxY - minY, 3),
          },
        },
        panoramas,
      },
    };
  } catch (error) {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
}
