import { randomBytes, randomUUID } from "node:crypto";

export const MAX_FILES_PER_VISIT = 100;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const SUPPORTED_CONTENT_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export type UploadFile = {
  name: string;
  size: number;
  type: string;
  pose?: ScenePose;
};

export type ScenePose = {
  id: number;
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
  neighbors: Array<{ id: number }>;
  timestamp: number;
};

export type TourMetadata = {
  sourceFolder: string;
  captured: string;
  poseSource?: string;
  poseConvention?: string;
  bounds?: {
    width: number;
    height: number;
  };
};

export type VisitScene = UploadFile & {
  id: string;
  index: number;
  extension: string;
  uploadKey: string;
};

export type VisitRecord = {
  PK: string;
  SK: string;
  entity: "visit";
  id: string;
  ownerId: string;
  title: string;
  slug: string;
  shareId: string;
  status: "draft" | "uploading" | "published";
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  release?: string;
  scenes?: VisitScene[];
  tourMetadata?: TourMetadata;
};

export function slugify(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-CH")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "visite-360";
}

export function createVisitRecord(ownerId: string, title: string, requestedSlug?: string): VisitRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  const suffix = randomBytes(3).toString("hex");
  const slug = slugify(requestedSlug || title);

  return {
    PK: `USER#${ownerId}`,
    SK: `VISIT#${id}`,
    entity: "visit",
    id,
    ownerId,
    title: title.trim(),
    slug: `${slug}-${suffix}`,
    shareId: randomBytes(10).toString("hex"),
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function validateUploadFiles(files: unknown): UploadFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_VISIT) {
    throw new Error(`Sélectionnez entre 1 et ${MAX_FILES_PER_VISIT} panoramas.`);
  }

  const validated = files.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Le fichier ${index + 1} est invalide.`);
    }
    const file = candidate as Partial<UploadFile>;
    const type = String(file.type ?? "").toLocaleLowerCase();
    const extension = SUPPORTED_CONTENT_TYPES.get(type);
    const size = Number(file.size);
    const name = String(file.name ?? "").trim();
    if (!extension || !name) {
      throw new Error(`${name || `Fichier ${index + 1}`} n’est pas une image JPEG, PNG ou WebP prise en charge.`);
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
      throw new Error(`${name} dépasse la taille maximale de ${MAX_FILE_BYTES / 1024 / 1024} Mo.`);
    }
    const pose = validateScenePose((candidate as { pose?: unknown }).pose, name);
    return { name: name.slice(0, 180), size, type, ...(pose ? { pose } : {}) };
  });

  const posedFiles = validated.filter((file) => file.pose);
  if (posedFiles.length > 0 && posedFiles.length !== validated.length) {
    throw new Error("Le fichier de poses doit décrire tous les panoramas importés.");
  }
  if (posedFiles.length) {
    const ids = new Set(posedFiles.map((file) => file.pose!.id));
    if (ids.size !== posedFiles.length) {
      throw new Error("Le fichier de poses contient des identifiants en double.");
    }
    posedFiles.forEach((file) => {
      file.pose!.neighbors.forEach((neighbor) => {
        if (!ids.has(neighbor.id)) {
          throw new Error(`${file.name} référence un panorama voisin absent de l’import.`);
        }
      });
    });
  }

  return validated;
}

function finiteNumber(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 10_000_000) {
    throw new Error(`${label} est invalide dans le fichier de poses.`);
  }
  return number;
}

function validateScenePose(input: unknown, filename: string): ScenePose | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object") {
    throw new Error(`La pose de ${filename} est invalide.`);
  }
  const candidate = input as Partial<ScenePose>;
  const id = Number(candidate.id);
  const floor = Number(candidate.floor);
  if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(floor) || floor < -100 || floor > 100) {
    throw new Error(`L’identifiant ou le niveau de ${filename} est invalide.`);
  }
  if (!candidate.position || !candidate.orientation || !Array.isArray(candidate.neighbors)) {
    throw new Error(`La pose de ${filename} est incomplète.`);
  }
  const position = {
    x: finiteNumber(candidate.position.x, `La position X de ${filename}`),
    y: finiteNumber(candidate.position.y, `La position Y de ${filename}`),
    z: finiteNumber(candidate.position.z, `La position Z de ${filename}`),
    mapX: finiteNumber(candidate.position.mapX, `La position sur plan X de ${filename}`),
    mapY: finiteNumber(candidate.position.mapY, `La position sur plan Y de ${filename}`),
  };
  if (position.mapX < 0 || position.mapX > 1 || position.mapY < 0 || position.mapY > 1) {
    throw new Error(`La position sur plan de ${filename} doit être comprise entre 0 et 1.`);
  }
  const orientation = {
    w: finiteNumber(candidate.orientation.w, `L’orientation W de ${filename}`),
    x: finiteNumber(candidate.orientation.x, `L’orientation X de ${filename}`),
    y: finiteNumber(candidate.orientation.y, `L’orientation Y de ${filename}`),
    z: finiteNumber(candidate.orientation.z, `L’orientation Z de ${filename}`),
  };
  const orientationLength = Math.hypot(orientation.w, orientation.x, orientation.y, orientation.z);
  if (orientationLength < 0.000001) {
    throw new Error(`L’orientation de ${filename} est invalide.`);
  }
  Object.keys(orientation).forEach((key) => {
    const component = key as keyof typeof orientation;
    orientation[component] /= orientationLength;
  });
  if (candidate.neighbors.length > 16) {
    throw new Error(`${filename} contient trop de connexions voisines.`);
  }
  const neighborIds = candidate.neighbors.map((neighbor) => Number(neighbor?.id));
  if (neighborIds.some((neighborId) => !Number.isSafeInteger(neighborId) || neighborId < 0 || neighborId === id)) {
    throw new Error(`Les voisins de ${filename} sont invalides.`);
  }
  const label = String(candidate.label ?? filename.replace(/\.[^.]+$/, "")).trim().slice(0, 240);
  const area = String(candidate.area ?? (floor === 0 ? "Niveau principal" : `Niveau ${floor}`)).trim().slice(0, 120);
  const timestamp = Number(candidate.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 10_000_000_000_000) {
    throw new Error(`L’horodatage de ${filename} est invalide dans le fichier de poses.`);
  }
  return {
    id,
    label: label || filename.replace(/\.[^.]+$/, ""),
    area: area || "Niveau principal",
    floor,
    position,
    orientation,
    neighbors: [...new Set(neighborIds)].map((neighborId) => ({ id: neighborId })),
    timestamp,
  };
}

export function validateTourMetadata(input: unknown): TourMetadata | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object") throw new Error("Les informations du dossier sont invalides.");
  const candidate = input as Partial<TourMetadata>;
  const sourceFolder = String(candidate.sourceFolder ?? "").trim().slice(0, 240);
  const captured = String(candidate.captured ?? "").trim().slice(0, 120);
  if (!sourceFolder || !captured) throw new Error("Le nom du dossier ou la date de capture est manquant.");
  const bounds = candidate.bounds ? {
    width: Math.max(0, finiteNumber(candidate.bounds.width, "La largeur du relevé")),
    height: Math.max(0, finiteNumber(candidate.bounds.height, "La hauteur du relevé")),
  } : undefined;
  const poseSource = String(candidate.poseSource ?? "").trim().slice(0, 240) || undefined;
  const poseConvention = String(candidate.poseConvention ?? "").trim().slice(0, 240) || undefined;
  return { sourceFolder, captured, poseSource, poseConvention, bounds };
}

export function createScenes(ownerId: string, visitId: string, files: UploadFile[]): VisitScene[] {
  return files.map((file, index) => {
    const extension = SUPPORTED_CONTENT_TYPES.get(file.type);
    if (!extension) throw new Error(`Type de fichier non pris en charge : ${file.type}`);
    const id = randomUUID();
    return {
      ...file,
      id,
      index,
      extension,
      uploadKey: `uploads/${ownerId}/${visitId}/${String(index).padStart(5, "0")}-${id}.${extension}`,
    };
  });
}

export function releaseIdentifier(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function buildPublishedTour(visit: VisitRecord, release: string, publishedAt: string) {
  const scenes = visit.scenes ?? [];
  const usesPoses = scenes.length > 0 && scenes.every((scene) => Boolean(scene.pose));
  const panoramas = scenes.map((scene, index) => {
    const pose = usesPoses ? scene.pose : undefined;
    const previous = index > 0 ? scenes[index - 1] : null;
    const next = index < scenes.length - 1 ? scenes[index + 1] : null;
    const neighbors = pose?.neighbors ?? [previous, next]
      .filter((candidate): candidate is VisitScene => Boolean(candidate))
      .map((candidate) => ({ id: candidate.index }));
    const panoramaKey = `tours/${visit.shareId}/releases/${release}/panoramas/${String(index).padStart(5, "0")}.${scene.extension}`;

    return {
      id: pose?.id ?? index,
      image: `/${panoramaKey}`,
      label: pose?.label ?? scene.name.replace(/\.[^.]+$/, ""),
      area: pose?.area ?? "Niveau principal",
      floor: pose?.floor ?? 0,
      position: pose?.position ?? {
        x: index * 2.5,
        y: 0,
        z: 0,
        mapX: scenes.length <= 1 ? 0.5 : index / (scenes.length - 1),
        mapY: 0.5,
      },
      orientation: pose?.orientation ?? { w: 1, x: 0, y: 0, z: 0 },
      neighbors,
      timestamp: pose?.timestamp ?? Date.parse(publishedAt) / 1000,
      panoramaKey,
    };
  });

  const fallbackCaptured = new Intl.DateTimeFormat("fr-CH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Zurich",
  }).format(new Date(publishedAt));

  const manifest = {
    site: {
      name: visit.title,
      captured: usesPoses ? visit.tourMetadata?.captured ?? fallbackCaptured : fallbackCaptured,
      panoramaCount: panoramas.length,
      source: "aws-studio",
      sourceFolder: usesPoses ? visit.tourMetadata?.sourceFolder ?? visit.slug : visit.slug,
      poseSource: usesPoses ? visit.tourMetadata?.poseSource : undefined,
      poseConvention: usesPoses
        ? visit.tourMetadata?.poseConvention ?? "Positions et orientations importées depuis le dossier source"
        : "Parcours séquentiel créé depuis le studio",
      bounds: usesPoses
        ? visit.tourMetadata?.bounds ?? { width: 0, height: 0 }
        : { width: Math.max((panoramas.length - 1) * 2.5, 0), height: 0 },
    },
    panoramas: panoramas.map((panorama) => ({
      id: panorama.id,
      image: panorama.image,
      label: panorama.label,
      area: panorama.area,
      floor: panorama.floor,
      position: panorama.position,
      orientation: panorama.orientation,
      neighbors: panorama.neighbors,
      timestamp: panorama.timestamp,
    })),
  };
  const pointer = {
    schemaVersion: 1,
    slug: visit.shareId,
    release,
    manifest: `/tours/${visit.shareId}/releases/${release}/manifest.json`,
    generatedAt: publishedAt,
  };

  return { manifest, pointer, panoramas };
}
