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
const APP_VERSION = '3.0.0';

// notification payload는 FCM SDK가 이미 표시한다. data-only payload만 직접 표시한다.
messaging.onBackgroundMessage(async (payload) => {
  console.log('[sw] 백그라운드 메시지 수신: ', payload);

  if (payload.notification) {
    console.log('[sw] FCM 자동 표시 payload이므로 수동 표시 생략:', payload.messageId || 'unknown');
    return;
  }

  const data = payload.data || {};
  const eventId = data.eventId || data.messageKey || payload.messageId || 'latest';
  const tag = `memo-${eventId}`;

  try {
    const existing = await self.registration.getNotifications({ tag });
    if (existing.length) {
      console.log('[sw] 중복 알림 생략:', eventId);
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
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names
          .filter(name => name.startsWith('memo-v') && name !== CACHE_VERSION)
          .map(name => caches.delete(name))
      );
    }).then(() => clients.claim())
  );
});
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });

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
