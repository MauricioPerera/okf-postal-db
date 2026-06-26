// Tests de los archivos especiales OKF: index.md y log.md tras operaciones del store.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity } from "../src/identity.js";
import { createStore } from "../src/store.js";

const DIR = join("test", "tmp-special");
let identity, store;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  identity = await createIdentity("test-agent");
  store = createStore({ dir: DIR, identity });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("create regenera index.md (lista el title) y log.md (fecha + record.create)", async () => {
  const created = await store.create("notes", {
    title: "Nota Índice", description: "resumen", body: "# Hola",
  });

  const index = await readFile(join(DIR, "bundle", "index.md"), "utf8");
  assert.match(index, /type: index/);
  assert.match(index, /## notes/);
  assert.match(index, /Nota Índice/);
  assert.match(index, new RegExp(`records/notes/${created.id}\\.md`));

  const log = await readFile(join(DIR, "bundle", "log.md"), "utf8");
  assert.match(log, /type: log/);
  const date = created.created_at.slice(0, 10);
  assert.match(log, new RegExp(`## ${date}`));
  assert.match(log, /record\.create/);
  assert.match(log, new RegExp(created.id));
});

test("index omite registros borrados (soft-delete)", async () => {
  const a = await store.create("notes", { title: "Visible", body: "x" });
  const b = await store.create("notes", { title: "Efímera", body: "x" });
  await store.remove("notes", b.id);

  const index = await readFile(join(DIR, "bundle", "index.md"), "utf8");
  assert.match(index, /Visible/);
  assert.doesNotMatch(index, /Efímera/);
  assert.match(index, new RegExp(`records/notes/${a.id}\\.md`));
});

test("log agrupa eventos por fecha y lista update/delete", async () => {
  const r = await store.create("notes", { title: "Ciclo", body: "x" });
  await store.update("notes", r.id, { title: "Ciclo2" }, { merge: true });
  await store.remove("notes", r.id);

  const log = await readFile(join(DIR, "bundle", "log.md"), "utf8");
  assert.match(log, /record\.create/);
  assert.match(log, /record\.update/);
  assert.match(log, /record\.delete/);
  // las tres entradas referencian el mismo record_id
  const matches = log.match(new RegExp(r.id, "g")) || [];
  assert.ok(matches.length >= 3);
});