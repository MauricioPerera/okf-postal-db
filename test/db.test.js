// Tests de integración: gate (firma/append-only) y CRUD end-to-end con proyección OKF.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity } from "../src/identity.js";
import { buildEvent, KIND_CREATE } from "../src/events.js";
import { verifyEvent } from "../src/gate.js";
import { createStore } from "../src/store.js";

const DIR = join("test", "tmp-data");
let identity, pubKeys, store;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  identity = await createIdentity("test-agent");
  pubKeys = { [identity.id]: identity.sign.publicKey };
  store = createStore({ dir: DIR, identity });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("gate acepta evento firmado y rechaza uno manipulado", async () => {
  const ev = await buildEvent(identity, {
    kind: KIND_CREATE, chat_id: "notes", body: { record_id: "abc", data: { type: "note", title: "x" } }, seq: 0, prev: null,
  });
  assert.equal((await verifyEvent(ev, pubKeys)).ok, true);

  const tampered = { ...ev, body: { ...ev.body, data: { type: "note", title: "HACKED" } } };
  const r = await verifyEvent(tampered, pubKeys);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
});

test("CRUD completo: create -> read -> update -> delete + OKF + verify", async () => {
  // CREATE
  const created = await store.create("notes", { title: "Hola", body: "# Hola\nmundo", tags: ["demo"] });
  assert.ok(created.id);
  assert.equal(created.title, "Hola");
  assert.equal(created.type, "note");

  // archivo OKF en disco con frontmatter + cuerpo
  const md = await readFile(join(DIR, "bundle", "records", "notes", `${created.id}.md`), "utf8");
  assert.match(md, /title: Hola/);
  assert.match(md, /# Hola/);

  // READ
  const read = await store.read("notes", created.id);
  assert.equal(read.title, "Hola");

  // UPDATE (merge): cambia título, conserva body
  const updated = await store.update("notes", created.id, { title: "Hola2" }, { merge: true });
  assert.equal(updated.title, "Hola2");
  assert.match(updated.body, /mundo/);
  assert.equal(updated.created_at, created.created_at); // conserva created_at

  // LIST: 1 visible
  assert.equal((await store.list("notes")).length, 1);

  // DELETE (soft): desaparece de list, archivo marcado deleted
  await store.remove("notes", created.id);
  assert.equal((await store.list("notes")).length, 0);
  assert.equal((await store.list("notes", { includeDeleted: true })).length, 1);
  const afterDel = await store.read("notes", created.id);
  assert.equal(afterDel.deleted, true);

  // VERIFY: la bitácora (create+update+delete) es válida y encadenada
  const v = await store.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
});

test("validación de schema: payload inválido es rechazado (400)", async () => {
  await assert.rejects(
    () => store.create("notes", { description: "sin título" }), // falta required title
    (err) => err.status === 400,
  );
});

test("colección desconocida es rechazada (404)", async () => {
  await assert.rejects(
    () => store.create("inexistente", { title: "x" }),
    (err) => err.status === 404,
  );
});
