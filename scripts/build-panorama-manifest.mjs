import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";

const sourcePath = process.argv[2];
const outputPath = process.argv[3] ?? "public/panoramas/manifest.json";

if (!sourcePath) {
  throw new Error("Usage: node scripts/build-panorama-manifest.mjs <pano-poses-registered.csv> [manifest.json]");
}

const rows = fs.readFileSync(sourcePath, "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const values = line.split(";").map((value) => value.trim());
    const orientationValues = {
      w: Number(values[6]),
      x: Number(values[7]),
      y: Number(values[8]),
      z: Number(values[9]),
    };
    return {
      id: Number(values[0]),
      filename: values[1],
      timestamp: Number(values[2]),
      position: new THREE.Vector3(Number(values[3]), Number(values[4]), Number(values[5])),
      orientationValues,
      orientation: new THREE.Quaternion(
        orientationValues.x,
        orientationValues.y,
        orientationValues.z,
        orientationValues.w,
      ).normalize(),
    };
  })
  .sort((a, b) => a.timestamp - b.timestamp);

if (rows.length !== 45 || new Set(rows.map((row) => row.id)).size !== rows.length) {
  throw new Error(`Expected 45 unique panorama poses, received ${rows.length}.`);
}

const baseManifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
const baseById = new Map(baseManifest.panoramas.map((panorama) => [panorama.id, panorama]));
const poseById = new Map(rows.map((row) => [row.id, row]));
const adjacency = new Map(rows.map((row) => [row.id, new Set()]));

const addEdge = (from, to) => {
  if (!poseById.has(from) || !poseById.has(to) || from === to) {
    throw new Error(`Invalid route edge ${from} -> ${to}.`);
  }
  adjacency.get(from).add(to);
  adjacency.get(to).add(from);
};

// Each range is one continuous capture walk. The breaks are scanner
// repositionings, not navigable steps between the two consecutive files.
const captureSegments = [
  [0, 15],
  [16, 27],
  [28, 38],
  [39, 43],
];

for (const [first, last] of captureSegments) {
  for (let id = first; id < last; id += 1) addEdge(id, id + 1);
}

// Physical portals between capture walks. These connect the parking area,
// entrance, stair hall and upper-floor branch without linking through walls.
for (const [from, to] of [
  [13, 44],
  [13, 16],
  [16, 40],
  [20, 28],
]) addEdge(from, to);

// NavVis normally exposes several capture locations in the surrounding 3D
// space, not only the immediately previous and next frames. Expand the base
// walk graph to locations reachable within three capture steps when the route
// remains close to a straight line. The path/direct-distance ratio prevents
// shortcuts through walls and around sharp corners.
const baseAdjacency = new Map(
  [...adjacency].map(([id, neighbors]) => [id, new Set(neighbors)]),
);
const distanceBetween = (from, to) => (
  poseById.get(from).position.distanceTo(poseById.get(to).position)
);
const expandedEdges = new Set();

for (const row of rows) {
  const bestPathDistance = new Map([[row.id, 0]]);
  const routeQueue = [{ id: row.id, hops: 0, pathDistance: 0 }];

  while (routeQueue.length) {
    const current = routeQueue.shift();
    if (current.hops === 3) continue;

    for (const neighborId of baseAdjacency.get(current.id)) {
      const pathDistance = current.pathDistance + distanceBetween(current.id, neighborId);
      if (bestPathDistance.has(neighborId) && bestPathDistance.get(neighborId) <= pathDistance) continue;
      bestPathDistance.set(neighborId, pathDistance);
      routeQueue.push({ id: neighborId, hops: current.hops + 1, pathDistance });
    }
  }

  for (const [candidateId, pathDistance] of bestPathDistance) {
    if (candidateId === row.id) continue;
    const directDistance = distanceBetween(row.id, candidateId);
    if (directDistance > 20 || pathDistance / Math.max(directDistance, 0.01) > 1.3) continue;
    expandedEdges.add([Math.min(row.id, candidateId), Math.max(row.id, candidateId)].join(":"));
  }
}

for (const edge of expandedEdges) {
  const [from, to] = edge.split(":").map(Number);
  addEdge(from, to);
}

const minX = Math.min(...rows.map((row) => row.position.x));
const maxX = Math.max(...rows.map((row) => row.position.x));
const minY = Math.min(...rows.map((row) => row.position.y));
const maxY = Math.max(...rows.map((row) => row.position.y));

const round = (value, digits) => Number(value.toFixed(digits));

const panoramas = rows.map((row) => {
  const base = baseById.get(row.id);
  if (!base) throw new Error(`Panorama ${row.id} is missing from the current manifest.`);
  const neighbors = [...adjacency.get(row.id)].map((neighborId) => ({ id: neighborId }));

  return {
    ...base,
    id: row.id,
    image: `/panoramas/${String(row.id).padStart(5, "0")}.webp`,
    timestamp: row.timestamp,
    position: {
      x: round(row.position.x - minX, 3),
      y: round(row.position.y - minY, 3),
      z: round(row.position.z, 3),
      mapX: round((row.position.x - minX) / (maxX - minX), 5),
      mapY: round((maxY - row.position.y) / (maxY - minY), 5),
    },
    orientation: {
      w: row.orientationValues.w,
      x: row.orientationValues.x,
      y: row.orientationValues.y,
      z: row.orientationValues.z,
    },
    neighbors,
  };
});

const reached = new Set([panoramas[0].id]);
const queue = [panoramas[0].id];
while (queue.length) {
  const current = queue.shift();
  for (const neighbor of adjacency.get(current)) {
    if (!reached.has(neighbor)) {
      reached.add(neighbor);
      queue.push(neighbor);
    }
  }
}
if (reached.size !== panoramas.length) {
  throw new Error(`Route graph is disconnected: ${reached.size}/${panoramas.length} panoramas reachable.`);
}

const output = {
  ...baseManifest,
  site: {
    ...baseManifest.site,
    panoramaCount: panoramas.length,
    poseSource: path.basename(sourcePath),
    poseConvention: "NavVis local X forward, Y right, Z up; quaternion local-to-dataset",
    bounds: {
      width: round(maxX - minX, 3),
      height: round(maxY - minY, 3),
    },
  },
  panoramas,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Manifest rebuilt: ${panoramas.length} panoramas, ${[...adjacency.values()].reduce((sum, set) => sum + set.size, 0) / 2} route edges.`);
