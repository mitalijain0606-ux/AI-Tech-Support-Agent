// Bug 7's "stale" worker: registered once, claims the page and stays resident.
// It does nothing else — the staleness is simulated by the app treating its
// presence as "an old deploy is still being served" (see src/main.js).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
