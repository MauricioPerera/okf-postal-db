// Rotación de clave: un autor rota su clave; los eventos viejos verifican con la clave
// de su época y los nuevos con la vigente. El id del autor no cambia al rotar.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity } from "../src/identity.js";
import { createStore } from "../src/store.js";

const DIR = join("test", "tmp-rotation");
let store;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const identity = await createIdentity("rot");
  store = createStore({ dir: DIR, identity });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("rotación: evento1 verifica con clave0 y evento2 con clave1 (id intacto)", async () => {
  const before = store.identity.id;
  await store.create("notes", { title: "nota A", body: "A" }); // evento1, firmado con clave0
  await store.rotate(); // nueva clave vigente, from = ahora
  await store.create("notes", { title: "nota B", body: "B" }); // evento2, firmado con clave1
  assert.equal(store.identity.id, before, "el id del autor NO cambia al rotar");

  const v = await store.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 2);
});

test("rotación: manipular un evento de la bitácora rompe la firma", async () => {
  const evdir = join(DIR, ".postal", "events");
  const files = (await readdir(evdir)).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 2);

  const path = join(evdir, files[0]);
  const ev = JSON.parse(await readFile(path, "utf8"));
  ev.body.data.title = "TAMPERED";
  await writeFile(path, JSON.stringify(ev, null, 2));

  const r = await store.verify();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
});