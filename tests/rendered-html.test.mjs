import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function rotateByQuaternion(vector, quaternion) {
  const q = [-quaternion.x, -quaternion.y, -quaternion.z];
  const w = quaternion.w;
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const firstCross = cross(q, vector);
  const inner = firstCross.map((value, index) => value + w * vector[index]);
  const secondCross = cross(q, inner);
  return vector.map((value, index) => value + 2 * secondCross[index]);
}

function viewerYaw(from, to) {
  const datasetVector = [
    to.position.x - from.position.x,
    to.position.y - from.position.y,
    to.position.z - from.position.z,
  ];
  const local = rotateByQuaternion(datasetVector, from.orientation);
  const viewer = [-local[0], local[2], local[1]];
  return Math.atan2(viewer[2], viewer[0]) * 180 / Math.PI;
}

test("server-renders the panorama folder prompt", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Panorama 360 — Visionneuse immersive<\/title>/i);
  assert.match(html, /Chargez vos panoramas/);
  assert.match(html, /Choisir un dossier/);
  assert.match(html, /Vos images restent sur cet appareil/);
  assert.match(html, /Glisser pour regarder/);
  assert.match(html, /Hotspots/);
  assert.match(html, /Rayon d’affichage/);
  assert.match(html, /Ouvrir un dossier/);
  assert.doesNotMatch(html, /Outil de mesure|Rechercher un lieu/);
});

test("lets the user choose and persist a panorama visibility radius", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /distanceBetweenPanoramas\(currentPanorama, panorama\) <= visibleRadiusMeters/);
  assert.match(pageSource, /panorama360\.visibleRadiusMeters/);
  assert.match(pageSource, /min=\{MIN_VISIBLE_RADIUS_METERS\}/);
  assert.match(pageSource, /max=\{MAX_VISIBLE_RADIUS_METERS\}/);
  assert.match(pageSource, /<span>30 m<\/span>/);
});

test("loads arbitrary local panorama folders without uploading their images", async () => {
  const [pageSource, loaderSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/panorama-folder.ts", import.meta.url), "utf8"),
  ]);

  assert.match(pageSource, /webkitdirectory/);
  assert.match(pageSource, /loadPanoramaFolder\(files\)/);
  assert.match(pageSource, /Aucune image n’est envoyée/);
  assert.match(pageSource, /Promise\.resolve<string \| null>\(null\)/);
  assert.doesNotMatch(pageSource, /Promise\.resolve\("\/panoramas\/manifest\.json"\)/);
  assert.match(loaderSource, /pano_pos_x/);
  assert.match(loaderSource, /URL\.createObjectURL\(row\.file\)/);
  assert.match(loaderSource, /Parcours séquentiel sans fichier de poses/);
  assert.doesNotMatch(loaderSource, /fetch\(|XMLHttpRequest|FormData/);
});

test("loads a published tour from its versioned current pointer", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const staticEntry = await readFile(new URL("../static-viewer/main.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /`tours\/\$\{encodeURIComponent\(slug\)\}\/current\.json`/);
  assert.match(pageSource, /function publishedTourBaseUrl\(\)/);
  assert.match(pageSource, /applicationBasePath === "\/viewer\/v1\/" \? "\/" : applicationBasePath/);
  assert.match(pageSource, /new URL\(`tours\/\$\{encodeURIComponent\(slug\)\}\/current\.json`, tourBaseUrl\)/);
  assert.ok(pageSource.includes('return new URL(pointer.manifest.replace(/^\\//, ""), tourBaseUrl).toString();'));
  assert.match(pageSource, /cache: "no-store"/);
  assert.match(staticEntry, /import Home from "\.\.\/app\/page"/);
});

test("provides a navigable 3D route map with direct panorama selection", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /OrbitControls/);
  assert.match(pageSource, /new THREE\.Raycaster\(\)/);
  assert.match(pageSource, /intersectObjects\(pointMeshes, false\)/);
  assert.match(pageSource, /onSelectRef\.current\(Number\(mesh\.userData\.panoramaId\)\)/);
  assert.match(pageSource, /<MapScene panoramas=\{manifest\.panoramas\}/);
  assert.doesNotMatch(pageSource, /getContext\("2d"\)/);
});

test("gives panorama hotspots a strong distance-based perspective", async () => {
  const [pageSource, cssSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(pageSource, /Math\.pow\(4\.5 \/ Math\.max\(distanceMeters, 2\.2\), 0\.72\)/);
  assert.match(pageSource, /hotspotPerspectiveScale\(distance, camera\.fov\)/);
  assert.match(pageSource, /hotspotPerspectiveOpacity\(distance\)\.toFixed\(3\)/);
  assert.match(pageSource, /hotspotRevealUntilRef\.current = performance\.now\(\) \+ HOTSPOT_REVEAL_DURATION_MS/);
  assert.match(pageSource, /time < hotspotRevealUntilRef\.current/);
  assert.match(cssSource, /border: 2px solid #fff/);
  assert.doesNotMatch(pageSource, /hotspot-chevron/);
  assert.doesNotMatch(cssSource, /\.hotspot-chevron/);
  assert.match(pageSource, /element\.style\.zIndex = String/);
});

test("keeps all NavVis poses and projects navigation in a proper 3D basis", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../public/panoramas/manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.panoramas.length, 45);
  assert.equal(manifest.site.poseSource, "pano-poses-registered.csv");

  const byId = new Map(manifest.panoramas.map((panorama) => [panorama.id, panorama]));
  for (const panorama of manifest.panoramas) {
    assert.ok(Number.isFinite(panorama.position.x));
    assert.ok(Number.isFinite(panorama.position.y));
    assert.ok(Number.isFinite(panorama.position.z));
    assert.ok(Number.isFinite(panorama.orientation.w));
    assert.ok(Number.isFinite(panorama.orientation.x));
    assert.ok(Number.isFinite(panorama.orientation.y));
    assert.ok(Number.isFinite(panorama.orientation.z));
    assert.ok(panorama.neighbors.every((neighbor) => Object.keys(neighbor).join() === "id"));
  }

  const reached = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const current = byId.get(queue.shift());
    for (const neighbor of current.neighbors) {
      if (!reached.has(neighbor.id)) {
        reached.add(neighbor.id);
        queue.push(neighbor.id);
      }
    }
  }
  assert.equal(reached.size, 45);

  const neighborCounts = manifest.panoramas.map((panorama) => panorama.neighbors.length);
  const averageNeighborCount = neighborCounts.reduce((sum, count) => sum + count, 0) / neighborCounts.length;
  assert.ok(averageNeighborCount >= 3.5);
  assert.ok(Math.max(...neighborCounts) >= 7);

  assert.ok(Math.abs(viewerYaw(byId.get(0), byId.get(1)) - (-12.126)) < 0.02);
  assert.ok(Math.abs(viewerYaw(byId.get(3), byId.get(4)) - (-116.864)) < 0.02);
});

test("levels each panorama from its NavVis orientation", async () => {
  const [manifest, pageSource] = await Promise.all([
    readFile(new URL("../public/panoramas/manifest.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  const tilts = manifest.panoramas.map((panorama) => {
    const localUp = rotateByQuaternion([0, 0, 1], panorama.orientation);
    const viewerUp = [-localUp[0], localUp[2], localUp[1]];
    const length = Math.hypot(...viewerUp);
    return Math.acos(Math.max(-1, Math.min(1, viewerUp[1] / length))) * 180 / Math.PI;
  });

  assert.ok(Math.max(...tilts) > 35);
  assert.ok(Math.max(...tilts) < 60);
  assert.match(pageSource, /setFromUnitVectors\(worldUpInViewer, VIEWER_UP\)/);
  assert.match(pageSource, /panoramaMeshRef\.current\?\.quaternion\.copy\(levelingQuaternion\(currentPanorama\)\)/);
});
