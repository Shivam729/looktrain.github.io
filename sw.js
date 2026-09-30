// Network-first cache so the site still opens with no signal (e.g. in tunnels or the depot).
// Always tries the live site first, so timetable updates show up as soon as you're online.
// Timetable files are cached in their encrypted form.
const CACHE = 'looktrain-v3';
const PAGES = ['./', 'index.html', 'app.js', 'classic.html', 'data/meta.json', 'favicon.svg', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PAGES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
