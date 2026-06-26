// Tests de la colección contacts: create válido, read correcto y rechazo por falta de name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity } from "../src/identity.js";
import { createStore } from "../src/store.js";

const DIR = join("test", "tmp-contacts");
let identity, store;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  identity = await createIdentity("test-agent");
  store = createStore({ dir: DIR, identity });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("contacts: crea contacto válido y se lee correctamente", async () => {
  const created = await store.create("contacts", { name: "Ada", email: "ada@example.com" });
  assert.ok(created.id);
  assert.equal(created.name, "Ada");
  assert.equal(created.type, "contact");

  const read = await store.read("contacts", created.id);
  assert.equal(read.name, "Ada");
  assert.equal(read.type, "contact");
});

test("contacts: crear sin name se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("contacts", { email: "sin-nombre@example.com" }), // falta required name
    (err) => err.status === 400,
  );
});