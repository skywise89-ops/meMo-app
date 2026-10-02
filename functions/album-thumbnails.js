"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOM_ID = "memo_private_room";
const THUMBNAIL_PREFIX = `${ROOM_ID}/thumbs/`;
const MAX_THUMBNAIL_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 240;
const MAX_SOURCE_PIXELS = 32 * 1024 * 1024;
const THUMBNAIL_VERSION = "album-v1";
const WORK_LEASE_MS = 5 * 60 * 1000;
const JPEG_QUALITIES = Object.freeze([82, 72, 62, 52, 42, 34, 28, 22]);
const JPEG_DIMENSIONS = Object.freeze([240, 216, 192, 168, 144, 120, 96]);

let sharpModule = null;
let ffmpegBinary = null;

class ThumbnailError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ThumbnailError";
    this.code = code;
  }
}

function loadSharp() {
  if (!sharpModule) sharpModule = require("sharp");
  return sharpModule;
}

function loadFfmpegPath() {
  if (!ffmpegBinary) ffmpegBinary = require("ffmpeg-static");
  if (!ffmpegBinary) throw new ThumbnailError("ffmpeg-unavailable");
  return ffmpegBinary;
}

function hasSafeSegments(objectPath) {
  return typeof objectPath === "string"
    && objectPath.length > 0
    && !objectPath.includes("\\")
    && !objectPath.includes("\0")
    && objectPath.split("/").every(segment => segment && segment !== "." && segment !== "..");
}

function isOriginalStoragePath(objectPath) {
  if (!hasSafeSegments(objectPath) || !objectPath.startsWith(`${ROOM_ID}/`)) return false;
  if (objectPath.startsWith(THUMBNAIL_PREFIX)) return false;
  if (objectPath.startsWith(`${ROOM_ID}/audio/`)) return false;
  return objectPath.length > `${ROOM_ID}/`.length;
}

function isThumbnailStoragePath(objectPath) {
  return hasSafeSegments(objectPath)
    && objectPath.startsWith(THUMBNAIL_PREFIX)
    && objectPath.length > THUMBNAIL_PREFIX.length
    && objectPath.toLowerCase().endsWith(".jpg");
}

function parseFirebaseDownloadUrl(value, bucketName) {
  if (typeof value !== "string" || !value || typeof bucketName !== "string" || !bucketName) return "";

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== "firebasestorage.googleapis.com"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
    ) {
      return "";
    }

    const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) return "";
    const parsedBucket = decodeURIComponent(match[1]);
    const objectPath = decodeURIComponent(match[2]);
    if (parsedBucket !== bucketName || !hasSafeSegments(objectPath)) return "";
    return objectPath;
  } catch {
    return "";
  }
}

function dataUrlByteLength(value) {
  if (typeof value !== "string") return Infinity;
  const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || match[1].length % 4 !== 0) return Infinity;
  const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(match[1].length * 3 / 4) - padding);
}

function isJpegBytes(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 6
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

function decodeInlineJpeg(value, maxBytes = MAX_THUMBNAIL_BYTES) {
  const byteLength = dataUrlByteLength(value);
  if (!Number.isFinite(byteLength) || byteLength <= 0 || byteLength > maxBytes) return null;

  try {
    const body = value.slice(value.indexOf(",") + 1);
    const decoded = Buffer.from(body, "base64");
    if (decoded.length !== byteLength || !isJpegBytes(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function buildLeanAlbumProjection(media, options = {}) {
  if (!media || (media.type !== "image" && media.type !== "video")) return null;

  const projection = {
    type:media.type,
    url:typeof media.url === "string" ? media.url : "",
    ts:normalizeFiniteNumber(media.ts) ?? 0,
    thumbnailStatus:typeof media.thumbnailStatus === "string"
      ? media.thumbnailStatus
      : "unavailable"
  };

  if (typeof media.messageKey === "string" && media.messageKey) projection.messageKey = media.messageKey;
  const durationMs = normalizeFiniteNumber(media.durationMs);
  if (durationMs !== undefined) projection.durationMs = durationMs;
  if (typeof media.thumbnailUrl === "string" && media.thumbnailUrl) projection.thumbnailUrl = media.thumbnailUrl;
  const indexRevisionAt = normalizeFiniteNumber(options.indexRevisionAt);
  if (indexRevisionAt !== undefined) projection.indexRevisionAt = indexRevisionAt;

  return projection;
}

function immutableThumbnailPath(originalPath, generation, version = THUMBNAIL_VERSION) {
  const digest = crypto.createHash("sha256")
    .update(`${originalPath}\n${generation}\n${version}`, "utf8")
    .digest("hex");
  return `${THUMBNAIL_PREFIX}${digest}.jpg`;
}

function firebaseDownloadUrl(bucketName, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`;
}

function thumbnailCandidate(media) {
  const thumbnailUrl = typeof media?.thumbnailUrl === "string" && media.thumbnailUrl
    ? media.thumbnailUrl
    : typeof media?.thumbUrl === "string" ? media.thumbUrl : "";
  const thumbnailStoragePath = typeof media?.thumbnailStoragePath === "string" && media.thumbnailStoragePath
    ? media.thumbnailStoragePath
    : typeof media?.thumbPath === "string" ? media.thumbPath : "";
  return { thumbnailUrl, thumbnailStoragePath };
}

function classifyAlbumMediaWrite(before, after) {
  if (!before && !after) return { process:false, reason:"empty" };
  if (!before && after) return { process:true, force:false, reason:"created" };
  if (before && !after) return { process:true, force:false, reason:"deleted" };

  if (
    before.type !== after.type
    || before.url !== after.url
    || before.storagePath !== after.storagePath
  ) {
    return { process:true, force:false, reason:"source-changed" };
  }

  if (before.thumbnailRetryRequestAt !== after.thumbnailRetryRequestAt) {
    return { process:true, force:true, reason:"retry-requested" };
  }

  const previousThumbnail = thumbnailCandidate(before);
  const nextThumbnail = thumbnailCandidate(after);
  const refsChanged = previousThumbnail.thumbnailUrl !== nextThumbnail.thumbnailUrl
    || previousThumbnail.thumbnailStoragePath !== nextThumbnail.thumbnailStoragePath;
  const sourceGenerationChanged = String(before.thumbnailSourceGeneration || "")
    !== String(after.thumbnailSourceGeneration || "");

  if (refsChanged && !sourceGenerationChanged) {
    return { process:true, force:false, reason:"external-thumbnail-changed" };
  }

  return { process:false, force:false, reason:"backend-metadata-only" };
}

function sameThumbnailState(media, state) {
  return media.thumbnailStatus === state.thumbnailStatus
    && media.thumbnailUrl === state.thumbnailUrl
    && media.thumbnailStoragePath === state.thumbnailStoragePath
    && String(media.thumbnailSourceGeneration || "") === String(state.thumbnailSourceGeneration || "")
    && !media.thumbnailWorkGeneration
    && !media.thumbnailWorkPath;
}

function applyThumbnailResult(current, expected, state) {
  if (!current || typeof current !== "object") return undefined;
  if (current.url !== expected.url) return undefined;
  if (expected.type && current.type !== expected.type) return undefined;
  if (
    Object.prototype.hasOwnProperty.call(expected, "storagePath")
    && String(current.storagePath || "") !== String(expected.storagePath || "")
  ) return undefined;
  const currentPath = parseFirebaseDownloadUrl(current.url, expected.bucketName);
  if (currentPath !== expected.originalPath) return undefined;
  if (
    expected.workGeneration
    && String(current.thumbnailWorkGeneration || "") !== String(expected.workGeneration)
  ) {
    return undefined;
  }
  if (
    !expected.workGeneration
    && current.thumbnailWorkGeneration
    && state.thumbnailSourceGeneration
    && String(current.thumbnailWorkGeneration) !== String(state.thumbnailSourceGeneration)
  ) {
    return undefined;
  }
  if (sameThumbnailState(current, state)) return undefined;

  const next = { ...current, ...state };
  delete next.thumbnailWorkGeneration;
  delete next.thumbnailWorkPath;
  delete next.thumbnailWorkAt;
  return next;
}

function applyThumbnailClaim(current, expected, now) {
  if (!current || typeof current !== "object" || current.url !== expected.url) return undefined;
  if (expected.type && current.type !== expected.type) return undefined;
  if (
    Object.prototype.hasOwnProperty.call(expected, "storagePath")
    && String(current.storagePath || "") !== String(expected.storagePath || "")
  ) return undefined;
  if (parseFirebaseDownloadUrl(current.url, expected.bucketName) !== expected.originalPath) return undefined;
  const sameWork = String(current.thumbnailWorkGeneration || "") === String(expected.generation)
    && current.thumbnailWorkPath === expected.originalPath
    && current.thumbnailStatus === "processing";
  if (sameWork && Number(current.thumbnailWorkAt || 0) > now - WORK_LEASE_MS) return undefined;
  return {
    ...current,
    thumbnailStatus:"processing",
    thumbnailWorkGeneration:String(expected.generation),
    thumbnailWorkPath:expected.originalPath,
    thumbnailWorkAt:now
  };
}

async function runWarmTransaction(ref, updater, applyLocally = false) {
  if (!ref || typeof ref.on !== "function" || typeof ref.off !== "function"
      || typeof ref.transaction !== "function") {
    throw new TypeError("A realtime database reference is required");
  }

  let attached = false;
  let listener;
  let cancelListener;
  try {
    await new Promise((resolve, reject) => {
      listener = () => resolve();
      cancelListener = error => reject(error);
      ref.on("value", listener, cancelListener);
      attached = true;
    });
    return await ref.transaction(updater, undefined, applyLocally);
  } finally {
    if (attached) ref.off("value", listener);
  }
}

async function inspectJpeg(buffer, sharp = loadSharp()) {
  if (!isJpegBytes(buffer) || buffer.length > MAX_THUMBNAIL_BYTES) {
    throw new ThumbnailError("invalid-jpeg");
  }
  const metadata = await sharp(buffer, { failOn:"error", limitInputPixels:MAX_SOURCE_PIXELS }).metadata();
  if (
    metadata.format !== "jpeg"
    || !Number.isFinite(metadata.width)
    || !Number.isFinite(metadata.height)
    || metadata.width < 1
    || metadata.height < 1
    || metadata.width > MAX_DIMENSION
    || metadata.height > MAX_DIMENSION
  ) {
    throw new ThumbnailError("invalid-jpeg-dimensions");
  }
  return { width:metadata.width, height:metadata.height, size:buffer.length };
}

async function inspectSourceImage(input, sharp = loadSharp()) {
  const metadata = await sharp(input, {
    failOn:"error",
    limitInputPixels:MAX_SOURCE_PIXELS
  }).metadata();
  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.height || 0);
  if (
    !metadata?.format
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width < 1
    || height < 1
    || width * height > MAX_SOURCE_PIXELS
  ) {
    throw new ThumbnailError("invalid-source-dimensions");
  }
  return { format:metadata.format, width, height };
}

async function renderSmallJpeg(input, sharp = loadSharp()) {
  await inspectSourceImage(input, sharp);
  let smallest = null;

  for (const dimension of JPEG_DIMENSIONS) {
    for (const quality of JPEG_QUALITIES) {
      const output = await sharp(input, { failOn:"error", limitInputPixels:MAX_SOURCE_PIXELS })
        .rotate()
        .resize({ width:dimension, height:dimension, fit:"inside", withoutEnlargement:true })
        .flatten({ background:"#000000" })
        .jpeg({ quality, progressive:true, mozjpeg:true, chromaSubsampling:"4:2:0" })
        .toBuffer();

      if (!smallest || output.length < smallest.length) smallest = output;
      if (output.length <= MAX_THUMBNAIL_BYTES) {
        await inspectJpeg(output, sharp);
        return output;
      }
    }
  }

  throw new ThumbnailError("thumbnail-too-large", `smallest=${smallest?.length || 0}`);
}

function runFfmpegFrame(inputPath, outputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath || loadFfmpegPath();
  const timeoutMs = Number(options.timeoutMs || 25_000);

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-ss", "0.1",
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", `scale=${MAX_DIMENSION}:${MAX_DIMENSION}:force_original_aspect_ratio=decrease`,
      "-f", "image2",
      "-y",
      outputPath
    ], { stdio:["ignore", "ignore", "pipe"] });

    let settled = false;
    let stderrBytes = 0;
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ThumbnailError("ffmpeg-timeout"));
    }, timeoutMs);

    child.once("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ThumbnailError("ffmpeg-error", err?.code || "spawn-error"));
    });

    child.once("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ThumbnailError("ffmpeg-error", `exit=${code};stderrBytes=${stderrBytes}`));
    });
  });
}

async function metadataOrThrow(file, code) {
  try {
    const [metadata] = await file.getMetadata();
    return metadata;
  } catch (err) {
    throw new ThumbnailError(code, err?.code ? String(err.code) : code);
  }
}

function validateOriginalMetadata(metadata, mediaType) {
  const size = Number(metadata?.size || 0);
  const generation = String(metadata?.generation || "");
  const contentType = String(metadata?.contentType || "").toLowerCase();
  const maxBytes = mediaType === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const expectedPrefix = mediaType === "video" ? "video/" : "image/";

  if (!generation || !Number.isFinite(size) || size <= 0 || size > maxBytes) {
    throw new ThumbnailError("invalid-original-size");
  }
  if (!contentType.startsWith(expectedPrefix)) throw new ThumbnailError("invalid-original-type");
  return { generation, size, contentType };
}

async function validateStoredThumbnail(bucket, candidate, options = {}) {
  const { thumbnailUrl, thumbnailStoragePath } = candidate || {};
  if (!thumbnailUrl || !thumbnailStoragePath || !isThumbnailStoragePath(thumbnailStoragePath)) return null;
  if (parseFirebaseDownloadUrl(thumbnailUrl, bucket.name) !== thumbnailStoragePath) return null;

  const file = bucket.file(thumbnailStoragePath);
  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch {
    return null;
  }

  const size = Number(metadata?.size || 0);
  const sourceStoragePath = String(metadata?.metadata?.sourceStoragePath || "");
  const sourceGeneration = String(metadata?.metadata?.sourceGeneration || "");
  if (
    String(metadata?.contentType || "").toLowerCase() !== "image/jpeg"
    || !Number.isFinite(size)
    || size <= 0
    || size > MAX_THUMBNAIL_BYTES
    || (options.originalPath && sourceStoragePath !== options.originalPath)
    || (options.generation && sourceGeneration && sourceGeneration !== String(options.generation))
  ) {
    return null;
  }

  try {
    const [bytes] = await file.download();
    if (bytes.length !== size) return null;
    await inspectJpeg(bytes, options.sharp || loadSharp());
  } catch {
    return null;
  }

  return { thumbnailUrl, thumbnailStoragePath };
}

function tokenFromMetadata(metadata) {
  const raw = metadata?.metadata?.firebaseStorageDownloadTokens;
  return typeof raw === "string" ? raw.split(",").map(value => value.trim()).find(Boolean) || "" : "";
}

async function storeImmutableThumbnail(bucket, objectPath, bytes, options = {}) {
  const file = bucket.file(objectPath);
  const existing = await validateStoredThumbnail(bucket, {
    thumbnailStoragePath:objectPath,
    thumbnailUrl:firebaseDownloadUrl(bucket.name, objectPath, "validation-token")
  }, options);

  if (existing) {
    const [metadata] = await file.getMetadata();
    const token = tokenFromMetadata(metadata);
    if (!token) throw new ThumbnailError("existing-thumbnail-missing-token");
    return {
      thumbnailStoragePath:objectPath,
      thumbnailUrl:firebaseDownloadUrl(bucket.name, objectPath, token)
    };
  }

  const token = crypto.randomUUID();
  try {
    await file.save(bytes, {
      resumable:false,
      validation:"crc32c",
      preconditionOpts:{ ifGenerationMatch:0 },
      metadata:{
        contentType:"image/jpeg",
        cacheControl:"private, max-age=86400",
        metadata:{
          firebaseStorageDownloadTokens:token,
          derivedFrom:"album-media",
          thumbnailVersion:THUMBNAIL_VERSION,
          sourceStoragePath:options.originalPath || "",
          sourceGeneration:String(options.generation || "")
        }
      }
    });
  } catch (err) {
    if (err?.code !== 412 && err?.code !== 409) throw err;
    const raced = await validateStoredThumbnail(bucket, {
      thumbnailStoragePath:objectPath,
      thumbnailUrl:firebaseDownloadUrl(bucket.name, objectPath, "validation-token")
    }, options);
    if (!raced) throw new ThumbnailError("immutable-thumbnail-conflict");
    const [metadata] = await file.getMetadata();
    const racedToken = tokenFromMetadata(metadata);
    if (!racedToken) throw new ThumbnailError("existing-thumbnail-missing-token");
    return {
      thumbnailStoragePath:objectPath,
      thumbnailUrl:firebaseDownloadUrl(bucket.name, objectPath, racedToken)
    };
  }

  return {
    thumbnailStoragePath:objectPath,
    thumbnailUrl:firebaseDownloadUrl(bucket.name, objectPath, token)
  };
}

function albumIndexTombstone(deletedAt = Date.now()) {
  return { deleted:true, deletedAt:Number(deletedAt) || Date.now() };
}

async function markAlbumIndexDeleted(roomRef, mediaKey, deletedAt = Date.now()) {
  const marker = albumIndexTombstone(deletedAt);
  const result = await runWarmTransaction(roomRef.child(`albumIndex/${mediaKey}`), current => {
    if (current?.deleted) return undefined;
    if (Number(current?.indexRevisionAt || 0) > marker.deletedAt) return undefined;
    return marker;
  }, false);
  return result.committed;
}

async function setAlbumIndex(roomRef, mediaKey, media, options = {}) {
  const projection = buildLeanAlbumProjection(media, {
    indexRevisionAt:options.indexRevisionAt
  });
  const indexRef = roomRef.child(`albumIndex/${mediaKey}`);
  if (!projection) {
    await markAlbumIndexDeleted(roomRef, mediaKey, options.deletedAt);
    return null;
  }
  const result = await runWarmTransaction(indexRef, current => {
    if (current?.deleted) return undefined;
    const preservedRevision = normalizeFiniteNumber(current?.indexRevisionAt);
    return preservedRevision !== undefined && projection.indexRevisionAt === undefined
      ? { ...projection, indexRevisionAt:preservedRevision }
      : projection;
  }, false);
  return result.committed ? projection : null;
}

async function syncConsistentIndex(roomRef, mediaKey, expected = {}) {
  const snapshot = await roomRef.child(`media/${mediaKey}`).get();
  if (!snapshot.exists()) {
    await markAlbumIndexDeleted(roomRef, mediaKey, expected.deletedAt);
    return { status:"deleted" };
  }
  const media = snapshot.val();
  if (expected.url && media.url !== expected.url) return { status:"stale" };
  if (
    expected.generation
    && String(media.thumbnailSourceGeneration || "") !== String(expected.generation)
  ) {
    return { status:"stale" };
  }
  await setAlbumIndex(roomRef, mediaKey, media, { indexRevisionAt:expected.indexRevisionAt });
  return { status:media.thumbnailStatus || "unavailable" };
}

async function processAlbumMedia(mediaKey, options = {}) {
  if (typeof mediaKey !== "string" || !mediaKey) throw new TypeError("mediaKey is required");
  const db = options.db;
  const bucket = options.bucket;
  if (!db || !bucket?.name || typeof bucket.file !== "function") {
    throw new TypeError("db and bucket dependencies are required");
  }

  const roomId = options.roomId || ROOM_ID;
  if (roomId !== ROOM_ID) throw new TypeError("unsupported roomId");
  const roomRef = db.ref(roomId);
  const mediaRef = roomRef.child(`media/${mediaKey}`);
  const authoritative = await mediaRef.get();

  if (!authoritative.exists()) {
    await markAlbumIndexDeleted(roomRef, mediaKey, options.deletedAt);
    return { status:"deleted" };
  }

  const media = authoritative.val();
  if (media.type !== "image" && media.type !== "video") {
    await roomRef.child(`albumIndex/${mediaKey}`).remove();
    return { status:"ignored" };
  }

  const expectedUrl = typeof media.url === "string" ? media.url : "";
  const originalPath = parseFirebaseDownloadUrl(expectedUrl, bucket.name);
  const declaredStoragePath = typeof media.storagePath === "string" ? media.storagePath : "";
  const expectedMedia = {
    url:expectedUrl,
    bucketName:bucket.name,
    originalPath,
    type:media.type,
    storagePath:declaredStoragePath
  };
  if (
    !isOriginalStoragePath(originalPath)
    || (declaredStoragePath && declaredStoragePath !== originalPath)
  ) {
    await runWarmTransaction(mediaRef, current => applyThumbnailResult(current, {
      ...expectedMedia,
      workGeneration:""
    }, {
      thumbnailStatus:"unavailable",
      thumbnailUrl:null,
      thumbnailStoragePath:null,
      thumbnailSourceGeneration:null
    }), false);
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl });
  }

  const originalFile = bucket.file(originalPath);
  let originalMetadata;
  let original;
  try {
    originalMetadata = await metadataOrThrow(originalFile, "original-metadata-unavailable");
    original = validateOriginalMetadata(originalMetadata, media.type);
  } catch (err) {
    await runWarmTransaction(mediaRef, current => applyThumbnailResult(current, {
      ...expectedMedia,
      workGeneration:""
    }, {
      thumbnailStatus:"unavailable",
      thumbnailUrl:null,
      thumbnailStoragePath:null,
      thumbnailSourceGeneration:null
    }), false);
    if (options.logger) options.logger("thumbnail-unavailable", { mediaKey, code:err?.code || "metadata" });
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl });
  }

  const generation = original.generation;
  if (!options.force && media.thumbnailStatus === "unavailable"
      && String(media.thumbnailSourceGeneration || "") === generation) {
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
  }

  let sharp;
  let reusable;
  try {
    sharp = options.sharp || loadSharp();
    reusable = await validateStoredThumbnail(bucket, thumbnailCandidate(media), {
      sharp,
      originalPath,
      generation
    });
  } catch (err) {
    await runWarmTransaction(mediaRef, current => applyThumbnailResult(current, {
      ...expectedMedia,
      workGeneration:""
    }, {
      thumbnailStatus:"unavailable",
      thumbnailUrl:null,
      thumbnailStoragePath:null,
      thumbnailSourceGeneration:generation
    }), false);
    if (options.logger) options.logger("thumbnail-unavailable", {
      mediaKey,
      code:err?.code || err?.name || "dependency"
    });
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
  }

  if (
    reusable
    && (!media.thumbnailSourceGeneration || String(media.thumbnailSourceGeneration) === generation)
  ) {
    await runWarmTransaction(mediaRef, current => applyThumbnailResult(current, {
      ...expectedMedia,
      workGeneration:""
    }, {
      ...reusable,
      thumbnailStatus:"ready",
      thumbnailSourceGeneration:generation
    }), false);
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
  }

  const now = typeof options.now === "function" ? options.now() : Date.now();
  const claim = await runWarmTransaction(mediaRef, current => applyThumbnailClaim(current, {
    ...expectedMedia,
    generation
  }, now), false);

  if (!claim.committed) {
    const currentSnapshot = await mediaRef.get();
    if (!currentSnapshot.exists()) {
      await markAlbumIndexDeleted(roomRef, mediaKey, options.deletedAt);
      return { status:"deleted" };
    }
    const current = currentSnapshot.val();
    const sameGeneration = String(current.thumbnailSourceGeneration || "") === generation;
    if (sameGeneration && current.thumbnailStatus === "ready") {
      return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
    }
    if (sameGeneration && current.thumbnailStatus === "unavailable") {
      return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
    }
    const sameActiveClaim = current.thumbnailStatus === "processing"
      && String(current.thumbnailWorkGeneration || "") === generation
      && current.thumbnailWorkPath === originalPath
      && Number(current.thumbnailWorkAt || 0) > now - WORK_LEASE_MS;
    return { status:sameActiveClaim ? "processing" : "stale" };
  }

  let tempDir = "";
  try {
    let bytes = null;
    const inline = decodeInlineJpeg(media.thumbnail);
    if (inline) {
      try {
        bytes = await renderSmallJpeg(inline, sharp);
      } catch {
        // A legacy data URL can have JPEG marker bytes yet still be corrupt.
        // Fall back to the bounded Storage original rather than trusting it.
      }
    }

    if (!bytes) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memo-album-thumb-"));
      const extension = media.type === "video" ? ".video" : ".image";
      const originalLocalPath = path.join(tempDir, `original${extension}`);
      await originalFile.download({
        destination:originalLocalPath,
        validation:true,
        timeout:Number(options.downloadTimeoutMs || 30_000)
      });
      const stat = await fs.stat(originalLocalPath);
      const maximum = media.type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (stat.size <= 0 || stat.size > maximum) throw new ThumbnailError("download-size-mismatch");

      let source = originalLocalPath;
      if (media.type === "video") {
        const framePath = path.join(tempDir, "frame.png");
        await runFfmpegFrame(originalLocalPath, framePath, {
          ffmpegPath:options.ffmpegPath,
          timeoutMs:options.ffmpegTimeoutMs
        });
        source = framePath;
      }
      bytes = await renderSmallJpeg(source, sharp);
    }

    const latestMetadata = await metadataOrThrow(originalFile, "original-metadata-unavailable");
    if (String(latestMetadata.generation || "") !== generation) {
      throw new ThumbnailError("original-generation-changed");
    }

    const objectPath = immutableThumbnailPath(originalPath, generation, options.version || THUMBNAIL_VERSION);
    const stored = await storeImmutableThumbnail(bucket, objectPath, bytes, {
      sharp,
      originalPath,
      generation
    });
    const result = await runWarmTransaction(mediaRef, current => applyThumbnailResult(current, {
      ...expectedMedia,
      workGeneration:generation
    }, {
      ...stored,
      thumbnailStatus:"ready",
      thumbnailSourceGeneration:generation
    }), false);

    if (!result.committed) return { status:"stale" };
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
  } catch (err) {
    const result = await runWarmTransaction(mediaRef, current => applyThumbnailResult(current, {
      ...expectedMedia,
      workGeneration:generation
    }, {
      thumbnailStatus:"unavailable",
      thumbnailUrl:null,
      thumbnailStoragePath:null,
      thumbnailSourceGeneration:generation
    }), false);

    if (options.logger) options.logger("thumbnail-unavailable", {
      mediaKey,
      code:err?.code || err?.name || "processing"
    });
    if (!result.committed) return { status:"stale" };
    return syncConsistentIndex(roomRef, mediaKey, { url:expectedUrl, generation });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive:true, force:true }).catch(() => {});
  }
}

function createAlbumThumbnailBackend(defaultOptions = {}) {
  return {
    processAlbumMedia(mediaKey, options = {}) {
      return processAlbumMedia(mediaKey, { ...defaultOptions, ...options });
    }
  };
}

module.exports = {
  JPEG_DIMENSIONS,
  JPEG_QUALITIES,
  MAX_DIMENSION,
  MAX_IMAGE_BYTES,
  MAX_SOURCE_PIXELS,
  MAX_THUMBNAIL_BYTES,
  MAX_VIDEO_BYTES,
  ROOM_ID,
  THUMBNAIL_PREFIX,
  THUMBNAIL_VERSION,
  WORK_LEASE_MS,
  ThumbnailError,
  albumIndexTombstone,
  applyThumbnailClaim,
  applyThumbnailResult,
  buildLeanAlbumProjection,
  classifyAlbumMediaWrite,
  createAlbumThumbnailBackend,
  dataUrlByteLength,
  decodeInlineJpeg,
  firebaseDownloadUrl,
  immutableThumbnailPath,
  inspectJpeg,
  inspectSourceImage,
  isJpegBytes,
  isOriginalStoragePath,
  isThumbnailStoragePath,
  markAlbumIndexDeleted,
  parseFirebaseDownloadUrl,
  processAlbumMedia,
  renderSmallJpeg,
  runFfmpegFrame,
  runWarmTransaction,
  setAlbumIndex,
  validateOriginalMetadata,
  validateStoredThumbnail
};
