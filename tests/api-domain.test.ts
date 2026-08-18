import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPublishedTour,
  createScenes,
  createVisitRecord,
  slugify,
  validateTourMetadata,
  validateUploadFiles,
} from "../infra/functions/domain.ts";

test("normalizes visit slugs and creates isolated share identifiers", () => {
  assert.equal(slugify("Résidence de l'Orée — Genève"), "residence-de-l-oree-geneve");
  const first = createVisitRecord("creator-a", "Résidence du Parc");
  const second = createVisitRecord("creator-a", "Résidence du Parc");
  assert.match(first.slug, /^residence-du-parc-[a-f0-9]{6}$/);
  assert.notEqual(first.slug, second.slug);
  assert.notEqual(first.shareId, second.shareId);
  assert.equal(first.PK, "USER#creator-a");
});

test("rejects unsupported uploads and caps visits at one hundred panoramas", () => {
  assert.throws(() => validateUploadFiles([{ name: "plan.pdf", size: 20, type: "application/pdf" }]), /prise en charge/);
  assert.throws(() => validateUploadFiles(Array.from({ length: 101 }, (_, index) => ({
    name: `${index}.jpg`,
    size: 1024,
    type: "image/jpeg",
  }))), /entre 1 et 100/);
});

test("builds the immutable manifest and sequential navigation for publication", () => {
  const visit = createVisitRecord("creator-a", "Bâtiment A");
  visit.scenes = createScenes("creator-a", visit.id, [
    { name: "hall.jpg", size: 1024, type: "image/jpeg" },
    { name: "salon.webp", size: 2048, type: "image/webp" },
    { name: "terrasse.png", size: 2048, type: "image/png" },
  ]);
  const published = buildPublishedTour(visit, "20260818T120000Z", "2026-08-18T12:00:00.000Z");
  assert.equal(published.manifest.site.panoramaCount, 3);
  assert.deepEqual(published.manifest.panoramas[0].neighbors, [{ id: 1 }]);
  assert.deepEqual(published.manifest.panoramas[1].neighbors, [{ id: 0 }, { id: 2 }]);
  assert.equal(published.pointer.manifest, `/tours/${visit.shareId}/releases/20260818T120000Z/manifest.json`);
  assert.equal(published.panoramas[2].panoramaKey.endsWith("00002.png"), true);
});

test("preserves imported poses, floors and spatial navigation in the published visit", () => {
  const visit = createVisitRecord("creator-a", "Relevé NavVis");
  const files = validateUploadFiles([
    {
      name: "pano-10.jpg",
      size: 1024,
      type: "image/jpeg",
      pose: {
        id: 10,
        label: "Entrée",
        area: "Niveau principal",
        floor: 0,
        position: { x: 0, y: 0, z: 412.4, mapX: 0, mapY: 1 },
        orientation: { w: 2, x: 0, y: 0, z: 0 },
        neighbors: [{ id: 42 }],
        timestamp: 1_775_000_000,
      },
    },
    {
      name: "pano-42.jpg",
      size: 1024,
      type: "image/jpeg",
      pose: {
        id: 42,
        label: "Étage",
        area: "Niveau 1",
        floor: 1,
        position: { x: 8.5, y: 2.25, z: 415.5, mapX: 1, mapY: 0 },
        orientation: { w: 0.707, x: 0, y: 0, z: 0.707 },
        neighbors: [{ id: 10 }],
        timestamp: 1_775_000_030,
      },
    },
  ]);
  visit.scenes = createScenes("creator-a", visit.id, files);
  visit.tourMetadata = validateTourMetadata({
    sourceFolder: "releve-navvis",
    captured: "1 avril 2026",
    poseSource: "pano-poses.csv",
    poseConvention: "NavVis local X forward, Y right, Z up; quaternion local-to-dataset",
    bounds: { width: 8.5, height: 2.25 },
  });

  const published = buildPublishedTour(visit, "20260818T120000Z", "2026-08-18T12:00:00.000Z");
  assert.deepEqual(published.manifest.panoramas.map((panorama) => panorama.id), [10, 42]);
  assert.deepEqual(published.manifest.panoramas[0].neighbors, [{ id: 42 }]);
  assert.equal(published.manifest.panoramas[1].floor, 1);
  assert.equal(published.manifest.panoramas[1].position.x, 8.5);
  assert.equal(published.manifest.panoramas[0].orientation.w, 1);
  assert.equal(published.manifest.site.poseSource, "pano-poses.csv");
  assert.deepEqual(published.manifest.site.bounds, { width: 8.5, height: 2.25 });
});

test("rejects a pose graph that references an image missing from the folder", () => {
  assert.throws(() => validateUploadFiles([{
    name: "pano-10.jpg",
    size: 1024,
    type: "image/jpeg",
    pose: {
      id: 10,
      label: "Entrée",
      area: "Niveau principal",
      floor: 0,
      position: { x: 0, y: 0, z: 0, mapX: 0.5, mapY: 0.5 },
      orientation: { w: 1, x: 0, y: 0, z: 0 },
      neighbors: [{ id: 99 }],
      timestamp: 1_775_000_000,
    },
  }]), /voisin absent/);
});
