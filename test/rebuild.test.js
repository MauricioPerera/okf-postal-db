// Tests de POST /rebuild: reconstruye el bundle OKF desde la bitácora tras perder los records.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

const DIR = join("test", "tmp-rebuild");
const IDENTITY = join(DIR, "agent.json");
const RECORDS = join(DIR, "bundle", "records");
let app;
let created = [];

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  app = await buildServer({ dir: DIR, identityPath: IDENTITY });

  for (let i = 0; i < 2; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/collections/notes/records",
      payload: { title: `Nota ${i}`, body: `cuerpo ${i}` },
    });
    assert.equal(r.statusCode, 201, `create falló: ${r.body}`);
    created.push(r.json());
  }
});

after(async () => {
  if (app) await app.close();
  await rm(DIR, { recursive: true, force: true });
});

test("POST /rebuild regenera los records perdidos y reporta el nº de eventos", async () => {
  // Simula bundle perdido: borra a mano la carpeta de records.
  await rm(RECORDS, { recursive: true, force: true });

  const r = await app.inject({ method: "POST", url: "/rebuild" });
  assert.equal(r.statusCode, 200, `rebuild falló: ${r.body}`);
  const body = r.json();
  assert.equal(body.ok, true);
  assert.equal(body.events, created.length, "events debe igualar los creates de la bitácora");

  // El record se regeneró en disco: el GET vuelve a responder 200.
  const g = await app.inject({
    method: "GET",
    url: `/collections/notes/records/${created[0].id}`,
  });
  assert.equal(g.statusCode, 200, `read tras rebuild falló: ${g.body}`);
  assert.equal(g.json().title, "Nota 0");
});