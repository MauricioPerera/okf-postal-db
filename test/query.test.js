// Tests de búsqueda de texto (q) y paginación (limit/offset) en GET /collections/:col/records.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

const DIR = join("test", "tmp-query");
const IDENTITY = join(DIR, "agent.json");
let app;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  app = await buildServer({ dir: DIR, identityPath: IDENTITY });

  // 3 notes con títulos/tags distintos para ejercitar q y paginación.
  const notes = [
    { title: "Aprender Fastify", description: "Notas sobre el servidor", body: "Fastify es rapido", tags: ["dev"] },
    { title: "Receta de pan", description: "Amasado lento", body: "Harina y agua", tags: ["cocina"] },
    { title: "Fastify vs Express", description: "Comparativa", body: "Rendimiento", tags: ["dev"] },
  ];
  for (const n of notes) {
    const r = await app.inject({ method: "POST", url: "/collections/notes/records", payload: n });
    assert.equal(r.statusCode, 201, `create falló: ${r.body}`);
  }
});

after(async () => {
  if (app) await app.close();
  await rm(DIR, { recursive: true, force: true });
});

test("q filtra por texto en title/description/body (case-insensitive)", async () => {
  const r = await app.inject({ method: "GET", url: "/collections/notes/records?q=fastify" });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.total, 2, `total esperado 2, fue ${body.total}`);
  assert.equal(body.records.length, 2);
  for (const rec of body.records) assert.match(`${rec.title} ${rec.description} ${rec.body}`, /fastify/i);
});

test("q sin coincidencias -> total 0 y records vacíos", async () => {
  const r = await app.inject({ method: "GET", url: "/collections/notes/records?q=zzznope" });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.total, 0);
  assert.equal(body.records.length, 0);
});

test("paginación limit=1&offset=1 sobre el total de 3", async () => {
  const r = await app.inject({ method: "GET", url: "/collections/notes/records?limit=1&offset=1" });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.total, 3, "total refleja el conjunto completo sin paginar");
  assert.equal(body.records.length, 1);
  assert.equal(body.limit, 1);
  assert.equal(body.offset, 1);
});

test("sin limit/offset devuelve todos y metadata coherente", async () => {
  const r = await app.inject({ method: "GET", url: "/collections/notes/records" });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.total, 3);
  assert.equal(body.records.length, 3);
  assert.equal(body.offset, 0);
  assert.equal(body.limit, body.total);
});