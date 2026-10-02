import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clearMediaPreviews,
  createAlbumThumbnail,
  createDeferredVideo,
  createVideoPreview,
  dataUrlByteLength,
  fitVideoThumbnailSize,
  formatVideoDuration,
  generateImageThumbnail,
  generateVideoThumbnail,
  isSafeAlbumThumbnailUrl,
  isUsableVideoThumbnail,
  setMediaPerformanceEnvironment,
  stopMediaWithin,
  thumbnailDataUrlToBlob
} from "../media-performance.js";

const source = await readFile(new URL("../media-performance.js", import.meta.url), "utf8");

function jpegDataUrl(byteLength = 256) {
  return `data:image/jpeg;base64,${Buffer.alloc(byteLength, 7).toString("base64")}`;
}

function safeRemoteThumbnail(name = "sample.jpg") {
  return `https://firebasestorage.googleapis.com/v0/b/memo-e366f.firebasestorage.app/o/memo_private_room%2Fthumbs%2F${encodeURIComponent(name)}?alt=media&token=test`;
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const values = this.listeners.get(type) || [];
    values.push({ listener, once:Boolean(options?.once) });
    this.listeners.set(type, values);
  }

  removeEventListener(type, listener) {
    const values = this.listeners.get(type) || [];
    this.listeners.set(type, values.filter(value => value.listener !== listener));
  }

  dispatch(type) {
    const event = { type, target:this, currentTarget:this };
    const values = [...(this.listeners.get(type) || [])];
    for (const value of values) {
      value.listener.call(this, event);
      if (value.once) this.removeEventListener(type, value.listener);
    }
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, ownerDocument = null) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = false;
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter(value => value !== child);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  replaceChild(next, current) {
    const index = this.children.indexOf(current);
    if (index < 0) throw new Error("child not found");
    this.children[index] = next;
    next.parentNode = this;
    current.parentNode = null;
    return current;
  }

  replaceWith(next) {
    this.parentNode?.replaceChild(next, this);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(value => value !== this);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this._src = "";
  }

  set src(value) {
    this._src = String(value);
    this.attributes.set("src", this._src);
    this.ownerDocument?.requestedSources.push({ tagName:this.tagName, url:this._src });
    if (this.tagName === "IMG" && this.emitLoadSynchronously && this._src) this.dispatch("load");
  }

  get src() {
    return this._src || "";
  }

  click() {
    if (!this.disabled) this.dispatch("click");
  }

  querySelectorAll(selector) {
    const target = selector.toUpperCase();
    const output = [];
    const visit = element => {
      for (const child of element.children) {
        if (child.tagName === target) output.push(child);
        visit(child);
      }
    };
    visit(this);
    return output;
  }

  getBoundingClientRect() {
    return { top:0, left:0, right:100, bottom:100 };
  }
}

class FakeVideo extends FakeElement {
  constructor(ownerDocument = null) {
    super("video", ownerDocument);
    this.videoWidth = 640;
    this.videoHeight = 360;
    this.duration = 12.345;
    this.loadCalls = 0;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.playResults = [];
    this.emitLoadedOnLoad = false;
    this.emitLoadedSynchronously = false;
  }

  load() {
    this.loadCalls += 1;
    if (this.emitLoadedSynchronously && this.src) this.dispatch("loadeddata");
    else if (this.emitLoadedOnLoad && this.src) queueMicrotask(() => this.dispatch("loadeddata"));
  }

  pause() {
    this.pauseCalls += 1;
  }

  play() {
    this.playCalls += 1;
    const next = this.playResults.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve();
  }
}

class FakeImage extends FakeElement {
  constructor(ownerDocument, { width = 1200, height = 800, syncLoad = false } = {}) {
    super("img", ownerDocument);
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.emitLoadSynchronously = syncLoad;
  }
}

class FakeCanvas extends FakeElement {
  constructor(dataUrl) {
    super("canvas");
    this.dataUrl = dataUrl;
    this.drawCalls = 0;
  }

  getContext() {
    return { drawImage:() => { this.drawCalls += 1; } };
  }

  toDataURL() {
    return this.dataUrl;
  }
}

class FakeDocument {
  constructor({
    canvasDataUrl = jpegDataUrl(300),
    autoLoadVideo = false,
    syncLoadVideo = false,
    syncLoadImage = false,
    imageWidth = 1200,
    imageHeight = 800,
    videoWidth = 640,
    videoHeight = 360
  } = {}) {
    this.visibilityState = "visible";
    this.documentElement = { clientWidth:390, clientHeight:844 };
    this.canvasDataUrl = canvasDataUrl;
    this.autoLoadVideo = autoLoadVideo;
    this.syncLoadVideo = syncLoadVideo;
    this.syncLoadImage = syncLoadImage;
    this.imageWidth = imageWidth;
    this.imageHeight = imageHeight;
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.createdVideos = [];
    this.createdImages = [];
    this.createdCanvases = [];
    this.requestedSources = [];
  }

  createElement(tagName) {
    if (tagName === "video") {
      const video = new FakeVideo(this);
      video.videoWidth = this.videoWidth;
      video.videoHeight = this.videoHeight;
      video.emitLoadedOnLoad = this.autoLoadVideo;
      video.emitLoadedSynchronously = this.syncLoadVideo;
      this.createdVideos.push(video);
      return video;
    }
    if (tagName === "img") {
      const image = new FakeImage(this, {
        width:this.imageWidth,
        height:this.imageHeight,
        syncLoad:this.syncLoadImage
      });
      this.createdImages.push(image);
      return image;
    }
    if (tagName === "canvas") {
      const canvas = new FakeCanvas(this.canvasDataUrl);
      this.createdCanvases.push(canvas);
      return canvas;
    }
    return new FakeElement(tagName, this);
  }
}

class FakeIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.disconnected = false;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  trigger(target, isIntersecting) {
    this.callback([{ target, isIntersecting, intersectionRatio:isIntersecting ? 1 : 0 }]);
  }
}

function installFakeBrowser(options = {}) {
  FakeIntersectionObserver.instances = [];
  const document = new FakeDocument(options);
  const restore = setMediaPerformanceEnvironment({
    document,
    IntersectionObserver:FakeIntersectionObserver,
    URL:options.URL || globalThis.URL,
    setTimeout:options.setTimeout || setTimeout,
    clearTimeout:options.clearTimeout || clearTimeout,
    isSafeAlbumThumbnailUrl:options.isSafeAlbumThumbnailUrl
  });
  return { document, restore };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test.afterEach(() => {
  clearMediaPreviews();
  setMediaPerformanceEnvironment(null);
});

test("thumbnail helpers enforce inline JPEG and 16 KiB cap", () => {
  const exact = jpegDataUrl(16 * 1024);
  const tooLarge = jpegDataUrl(16 * 1024 + 1);
  assert.equal(dataUrlByteLength(exact), 16 * 1024);
  assert.equal(isUsableVideoThumbnail(exact), true);
  assert.equal(isUsableVideoThumbnail(tooLarge), false);
  assert.equal(isUsableVideoThumbnail(exact.replace("image/jpeg", "image/png")), false);
  assert.deepEqual(fitVideoThumbnailSize(1920, 1080, 240), { width:240, height:135 });
  assert.deepEqual(fitVideoThumbnailSize(1080, 1920, 240), { width:135, height:240 });
  assert.deepEqual(fitVideoThumbnailSize(120, 80, 240), { width:120, height:80 });
  const blob = thumbnailDataUrlToBlob(jpegDataUrl(321));
  assert.equal(blob?.type, "image/jpeg");
  assert.equal(blob?.size, 321);
  assert.equal(thumbnailDataUrlToBlob(tooLarge), null);
  assert.equal(formatVideoDuration(65_400), "1:05");
  assert.equal(formatVideoDuration(undefined), "");
});

test("album thumbnail URLs are restricted to the current bucket thumbnail prefix", () => {
  assert.equal(isSafeAlbumThumbnailUrl(safeRemoteThumbnail()), true);
  assert.equal(isSafeAlbumThumbnailUrl("http://firebasestorage.googleapis.com/v0/b/memo-e366f.firebasestorage.app/o/memo_private_room%2Fthumbs%2Fx.jpg"), false);
  assert.equal(isSafeAlbumThumbnailUrl("https://firebasestorage.googleapis.com/v0/b/other.firebasestorage.app/o/memo_private_room%2Fthumbs%2Fx.jpg"), false);
  assert.equal(isSafeAlbumThumbnailUrl("https://firebasestorage.googleapis.com/v0/b/memo-e366f.firebasestorage.app/o/memo_private_room%2Foriginals%2Fx.jpg"), false);
  assert.equal(isSafeAlbumThumbnailUrl("https://firebasestorage.googleapis.com/v0/b/memo-e366f.firebasestorage.app/o/memo_private_room%2Fthumbs%2F..%2Foriginal.jpg"), false);
  assert.equal(isSafeAlbumThumbnailUrl("https://private.invalid/thumb.jpg"), false);
});

test("album remote thumbnail is lazy, CORS-safe, and never requests the original", () => {
  const { document, restore } = installFakeBrowser();
  const original = "https://private.invalid/original.mov";
  const thumbnailUrl = safeRemoteThumbnail("remote.jpg");
  let activations = 0;
  const thumbnail = createAlbumThumbnail(
    { url:original, thumbnailUrl },
    { className:"album-media", onActivate:() => { activations += 1; } }
  );

  assert.equal(thumbnail.tagName, "IMG");
  assert.equal(thumbnail.src, thumbnailUrl);
  assert.equal(thumbnail.loading, "lazy");
  assert.equal(thumbnail.decoding, "async");
  assert.equal(thumbnail.crossOrigin, "anonymous");
  assert.equal(thumbnail.dataset.thumbnailStatus, "loading");
  assert.equal(thumbnail.dataset.thumbnailSource, "remote");
  assert.equal(thumbnail.dataset.thumbnailPlaceholder, "false");
  assert.deepEqual(document.requestedSources, [{ tagName:"IMG", url:thumbnailUrl }]);
  assert.equal(document.createdVideos.length, 0);
  thumbnail.dispatch("load");
  assert.equal(thumbnail.dataset.thumbnailStatus, "ready");
  thumbnail.click();
  assert.equal(activations, 1);
  restore();
});

test("album uses bounded legacy inline JPEG and missing thumbnails stay neutral and clickable", () => {
  const { document, restore } = installFakeBrowser();
  const original = "https://private.invalid/original.jpg";
  const inline = jpegDataUrl(500);
  const image = createAlbumThumbnail({ url:original, thumbnail:inline, thumbnailUrl:"https://evil.invalid/thumb.jpg" });
  assert.equal(image.tagName, "IMG");
  assert.equal(image.src, inline);
  assert.equal(image.dataset.thumbnailSource, "inline");

  let activations = 0;
  const missing = createAlbumThumbnail(
    { url:original, thumbnail:jpegDataUrl(16 * 1024 + 1), thumbnailUrl:"https://evil.invalid/thumb.jpg" },
    { className:"album-media", onActivate:() => { activations += 1; } }
  );
  assert.equal(missing.tagName, "DIV");
  assert.equal(missing.className, "album-media");
  assert.equal(missing.textContent, "");
  assert.equal(missing.dataset.thumbnailStatus, "missing");
  assert.equal(missing.dataset.thumbnailPlaceholder, "true");
  assert.equal(missing.style.background, "#e5e7eb");
  missing.click();
  assert.equal(activations, 1);
  assert.equal(document.requestedSources.some(request => request.url === original), false);
  assert.equal(document.createdVideos.length, 0);
  restore();
});

test("album thumbnail load failure becomes a placeholder without original fallback", () => {
  const { document, restore } = installFakeBrowser();
  const host = new FakeElement("div");
  const original = "https://private.invalid/fallback-must-not-load.mp4";
  const thumbnailUrl = safeRemoteThumbnail("broken.jpg");
  let activations = 0;
  const image = createAlbumThumbnail(
    { url:original, thumbnailUrl },
    { className:"album-media", onActivate:() => { activations += 1; } }
  );
  host.appendChild(image);
  image.dispatch("error");

  const placeholder = host.children[0];
  assert.equal(placeholder.tagName, "DIV");
  assert.equal(placeholder.dataset.thumbnailStatus, "error");
  assert.equal(placeholder.dataset.thumbnailSource, "remote");
  assert.equal(placeholder.dataset.thumbnailPlaceholder, "true");
  assert.deepEqual(document.requestedSources, [{ tagName:"IMG", url:thumbnailUrl }]);
  assert.equal(document.requestedSources.some(request => request.url === original), false);
  assert.equal(document.createdVideos.length, 0);
  placeholder.click();
  assert.equal(activations, 1);
  restore();
});

test("inline thumbnail preview is an image and performs no video request", () => {
  const { document, restore } = installFakeBrowser();
  let activations = 0;
  const thumbnail = jpegDataUrl(512);
  const preview = createVideoPreview(
    { url:"https://private.invalid/movie.mp4", thumbnail, durationMs:12_000 },
    { className:"album-media", onActivate:() => { activations += 1; } }
  );

  assert.equal(preview.tagName, "IMG");
  assert.equal(preview.src, thumbnail);
  assert.equal(preview.className, "album-media");
  assert.equal(preview.dataset.videoState, "thumbnail");
  assert.equal(preview.dataset.videoDuration, "0:12");
  assert.equal(document.createdVideos.length, 0);
  preview.click();
  assert.equal(activations, 1);
  restore();
});

test("legacy preview assigns its source only after intersection and caches one frame", async () => {
  const { restore } = installFakeBrowser();
  const host = new FakeElement("div");
  const url = "https://private.invalid/legacy.mp4";
  const preview = createVideoPreview({ url }, { className:"album-media" });
  host.appendChild(preview);
  const observer = FakeIntersectionObserver.instances[0];

  assert.equal(preview.tagName, "VIDEO");
  assert.equal(preview.src, "");
  assert.equal(preview.preload, "metadata");
  assert.equal(preview.muted, true);
  assert.equal(preview.playsInline, true);
  assert.equal(preview.dataset.deferredSrc, "true");

  observer.trigger(preview, false);
  assert.equal(preview.src, "");
  observer.trigger(preview, true);
  assert.equal(preview.src, url);
  assert.equal(preview.crossOrigin, "anonymous");
  assert.equal(preview.dataset.videoState, "loading");

  preview.dispatch("loadeddata");
  await flush();
  assert.equal(host.children[0].tagName, "IMG");
  assert.equal(host.children[0].dataset.videoState, "thumbnail");

  const reopened = createVideoPreview({ url });
  assert.equal(reopened.tagName, "IMG");
  restore();
});

test("legacy preview retries visibly without CORS when canvas-safe loading is rejected", () => {
  const { restore } = installFakeBrowser();
  const url = "https://private.invalid/cors-fallback.mp4";
  const preview = createVideoPreview({ url });
  const observer = FakeIntersectionObserver.instances[0];
  observer.trigger(preview, true);

  preview.dispatch("error");
  assert.equal(preview.crossOrigin, null);
  assert.equal(preview.src, url);
  assert.equal(preview.dataset.videoState, "loading");

  preview.dispatch("error");
  assert.equal(preview.dataset.videoState, "error");
  restore();
});

test("session thumbnail cache is bounded and evicts the least-recently-used frame", () => {
  const { restore } = installFakeBrowser({ canvasDataUrl:jpegDataUrl(16 * 1024) });
  for (let index = 0; index < 257; index += 1) {
    const preview = createVideoPreview({ url:`https://private.invalid/cache-${index}.mp4` });
    const host = new FakeElement("div");
    host.appendChild(preview);
    FakeIntersectionObserver.instances[0].trigger(preview, true);
    preview.dispatch("loadeddata");
  }

  assert.equal(createVideoPreview({ url:"https://private.invalid/cache-0.mp4" }).tagName, "VIDEO");
  assert.equal(createVideoPreview({ url:"https://private.invalid/cache-256.mp4" }).tagName, "IMG");
  restore();
});

test("deferred player needs one explicit click and retains native controls", async () => {
  const { restore } = installFakeBrowser();
  const url = "https://private.invalid/deferred.mp4";
  const wrapper = createDeferredVideo({ url, thumbnail:jpegDataUrl(400), durationMs:9_000 });
  const [video, overlay, badge] = wrapper.children;

  assert.equal(video.tagName, "VIDEO");
  assert.equal(video.src, "");
  assert.equal(video.preload, "none");
  assert.equal(video.controls, true);
  assert.equal(video.playsInline, true);
  assert.equal(wrapper.className, "memo-video-player");
  assert.equal(wrapper.style.position, "relative");
  assert.equal(wrapper.dataset.videoState, "idle");
  assert.equal(typeof wrapper.startPlayback, "function");
  assert.equal(overlay.tagName, "BUTTON");
  assert.match(overlay.className, /memo-video-play/);
  assert.equal(overlay.style.display, "flex");
  assert.equal(overlay.getAttribute("aria-label"), "영상 재생");
  assert.equal(badge.textContent, "0:09");

  overlay.click();
  assert.equal(overlay.getAttribute("aria-busy"), "true");
  assert.equal(overlay.children[0].className, "video-loading-spinner");
  await flush();
  assert.equal(video.src, url);
  assert.equal(video.playCalls, 1);
  assert.equal(wrapper.dataset.videoState, "playing");
  assert.equal(wrapper.dataset.deferredSrc, "false");
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.style.display, "none");
  assert.equal(video.controls, true);

  overlay.click();
  await flush();
  assert.equal(video.playCalls, 1);
  restore();
});

test("autoplay starts after the wrapper is connected, while startPlayback supports parent wiring", async () => {
  const { restore } = installFakeBrowser();
  const autoWrapper = createDeferredVideo({ url:"blob:auto" }, { autoplay:true });
  const [autoVideo] = autoWrapper.children;
  assert.equal(autoVideo.src, "");
  autoWrapper.isConnected = true;
  await flush();
  assert.equal(autoVideo.src, "blob:auto");
  assert.equal(autoVideo.playCalls, 1);

  const wiredWrapper = createDeferredVideo({ url:"blob:wired" });
  const [wiredVideo] = wiredWrapper.children;
  await wiredWrapper.startPlayback();
  assert.equal(wiredVideo.src, "blob:wired");
  assert.equal(wiredVideo.playCalls, 1);
  restore();
});

test("deferred player shows an accessible retry without requiring a double click", async () => {
  const { document, restore } = installFakeBrowser();
  const wrapper = createDeferredVideo({ url:"blob:local-video" });
  const [video, overlay] = wrapper.children;
  video.playResults.push(new Error("decode"), undefined);

  overlay.click();
  await flush();
  assert.equal(wrapper.dataset.videoState, "error");
  assert.equal(overlay.disabled, false);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.display, "flex");
  assert.equal(overlay.textContent, "다시 시도");
  assert.equal(overlay.getAttribute("aria-label"), "영상 다시 불러오기");

  overlay.click();
  await flush();
  assert.equal(video.playCalls, 2);
  assert.equal(wrapper.dataset.videoState, "playing");
  assert.equal(document.createdVideos.length, 1);
  restore();
});

test("an asynchronous native video error after playback restores the retry overlay", async () => {
  const { restore } = installFakeBrowser();
  const wrapper = createDeferredVideo({ url:"blob:later-error" });
  const [video, overlay] = wrapper.children;
  await wrapper.startPlayback();
  assert.equal(wrapper.dataset.videoState, "playing");

  video.dispatch("error");
  assert.equal(wrapper.dataset.videoState, "error");
  assert.equal(video.src, "");
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.display, "flex");
  assert.equal(overlay.textContent, "다시 시도");
  restore();
});

test("stopMediaWithin unloads detached media but preserves retained connected tiles", () => {
  const { restore } = installFakeBrowser();
  const root = new FakeElement("div");
  const detached = new FakeVideo();
  const retained = new FakeVideo();
  detached.src = "blob:detached";
  retained.src = "blob:retained";
  retained.isConnected = true;
  root.appendChild(detached);
  root.appendChild(retained);

  stopMediaWithin(root);
  assert.equal(detached.src, "");
  assert.ok(detached.pauseCalls > 0);
  assert.equal(detached.dataset.videoState, "stopped");
  assert.equal(retained.src, "blob:retained");
  assert.equal(retained.pauseCalls, 0);

  stopMediaWithin(root, { force:true });
  assert.equal(retained.src, "");
  assert.ok(retained.pauseCalls > 0);
  restore();
});

test("image thumbnail extraction is bounded, caps portrait dimensions, and revokes its URL", async () => {
  const revoked = [];
  const UrlApi = {
    createObjectURL:() => "blob:image-generated-locally",
    revokeObjectURL:value => revoked.push(value)
  };
  const { document, restore } = installFakeBrowser({
    URL:UrlApi,
    syncLoadImage:true,
    imageWidth:600,
    imageHeight:1200,
    canvasDataUrl:jpegDataUrl(700)
  });
  const original = new Blob(["image bytes"], { type:"image/png" });
  const originalSize = original.size;
  const result = await generateImageThumbnail(original);

  assert.equal(isUsableVideoThumbnail(result.thumbnail), true);
  assert.equal(result.width, 600);
  assert.equal(result.height, 1200);
  assert.equal(document.createdCanvases[0].width, 120);
  assert.equal(document.createdCanvases[0].height, 240);
  assert.equal(original.size, originalSize);
  assert.deepEqual(revoked, ["blob:image-generated-locally"]);
  restore();
});

test("image thumbnail generation uses the shared three-second failure bound", async () => {
  const revoked = [];
  const delays = [];
  const UrlApi = {
    createObjectURL:() => "blob:image-timeout",
    revokeObjectURL:value => revoked.push(value)
  };
  const { restore } = installFakeBrowser({
    URL:UrlApi,
    setTimeout:(callback, delay) => {
      delays.push(delay);
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout:() => {}
  });
  assert.deepEqual(await generateImageThumbnail(new Blob(["bad image"])), {});
  assert.deepEqual(delays, [3_000]);
  assert.deepEqual(revoked, ["blob:image-timeout"]);
  restore();
});

test("thumbnail extraction uses a local object URL, stays bounded, and revokes it", async () => {
  const revoked = [];
  const UrlApi = {
    createObjectURL:() => "blob:generated-locally",
    revokeObjectURL:value => revoked.push(value)
  };
  const { document, restore } = installFakeBrowser({
    URL:UrlApi,
    syncLoadVideo:true,
    videoWidth:1080,
    videoHeight:1920,
    canvasDataUrl:jpegDataUrl(700)
  });
  const result = await generateVideoThumbnail(new Blob(["video bytes"], { type:"video/mp4" }));

  assert.equal(isUsableVideoThumbnail(result.thumbnail), true);
  assert.equal(result.durationMs, 12_345);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(document.createdCanvases[0].width, 135);
  assert.equal(document.createdCanvases[0].height, 240);
  assert.deepEqual(revoked, ["blob:generated-locally"]);
  restore();
});

test("thumbnail extraction failure is non-blocking and still revokes the object URL", async () => {
  const revoked = [];
  const UrlApi = {
    createObjectURL:() => "blob:bad-video",
    revokeObjectURL:value => revoked.push(value)
  };
  const { document, restore } = installFakeBrowser({ URL:UrlApi });
  const promise = generateVideoThumbnail(new Blob(["bad"]));
  queueMicrotask(() => document.createdVideos[0].dispatch("error"));
  assert.deepEqual(await promise, {});
  assert.deepEqual(revoked, ["blob:bad-video"]);
  restore();
});

test("module is browser-standalone and contains no persistence or network writes", () => {
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(source, /from\s+["'][^"']*firebase|\b(?:setDoc|updateDoc|localStorage|sessionStorage)\b/);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)/);
  assert.match(source, /data(?:set)?\.videoState|dataset\.videoState/);
  assert.match(source, /dataset\.deferredSrc/);
  assert.match(source, /THUMBNAIL_TIMEOUT_MS = 3_000/);
});


test("browser timer receiver is preserved when autoplay is scheduled", async () => {
  const host = globalThis;
  const calls = [];
  const { restore } = installFakeBrowser({
    setTimeout:function(callback, delay) {
      assert.equal(this, host, "native Window timer requires its receiver");
      calls.push(delay);
      queueMicrotask(callback);
      return 1;
    }
  });
  try {
    const wrapper = createDeferredVideo({ url:"blob:brand-checked-autoplay" }, { autoplay:true });
    wrapper.isConnected = true;
    await flush();
    assert.deepEqual(calls, [0]);
    assert.equal(wrapper.children[0].playCalls, 1);
  } finally { restore(); }
});

test("browser timer receivers survive thumbnail timeout destructuring", async () => {
  const host = globalThis;
  const cleared = [];
  const { restore } = installFakeBrowser({
    URL:{ createObjectURL:() => "blob:brand-checked-image", revokeObjectURL:() => {} },
    setTimeout:function(callback) {
      assert.equal(this, host, "detached native timer requires Window");
      queueMicrotask(callback);
      return 42;
    },
    clearTimeout:function(id) {
      assert.equal(this, host, "detached native clearTimer requires Window");
      cleared.push(id);
    }
  });
  try {
    assert.deepEqual(await generateImageThumbnail(new Blob(["invalid image"])), {});
    assert.deepEqual(cleared, [42]);
  } finally { restore(); }
});
