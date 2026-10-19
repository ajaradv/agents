/**
 * Fleet service worker (D6): makes the dashboard installable as a phone app,
 * shows push notifications for Needs you, and keeps the page shell for when
 * the laptop is out of reach (the shell loads; live data needs the fleet).
 *
 * Network first for everything: the fleet is live, so a cached page is only a
 * fallback. API calls, the event stream, and sockets are never cached.
 */
const SHELL = "fleet-shell-v1";
const SHELL_FILES = ["/", "/pixel.css", "/md.js", "/live-voice.js", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/events") || req.headers.get("accept") === "text/event-stream") return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === "navigate" || SHELL_FILES.includes(url.pathname) || url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/fonts/"))) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req.mode === "navigate" ? "/" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === "navigate" ? "/" : req).then((hit) => hit || new Response("The fleet is out of reach.", { status: 503 }))),
  );
});

self.addEventListener("push", (e) => {
  let msg = { title: "Fleet", body: "Something needs you.", tag: "fleet", url: "/needs" };
  try {
    msg = { ...msg, ...e.data.json() };
  } catch {
    /* plain text or empty: keep the default */
  }
  e.waitUntil(self.registration.showNotification(msg.title, { body: msg.body, tag: msg.tag, renotify: true, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: msg.url } }));
});

// The browser rotated or expired the subscription: make a new one and tell the dashboard.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    fetch("/api/push/key")
      .then((r) => r.json())
      .then(({ publicKey }) => {
        const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (publicKey.length % 4)) % 4));
        return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      })
      .then((sub) => fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON(), label: "renewed" }) })),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/needs";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(url).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
