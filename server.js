import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { createRequire } from "module";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const app = fastify({ logger: false });

const scramjetDist = path.join(import.meta.dirname ?? ".", "node_modules/@mercuryworkshop/scramjet/dist");
const bareMuxDist = path.join(import.meta.dirname ?? ".", "node_modules/@mercuryworkshop/bare-mux/dist");

// Static UI (index.html, chrome.css, app.js, sw.js)
app.register(fastifyStatic, { root: path.join(import.meta.dirname ?? ".", "") });

// Serve CORS so assets can load under any proxied origin context
function withCors(reply) {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET, HEAD, OPTIONS");
  reply.header("access-control-allow-headers", "*");
}

app.options("/scramjet*", (req, reply) => { withCors(reply); return reply.send(); });
app.options("/baremux/*", (req, reply) => { withCors(reply); return reply.send(); });

// Scramjet engine files (also under /scramjet/ so the SW's relative asset paths resolve)
for (const name of ["scramjet.bundle.js", "scramjet.all.js", "scramjet.sync.js"]) {
  const send = (req, reply) => {
    withCors(reply);
    return reply.type("application/javascript").send(fs.createReadStream(path.join(scramjetDist, name)));
  };
  app.get("/" + name, send);
  app.get("/scramjet/" + name, send);
}
for (const [name, type] of [["scramjet.wasm.wasm", "application/wasm"]]) {
  const send = (req, reply) => {
    withCors(reply);
    return reply.type(type).send(fs.createReadStream(path.join(scramjetDist, name)));
  };
  app.get("/" + name, send);
  app.get("/scramjet/" + name, send);
}

// Bare-mux shared worker + client script
app.get("/baremux/worker.js", (req, reply) => {
  withCors(reply);
  return reply.type("application/javascript").send(fs.createReadStream(path.join(bareMuxDist, "worker.js")));
});
app.get("/baremux/index.js", (req, reply) => {
  withCors(reply);
  return reply.type("application/javascript").send(fs.createReadStream(path.join(bareMuxDist, "index.js")));
});

const PORT = process.env.PORT || 8080;
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`Scramjet Chrome-style proxy running at http://localhost:${PORT}`);
});
