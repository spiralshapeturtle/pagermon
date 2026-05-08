// PagerMon Service Worker — push notificaties + offline shell caching
// Ondersteunt Chrome, Firefox en Safari 16.4+

const CACHE_NAME = 'pagermon-shell-v2';
const CACHE_URLS = [
  '/',
  '/stylesheets/style.css',
  '/apple-touch-icon.png',
  '/favicon-32x32.png'
];

// ── Install: precache shell assets ──────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS);
    })
  );
  // Activeer direct — wacht niet totdat alle tabs gesloten zijn
  self.skipWaiting();
});

// ── Activate: verwijder verouderde caches + claim open tabs ─────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    }).then(function() {
      // KRITIEK: zonder clients.claim() bestuurt de SW bestaande tabbladen niet
      // en kunnen push-notificaties niet worden weergegeven voor reeds open tabs
      return clients.claim();
    })
  );
});

// ── Fetch: network-first, cache als fallback voor shell assets ───────────────
self.addEventListener('fetch', function(event) {
  // Alleen GET verzoeken cachen
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);

  // API- en Socket.io-verzoeken nooit cachen
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname.startsWith('/auth/')) return;

  event.respondWith(
    fetch(event.request).then(function(response) {
      // Sla shell-assets op in cache bij succesvolle response
      if (response.ok && CACHE_URLS.includes(url.pathname)) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      // Netwerk niet beschikbaar — probeer cache
      return caches.match(event.request);
    })
  );
});

// ── Push: verwerk binnenkomend push-bericht van server ──────────────────────
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch(e) {
    data = {
      title: 'P2000-melding',
      body: event.data ? event.data.text() : 'Nieuw pager-bericht ontvangen'
    };

  }

  var origin  = self.location.origin;
  var title   = data.title  || 'P2000-melding';
  var options = {
    body:     data.body   || 'Nieuw pager-bericht ontvangen',
    // Absolute URLs — vereist door Chrome en Firefox voor push-notificaties
    icon:     origin + '/apple-touch-icon.png',
    badge:    origin + '/favicon-32x32.png',
    tag:      data.tag    || 'pagermon-alert',
    renotify: true,
    data:     { url: data.url || '/' }
  };

  // Dubbel-fix: check of de app al open staat. Zo ja, toon GEEN push-notificatie
  // omdat de geopende pagina zelf al een melding geeft via Socket.io.
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      var focused = clientList.some(function(client) {
        return client.focused || client.visibilityState === 'visible';
      });

      if (focused) {
        return;
      }

      return self.registration.showNotification(title, options);
    })
  );
});

// ── NotificationClick: breng app naar voren bij klikken op notificatie ───────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Zoek een al geopend tabblad, navigeer naar targetUrl én focus het
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if ('navigate' in client) {
            return client.navigate(targetUrl).then(function(c) { return c && c.focus(); });
          }
          return client.focus();
        }
      }
      // Geen open tabblad gevonden — open nieuw venster
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
