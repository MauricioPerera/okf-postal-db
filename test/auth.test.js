// Tests de autenticación opt-in por API key (header x-api-key).
// node:test corre cada archivo en su propio proceso: setear process.env.API_KEY
// aquí no afecta a otros tests. /health queda exento; el resto exige el header.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

const DIR = join("test", "tmp-auth");
const IDENTITY = join(DIR, "agent.json");
let app;

before(async () => {
  process.env.API_KEY = "secreto";
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  app = await buildServer({ dir: DIR, identityPath: IDENTITY });
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await rm(DIR, { recursive: true, force: true });
  delete process.env.API_KEY;
});

test("GET /health SIN header -> 200 (exento de auth)", async () => {
  const r = await app.inject({ method: "GET", url: "/health" });
  assert.equal(r.statusCode, 200);
});

test("GET /collections SIN header -> 401", async () => {
  const r = await app.inject({ method: "GET", url: "/collections" });
  assert.equal(r.statusCode, 401);
  assert.deepEqual(r.json(), { error: "unauthorized" });
});

test("GET /collections CON header x-api-key:'secreto' -> 200", async () => {
  const r = await app.inject({
    method: "GET",
    url: "/collections",
    headers: { "x-api-key": "secreto" },
  });
  assert.equal(r.statusCode, 200);
});

test("GET /collections CON header x-api-key:'malo' -> 401", async () => {
  const r = await app.inject({
    method: "GET",
    url: "/collections",
    headers: { "x-api-key": "malo" },
  });
  assert.equal(r.statusCode, 401);
  assert.deepEqual(r.json(), { error: "unauthorized" });
});