const MAX_THUMBNAIL_BYTES = 16 * 1024;
const THUMBNAIL_TIMEOUT_MS = 3_000;
const SESSION_THUMBNAIL_MAX_ENTRIES = 256;
const SESSION_THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;
const PREVIEW_WIDTHS = Object.freeze([240, 200, 160, 128, 96]);
const JPEG_QUALITIES = Object.freeze([0.78, 0.64, 0.5, 0.38, 0.28]);
const CURRENT_FIREBASE_STORAGE_BUCKET = "memo-e366f.firebasestorage.app";
const ALBUM_THUMBNAIL_PREFIX = "memo_private_room/thumbs/";

let environmentOverrides = null;
let previewObserver = null;
let previewObserverConstructor = null;
let previewRecords = new WeakMap();
const previewVideos = new Set();
const managedVideos = new Set();
const managedVideoDisposers = new Map();
const sessionThumbnails = new Map();
let sessionThumbnailBytes = 0;

function environment() {
  const source = environmentOverrides || {};
  const setTimer = source.setTimeout || globalThis.setTimeout;
  const clearTimer = source.clearTimeout || globalThis.clearTimeout;
  return {
    document: source.document || globalThis.document,
    IntersectionObserver: source.IntersectionObserver || globalThis.IntersectionObserver,
    URL: source.URL || globalThis.URL,
    // Native Window timers require their receiver, even after destructuring.
    setTimeout: typeof setTimer === "function" ? setTimer.bind(globalThis) : undefined,
    clearTimeout: typeof clearTimer === "function" ? clearTimer.bind(globalThis) : undefined,
    isSafeAlbumThumbnailUrl: source.isSafeAlbumThumbnailUrl
  };
}

/**
 * Overrides browser primitives for isolated tests. The returned function restores
 * the previous environment. Application code normally does not need this.
 */
export function setMediaPerformanceEnvironment(overrides = null) {
  const previous = environmentOverrides;
  clearMediaPreviews();
  environmentOverrides = overrides;
  return () => {
    clearMediaPreviews();
    environmentOverrides = previous;
  };
}

function browserDocument() {
  const doc = environment().document;
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("Media previews require a browser document.");
  }
  return doc;
}

function sourceUrl(item) {
  return typeof item?.url === "string" ? item.url.trim() : "";
}

function getSessionThumbnail(key) {
  if (!key || !sessionThumbnails.has(key)) return undefined;
  const thumbnail = sessionThumbnails.get(key);
  sessionThumbnails.delete(key);
  sessionThumbnails.set(key, thumbnail);
  return thumbnail;
}

function cacheSessionThumbnail(key, thumbnail) {
  if (!key || !isUsableVideoThumbnail(thumbnail)) return;
  const bytes = dataUrlByteLength(thumbnail);
  const previous = sessionThumbnails.get(key);
  if (previous) sessionThumbnailBytes -= dataUrlByteLength(previous);
  sessionThumbnails.delete(key);
  sessionThumbnails.set(key, thumbnail);
  sessionThumbnailBytes += bytes;

  while (
    sessionThumbnails.size > SESSION_THUMBNAIL_MAX_ENTRIES ||
    sessionThumbnailBytes > SESSION_THUMBNAIL_MAX_BYTES
  ) {
    const oldestKey = sessionThumbnails.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = sessionThumbnails.get(oldestKey);
    sessionThumbnailBytes -= dataUrlByteLength(oldest);
    sessionThumbnails.delete(oldestKey);
  }
}

export function dataUrlByteLength(value) {
  if (typeof value !== "string") return Infinity;
  const comma = value.indexOf(",");
  if (comma < 0) return Infinity;
  const header = value.slice(0, comma);
  const body = value.slice(comma + 1);
  if (/;base64(?:;|$)/i.test(header)) {
    const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(body)).length;
  } catch {
    return Infinity;
  }
}

export function isUsableVideoThumbnail(value) {
  return typeof value === "string" &&
    /^data:image\/jpeg(?:;[^,]*)?;base64,/i.test(value) &&
    dataUrlByteLength(value) <= MAX_THUMBNAIL_BYTES;
}

function hasSafeThumbnailObjectPath(objectPath) {
  if (typeof objectPath !== "string" || !objectPath.startsWith(ALBUM_THUMBNAIL_PREFIX)) return false;
  const segments = objectPath.split("/");
  return segments.length >= 3 && Boolean(segments.at(-1)) && segments.every(segment => segment !== "." && segment !== "..");
}

/** Accepts only HTTPS download URLs for the app's current private thumbnail prefix. */
export function isSafeAlbumThumbnailUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const override = environment().isSafeAlbumThumbnailUrl;
  if (typeof override === "function") return override(value) === true;

  let parsed;
  try {
    parsed = new globalThis.URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    return false;
  }

  if (parsed.hostname === "firebasestorage.googleapis.com") {
    const prefix = `/v0/b/${CURRENT_FIREBASE_STORAGE_BUCKET}/o/`;
    if (!parsed.pathname.startsWith(prefix)) return false;
    try {
      return hasSafeThumbnailObjectPath(decodeURIComponent(parsed.pathname.slice(prefix.length)));
    } catch {
      return false;
    }
  }

  if (parsed.hostname === "storage.googleapis.com") {
    const prefix = `/${CURRENT_FIREBASE_STORAGE_BUCKET}/`;
    if (!parsed.pathname.startsWith(prefix)) return false;
    try {
      return hasSafeThumbnailObjectPath(decodeURIComponent(parsed.pathname.slice(prefix.length)));
    } catch {
      return false;
    }
  }

  return false;
}

/** Converts an accepted inline JPEG thumbnail to uploadable bytes. */
export function thumbnailDataUrlToBlob(value) {
  if (!isUsableVideoThumbnail(value) || typeof globalThis.atob !== "function" || typeof globalThis.Blob !== "function") {
    return null;
  }
  try {
    const body = value.slice(value.indexOf(",") + 1);
    const decoded = globalThis.atob(body);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return new globalThis.Blob([bytes], { type:"image/jpeg" });
  } catch {
    return null;
  }
}

export function fitVideoThumbnailSize(width, height, maxDimension = 240) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(maxDimension > 0)) {
    return { width:0, height:0 };
  }
  const scale = Math.min(1, maxDimension / sourceWidth, maxDimension / sourceHeight);
  return {
    width:Math.max(1, Math.round(sourceWidth * scale)),
    height:Math.max(1, Math.round(sourceHeight * scale))
  };
}

export function formatVideoDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function applyClassName(element, className) {
  if (typeof className === "string" && className.trim()) element.className = className.trim();
}

function applyDurationMetadata(element, item) {
  const durationMs = Number(item?.durationMs);
  const label = formatVideoDuration(durationMs);
  if (!label) return "";
  element.dataset.videoDuration = label;
  element.dataset.videoDurationMs = String(Math.max(0, Math.round(durationMs)));
  return label;
}

function bindActivation(element, onActivate) {
  if (typeof onActivate !== "function") return;
  element.addEventListener("click", event => onActivate(event, element));
}

function styleAlbumPlaceholder(element) {
  Object.assign(element.style, {
    display:"block",
    width:"100%",
    minHeight:"72px",
    background:"#e5e7eb",
    border:"1px solid #d1d5db",
    boxSizing:"border-box"
  });
}

function createAlbumPlaceholder(doc, { className = "", onActivate, status = "missing", source = "none" } = {}) {
  const placeholder = doc.createElement("div");
  applyClassName(placeholder, className);
  placeholder.setAttribute("role", "img");
  placeholder.setAttribute("aria-label", "미리보기 없음");
  placeholder.dataset.albumThumbnail = "true";
  placeholder.dataset.thumbnailStatus = status;
  placeholder.dataset.thumbnailSource = source;
  placeholder.dataset.thumbnailPlaceholder = "true";
  styleAlbumPlaceholder(placeholder);
  bindActivation(placeholder, onActivate);
  return placeholder;
}

/**
 * Creates album-only media without ever consulting or loading item.url. Remote
 * thumbnails are restricted to this app's current Firebase thumbnail prefix;
 * older records may use a bounded inline JPEG.
 */
export function createAlbumThumbnail(item, { className = "", onActivate } = {}) {
  const doc = browserDocument();
  const remoteThumbnail = typeof item?.thumbnailUrl === "string" && isSafeAlbumThumbnailUrl(item.thumbnailUrl)
    ? item.thumbnailUrl.trim()
    : "";
  const inlineThumbnail = isUsableVideoThumbnail(item?.thumbnail) ? item.thumbnail : "";
  const thumbnail = remoteThumbnail || inlineThumbnail;
  const source = remoteThumbnail ? "remote" : inlineThumbnail ? "inline" : "none";

  if (!thumbnail) return createAlbumPlaceholder(doc, { className, onActivate, status:"missing", source });

  const image = doc.createElement("img");
  applyClassName(image, className);
  image.alt = "앨범 미리보기";
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  image.dataset.albumThumbnail = "true";
  image.dataset.thumbnailStatus = remoteThumbnail ? "loading" : "ready";
  image.dataset.thumbnailSource = source;
  image.dataset.thumbnailPlaceholder = "false";
  bindActivation(image, onActivate);

  image.addEventListener("load", () => {
    image.dataset.thumbnailStatus = "ready";
  }, { once:true });
  image.addEventListener("error", () => {
    const placeholder = createAlbumPlaceholder(doc, { className, onActivate, status:"error", source });
    if (image.parentNode) image.replaceWith(placeholder);
    else {
      image.removeAttribute?.("src");
      image.dataset.thumbnailStatus = "error";
      image.dataset.thumbnailPlaceholder = "true";
      styleAlbumPlaceholder(image);
    }
  }, { once:true });

  if (remoteThumbnail) image.crossOrigin = "anonymous";
  image.src = thumbnail;
  return image;
}

function createThumbnailImage(doc, thumbnail, item, options = {}) {
  const image = doc.createElement("img");
  applyClassName(image, options.className);
  image.src = thumbnail;
  image.alt = options.alt || "영상 미리보기";
  image.decoding = "async";
  image.draggable = false;
  image.dataset.deferredSrc = "false";
  image.dataset.videoState = "thumbnail";
  applyDurationMetadata(image, item);
  bindActivation(image, options.onActivate);
  return image;
}

function setState(target, state, deferred) {
  if (!target?.dataset) return;
  target.dataset.videoState = state;
  if (deferred !== undefined) target.dataset.deferredSrc = deferred ? "true" : "false";
}

function unloadVideo(video) {
  if (!video) return;
  try { video.pause?.(); } catch {}
  try { video.removeAttribute?.("src"); } catch {}
  try { video.load?.(); } catch {}
}

function releasePreviewVideo(video, { unload = false } = {}) {
  try { previewObserver?.unobserve?.(video); } catch {}
  previewVideos.delete(video);
  managedVideos.delete(video);
  previewRecords.delete(video);
  if (unload) unloadVideo(video);
}

function makeCanvasThumbnail(media, maxBytes = MAX_THUMBNAIL_BYTES) {
  const doc = environment().document;
  if (!doc?.createElement) return "";
  const sourceWidth = Number(media?.videoWidth || media?.naturalWidth || media?.width);
  const sourceHeight = Number(media?.videoHeight || media?.naturalHeight || media?.height);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return "";

  for (const maxDimension of PREVIEW_WIDTHS) {
    const size = fitVideoThumbnailSize(sourceWidth, sourceHeight, maxDimension);
    const canvas = doc.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext?.("2d", { alpha:false });
    if (!context) continue;

    try {
      context.drawImage(media, 0, 0, size.width, size.height);
      for (const quality of JPEG_QUALITIES) {
        const thumbnail = canvas.toDataURL("image/jpeg", quality);
        if (isUsableVideoThumbnail(thumbnail) && dataUrlByteLength(thumbnail) <= maxBytes) {
          return thumbnail;
        }
      }
    } catch {
      return "";
    }
  }
  return "";
}

async function cacheAndReplaceLegacyPreview(video, record) {
  if (previewRecords.get(video) !== record) return;
  const thumbnail = makeCanvasThumbnail(video);
  if (!thumbnail) {
    setState(video, "ready", false);
    return;
  }

  cacheSessionThumbnail(record.source, thumbnail);
  const parent = video.parentNode;
  if (!parent) {
    setState(video, "ready", false);
    return;
  }

  const image = createThumbnailImage(record.document, thumbnail, record.item, record.options);
  try {
    if (typeof video.replaceWith === "function") video.replaceWith(image);
    else parent.replaceChild(image, video);
    releasePreviewVideo(video, { unload:true });
  } catch {
    setState(video, "ready", false);
  }
}

function loadLegacyPreview(video) {
  const record = previewRecords.get(video);
  if (!record || record.started || !record.source) return;
  record.started = true;
  setState(video, "loading", false);
  try { previewObserver?.unobserve?.(video); } catch {}

  video.addEventListener("loadeddata", () => {
    const current = previewRecords.get(video);
    if (current !== record) return;
    setState(video, "ready", false);
    void cacheAndReplaceLegacyPreview(video, record);
  }, { once:true });

  video.addEventListener("error", () => {
    if (previewRecords.get(video) !== record) return;
    if (!record.corsFallbackTried) {
      record.corsFallbackTried = true;
      try {
        video.removeAttribute?.("crossorigin");
        video.crossOrigin = null;
        video.removeAttribute?.("src");
        video.load?.();
        video.src = record.source;
        video.load?.();
        return;
      } catch {}
    }
    setState(video, "error", false);
  });

  try {
    video.crossOrigin = "anonymous";
    video.src = record.source;
    video.load?.();
  } catch {
    setState(video, "error", false);
  }
}

function getPreviewObserver() {
  const Observer = environment().IntersectionObserver;
  if (typeof Observer !== "function") return null;
  if (previewObserver && previewObserverConstructor === Observer) return previewObserver;
  try { previewObserver?.disconnect?.(); } catch {}
  previewObserverConstructor = Observer;
  previewObserver = new Observer(entries => {
    for (const entry of entries || []) {
      if (entry?.isIntersecting || Number(entry?.intersectionRatio) > 0) {
        loadLegacyPreview(entry.target);
      }
    }
  }, { rootMargin:"0px", threshold:0.01 });
  return previewObserver;
}

function elementIsInitiallyVisible(element, doc) {
  if (doc?.visibilityState === "hidden" || typeof element?.getBoundingClientRect !== "function") return false;
  const rect = element.getBoundingClientRect();
  const viewportWidth = Number(globalThis.innerWidth || doc?.documentElement?.clientWidth || 0);
  const viewportHeight = Number(globalThis.innerHeight || doc?.documentElement?.clientHeight || 0);
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
}

/**
 * Creates one card media element. With an inline thumbnail this is an image.
 * Historical records without a thumbnail use a muted video whose source is
 * assigned only after it intersects the viewport. The parent owns any button,
 * play icon, or other overlay.
 */
export function createVideoPreview(item, { className = "", onActivate } = {}) {
  const doc = browserDocument();
  const source = sourceUrl(item);
  const thumbnail = isUsableVideoThumbnail(item?.thumbnail)
    ? item.thumbnail
    : getSessionThumbnail(source);

  if (thumbnail) {
    return createThumbnailImage(doc, thumbnail, item, { className, onActivate });
  }

  const video = doc.createElement("video");
  applyClassName(video, className);
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.controls = false;
  setState(video, "waiting", true);
  applyDurationMetadata(video, item);
  bindActivation(video, onActivate);

  const record = {
    document:doc,
    item,
    options:{ className, onActivate },
    source,
    started:false,
    corsFallbackTried:false
  };
  previewRecords.set(video, record);
  previewVideos.add(video);
  managedVideos.add(video);

  if (!source) {
    setState(video, "error", true);
    return video;
  }

  const observer = getPreviewObserver();
  if (observer) {
    observer.observe(video);
  } else {
    const { setTimeout:setTimer } = environment();
    setTimer?.(() => {
      if (previewRecords.get(video) === record && elementIsInitiallyVisible(video, doc)) {
        loadLegacyPreview(video);
      }
    }, 0);
  }
  return video;
}

function styleDeferredWrapper(wrapper) {
  wrapper.style.position = "relative";
}

function stylePlayOverlay(button) {
  Object.assign(button.style, {
    position:"absolute",
    inset:"0",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    width:"100%",
    minHeight:"44px",
    border:"0",
    background:"rgba(0, 0, 0, 0.28)",
    color:"#fff",
    cursor:"pointer",
    zIndex:"2"
  });
}

function addDurationBadge(doc, wrapper, durationMs) {
  const label = formatVideoDuration(Number(durationMs));
  if (!label) return;
  const badge = doc.createElement("span");
  badge.textContent = label;
  badge.setAttribute("aria-hidden", "true");
  badge.dataset.videoDuration = label;
  Object.assign(badge.style, {
    position:"absolute",
    right:"6px",
    bottom:"6px",
    padding:"2px 5px",
    borderRadius:"3px",
    background:"rgba(0, 0, 0, 0.68)",
    color:"#fff",
    fontSize:"12px",
    lineHeight:"1.2",
    pointerEvents:"none"
  });
  wrapper.appendChild(badge);
}

/**
 * Creates an inline native player that remains source-free until the user uses
 * the first-play overlay. One activation assigns the source and calls play();
 * after that, the native controls remain in charge.
 */
export function createDeferredVideo(item, { autoplay = false, controls = true } = {}) {
  const doc = browserDocument();
  const source = sourceUrl(item);
  const wrapper = doc.createElement("div");
  const video = doc.createElement("video");
  const overlay = doc.createElement("button");
  let attempt = 0;
  let loading = false;
  let disposed = false;

  wrapper.className = "memo-video-player";
  styleDeferredWrapper(wrapper);
  setState(wrapper, "idle", true);

  video.controls = Boolean(controls);
  video.autoplay = Boolean(autoplay);
  video.preload = "none";
  video.playsInline = true;
  setState(video, "idle", true);
  applyDurationMetadata(video, item);
  if (isUsableVideoThumbnail(item?.thumbnail)) video.poster = item.thumbnail;
  managedVideos.add(video);

  overlay.type = "button";
  overlay.className = "video-first-play memo-video-play";
  overlay.textContent = "재생";
  overlay.setAttribute("aria-label", "영상 재생");
  overlay.setAttribute("aria-live", "polite");
  stylePlayOverlay(overlay);

  wrapper.appendChild(video);
  wrapper.appendChild(overlay);
  addDurationBadge(doc, wrapper, item?.durationMs);

  const updateState = (state, deferred) => {
    setState(wrapper, state, deferred);
    setState(video, state, deferred);
  };

  const showError = currentAttempt => {
    if (disposed || currentAttempt !== attempt) return;
    loading = false;
    updateState("error", true);
    overlay.disabled = false;
    overlay.hidden = false;
    overlay.style.display = "flex";
    overlay.textContent = "다시 시도";
    overlay.setAttribute("aria-label", "영상 다시 불러오기");
    overlay.setAttribute("aria-busy", "false");
  };

  const finishPlaying = currentAttempt => {
    if (disposed || currentAttempt !== attempt) return;
    loading = false;
    updateState("playing", false);
    overlay.hidden = true;
    overlay.style.display = "none";
    overlay.disabled = true;
    overlay.setAttribute("aria-busy", "false");
  };

  const activate = async () => {
    if (disposed || loading || wrapper.dataset.videoState === "playing") return;
    const currentAttempt = ++attempt;
    loading = true;
    updateState("loading", false);
    overlay.disabled = true;
    overlay.hidden = false;
    overlay.style.display = "flex";
    overlay.textContent = "불러오는 중";
    overlay.setAttribute("aria-label", "영상 불러오는 중");
    overlay.setAttribute("aria-busy", "true");
    const spinner = doc.createElement("span");
    spinner.className = "video-loading-spinner";
    spinner.setAttribute("aria-hidden", "true");
    Object.assign(spinner.style, {
      display:"inline-block",
      flex:"0 0 auto",
      width:"18px",
      height:"18px",
      marginLeft:"8px",
      border:"2px solid rgba(255, 255, 255, 0.45)",
      borderTopColor:"#fff",
      borderRadius:"50%"
    });
    overlay.appendChild(spinner);
    try {
      spinner.animate?.(
        [{ transform:"rotate(0deg)" }, { transform:"rotate(360deg)" }],
        { duration:700, iterations:Infinity }
      );
    } catch {}

    if (!source) {
      showError(currentAttempt);
      return;
    }

    try {
      unloadVideo(video);
      video.src = source;
      video.load?.();
      const result = video.play?.();
      if (result && typeof result.then === "function") await result;
      finishPlaying(currentAttempt);
    } catch {
      unloadVideo(video);
      showError(currentAttempt);
    }
  };

  wrapper.startPlayback = activate;
  overlay.addEventListener("click", activate);
  video.addEventListener("playing", () => finishPlaying(attempt));
  let handlingVideoError = false;
  video.addEventListener("error", () => {
    if (disposed || handlingVideoError) return;
    if (wrapper.dataset.videoState === "error" && !video.getAttribute?.("src")) return;
    handlingVideoError = true;
    const currentAttempt = attempt;
    unloadVideo(video);
    showError(currentAttempt);
    handlingVideoError = false;
  });

  managedVideoDisposers.set(video, () => {
    disposed = true;
    loading = false;
    attempt += 1;
  });

  if (autoplay) {
    const tryAutoplay = () => {
      if (!disposed && wrapper.isConnected && wrapper.dataset.videoState === "idle") {
        void activate();
      }
    };
    if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(tryAutoplay);
    else Promise.resolve().then(tryAutoplay);
    environment().setTimeout?.(tryAutoplay, 0);
  }

  return wrapper;
}

/**
 * Pauses and unloads videos in a detached subtree. Connected videos are skipped
 * so callers can retain or move incremental tiles without interrupting them.
 */
export function stopMediaWithin(root, { force = false } = {}) {
  if (!root) return;
  const videos = [];
  if (String(root.tagName || "").toLowerCase() === "video") videos.push(root);
  if (typeof root.querySelectorAll === "function") videos.push(...root.querySelectorAll("video"));

  for (const video of new Set(videos)) {
    if (!force && video.isConnected) continue;
    releasePreviewVideo(video);
    managedVideoDisposers.get(video)?.();
    managedVideoDisposers.delete(video);
    managedVideos.delete(video);
    unloadVideo(video);
    setState(video, "stopped", true);
  }
}

/** Clears account-private in-memory frames, observers, and managed media. */
export function clearMediaPreviews() {
  try { previewObserver?.disconnect?.(); } catch {}
  previewObserver = null;
  previewObserverConstructor = null;
  const videos = new Set([...previewVideos, ...managedVideos]);
  previewRecords = new WeakMap();
  for (const dispose of managedVideoDisposers.values()) dispose();
  managedVideoDisposers.clear();
  previewVideos.clear();
  managedVideos.clear();
  sessionThumbnails.clear();
  sessionThumbnailBytes = 0;
  for (const video of videos) unloadVideo(video);
}

function waitForVideoFrame(video, timeoutMs) {
  const { setTimeout:setTimer, clearTimeout:clearTimer } = environment();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener?.("loadeddata", onLoaded);
      video.removeEventListener?.("canplay", onLoaded);
      video.removeEventListener?.("error", onError);
      clearTimer?.(timer);
    };
    const finish = callback => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onLoaded = () => finish(resolve);
    const onError = () => finish(() => reject(new Error("video decode failed")));
    const timer = setTimer?.(() => finish(() => reject(new Error("video decode timed out"))), timeoutMs);
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("canplay", onLoaded);
    video.addEventListener("error", onError);
  });
}

function waitForImage(image, timeoutMs) {
  const { setTimeout:setTimer, clearTimeout:clearTimer } = environment();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      image.removeEventListener?.("load", onLoaded);
      image.removeEventListener?.("error", onError);
      clearTimer?.(timer);
    };
    const finish = callback => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onLoaded = () => finish(resolve);
    const onError = () => finish(() => reject(new Error("image decode failed")));
    const timer = setTimer?.(() => finish(() => reject(new Error("image decode timed out"))), timeoutMs);
    image.addEventListener("load", onLoaded);
    image.addEventListener("error", onError);
  });
}

/**
 * Extracts a bounded inline JPEG from a local image File/Blob. The source blob
 * is never modified or uploaded here, and failures resolve to {}.
 */
export async function generateImageThumbnail(file) {
  const { document:doc, URL:UrlApi } = environment();
  if (!file || !doc?.createElement || !UrlApi?.createObjectURL || !UrlApi?.revokeObjectURL) return {};

  let objectUrl = "";
  const image = doc.createElement("img");
  try {
    objectUrl = UrlApi.createObjectURL(file);
    const imagePromise = waitForImage(image, THUMBNAIL_TIMEOUT_MS);
    image.src = objectUrl;
    await imagePromise;

    const width = Number(image.naturalWidth || image.width) || 0;
    const height = Number(image.naturalHeight || image.height) || 0;
    const thumbnail = makeCanvasThumbnail(image);
    if (!thumbnail) return {};
    return { thumbnail, width, height };
  } catch {
    return {};
  } finally {
    try { image.removeAttribute?.("src"); } catch {}
    if (objectUrl) {
      try { UrlApi.revokeObjectURL(objectUrl); } catch {}
    }
  }
}

/**
 * Extracts a small inline JPEG from a local File/Blob. Failures deliberately
 * resolve to {} so thumbnail work never blocks the original upload.
 */
export async function generateVideoThumbnail(file) {
  const { document:doc, URL:UrlApi } = environment();
  if (!file || !doc?.createElement || !UrlApi?.createObjectURL || !UrlApi?.revokeObjectURL) return {};

  let objectUrl = "";
  const video = doc.createElement("video");
  try {
    objectUrl = UrlApi.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    const framePromise = waitForVideoFrame(video, THUMBNAIL_TIMEOUT_MS);
    video.src = objectUrl;
    video.load?.();
    await framePromise;

    const width = Number(video.videoWidth) || 0;
    const height = Number(video.videoHeight) || 0;
    const durationMs = Number.isFinite(video.duration)
      ? Math.max(0, Math.round(video.duration * 1000))
      : undefined;
    const thumbnail = makeCanvasThumbnail(video);
    if (!thumbnail) return {};
    return { thumbnail, durationMs, width, height };
  } catch {
    return {};
  } finally {
    unloadVideo(video);
    if (objectUrl) {
      try { UrlApi.revokeObjectURL(objectUrl); } catch {}
    }
  }
}
