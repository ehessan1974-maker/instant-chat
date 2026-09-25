var CHAT_CACHE = 'chat-cache-v1';

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CHAT_CACHE).then(function(cache) {
      return cache.addAll(['/', '/index.html']);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CHAT_CACHE; }).map(function(n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request).then(function(res) {
      return res || fetch(event.request).then(function(resp) {
        if (resp.status === 200 && resp.type === 'basic') {
          var clone = resp.clone();
          caches.open(CHAT_CACHE).then(function(cache) { cache.put(event.request, clone); });
        }
        return resp;
      }).catch(function() {
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

self.addEventListener('push', function(event) {
  var data = { title: 'محادثة فورية', body: 'لديك رسالة جديدة' };
  if (event.data) {
    try { data = event.data.json(); } catch(e) { data.body = event.data.text(); }
  }
  var options = {
    body: data.body || 'لديك رسالة جديدة',
    tag: 'chat-msg',
    renotify: true,
    dir: 'rtl',
    lang: 'ar'
  };
  if (data.username) {
    options.body = data.username + ': ' + (data.text || '');
  }
  event.waitUntil(self.registration.showNotification(data.title || 'محادثة فورية', options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('chat') !== -1 || list[i].url.indexOf('instant-chat') !== -1) {
          list[i].focus();
          return;
        }
      }
      return clients.openWindow('/');
    })
  );
});