/* Service worker: hosts the Scramjet service-worker engine and routes proxied fetches. */
importScripts("/scramjet.all.js");

const { ScramjetServiceWorker } = self.$scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) {
    event.respondWith(scramjet.fetch(event));
  }
}

self.addEventListener("fetch", (event) => {
  event.waitUntil(handleRequest(event));
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
