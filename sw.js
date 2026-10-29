const CACHE_NAME = "mellowoku-pwa-v6";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./assets/mellowoku_logo.png",
  "./assets/apple-touch-icon.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  ...Array.from({ length: 9 }, (_, index) => `./assets/cat_symbol_${index + 1}.png`),
  "./assets/cat_light_awake.png",
  "./assets/cat_light_sleeping.png",
  "./assets/cat_gray_awake.png",
  "./assets/cat_gray_sleeping.png",
  "./assets/music_menu.mp3",
  "./assets/music_gameplay.mp3",
  "./assets/ui_button.mp3",
  "./assets/ui_cell_select.mp3",
  "./assets/ui_number_input.mp3",
  "./assets/ui_success.mp3",
  "./assets/cat_purr.mp3",
  "./assets/cat_meow.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === "navigate") return caches.match("./index.html");
        throw new Error("Offline resource is not available in the app cache.");
      });
    })
  );
});
