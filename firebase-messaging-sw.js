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

// 앱이 완전히 닫혔을 때 백그라운드 푸시 알림 수신
messaging.onBackgroundMessage((payload) => {
  console.log('[sw] 백그라운드 메시지 수신: ', payload);
  const notificationTitle = payload.notification?.title || 'meMo';
  const notificationOptions = {
    body: payload.notification?.body || '새로운 메시지가 도착했습니다.',
    icon: 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><rect width=\'100\' height=\'100\' rx=\'20\' fill=\'%230d0d0f\'/><text x=\'50\' y=\'62\' text-anchor=\'middle\' font-size=\'40\' font-family=\'system-ui\' fill=\'%23c8a97e\'>mM</text></svg>',
    tag: 'memo-chat-alert',
    renotify: true
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// 캐싱 버전 관리
const CACHE_VERSION = 'memo-v2';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names => {
      return Promise.all(names.filter(n => n !== CACHE_VERSION).map(n => caches.delete(n)));
    }).then(() => clients.claim())
  );
});
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });

// 알림 클릭시 웹앱 창 열기 및 포커스
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('meMo') || client.url.includes('memo')) { return client.focus(); }
      }
      return clients.openWindow('./');
    })
  );
});
