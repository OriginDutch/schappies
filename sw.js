// Service worker: bewaart de app-bestanden zodat hij snel en installeerbaar is.
// Het versienummer komt uit js/version.js. Ophogen = nieuwe cache = update-balk in de app.
importScripts('js/version.js');

const CACHE = `boodschappen-${self.APP_VERSION}`;
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/version.js',
  'js/app.js',
  'js/firebase.js',
  'js/data.js',
  'js/theme.js',
  'js/parse.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  // Geen skipWaiting hier: de gebruiker kiest zelf wanneer hij vernieuwt.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('boodschappen-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Firebase, fonts en andere domeinen: niet aankomen.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((res) => res || fetch(req)));
    return;
  }

  event.respondWith(caches.match(req, { ignoreSearch: true }).then((res) => res || fetch(req)));
});
