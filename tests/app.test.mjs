import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_VIDEO_BYTES,
  albumMonthKey,
  mediaKind,
  normalizedVideoFileName,
  normalizeSearchText,
  validateMediaFile,
  videoContentType
} from "../app-core.js";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const worker = await readFile(new URL("firebase-messaging-sw.js", root), "utf8");

test("module script parses", async () => {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "module script not found");

  const directory = await mkdtemp(join(tmpdir(), "memo-check-"));
  const scriptPath = join(directory, "app.mjs");

  try {
    await writeFile(scriptPath, match[1], "utf8");
    const result = spawnSync(process.execPath, ["--check", scriptPath], { encoding:"utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive:true, force:true });
  }
});

test("service worker parses", () => {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL("firebase-messaging-sw.js", root))], {
    encoding:"utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});

test("document ids are unique", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("required improvements remain wired", () => {
  assert.match(html, /SEARCH_PAGE_SIZE/);
  assert.match(html, /albumMonthFilter/);
  assert.match(html, /album-section-grid/);
  assert.match(html, /contextmenu/);
  assert.match(html, /validateMediaFile/);
  assert.match(html, /fcmReady/);
  assert.match(worker, /if \(payload\.notification\)/);
  assert.match(worker, /getNotifications\(\{ tag \}\)/);
});

test("video upload limit is exactly 5 MiB", () => {
  assert.equal(MAX_VIDEO_BYTES, 5 * 1024 * 1024);
  assert.doesNotThrow(() => validateMediaFile({ name:"ok.mp4", type:"video/mp4", size:MAX_VIDEO_BYTES }));
  assert.throws(
    () => validateMediaFile({ name:"large.mp4", type:"video/mp4", size:MAX_VIDEO_BYTES + 1 }),
    /5MB 이하/
  );
  assert.equal(mediaKind({ name:"iphone.MOV", type:"" }), "video");
  assert.equal(mediaKind({ name:"photo.JPG", type:"" }), "image");
  assert.equal(videoContentType({ name:"iphone.MOV", type:"" }), "video/quicktime");
  assert.equal(videoContentType({ name:"clip", type:"video/mp4" }), "video/mp4");
  assert.equal(normalizedVideoFileName({ name:"clip", type:"video/quicktime" }), "clip.mov");
});

test("iOS video upload uses a stable blob and non-resumable request", () => {
  assert.match(html, /const bytes = await file\.arrayBuffer\(\)/);
  assert.match(html, /targetFile = new Blob\(\[bytes\]/);
  assert.match(html, /await uploadBytes\(storageRef, targetFile, metadata\)/);
  assert.match(html, /serverResponse:err\?\.serverResponse/);
  assert.match(html, /finally \{[\s\S]*?input\.value = "";/);
});

test("search normalization and album month grouping are deterministic", () => {
  assert.equal(normalizeSearchText("ＡBC 가나다"), "abc 가나다");
  assert.match(albumMonthKey(new Date(2026, 7, 2).getTime()), /^2026-08$/);
});
