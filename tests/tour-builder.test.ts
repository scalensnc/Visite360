import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildTour } from "../scripts/lib/tour-builder.ts";

sharp.cache(false);
sharp.concurrency(1);

test("builds an immutable optimized release and updates its local pointer", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "panorama-tour-"));
  const source = resolve(root, "panoramas-client-a");
  const output = resolve(root, "published");

  try {
    await mkdir(source, { recursive: true });
    await sharp({ create: { width: 1024, height: 512, channels: 3, background: "#345f7a" } })
      .jpeg()
      .toFile(resolve(source, "pano-000.jpg"));
    await sharp({ create: { width: 1024, height: 512, channels: 3, background: "#81563d" } })
      .jpeg()
      .toFile(resolve(source, "pano-001.jpg"));
    await writeFile(resolve(source, "pano-poses.csv"), [
      "pano_id;pano_filename;timestamp;pano_pos_x;pano_pos_y;pano_pos_z;pano_ori_w;pano_ori_x;pano_ori_y;pano_ori_z",
      "0;pano-000.jpg;1754900000;0;0;0;1;0;0;0",
      "1;pano-001.jpg;1754900010;3;0;0;1;0;0;0",
    ].join("\n"), "utf8");

    const result = await buildTour({
      source,
      slug: "client-a",
      title: "Bâtiment A",
      release: "test-release",
      outputRoot: output,
      maxWidth: 512,
      maxHeight: 256,
      quality: 75,
    });
    const pointer = JSON.parse(await readFile(result.pointerPath, "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const optimized = await readFile(resolve(result.releaseDirectory, "panoramas", "00000.webp"));

    assert.equal(pointer.manifest, "/tours/client-a/releases/test-release/manifest.json");
    assert.equal(manifest.site.name, "Bâtiment A");
    assert.equal(manifest.site.source, "remote-tour");
    assert.equal(manifest.panoramas.length, 2);
    assert.deepEqual(manifest.panoramas[0].neighbors, [{ id: 1 }]);
    assert.equal(optimized.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(optimized.subarray(8, 12).toString("ascii"), "WEBP");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
