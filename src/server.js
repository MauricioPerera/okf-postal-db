// REST API (Fastify) sobre la DB OKF + bitácora postal.
// Un agente consume estos endpoints para CRUD. Las escrituras quedan firmadas y
// auditables en la bitácora; las lecturas salen del estado materializado OKF.

import Fastify from "fastify";
import { loadOrCreateIdentity, publicIdentity } from "./identity.js";
import { createStore } from "./store.js";
import { listCollections } from "./config.js";

const DATA_DIR = process.env.DATA_DIR || "data";
const PORT = Number(process.env.PORT || 3000);

// Traduce errores de dominio (con .status/.errors/.gate) a respuestas HTTP.
function fail(reply, err) {
  const status = err.status || 500;
  return reply.code(status).send({
    error: err.message,
    ...(err.errors ? { details: err.errors } : {}),
    ...(err.gate ? { gate: err.gate } : {}),
  });
}

// Envuelve un handler de escritura: ejecuta y, si el store lanza, traduce a HTTP.
const writeHandler = (fn) => async (req, reply) => {
  try {
    return await fn(req, reply);
  } catch (err) {
    return fail(reply, err);
  }
};

// Hook onRequest: autenticación opt-in por API key (header x-api-key).
// - Si process.env.API_KEY no está definida o es "" -> passthrough (no se exige auth).
// - Si está definida -> exige header x-api-key === API_KEY, salvo en GET /health (exento).
// La clave se lee EN runtime (cada request) para que los tests puedan setearla.
async function apiKeyGuard(req, reply) {
  const path = req.url.split("?")[0];
  if (path === "/health") return;
  const expected = process.env.API_KEY;
  if (!expected) return;
  if (req.headers["x-api-key"] === expected) return;
  return reply.code(401).send({ error: "unauthorized" });
}

// Handler POST /rebuild: reconstruye el bundle OKF desde la bitácora y reporta el
// nº de eventos. Aislado de registerRoutes para no sumar complejidad al registro.
async function rebuildHandler(store) {
  await store.rebuild();
  return { ok: true, events: (await store.log()).length };
}

// Handler POST /rotate: rota la clave de firma del agente y devuelve la identidad
// pública (con el historial de claves actualizado). Aislado igual que rebuildHandler.
async function rotateHandler(store) {
  const identity = await store.rotate();
  return { ok: true, identity };
}

// Rutas CRUD de /collections/:col/records (create/list/read/update/patch/delete).
function registerRecordRoutes(app, store) {
  // CREATE
  app.post("/collections/:col/records", writeHandler(async (req, reply) =>
    reply.code(201).send(await store.create(req.params.col, req.body || {}))));

  // LIST (?tag=&type=&q=&includeDeleted=&limit=&offset=)
  app.get("/collections/:col/records", async (req) => {
    const { tag, type, q, includeDeleted, limit, offset } = req.query;
    const all = await store.list(req.params.col, { tag, type, q, includeDeleted: includeDeleted === "true" });
    const total = all.length;
    const off = Math.max(0, parseInt(offset) || 0);
    const lim = limit != null && limit !== "" ? Math.max(0, parseInt(limit) || 0) : total;
    const page = all.slice(off, off + lim);
    return { records: page, total, limit: lim, offset: off };
  });

  // READ
  app.get("/collections/:col/records/:id", async (req, reply) => {
    const rec = await store.read(req.params.col, req.params.id);
    if (!rec || rec.deleted) return reply.code(404).send({ error: "no encontrado" });
    return rec;
  });

  // UPDATE (reemplazo)
  app.put("/collections/:col/records/:id", writeHandler(async (req) =>
    store.update(req.params.col, req.params.id, req.body || {}, { merge: false })));

  // UPDATE parcial (merge)
  app.patch("/collections/:col/records/:id", writeHandler(async (req) =>
    store.update(req.params.col, req.params.id, req.body || {}, { merge: true })));

  // DELETE
  app.delete("/collections/:col/records/:id", writeHandler(async (req) =>
    store.remove(req.params.col, req.params.id)));
}

// Rutas de metadata/auditoría: /health, /collections, /log, /verify.
function registerMetaRoutes(app, store, identity) {
  app.get("/health", async () => ({ ok: true, agent: publicIdentity(identity) }));
  app.get("/collections", async () => ({ collections: await listCollections() }));
  app.get("/log", async () => ({ events: await store.log() }));
  app.get("/verify", async (req, reply) => {
    const r = await store.verify();
    return reply.code(r.ok ? 200 : 409).send(r);
  });
}

// Rutas de administración: /rebuild, /rotate.
function registerAdminRoutes(app, store) {
  app.post("/rebuild", writeHandler(rebuildHandler.bind(null, store)));
  app.post("/rotate", writeHandler(rotateHandler.bind(null, store)));
}

// Registra las rutas REST sobre `app`. Sólo delega en sub-funciones por grupo para
// mantener la ciclomática del registro por debajo del umbral del gate.
function registerRoutes(app, store, identity) {
  registerRecordRoutes(app, store);
  registerMetaRoutes(app, store, identity);
  registerAdminRoutes(app, store);
}

// Construye la app Fastify lista para escuchar. Glue puro: identidad + store + rutas.
export async function buildServer({ dir = DATA_DIR, identityPath } = {}) {
  const app = Fastify({ logger: true });
  const idPath = identityPath || "identities/agent.json";
  const identity = await loadOrCreateIdentity(idPath);
  const store = createStore({ dir, identity, identityPath: idPath });
  app.addHook("onRequest", apiKeyGuard);
  registerRoutes(app, store, identity);
  return app;
}

// Arranque directo: `node src/server.js`.
if (process.argv[1]?.endsWith("server.js")) {
  const app = await buildServer();
  app.listen({ port: PORT, host: "0.0.0.0" })
    .catch((err) => { app.log.error(err); process.exit(1); });
}