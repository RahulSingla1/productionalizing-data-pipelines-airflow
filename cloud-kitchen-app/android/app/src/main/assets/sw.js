// Lets the web version open with no internet. Fresh files are used when online; the saved copy when not.
var CACHE = "kitchen-book";
var FILES = ["./", "index.html", "menu.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
  "fonts/mukta-latin-400-normal.woff2", "fonts/mukta-latin-600-normal.woff2", "fonts/mukta-latin-700-normal.woff2", "fonts/mukta-latin-800-normal.woff2"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;   // order sharing goes straight to the network
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match("index.html"); });
  }));
});
