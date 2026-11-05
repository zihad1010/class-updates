const CACHE = "bup-ice-v5";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/logo-white.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Only the public bootstrap data is kept as an offline fallback. All other API calls (login, publish, edit, delete) always go to the network.
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname !== "/api/bootstrap") return;
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Pages and files: try the network first so new deploys show up, fall back to the cache when offline.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : undefined)))
  );
});

// ---------- Push notifications ----------
self.addEventListener("push", (event) => {
  let data = { title: "My CR", body: "New update from your CR", url: "/" };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    open.forEach((c) => c.postMessage({ type: "refresh" }));
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: "mycr-" + Date.now(),
      vibrate: [200, 100, 200],
      data: { url: data.url },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  const hash = target.includes("#") ? target.split("#")[1] : "";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.postMessage({ type: "open", hash }); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});
