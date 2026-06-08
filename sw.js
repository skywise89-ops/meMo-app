// meMo Service Worker
const CACHE_VERSION = 'memo-v2';

// 설치 — 즉시 활성화
self.addEventListener('install', e => {
  self.skipWaiting();
});

// 활성화 — 이전 캐시 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names.filter(n => n !== CACHE_VERSION).map(n => caches.delete(n))
      );
    }).then(() => clients.claim())
  );
});

// 네트워크 우선 — 항상 최신 파일 가져옴
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// 알림 클릭 → 앱 열기
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('meMo') || client.url.includes('memo')) {
          return client.focus();
        }
      }
      return clients.openWindow('./');
    })
  );
});
