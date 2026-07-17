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

test("server-renders the Arnex 360 loading shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Arnex 360 — Visite immersive<\/title>/i);
  assert.match(html, /Préparation de la visite d’Arnex/);
  assert.match(html, /Glisser pour regarder/);
  assert.match(html, /Hotspots/);
  assert.doesNotMatch(html, /Outil de mesure|Rechercher un lieu/);
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

  assert.ok(Math.abs(viewerYaw(byId.get(0), byId.get(1)) - (-12.126)) < 0.02);
  assert.ok(Math.abs(viewerYaw(byId.get(3), byId.get(4)) - (-116.864)) < 0.02);
});
