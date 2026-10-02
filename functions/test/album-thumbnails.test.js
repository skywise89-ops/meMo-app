"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_IMAGE_BYTES,
  MAX_SOURCE_PIXELS,
  MAX_THUMBNAIL_BYTES,
  MAX_VIDEO_BYTES,
  applyThumbnailClaim,
  applyThumbnailResult,
  buildLeanAlbumProjection,
  classifyAlbumMediaWrite,
  dataUrlByteLength,
  decodeInlineJpeg,
  immutableThumbnailPath,
  inspectSourceImage,
  isOriginalStoragePath,
  isThumbnailStoragePath,
  markAlbumIndexDeleted,
  parseFirebaseDownloadUrl,
  runWarmTransaction,
  setAlbumIndex,
  validateOriginalMetadata,
  validateStoredThumbnail
} = require("../album-thumbnails");

const BUCKET = "memo-e366f.firebasestorage.app";

function downloadUrl(objectPath, bucket = BUCKET) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}?alt=media&token=secret`;
}

test("lean album projection contains only visual fields and never inline or upload metadata", () => {
  const projection = buildLeanAlbumProjection({
    type:"video",
    url:"https://example.invalid/original",
    ts:123,
    uid:"Kevin",
    name:"Kevin",
    messageKey:"message-key",
    sourceTodoKey:"todo-key",
    durationMs:4567,
    thumbnailUrl:"https://example.invalid/thumb",
    thumbnailStoragePath:"memo_private_room/thumbs/a.jpg",
    thumbnailStatus:"ready",
    thumbnail:"data:image/jpeg;base64,heavy",
    size:999999,
    mimeType:"video/mp4",
    fileName:"private.mp4",
    ownerUid:"auth-secret",
    ownerEmail:"private@example.com",
    storagePath:"memo_private_room/private.mp4"
  });

  assert.deepEqual(projection, {
    type:"video",
    url:"https://example.invalid/original",
    ts:123,
    messageKey:"message-key",
    durationMs:4567,
    thumbnailUrl:"https://example.invalid/thumb",
    thumbnailStatus:"ready"
  });
  assert.equal(JSON.stringify(projection).includes("base64"), false);
  assert.equal("ownerUid" in projection, false);
  assert.equal("uid" in projection, false);
  assert.equal("name" in projection, false);
  assert.equal("sourceTodoKey" in projection, false);
  assert.equal("storagePath" in projection, false);
  assert.equal("thumbnailStoragePath" in projection, false);
});

test("inline JPEG decoding is bounded and fails closed on MIME, base64, and signatures", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const valid = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  assert.equal(dataUrlByteLength(valid), jpeg.length);
  assert.deepEqual(decodeInlineJpeg(valid), jpeg);
  assert.equal(decodeInlineJpeg(valid, jpeg.length - 1), null);
  assert.equal(decodeInlineJpeg(valid.replace("image/jpeg", "image/png")), null);
  assert.equal(decodeInlineJpeg("data:image/jpeg;base64,!!!!"), null);

  const notJpeg = Buffer.alloc(20, 7);
  assert.equal(decodeInlineJpeg(`data:image/jpeg;base64,${notJpeg.toString("base64")}`), null);

  const oversized = Buffer.alloc(MAX_THUMBNAIL_BYTES + 1, 0);
  oversized[0] = 0xff;
  oversized[1] = 0xd8;
  oversized[2] = 0xff;
  oversized[oversized.length - 2] = 0xff;
  oversized[oversized.length - 1] = 0xd9;
  assert.equal(decodeInlineJpeg(`data:image/jpeg;base64,${oversized.toString("base64")}`), null);
});

test("Firebase download URL parsing requires HTTPS, exact bucket, and safe encoded path", () => {
  const originalPath = "memo_private_room/photo name.jpg";
  assert.equal(parseFirebaseDownloadUrl(downloadUrl(originalPath), BUCKET), originalPath);
  assert.equal(parseFirebaseDownloadUrl(downloadUrl(originalPath, "other.firebasestorage.app"), BUCKET), "");
  assert.equal(parseFirebaseDownloadUrl(downloadUrl(originalPath).replace("https:", "http:"), BUCKET), "");
  assert.equal(parseFirebaseDownloadUrl("https://storage.googleapis.com/memo-e366f.firebasestorage.app/file.jpg", BUCKET), "");
  assert.equal(parseFirebaseDownloadUrl(downloadUrl("memo_private_room/../secret.jpg"), BUCKET), "");
});

test("source and thumbnail path policy excludes audio, derived files, and traversal", () => {
  assert.equal(isOriginalStoragePath("memo_private_room/photo.jpg"), true);
  assert.equal(isOriginalStoragePath("memo_private_room/folder/video.mp4"), true);
  assert.equal(isOriginalStoragePath("memo_private_room/thumbs/x.jpg"), false);
  assert.equal(isOriginalStoragePath("memo_private_room/audio/x.m4a"), false);
  assert.equal(isOriginalStoragePath("memo_private_room/../x.jpg"), false);
  assert.equal(isThumbnailStoragePath("memo_private_room/thumbs/abc.jpg"), true);
  assert.equal(isThumbnailStoragePath("memo_private_room/thumbs/abc.png"), false);
  assert.equal(isThumbnailStoragePath("memo_private_room/photo.jpg"), false);
});

test("original metadata validation enforces generation, media format, and per-type caps", () => {
  assert.deepEqual(validateOriginalMetadata({
    generation:"123",
    size:String(MAX_IMAGE_BYTES),
    contentType:"image/heic"
  }, "image"), {
    generation:"123",
    size:MAX_IMAGE_BYTES,
    contentType:"image/heic"
  });
  assert.throws(() => validateOriginalMetadata({
    generation:"123",
    size:String(MAX_IMAGE_BYTES + 1),
    contentType:"image/jpeg"
  }, "image"), /invalid-original-size/);
  assert.equal(MAX_VIDEO_BYTES, 16 * 1024 * 1024);
  assert.throws(() => validateOriginalMetadata({
    generation:"123",
    size:String(MAX_VIDEO_BYTES + 1),
    contentType:"video/mp4"
  }, "video"), /invalid-original-size/);
  assert.throws(() => validateOriginalMetadata({
    generation:"123",
    size:"10",
    contentType:"text/html"
  }, "image"), /invalid-original-type/);
});

test("stored thumbnail validation rejects metadata format and size before reuse", async () => {
  const objectPath = "memo_private_room/thumbs/abc.jpg";
  const candidate = {
    thumbnailStoragePath:objectPath,
    thumbnailUrl:downloadUrl(objectPath)
  };
  let downloads = 0;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const makeBucket = metadata => ({
    name:BUCKET,
    file() {
      return {
        async getMetadata() { return [metadata]; },
        async download() { downloads += 1; return [jpeg]; }
      };
    }
  });
  const fakeSharp = () => ({
    async metadata() { return { format:"jpeg", width:1, height:1 }; }
  });

  const validation = {
    sharp:fakeSharp,
    originalPath:"memo_private_room/original.jpg",
    generation:"7"
  };
  assert.equal(await validateStoredThumbnail(makeBucket({
    contentType:"image/png",
    size:String(jpeg.length),
    metadata:{ sourceStoragePath:validation.originalPath }
  }), candidate, validation), null);
  assert.equal(await validateStoredThumbnail(makeBucket({
    contentType:"image/jpeg",
    size:String(MAX_THUMBNAIL_BYTES + 1),
    metadata:{ sourceStoragePath:validation.originalPath }
  }), candidate, validation), null);
  assert.equal(await validateStoredThumbnail(makeBucket({
    contentType:"image/jpeg",
    size:String(jpeg.length),
    metadata:{ sourceStoragePath:"memo_private_room/other.jpg" }
  }), candidate, validation), null);
  assert.equal(await validateStoredThumbnail(makeBucket({
    contentType:"image/jpeg",
    size:String(jpeg.length),
    metadata:{ sourceStoragePath:validation.originalPath, sourceGeneration:"8" }
  }), candidate, validation), null);
  assert.equal(downloads, 0);
  assert.deepEqual(await validateStoredThumbnail(makeBucket({
    contentType:"image/jpeg",
    size:String(jpeg.length),
    metadata:{ sourceStoragePath:validation.originalPath, sourceGeneration:"7" }
  }), candidate, validation), candidate);
  assert.equal(downloads, 1);
});

test("source metadata rejects images beyond the 32M pixel decode cap", async () => {
  assert.equal(MAX_SOURCE_PIXELS, 32 * 1024 * 1024);
  const fakeSharp = () => ({
    async metadata() { return { format:"jpeg", width:8192, height:8192 }; }
  });
  await assert.rejects(() => inspectSourceImage(Buffer.from("x"), fakeSharp), /invalid-source-dimensions/);
});

test("immutable path depends on original path, generation, and version", () => {
  const one = immutableThumbnailPath("memo_private_room/a.jpg", "1", "v1");
  assert.match(one, /^memo_private_room\/thumbs\/[a-f0-9]{64}\.jpg$/);
  assert.equal(one, immutableThumbnailPath("memo_private_room/a.jpg", "1", "v1"));
  assert.notEqual(one, immutableThumbnailPath("memo_private_room/a.jpg", "2", "v1"));
  assert.notEqual(one, immutableThumbnailPath("memo_private_room/a.jpg", "1", "v2"));
});

test("race guards never resurrect deleted or replaced media", () => {
  const url = downloadUrl("memo_private_room/a.jpg");
  const expected = {
    url,
    bucketName:BUCKET,
    originalPath:"memo_private_room/a.jpg",
    type:"image",
    storagePath:"memo_private_room/a.jpg",
    workGeneration:"7"
  };
  const state = {
    thumbnailStatus:"ready",
    thumbnailUrl:downloadUrl("memo_private_room/thumbs/a.jpg"),
    thumbnailStoragePath:"memo_private_room/thumbs/a.jpg",
    thumbnailSourceGeneration:"7"
  };

  assert.equal(applyThumbnailResult(null, expected, state), undefined);
  assert.equal(applyThumbnailResult({ type:"image", storagePath:"memo_private_room/a.jpg", url:downloadUrl("memo_private_room/b.jpg") }, expected, state), undefined);
  assert.equal(applyThumbnailResult({ type:"video", storagePath:"memo_private_room/a.jpg", url, thumbnailWorkGeneration:"7" }, expected, state), undefined);
  assert.equal(applyThumbnailResult({ type:"image", storagePath:"memo_private_room/b.jpg", url, thumbnailWorkGeneration:"7" }, expected, state), undefined);
  assert.equal(applyThumbnailResult({ type:"image", storagePath:"memo_private_room/a.jpg", url, thumbnailWorkGeneration:"8" }, expected, state), undefined);
  assert.equal(applyThumbnailResult({ type:"image", storagePath:"memo_private_room/a.jpg", url, thumbnailWorkGeneration:"8" }, {
    ...expected,
    workGeneration:""
  }, state), undefined);

  const updated = applyThumbnailResult({
    type:"image",
    storagePath:"memo_private_room/a.jpg",
    url,
    thumbnailWorkGeneration:"7",
    thumbnailWorkPath:"memo_private_room/a.jpg",
    thumbnailWorkAt:1
  }, expected, state);
  assert.equal(updated.thumbnailStatus, "ready");
  assert.equal(updated.thumbnailWorkGeneration, undefined);
  assert.equal(updated.thumbnailWorkPath, undefined);
});

test("warm transaction observes server state without seeding a stale read", async () => {
  function coldRef(initialValue) {
    let serverValue = initialValue;
    let cacheValue = null;
    let listener = null;
    return {
      on(event, callback) {
        assert.equal(event, "value");
        listener = callback;
        cacheValue = serverValue;
        callback({ val:() => cacheValue });
      },
      off(event, callback) {
        assert.equal(event, "value");
        assert.equal(callback, listener);
        listener = null;
        cacheValue = null;
      },
      async transaction(update) {
        const next = update(listener ? cacheValue : null);
        if (next === undefined) return { committed:false };
        serverValue = next;
        cacheValue = next;
        return { committed:true };
      },
      value:() => serverValue,
      listening:() => Boolean(listener)
    };
  }

  const existing = coldRef({ count:1 });
  assert.equal((await existing.transaction(current => current ? { count:current.count + 1 } : undefined)).committed, false);
  const result = await runWarmTransaction(existing, current => ({ count:current.count + 1 }));
  assert.equal(result.committed, true);
  assert.deepEqual(existing.value(), { count:2 });
  assert.equal(existing.listening(), false);

  const deleted = coldRef(null);
  const deletedResult = await runWarmTransaction(deleted, current => (
    current ? { ...current, thumbnailStatus:"processing" } : undefined
  ));
  assert.equal(deletedResult.committed, false);
  assert.equal(deleted.value(), null);
  assert.equal(deleted.listening(), false);
});

test("claim guard is URL/path scoped and idempotent for the same work generation", () => {
  const url = downloadUrl("memo_private_room/a.jpg");
  const expected = {
    url,
    bucketName:BUCKET,
    originalPath:"memo_private_room/a.jpg",
    generation:"7"
  };
  const claimed = applyThumbnailClaim({ type:"image", url }, expected, 100);
  assert.equal(claimed.thumbnailStatus, "processing");
  assert.equal(claimed.thumbnailWorkGeneration, "7");
  assert.equal(applyThumbnailClaim(claimed, expected, 101), undefined);
  assert.equal(applyThumbnailClaim({ type:"image", url:downloadUrl("memo_private_room/b.jpg") }, expected, 101), undefined);
});

test("trigger guard processes only source, external thumbnail, retry, create, and delete writes", () => {
  const base = {
    type:"image",
    url:"original",
    storagePath:"memo_private_room/a.jpg",
    thumbnailStatus:"processing"
  };
  assert.equal(classifyAlbumMediaWrite(null, base).reason, "created");
  assert.equal(classifyAlbumMediaWrite(base, null).reason, "deleted");
  assert.equal(classifyAlbumMediaWrite(base, { ...base, url:"replacement" }).reason, "source-changed");
  assert.equal(classifyAlbumMediaWrite(base, { ...base, storagePath:"memo_private_room/b.jpg" }).reason, "source-changed");
  assert.equal(classifyAlbumMediaWrite(base, { ...base, thumbnailRetryRequestAt:1 }).force, true);
  assert.equal(classifyAlbumMediaWrite(base, {
    ...base,
    thumbnailUrl:"client-thumb",
    thumbnailStoragePath:"memo_private_room/thumbs/client.jpg"
  }).reason, "external-thumbnail-changed");
  const withGeneration = { ...base, thumbnailSourceGeneration:"7" };
  assert.equal(classifyAlbumMediaWrite(withGeneration, {
    ...withGeneration,
    thumbnailUrl:"replacement-client-thumb",
    thumbnailStoragePath:"memo_private_room/thumbs/replacement.jpg"
  }).reason, "external-thumbnail-changed");
  assert.equal(classifyAlbumMediaWrite(base, { ...base, thumbnailStatus:"unavailable" }).process, false);
  assert.equal(classifyAlbumMediaWrite(base, {
    ...base,
    thumbnailStatus:"ready",
    thumbnailUrl:"backend-thumb",
    thumbnailStoragePath:"memo_private_room/thumbs/backend.jpg",
    thumbnailSourceGeneration:"7"
  }).process, false);
});

test("pending index writer cannot overwrite a delete tombstone", async () => {
  let current = { deleted:true, deletedAt:200 };
  const indexRef = {
    on(event, callback) { callback({ val:() => current }); },
    off() {},
    async transaction(update) {
      const next = update(current);
      if (next === undefined) return { committed:false };
      current = next;
      return { committed:true };
    }
  };
  const roomRef = {
    child(name) {
      assert.equal(name, "albumIndex/media-key");
      return indexRef;
    }
  };
  const result = await setAlbumIndex(roomRef, "media-key", {
    type:"image",
    url:"original",
    ts:1,
    uid:"Kevin",
    name:"Kevin",
    thumbnailStatus:"ready"
  }, { indexRevisionAt:100 });
  assert.equal(result, null);
  assert.deepEqual(current, { deleted:true, deletedAt:200 });
});

test("normal index refresh preserves the restore revision barrier", async () => {
  let current = {
    type:"image",
    url:"original",
    thumbnailStatus:"ready",
    indexRevisionAt:300
  };
  const roomRef = {
    child() {
      return {
        on(event, callback) { callback({ val:() => current }); },
        off() {},
        async transaction(update) {
          const next = update(current);
          if (next === undefined) return { committed:false };
          current = next;
          return { committed:true };
        }
      };
    }
  };
  await setAlbumIndex(roomRef, "media-key", {
    type:"image",
    url:"original",
    ts:2,
    uid:"Kevin",
    name:"Kevin",
    thumbnailStatus:"ready"
  });
  assert.equal(current.indexRevisionAt, 300);
  assert.equal(current.ts, 2);
});

test("stale deletion marker cannot replace a newer restored projection", async () => {
  let current = {
    type:"image",
    url:"original",
    thumbnailStatus:"ready",
    indexRevisionAt:300
  };
  const roomRef = {
    child() {
      return {
        on(event, callback) { callback({ val:() => current }); },
        off() {},
        async transaction(update) {
          const next = update(current);
          if (next === undefined) return { committed:false };
          current = next;
          return { committed:true };
        }
      };
    }
  };
  assert.equal(await markAlbumIndexDeleted(roomRef, "media-key", 200), false);
  assert.equal(current.deleted, undefined);
});

test("thumbnail trigger has isolated low-concurrency production settings", () => {
  const functions = require("../index");
  const endpoint = functions.processAlbumThumbnail.__endpoint;

  assert.equal(endpoint.platform, "gcfv2");
  assert.deepEqual(endpoint.region, ["asia-southeast1"]);
  assert.equal(endpoint.eventTrigger.eventType, "google.firebase.database.ref.v1.written");
  assert.equal(endpoint.eventTrigger.eventFilters.instance, "memo-e366f-default-rtdb");
  assert.equal(endpoint.eventTrigger.eventFilterPathPatterns.ref, "memo_private_room/media/{mediaId}");
  assert.equal(endpoint.eventTrigger.retry, false);
  assert.equal(endpoint.timeoutSeconds, 120);
  assert.equal(endpoint.maxInstances, 1);
  assert.equal(endpoint.concurrency, 1);
  assert.equal(endpoint.cpu, 1);
  assert.equal(endpoint.availableMemoryMb, 512);
});
