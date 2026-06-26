// Tests de colecciones de ejemplo (medicina y abogacía): create válido, read con type correcto y rechazo 400 por falta de required.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity } from "../src/identity.js";
import { createStore } from "../src/store.js";

const DIR = join("test", "tmp-domain-schemas");
let store;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const identity = await createIdentity("test-agent");
  store = createStore({ dir: DIR, identity });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("patient: crea válido mínimo y se lee con type correcto", async () => {
  const created = await store.create("patient", { name: "Ada" });
  assert.ok(created.id);
  assert.equal(created.name, "Ada");
  assert.equal(created.type, "patient");

  const read = await store.read("patient", created.id);
  assert.equal(read.name, "Ada");
  assert.equal(read.type, "patient");
});

test("patient: crear sin name se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("patient", { birth_date: "2000-01-01" }), // falta required name
    (err) => err.status === 400,
  );
});

test("prescription: crea válido mínimo y se lee con type correcto", async () => {
  const created = await store.create("prescription", { patient: "Ada", medication: "X", dose: "5mg" });
  assert.ok(created.id);
  assert.equal(created.patient, "Ada");
  assert.equal(created.type, "prescription");

  const read = await store.read("prescription", created.id);
  assert.equal(read.patient, "Ada");
  assert.equal(read.type, "prescription");
});

test("prescription: crear sin medication se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("prescription", { patient: "Ada", dose: "5mg" }), // falta required medication
    (err) => err.status === 400,
  );
});

test("legal_case: crea válido mínimo y se lee con type correcto", async () => {
  const created = await store.create("legal_case", { title: "C1", client: "Acme" });
  assert.ok(created.id);
  assert.equal(created.title, "C1");
  assert.equal(created.type, "legal_case");

  const read = await store.read("legal_case", created.id);
  assert.equal(read.title, "C1");
  assert.equal(read.type, "legal_case");
});

test("legal_case: crear sin client se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("legal_case", { title: "C1" }), // falta required client
    (err) => err.status === 400,
  );
});

test("contract: crea válido mínimo y se lee con type correcto", async () => {
  const created = await store.create("contract", { title: "NDA", parties: ["A", "B"] });
  assert.ok(created.id);
  assert.equal(created.title, "NDA");
  assert.equal(created.type, "contract");

  const read = await store.read("contract", created.id);
  assert.equal(read.title, "NDA");
  assert.equal(read.type, "contract");
});

test("contract: crear sin parties se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("contract", { title: "NDA" }), // falta required parties
    (err) => err.status === 400,
  );
});