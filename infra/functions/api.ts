import { CopyObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildPublishedTour,
  createScenes,
  createVisitRecord,
  MAX_FILE_BYTES,
  MAX_FILES_PER_VISIT,
  releaseIdentifier,
  validateTourMetadata,
  validateUploadFiles,
  type VisitRecord,
} from "./domain";

type ApiEvent = {
  rawPath?: string;
  requestContext?: {
    http?: { method?: string };
    authorizer?: { jwt?: { claims?: Record<string, string> } };
  };
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
};

const bucketName = requiredEnvironment("BUCKET_NAME");
const tableName = requiredEnvironment("TABLE_NAME");
const userPoolId = requiredEnvironment("USER_POOL_ID");
const userPoolClientId = requiredEnvironment("USER_POOL_CLIENT_ID");
const region = process.env.AWS_REGION ?? "eu-central-2";
const s3 = new S3Client({ region });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`La variable ${name} est requise.`);
  return value;
}

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event: ApiEvent) {
  if (!event.body) return {} as Record<string, unknown>;
  try {
    return JSON.parse(event.body) as Record<string, unknown>;
  } catch {
    throw new Error("Le corps de la requête n’est pas un JSON valide.");
  }
}

function ownerId(event: ApiEvent) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const subject = claims?.sub;
  if (!subject) throw new Error("AUTH_REQUIRED");
  return subject;
}

function publicVisit(visit: VisitRecord) {
  return {
    id: visit.id,
    title: visit.title,
    slug: visit.slug,
    shareId: visit.shareId,
    status: visit.status,
    panoramaCount: visit.scenes?.length ?? 0,
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
    publishedAt: visit.publishedAt,
    release: visit.release,
    sharePath: visit.status === "published" ? `/v/${visit.shareId}/` : undefined,
  };
}

async function findVisit(owner: string, visitId: string) {
  const result = await dynamodb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `USER#${owner}`, SK: `VISIT#${visitId}` },
  }));
  return result.Item as VisitRecord | undefined;
}

async function createVisit(event: ApiEvent, owner: string) {
  const body = parseBody(event);
  const title = String(body.title ?? "").trim();
  if (title.length < 2 || title.length > 100) {
    return response(400, { message: "Le titre doit contenir entre 2 et 100 caractères." });
  }
  const visit = createVisitRecord(owner, title, String(body.slug ?? ""));
  await dynamodb.send(new PutCommand({ TableName: tableName, Item: visit }));
  return response(201, { visit: publicVisit(visit) });
}

async function listVisits(owner: string) {
  const result = await dynamodb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :visit)",
    ExpressionAttributeValues: { ":pk": `USER#${owner}`, ":visit": "VISIT#" },
    ScanIndexForward: false,
  }));
  const visits = (result.Items ?? []) as VisitRecord[];
  return response(200, {
    visits: visits.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(publicVisit),
  });
}

async function prepareUploads(event: ApiEvent, owner: string, visitId: string) {
  const visit = await findVisit(owner, visitId);
  if (!visit) return response(404, { message: "Cette visite est introuvable." });
  if (visit.status === "published") {
    return response(409, { message: "Créez une nouvelle version avant de remplacer une visite publiée." });
  }

  const body = parseBody(event);
  const files = validateUploadFiles(body.files);
  const tourMetadata = validateTourMetadata(body.tour);
  const scenes = createScenes(owner, visitId, files);
  const uploads = await Promise.all(scenes.map(async (scene) => ({
    id: scene.id,
    index: scene.index,
    name: scene.name,
    url: await getSignedUrl(s3, new PutObjectCommand({
      Bucket: bucketName,
      Key: scene.uploadKey,
      ContentType: scene.type,
      Metadata: {
        owner,
        visit: visitId,
      },
    }), { expiresIn: 15 * 60 }),
    contentType: scene.type,
  })));

  const now = new Date().toISOString();
  await dynamodb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: visit.PK, SK: visit.SK },
    UpdateExpression: tourMetadata
      ? "SET scenes = :scenes, tourMetadata = :tourMetadata, #status = :status, updatedAt = :updatedAt"
      : "SET scenes = :scenes, #status = :status, updatedAt = :updatedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":scenes": scenes,
      ":status": "uploading",
      ":updatedAt": now,
      ...(tourMetadata ? { ":tourMetadata": tourMetadata } : {}),
    },
  }));
  return response(200, { uploads, expiresInSeconds: 900 });
}

async function publishVisit(owner: string, visitId: string) {
  const visit = await findVisit(owner, visitId);
  if (!visit) return response(404, { message: "Cette visite est introuvable." });
  if (!visit.scenes?.length) return response(409, { message: "Importez des panoramas avant de publier." });

  await Promise.all(visit.scenes.map((scene) => s3.send(new HeadObjectCommand({
    Bucket: bucketName,
    Key: scene.uploadKey,
  }))));

  const publishedAt = new Date().toISOString();
  const release = releaseIdentifier(new Date(publishedAt));
  const published = buildPublishedTour(visit, release, publishedAt);
  await Promise.all(published.panoramas.map((panorama, index) => s3.send(new CopyObjectCommand({
    Bucket: bucketName,
    Key: panorama.panoramaKey,
    CopySource: `${bucketName}/${visit.scenes?.[index].uploadKey ?? ""}`,
    ContentType: visit.scenes?.[index].type,
    CacheControl: "public, max-age=31536000, immutable",
    MetadataDirective: "REPLACE",
  }))));

  const manifestKey = `tours/${visit.shareId}/releases/${release}/manifest.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: manifestKey,
    Body: JSON.stringify(published.manifest),
    ContentType: "application/json; charset=utf-8",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `tours/${visit.shareId}/current.json`,
    Body: JSON.stringify(published.pointer),
    ContentType: "application/json; charset=utf-8",
    CacheControl: "no-store, max-age=0",
  }));

  await dynamodb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: visit.PK, SK: visit.SK },
    UpdateExpression: "SET #status = :status, publishedAt = :publishedAt, updatedAt = :publishedAt, release = :release",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "published", ":publishedAt": publishedAt, ":release": release },
  }));

  return response(200, {
    visit: publicVisit({ ...visit, status: "published", publishedAt, updatedAt: publishedAt, release }),
  });
}

export async function handler(event: ApiEvent) {
  try {
    const method = event.requestContext?.http?.method ?? "GET";
    const path = event.rawPath ?? "/";

    if (method === "GET" && path === "/api/config") {
      return response(200, {
        region,
        userPoolId,
        userPoolClientId,
        maxFilesPerVisit: MAX_FILES_PER_VISIT,
        maxFileBytes: MAX_FILE_BYTES,
      });
    }

    const owner = ownerId(event);
    if (method === "GET" && path === "/api/visits") return listVisits(owner);
    if (method === "POST" && path === "/api/visits") return createVisit(event, owner);

    const uploadMatch = path.match(/^\/api\/visits\/([^/]+)\/uploads$/);
    if (method === "POST" && uploadMatch) return prepareUploads(event, owner, uploadMatch[1]);
    const publishMatch = path.match(/^\/api\/visits\/([^/]+)\/publish$/);
    if (method === "POST" && publishMatch) return publishVisit(owner, publishMatch[1]);

    return response(404, { message: "Route introuvable." });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REQUIRED") {
      return response(401, { message: "Authentification requise." });
    }
    console.error(error);
    const message = error instanceof Error ? error.message : "Une erreur interne est survenue.";
    const statusCode = /Sélectionnez|fichier|taille|JSON|pose|panorama|niveau|position|orientation|voisin|dossier|relevé|connexion|identifiant/i.test(message) ? 400 : 500;
    return response(statusCode, { message });
  }
}
