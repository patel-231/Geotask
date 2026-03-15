/* ============================================================
   GeoTask Service Worker — Background Geofence Monitor
   Runs even when Chrome is minimised or screen is off.
   ============================================================ */

const SW_VERSION = 'geotask-sw-v1';
const CHECK_INTERVAL_MS = 30000; // check every 30 s

/* ── Install & activate ── */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
  startBackgroundWatch();
});

/* ── Message bus from main page ── */
self.addEventListener('message', e => {
  if (e.data.type === 'SYNC_TASKS') {
    storeTasks(e.data.tasks);
  }
  if (e.data.type === 'START_WATCH') {
    startBackgroundWatch();
  }
  if (e.data.type === 'PING') {
    e.source && e.source.postMessage({ type: 'PONG' });
  }
});

/* ── Periodic background sync (where supported) ── */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'geofence-check') {
    e.waitUntil(doGeofenceCheck());
  }
});

/* ── Push event (from server — future use) ── */
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(showNotification(data.title || '📍 Location Alert', data.body || 'You have arrived!', data.taskId));
});

/* ── Notification click ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});

/* ════════════════════════════════════════════
   BACKGROUND GEOFENCE LOGIC
════════════════════════════════════════════ */
let watchInterval = null;

function startBackgroundWatch() {
  if (watchInterval) clearInterval(watchInterval);
  watchInterval = setInterval(doGeofenceCheck, CHECK_INTERVAL_MS);
}

async function doGeofenceCheck() {
  try {
    const tasks = await getTasks();
    if (!tasks || !tasks.length) return;

    const activeTasks = tasks.filter(t => t.active);
    if (!activeTasks.length) return;

    // Get position via background geolocation if page is not focused
    const clients = await self.clients.matchAll({ type: 'window' });
    
    if (clients.length === 0) {
      // No open window — rely on last known position stored
      const lastPos = await getLastPos();
      if (lastPos) {
        await checkAllFences(activeTasks, lastPos.lat, lastPos.lng);
      }
    }
    // If window open, the page handles it — SW is fallback
  } catch (err) {
    console.error('[SW] geofence check error', err);
  }
}

async function checkAllFences(tasks, lat, lng) {
  const now = Date.now();
  let dirty = false;

  for (const t of tasks) {
    const dist = haversine(lat, lng, t.lat, t.lng);
    const inside = dist <= t.radius;
    const cooldown = !t.lastN || (now - t.lastN > 90000);

    if (inside && cooldown && !t.inside) {
      await showNotification(
        '📍 ' + t.title,
        t.desc || 'You are within ' + t.radius + 'm of this location.',
        t.id
      );
      t.inside = true;
      t.lastN = now;
      dirty = true;
    } else if (!inside && t.inside) {
      t.inside = false;
      dirty = true;
    }
  }

  if (dirty) await storeTasks(tasks);
}

/* ════════════════════════════════════════════
   SHOW NOTIFICATION
════════════════════════════════════════════ */
async function showNotification(title, body, taskId) {
  const opts = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    tag: 'geotask-' + (taskId || Date.now()),
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 400],
    data: { taskId },
    actions: [
      { action: 'open', title: '📋 View Task' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  return self.registration.showNotification(title, opts);
}

/* ════════════════════════════════════════════
   STORAGE HELPERS (IndexedDB-like via Cache API)
════════════════════════════════════════════ */
async function storeTasks(tasks) {
  try {
    const cache = await caches.open(SW_VERSION);
    const res = new Response(JSON.stringify(tasks), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put('/sw-tasks', res);
  } catch (e) {}
}

async function getTasks() {
  try {
    const cache = await caches.open(SW_VERSION);
    const res = await cache.match('/sw-tasks');
    if (res) return await res.json();
  } catch (e) {}
  return [];
}

async function storeLastPos(lat, lng) {
  try {
    const cache = await caches.open(SW_VERSION);
    const res = new Response(JSON.stringify({ lat, lng, t: Date.now() }), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put('/sw-lastpos', res);
  } catch (e) {}
}

async function getLastPos() {
  try {
    const cache = await caches.open(SW_VERSION);
    const res = await cache.match('/sw-lastpos');
    if (res) return await res.json();
  } catch (e) {}
  return null;
}

/* ════════════════════════════════════════════
   HAVERSINE
════════════════════════════════════════════ */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
