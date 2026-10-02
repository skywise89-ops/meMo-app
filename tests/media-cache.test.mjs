import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const workerSource = await readFile(new URL('../firebase-messaging-sw.js', import.meta.url), 'utf8');
const APP_ORIGIN = 'https://app.example.test';
const APP_SCOPE = `${APP_ORIGIN}/`;
const BUCKET = 'memo-e366f.firebasestorage.app';

function storageUrl(name, token = 'token-a', bucket = BUCKET) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(name)}?alt=media&token=${token}`;
}

function requestFor(url, { destination = 'image', headers = {}, method = 'GET', mode = 'no-cors' } = {}) {
  const request = new Request(url, { method, headers, mode });
  Object.defineProperty(request, 'destination', { value:destination });
  return request;
}

function opaqueImageResponse(body = 'opaque-image') {
  return {
    status:0,
    statusText:'',
    type:'opaque',
    headers:new Headers(),
    clone() { return opaqueImageResponse(body); },
    async text() { return body; }
  };
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  keyFor(request) {
    return typeof request === 'string' ? new URL(request).href : new URL(request.url).href;
  }

  async match(request) {
    const response = this.entries.get(this.keyFor(request));
    return response ? response.clone() : undefined;
  }

  async put(request, response) {
    this.entries.set(this.keyFor(request), response.clone());
  }

  async delete(request) {
    return this.entries.delete(this.keyFor(request));
  }

  async keys() {
    return Array.from(this.entries.keys(), url => new Request(url));
  }
}

class MemoryCacheStorage {
  constructor() {
    this.stores = new Map();
  }

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name) {
    return this.stores.delete(name);
  }

  async match(request) {
    for (const cache of this.stores.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
    return undefined;
  }

  privateNames() {
    return [...this.stores.keys()].filter(name => name.startsWith('memo-private-v2-'));
  }

  privateEntryCount() {
    return this.privateNames().reduce((sum, name) => sum + this.stores.get(name).entries.size, 0);
  }
}

function createHarness({ cacheStorage = new MemoryCacheStorage() } = {}) {
  const listeners = new Map();
  const clientMap = new Map([
    ['client-a', { id:'client-a', url:`${APP_ORIGIN}/index.html` }],
    ['client-b', { id:'client-b', url:`${APP_ORIGIN}/album` }],
    ['outside-scope', { id:'outside-scope', url:`${APP_ORIGIN}/outside` }],
    ['foreign', { id:'foreign', url:'https://evil.example/index.html' }]
  ]);
  const network = new Map();
  const fetchCounts = new Map();
  const fetchRequests = new Map();
  const consoleLines = [];
  const clock = { now:1_800_000_000_000 };

  class FakeDate extends Date {
    static now() {
      return clock.now++;
    }
  }

  const self = {
    location:new URL(APP_SCOPE),
    registration:{
      scope:APP_SCOPE,
      async getNotifications() { return []; },
      async showNotification() {}
    },
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    skipWaiting() {}
  };

  const clients = {
    async get(id) { return clientMap.get(id); },
    async claim() {},
    async matchAll() { return [...clientMap.values()]; },
    async openWindow() {}
  };

  const fetchMock = async request => {
    const url = new URL(typeof request === 'string' ? request : request.url).href;
    fetchCounts.set(url, (fetchCounts.get(url) || 0) + 1);
    const requests = fetchRequests.get(url) || [];
    requests.push({ mode:request.mode, credentials:request.credentials });
    fetchRequests.set(url, requests);
    const handler = network.get(url);
    if (!handler) throw new Error(`Unmocked network request: ${url}`);
    return typeof handler === 'function' ? handler(request) : handler.clone();
  };

  const messaging = { onBackgroundMessage(handler) { this.handler = handler; } };
  const firebase = {
    initializeApp() {},
    messaging() { return messaging; }
  };

  const context = vm.createContext({
    self,
    clients,
    caches:cacheStorage,
    fetch:fetchMock,
    firebase,
    importScripts() {},
    URL,
    Request,
    Response,
    Headers,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Promise,
    Map,
    Set,
    Number,
    String,
    RegExp,
    Date:FakeDate,
    crypto:webcrypto,
    console:{
      log(...values) { consoleLines.push(values.join(' ')); },
      warn(...values) { consoleLines.push(values.join(' ')); },
      error(...values) { consoleLines.push(values.join(' ')); }
    }
  });
  vm.runInContext(workerSource, context, { filename:'firebase-messaging-sw.js' });

  function emit(type, event) {
    for (const listener of listeners.get(type) || []) listener(event);
  }

  async function message(data, sourceId = 'client-a') {
    const waits = [];
    emit('message', {
      data,
      source:{ id:sourceId },
      waitUntil(promise) { waits.push(Promise.resolve(promise)); }
    });
    await Promise.all(waits);
  }

  function startFetch(request, clientId = 'client-a') {
    const waits = [];
    let responsePromise;
    emit('fetch', {
      request,
      clientId,
      respondWith(promise) { responsePromise = Promise.resolve(promise); },
      waitUntil(promise) { waits.push(Promise.resolve(promise)); }
    });
    assert.ok(responsePromise, 'fetch handler did not call respondWith');
    return {
      response:responsePromise,
      done:Promise.all(waits)
    };
  }

  async function fetchAndSettle(request, clientId = 'client-a') {
    const operation = startFetch(request, clientId);
    const response = await operation.response;
    await operation.done;
    return response;
  }

  async function activate() {
    const waits = [];
    emit('activate', { waitUntil(promise) { waits.push(Promise.resolve(promise)); } });
    await Promise.all(waits);
  }

  return {
    activate,
    cacheStorage,
    clientMap,
    clock,
    consoleLines,
    fetchAndSettle,
    fetchCount(url) { return fetchCounts.get(new URL(url).href) || 0; },
    fetchRequests(url) { return fetchRequests.get(new URL(url).href) || []; },
    message,
    network,
    startFetch
  };
}

function imageResponse(body = 'image', headers = {}) {
  return new Response(body, {
    status:200,
    headers:{ 'content-type':'image/jpeg', ...headers }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('caches only bounded successful current-bucket image responses and returns the original network response', async () => {
  const h = createHarness();
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'firebase_uid_A' });

  const valid = storageUrl('valid.jpg');
  h.network.set(valid, imageResponse('valid-bytes', { 'x-origin-header':'kept' }));
  const original = await h.fetchAndSettle(requestFor(valid));
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('x-origin-header'), 'kept');
  assert.equal(original.headers.get('x-memo-cache-size'), null);
  assert.equal(await original.text(), 'valid-bytes');
  assert.equal(h.cacheStorage.privateEntryCount(), 1);

  const cases = [
    [storageUrl('video.mp4'), { destination:'video' }, imageResponse('not-an-image-request')],
    [storageUrl('audio.m4a'), { destination:'audio' }, new Response('audio', { status:200, headers:{ 'content-type':'audio/mp4' } })],
    [storageUrl('range.jpg'), { destination:'image', headers:{ Range:'bytes=0-10' } }, imageResponse('range')],
    [storageUrl('html.jpg'), { destination:'image' }, new Response('<html>', { status:200, headers:{ 'content-type':'text/html' } })],
    [storageUrl('partial.jpg'), { destination:'image' }, new Response('part', { status:206, headers:{ 'content-type':'image/jpeg', 'content-range':'bytes 0-3/10' } })],
    [storageUrl('declared-large.jpg'), { destination:'image' }, imageResponse('small', { 'content-length':String(2 * 1024 * 1024 + 1) })],
    [storageUrl('wrong-bucket.jpg', 'token-a', 'other.firebasestorage.app'), { destination:'image' }, imageResponse('wrong bucket')],
    ['https://example.com/current.jpg', { destination:'image' }, imageResponse('wrong host')]
  ];

  for (const [url, options, response] of cases) {
    h.network.set(url, response);
    await h.fetchAndSettle(requestFor(url, options));
  }

  const actualLarge = storageUrl('actual-large.jpg');
  h.network.set(actualLarge, imageResponse(new Uint8Array(2 * 1024 * 1024 + 1)));
  await h.fetchAndSettle(requestFor(actualLarge));
  assert.equal(h.cacheStorage.privateEntryCount(), 1);
});

test('uses cache-first for signed token URLs without stripping or merging query tokens', async () => {
  const h = createHarness();
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'firebase_uid_A' });

  const tokenA = storageUrl('photo.jpg', 'signed-A');
  const tokenB = storageUrl('photo.jpg', 'signed-B');
  h.network.set(tokenA, imageResponse('from-token-a'));
  h.network.set(tokenB, imageResponse('from-token-b'));

  const first = await h.fetchAndSettle(requestFor(tokenA));
  assert.equal(await first.text(), 'from-token-a');
  h.network.set(tokenA, () => { throw new Error('network must not run on cache hit'); });

  const hit = await h.fetchAndSettle(requestFor(tokenA));
  assert.equal(await hit.text(), 'from-token-a');
  assert.equal(hit.headers.get('x-memo-cache-stored-at'), null);
  assert.equal(h.fetchCount(tokenA), 1);
  assert.deepEqual(h.fetchRequests(tokenA), [{ mode:'cors', credentials:'omit' }]);

  const otherToken = await h.fetchAndSettle(requestFor(tokenB));
  assert.equal(await otherToken.text(), 'from-token-b');
  assert.equal(h.fetchCount(tokenB), 1);
  assert.equal(h.cacheStorage.privateEntryCount(), 2);
});

test('falls back to the original no-cors image request when the inspectable CORS fetch fails', async () => {
  const h = createHarness();
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'cors_fallback_uid' });
  const url = storageUrl('cors-fallback.jpg');
  h.network.set(url, request => {
    if (request.mode === 'cors') throw new TypeError('CORS blocked');
    return opaqueImageResponse('visually-usable-opaque-image');
  });

  const originalRequest = requestFor(url);
  assert.equal(originalRequest.mode, 'no-cors');
  const first = await h.fetchAndSettle(originalRequest);
  assert.equal(first.type, 'opaque');
  assert.equal(await first.text(), 'visually-usable-opaque-image');
  assert.deepEqual(h.fetchRequests(url), [
    { mode:'cors', credentials:'omit' },
    { mode:'no-cors', credentials:'same-origin' }
  ]);
  assert.equal(h.cacheStorage.privateEntryCount(), 0);

  await h.fetchAndSettle(requestFor(url));
  assert.equal(h.fetchCount(url), 4, 'opaque fallback is never cached');
  assert.equal(h.cacheStorage.privateEntryCount(), 0);
});

test('evicts oldest entries at 128 images and at 32 MiB actual bytes', async () => {
  const countHarness = createHarness();
  await countHarness.message({ type:'MEMO_CACHE_SESSION', uid:'count_uid' });
  const countUrls = [];
  for (let index = 0; index < 129; index += 1) {
    const url = storageUrl(`count-${index}.jpg`, `token-${index}`);
    countUrls.push(url);
    countHarness.network.set(url, imageResponse(new Uint8Array([index % 255])));
    await countHarness.fetchAndSettle(requestFor(url));
  }
  assert.equal(countHarness.cacheStorage.privateEntryCount(), 128);
  const countCache = countHarness.cacheStorage.stores.get(countHarness.cacheStorage.privateNames()[0]);
  assert.equal(await countCache.match(countUrls[0]), undefined);
  assert.ok(await countCache.match(countUrls[128]));

  const byteHarness = createHarness();
  await byteHarness.message({ type:'MEMO_CACHE_SESSION', uid:'byte_uid' });
  const byteUrls = [];
  for (let index = 0; index < 17; index += 1) {
    const url = storageUrl(`bytes-${index}.jpg`, `token-${index}`);
    byteUrls.push(url);
    byteHarness.network.set(url, imageResponse(new Uint8Array(2 * 1024 * 1024)));
    await byteHarness.fetchAndSettle(requestFor(url));
  }
  assert.equal(byteHarness.cacheStorage.privateEntryCount(), 16);
  const byteCache = byteHarness.cacheStorage.stores.get(byteHarness.cacheStorage.privateNames()[0]);
  assert.equal(await byteCache.match(byteUrls[0]), undefined);
  assert.ok(await byteCache.match(byteUrls[16]));
});

test('account switch isolates clients and logout prevents pending requests from repopulating caches', async () => {
  const h = createHarness();
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'account_A' }, 'client-a');
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'account_B' }, 'client-b');

  const aUrl = storageUrl('account-a.jpg');
  const bUrl = storageUrl('account-b.jpg');
  h.network.set(aUrl, imageResponse('A'));
  h.network.set(bUrl, imageResponse('B'));
  await h.fetchAndSettle(requestFor(aUrl), 'client-a');
  await h.fetchAndSettle(requestFor(bUrl), 'client-b');
  assert.equal(h.cacheStorage.privateNames().length, 2);

  await h.message({ type:'MEMO_CACHE_SESSION', uid:'account_C' }, 'client-a');
  assert.equal(h.cacheStorage.privateNames().length, 1, 'switched-out account cache is purged while another active client remains');
  h.network.set(aUrl, imageResponse('C'));
  const switched = await h.fetchAndSettle(requestFor(aUrl), 'client-a');
  assert.equal(await switched.text(), 'C');
  assert.equal(h.cacheStorage.privateNames().length, 2);

  const pendingUrl = storageUrl('pending.jpg');
  const pendingNetwork = deferred();
  h.network.set(pendingUrl, () => pendingNetwork.promise);
  const pending = h.startFetch(requestFor(pendingUrl), 'client-a');
  await h.message({ type:'MEMO_CACHE_SESSION', uid:null }, 'client-a');
  pendingNetwork.resolve(imageResponse('late image'));
  assert.equal(await (await pending.response).text(), 'late image');
  await pending.done;
  assert.equal(h.cacheStorage.privateEntryCount(), 0);
  assert.equal(h.cacheStorage.privateNames().length, 0);

  h.network.set(bUrl, imageResponse('B-network-after-logout'));
  const noLongerAuthorized = await h.fetchAndSettle(requestFor(bUrl), 'client-b');
  assert.equal(await noLongerAuthorized.text(), 'B-network-after-logout');
  assert.equal(h.cacheStorage.privateEntryCount(), 0);
});

test('invalidation prevents an already pending fetch from repopulating the deleted URL', async () => {
  const h = createHarness();
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'invalidate_race_uid' });
  const url = storageUrl('pending-invalidation.jpg');
  const pendingNetwork = deferred();
  h.network.set(url, request => {
    assert.equal(request.mode, 'cors');
    return pendingNetwork.promise;
  });

  const pending = h.startFetch(requestFor(url));
  await Promise.resolve();
  await Promise.resolve();
  await h.message({ type:'MEMO_CACHE_INVALIDATE', urls:[url] });
  pendingNetwork.resolve(imageResponse('late-after-invalidate'));
  assert.equal(await (await pending.response).text(), 'late-after-invalidate');
  await pending.done;
  assert.equal(h.cacheStorage.privateEntryCount(), 0);
});

test('retained cache is not served after worker restart until a UID handshake', async () => {
  const sharedCaches = new MemoryCacheStorage();
  const firstWorker = createHarness({ cacheStorage:sharedCaches });
  const url = storageUrl('restart.jpg', 'stable-token');
  await firstWorker.message({ type:'MEMO_CACHE_SESSION', uid:'restart_uid' });
  firstWorker.network.set(url, imageResponse('cached-before-restart'));
  await firstWorker.fetchAndSettle(requestFor(url));
  assert.equal(sharedCaches.privateEntryCount(), 1);

  const restarted = createHarness({ cacheStorage:sharedCaches });
  await restarted.activate();
  restarted.network.set(url, imageResponse('network-without-session'));
  const withoutSession = await restarted.fetchAndSettle(requestFor(url));
  assert.equal(await withoutSession.text(), 'network-without-session');
  assert.equal(restarted.fetchCount(url), 1);

  restarted.network.set(url, () => { throw new Error('no session must not fall back to private cache'); });
  await assert.rejects(restarted.fetchAndSettle(requestFor(url)), /no session must not fall back/);
  assert.equal(restarted.fetchCount(url), 2);

  await restarted.message({ type:'MEMO_CACHE_SESSION', uid:'restart_uid' });
  restarted.network.set(url, () => { throw new Error('handshake should unlock the retained cache'); });
  const afterHandshake = await restarted.fetchAndSettle(requestFor(url));
  assert.equal(await afterHandshake.text(), 'cached-before-restart');
  assert.equal(restarted.fetchCount(url), 2);
});

test('session and invalidation messages require a current same-origin scoped client and bounded valid URL lists', async () => {
  const h = createHarness();
  const urlA = storageUrl('invalidate-a.jpg');
  const urlB = storageUrl('invalidate-b.jpg');

  await h.message({ type:'MEMO_CACHE_SESSION', uid:'ignored_uid' }, 'foreign');
  h.network.set(urlA, imageResponse('network-only'));
  await h.fetchAndSettle(requestFor(urlA), 'foreign');
  assert.equal(h.cacheStorage.privateEntryCount(), 0);

  await h.message({ type:'MEMO_CACHE_SESSION', uid:'x'.repeat(129) }, 'client-a');
  h.network.set(urlA, imageResponse('still-network-only'));
  await h.fetchAndSettle(requestFor(urlA), 'client-a');
  assert.equal(h.cacheStorage.privateEntryCount(), 0);

  await h.message({ type:'MEMO_CACHE_SESSION', uid:'valid/custom:uid' }, 'client-a');
  h.network.set(urlA, imageResponse('A'));
  h.network.set(urlB, imageResponse('B'));
  await h.fetchAndSettle(requestFor(urlA), 'client-a');
  await h.fetchAndSettle(requestFor(urlB), 'client-a');
  assert.equal(h.cacheStorage.privateEntryCount(), 2);

  await h.message({ type:'MEMO_CACHE_INVALIDATE', urls:[urlA] }, 'foreign');
  assert.equal(h.cacheStorage.privateEntryCount(), 2);

  await h.message({ type:'MEMO_CACHE_INVALIDATE', urls:Array(65).fill(urlA) }, 'client-a');
  assert.equal(h.cacheStorage.privateEntryCount(), 2);

  await h.message({ type:'MEMO_CACHE_INVALIDATE', urls:[urlA, 'https://example.com/not-storage.jpg'] }, 'client-a');
  assert.equal(h.cacheStorage.privateEntryCount(), 2, 'mixed invalid lists are rejected atomically');

  await h.message({ type:'MEMO_CACHE_INVALIDATE', urls:[urlA] }, 'client-a');
  assert.equal(h.cacheStorage.privateEntryCount(), 1);
  const privateCache = h.cacheStorage.stores.get(h.cacheStorage.privateNames()[0]);
  assert.equal(await privateCache.match(urlA), undefined);
  assert.ok(await privateCache.match(urlB));
});

test('expired entries miss to network and cache API failures remain fail-open', async () => {
  const h = createHarness();
  const url = storageUrl('ttl.jpg');
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'ttl_uid' });
  h.network.set(url, imageResponse('fresh'));
  await h.fetchAndSettle(requestFor(url));

  h.clock.now += 24 * 60 * 60 * 1000 + 1;
  h.network.set(url, imageResponse('refreshed'));
  const expired = await h.fetchAndSettle(requestFor(url));
  assert.equal(await expired.text(), 'refreshed');
  assert.equal(h.fetchCount(url), 2);

  const failingCaches = new MemoryCacheStorage();
  failingCaches.open = async () => { throw new Error('cache unavailable'); };
  const failOpen = createHarness({ cacheStorage:failingCaches });
  const failUrl = storageUrl('cache-failure.jpg');
  await failOpen.message({ type:'MEMO_CACHE_SESSION', uid:'fail_open_uid' });
  failOpen.network.set(failUrl, imageResponse('network survives'));
  const networkResponse = await failOpen.fetchAndSettle(requestFor(failUrl));
  assert.equal(await networkResponse.text(), 'network survives');
  assert.equal(failOpen.fetchCount(failUrl), 1);
});

test('activation removes old public and old private formats but retains the active private format', async () => {
  const h = createHarness();
  await h.cacheStorage.open('memo-v3.0.0');
  await h.cacheStorage.open('memo-v4.5.2');
  await h.cacheStorage.open('memo-private-v1-old');
  await h.cacheStorage.open('memo-private-v2-retained');

  await h.activate();
  const names = await h.cacheStorage.keys();
  assert.deepEqual(names.sort(), ['memo-private-v2-retained', 'memo-v4.5.2']);
});

test('service worker logs never include private storage URLs', async () => {
  const h = createHarness();
  const privateUrl = storageUrl('secret.jpg', 'private-token');
  await h.message({ type:'MEMO_CACHE_SESSION', uid:'log_uid' });
  h.network.set(privateUrl, imageResponse('secret'));
  await h.fetchAndSettle(requestFor(privateUrl));
  assert.ok(h.consoleLines.every(line => !line.includes('firebasestorage.googleapis.com')));
  assert.ok(h.consoleLines.every(line => !line.includes('private-token')));
});
