const C = 'dh-v2';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.mode !== 'navigate') return;
  e.respondWith(
    fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(C).then(x => x.put('/', c)); } return res; })
      .catch(() => caches.match('/').then(m => m || new Response('آفلاین هستی. اینترنت را وصل کن.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});
