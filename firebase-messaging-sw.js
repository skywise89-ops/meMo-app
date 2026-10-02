// meMo Service Worker & FCM 푸시 수신 스크립트
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey:            "AIzaSyBSfAOkWJtk41iCLIWkCtG91Hn9Aa44UNA",
  authDomain:        "memo-e366f.firebaseapp.com",
  databaseURL:       "https://memo-e366f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "memo-e366f",
  storageBucket:     "memo-e366f.firebasestorage.app",
  messagingSenderId: "103854425677",
  appId:             "1:103854425677:web:67e0b818c41b42bc3c7e04"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();
const APP_VERSION = '4.5.2';

// notification payload는 FCM SDK가 이미 표시한다. data-only payload만 직접 표시한다.
messaging.onBackgroundMessage(async (payload) => {
  console.log('[sw] 백그라운드 메시지 수신');

  if (payload.notification) {
    console.log('[sw] FCM 자동 표시 payload이므로 수동 표시 생략');
    return;
  }

  const data = payload.data || {};
  const eventId = data.eventId || data.messageKey || payload.messageId || 'latest';
  const tag = `memo-${eventId}`;

  try {
    const existing = await self.registration.getNotifications({ tag });
    if (existing.length) {
      console.log('[sw] 중복 알림 생략');
      return;
    }
  } catch (err) {
    console.warn('[sw] 기존 알림 조회 실패:', err);
  }

  const notificationTitle = data.title || 'meMo';
  const notificationOptions = {
    body: data.body || '새로운 메시지가 도착했습니다.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag,
    renotify: false,
    data: {
      eventId,
      url: data.url || './'
    }
  };

  await self.registration.showNotification(notificationTitle, notificationOptions);
});

// 캐싱 버전 관리
const CACHE_VERSION = `memo-v${APP_VERSION}`;
const PRIVATE_CACHE_PREFIX = 'memo-private-v2-';
const PRIVATE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const PRIVATE_CACHE_MAX_ENTRIES = 128;
const PRIVATE_OBJECT_MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRIVATE_STORAGE_HOST = 'firebasestorage.googleapis.com';
const PRIVATE_STORAGE_BUCKET = firebaseConfig.storageBucket;
const PRIVATE_CACHE_TIME_HEADER = 'x-memo-cache-stored-at';
const PRIVATE_CACHE_SIZE_HEADER = 'x-memo-cache-size';
const INVALIDATE_URL_LIMIT = 64;
const INVALIDATE_URL_MAX_LENGTH = 4096;

const privateSessions = new Map();
let privateSessionRevision = 0;
let privateLogoutEpoch = 0;
let privateWriteEpoch = 0;
let privatePurgeInProgress = false;
let privateCacheMutationChain = Promise.resolve();
let privateMessageChain = Promise.resolve();

function enqueuePrivateCacheMutation(task) {
  const run = privateCacheMutationChain.catch(() => {}).then(task);
  privateCacheMutationChain = run.catch(() => {});
  return run.catch(() => {});
}

function enqueuePrivateMessage(task) {
  const run = privateMessageChain.catch(() => {}).then(task);
  privateMessageChain = run.catch(() => {});
  return run.catch(() => {});
}

function isSafeUid(uid) {
  if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128) return false;
  if (/[\u0000-\u001f\u007f]/.test(uid)) return false;
  for (let index = 0; index < uid.length; index += 1) {
    const code = uid.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = uid.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

async function privateCacheNameForUid(uid) {
  const bytes = new TextEncoder().encode(uid);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const suffix = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${PRIVATE_CACHE_PREFIX}${suffix}`;
}

function privateStorageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== PRIVATE_STORAGE_HOST) return null;
    const match = url.pathname.match(/^\/(?:v0|download\/storage\/v1)\/b\/([^/]+)\/o(?:\/|$)/);
    if (!match || decodeURIComponent(match[1]) !== PRIVATE_STORAGE_BUCKET) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function isPrivateImageRequest(request) {
  return request.method === 'GET' &&
    request.destination === 'image' &&
    !request.headers.has('range') &&
    !!privateStorageUrl(request.url);
}

function capturePrivateSession(clientId) {
  if (!clientId) return null;
  const session = privateSessions.get(clientId);
  if (!session) return null;
  return {
    clientId,
    uid: session.uid,
    cacheName: session.cacheName,
    revision: session.revision,
    logoutEpoch: privateLogoutEpoch,
    writeEpoch: privateWriteEpoch
  };
}

function isPrivateSessionCurrent(token) {
  const current = privateSessions.get(token.clientId);
  return !!current &&
    current.uid === token.uid &&
    current.cacheName === token.cacheName &&
    current.revision === token.revision &&
    token.logoutEpoch === privateLogoutEpoch &&
    token.writeEpoch === privateWriteEpoch;
}

function cachedResponseWithoutMetadata(response) {
  const headers = new Headers(response.headers);
  headers.delete(PRIVATE_CACHE_TIME_HEADER);
  headers.delete(PRIVATE_CACHE_SIZE_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function privateCacheMetadata(response, now = Date.now()) {
  const storedAt = Number(response.headers.get(PRIVATE_CACHE_TIME_HEADER));
  const size = Number(response.headers.get(PRIVATE_CACHE_SIZE_HEADER));
  const contentType = response.headers.get('content-type') || '';
  if (!Number.isFinite(storedAt) || !Number.isFinite(size) || size < 0 || size > PRIVATE_OBJECT_MAX_BYTES) return null;
  if (!contentType.toLowerCase().startsWith('image/')) return null;
  if (storedAt > now + 60 * 1000 || now - storedAt > PRIVATE_CACHE_TTL_MS) return null;
  return { storedAt, size };
}

async function enforcePrivateCacheBounds(cache, now = Date.now()) {
  const entries = [];
  const requests = await cache.keys();

  for (const request of requests) {
    const response = await cache.match(request);
    const metadata = response && privateCacheMetadata(response, now);
    if (!metadata) {
      await cache.delete(request);
      continue;
    }
    entries.push({ request, ...metadata });
  }

  entries.sort((a, b) => a.storedAt - b.storedAt);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let totalEntries = entries.length;

  for (const entry of entries) {
    if (totalEntries <= PRIVATE_CACHE_MAX_ENTRIES && totalBytes <= PRIVATE_CACHE_MAX_BYTES) break;
    if (await cache.delete(entry.request)) {
      totalEntries -= 1;
      totalBytes -= entry.size;
    }
  }
}

async function preparePrivateCacheWrite(request, response, token) {
  if (!isPrivateSessionCurrent(token)) return;
  if (response.status !== 200 || response.headers.has('content-range')) return;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) return;

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > PRIVATE_OBJECT_MAX_BYTES) return;

  let bytes;
  try {
    bytes = await response.arrayBuffer();
  } catch (_) {
    return;
  }
  if (bytes.byteLength > PRIVATE_OBJECT_MAX_BYTES || !isPrivateSessionCurrent(token)) return;

  const storedAt = Date.now();
  const headers = new Headers(response.headers);
  headers.set(PRIVATE_CACHE_TIME_HEADER, String(storedAt));
  headers.set(PRIVATE_CACHE_SIZE_HEADER, String(bytes.byteLength));
  const storedResponse = new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers
  });

  return enqueuePrivateCacheMutation(async () => {
    if (!isPrivateSessionCurrent(token)) return;
    const cache = await caches.open(token.cacheName);
    if (!isPrivateSessionCurrent(token)) return;
    await cache.put(request, storedResponse);
    await enforcePrivateCacheBounds(cache, storedAt);
  });
}

async function fetchPrivateImageNetwork(request) {
  if (request.mode !== 'no-cors') return fetch(request);

  try {
    const corsRequest = new Request(request, { mode:'cors', credentials:'omit' });
    return await fetch(corsRequest);
  } catch (_) {
    // Markup image requests are normally no-cors. If CORS is unavailable,
    // preserve display behavior with the original opaque response and skip caching.
    return fetch(request);
  }
}

function handlePrivateImageRequest(event, request, token) {
  let finishLifetime;
  const lifetime = new Promise(resolve => { finishLifetime = resolve; });
  event.waitUntil(lifetime);

  const finish = promise => {
    Promise.resolve(promise).catch(() => {}).then(finishLifetime);
  };

  return (async () => {
    const background = [];
    try {
      if (!privatePurgeInProgress && isPrivateSessionCurrent(token)) {
        try {
          const cache = await caches.open(token.cacheName);
          const cached = await cache.match(request);
          if (cached) {
            const metadata = privateCacheMetadata(cached);
            if (metadata && isPrivateSessionCurrent(token) && !privatePurgeInProgress) {
              finish(background.length ? Promise.all(background) : undefined);
              return cachedResponseWithoutMetadata(cached);
            }
            background.push(enqueuePrivateCacheMutation(async () => {
              if (isPrivateSessionCurrent(token)) await cache.delete(request);
            }));
          }
        } catch (_) {
          // Cache API failures must never block the network request.
        }
      }

      const networkResponse = await fetchPrivateImageNetwork(request);
      try {
        background.push(preparePrivateCacheWrite(request, networkResponse.clone(), token));
      } catch (_) {
        // An uncloneable response remains usable by the page.
      }
      finish(Promise.all(background));
      return networkResponse;
    } catch (err) {
      finish(Promise.all(background));
      throw err;
    }
  })();
}

function scopeContainsClient(clientUrl) {
  try {
    const candidate = new URL(clientUrl);
    const scope = new URL(self.registration.scope);
    if (candidate.origin !== self.location.origin || candidate.origin !== scope.origin) return false;
    const scopePath = scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`;
    return candidate.pathname === scope.pathname || candidate.pathname.startsWith(scopePath);
  } catch (_) {
    return false;
  }
}

async function validatedMessageClient(event) {
  const sourceId = event.source && event.source.id;
  if (typeof sourceId !== 'string' || !sourceId) return null;
  let client;
  try {
    client = await clients.get(sourceId);
  } catch (_) {
    return null;
  }
  if (!client || client.id !== sourceId || !scopeContainsClient(client.url)) return null;
  return client;
}

async function purgeInactivePrivateCaches() {
  return enqueuePrivateCacheMutation(async () => {
    for (const clientId of privateSessions.keys()) {
      let client = null;
      try {
        client = await clients.get(clientId);
      } catch (_) {
        // Treat an unreadable client as inactive; its next heartbeat can restore the session.
      }
      if (!client || !scopeContainsClient(client.url)) privateSessions.delete(clientId);
    }

    const activeNames = new Set(Array.from(privateSessions.values(), session => session.cacheName));
    const names = await caches.keys();
    for (const name of names) {
      if (name.startsWith(PRIVATE_CACHE_PREFIX) && !activeNames.has(name)) await caches.delete(name);
    }
  });
}

function purgeAllPrivateCaches() {
  const purgeEpoch = ++privateLogoutEpoch;
  privateSessions.clear();
  privatePurgeInProgress = true;
  const purge = enqueuePrivateCacheMutation(async () => {
    const names = await caches.keys();
    for (const name of names) {
      if (name.startsWith('memo-private-')) await caches.delete(name);
    }
  });
  return purge.finally(() => {
    if (privateLogoutEpoch === purgeEpoch) privatePurgeInProgress = false;
  });
}

async function updatePrivateSession(clientId, uid) {
  if (uid === null || uid === '') return purgeAllPrivateCaches();
  if (!isSafeUid(uid)) return;

  const current = privateSessions.get(clientId);
  if (current && current.uid === uid) return;

  const cacheName = await privateCacheNameForUid(uid);
  privateSessions.set(clientId, {
    uid,
    cacheName,
    revision: ++privateSessionRevision
  });
  await purgeInactivePrivateCaches();
}

async function invalidatePrivateUrls(clientId, urls) {
  if (!Array.isArray(urls) || urls.length > INVALIDATE_URL_LIMIT) return;
  if (!privateSessions.has(clientId)) return;

  const normalized = [];
  for (const value of urls) {
    if (typeof value !== 'string' || value.length > INVALIDATE_URL_MAX_LENGTH) return;
    const url = privateStorageUrl(value);
    if (!url) return;
    normalized.push(url.href);
  }
  if (!normalized.length) return;

  // Invalidate every in-flight private write before queuing deletes. This is
  // deliberately global and conservative so another tab cannot reinsert a
  // just-deleted private image after this mutation completes.
  privateWriteEpoch += 1;
  const session = capturePrivateSession(clientId);
  if (!session) return;

  return enqueuePrivateCacheMutation(async () => {
    if (!isPrivateSessionCurrent(session)) return;
    const cache = await caches.open(session.cacheName);
    for (const url of normalized) {
      if (!isPrivateSessionCurrent(session)) return;
      await cache.delete(url, { ignoreVary:true });
    }
  });
}

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    for (const name of names) {
      const oldPublicCache = name.startsWith('memo-v') && name !== CACHE_VERSION;
      const oldPrivateFormat = name.startsWith('memo-private-') && !name.startsWith(PRIVATE_CACHE_PREFIX);
      if (oldPublicCache || oldPrivateFormat) await caches.delete(name);
    }
    await clients.claim();
  })());
});

self.addEventListener('message', e => {
  const data = e.data;
  if (!data || (data.type !== 'MEMO_CACHE_SESSION' && data.type !== 'MEMO_CACHE_INVALIDATE')) return;

  e.waitUntil(enqueuePrivateMessage(async () => {
    const client = await validatedMessageClient(e);
    if (!client) return;

    if (data.type === 'MEMO_CACHE_SESSION') {
      await updatePrivateSession(client.id, data.uid);
      return;
    }

    await invalidatePrivateUrls(client.id, data.urls);
  }));
});

self.addEventListener('fetch', e => {
  const request = e.request;
  const storageUrl = privateStorageUrl(request.url);

  if (storageUrl) {
    const session = isPrivateImageRequest(request) ? capturePrivateSession(e.clientId) : null;
    e.respondWith(session ? handlePrivateImageRequest(e, request, session) : fetch(request));
    return;
  }

  e.respondWith(fetch(request).catch(() => caches.match(request)));
});

// 알림 클릭시 웹앱 창 열기 및 포커스
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = new URL(e.notification.data?.url || './', self.registration.scope).href;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      for (const client of list) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ('navigate' in client && client.url !== targetUrl) await client.navigate(targetUrl);
        return client.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
