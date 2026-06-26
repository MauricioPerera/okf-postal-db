// Tests de colecciones de ejemplo (compra-venta): create válido, read con type correcto y rechazo 400 por falta de required / minItems.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity } from "../src/identity.js";
import { createStore } from "../src/store.js";

const DIR = join("test", "tmp-commerce");
let store;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const identity = await createIdentity("test-agent");
  store = createStore({ dir: DIR, identity });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("product: crea válido y se lee con type correcto", async () => {
  const created = await store.create("product", { name: "Teclado", sku: "KB1", price: 50, stock: 10 });
  assert.ok(created.id);
  assert.equal(created.name, "Teclado");
  assert.equal(created.type, "product");

  const read = await store.read("product", created.id);
  assert.equal(read.name, "Teclado");
  assert.equal(read.type, "product");
});

test("product: crear sin name se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("product", { sku: "KB1", price: 50 }), // falta required name
    (err) => err.status === 400,
  );
});

test("order: crea válido y se lee con type correcto", async () => {
  const created = await store.create("order", { customer: "Ada", items: [{ sku: "KB1", qty: 2 }] });
  assert.ok(created.id);
  assert.equal(created.customer, "Ada");
  assert.equal(created.type, "order");

  const read = await store.read("order", created.id);
  assert.equal(read.customer, "Ada");
  assert.equal(read.type, "order");
});

test("order: crear sin items se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("order", { customer: "Ada" }), // falta required items
    (err) => err.status === 400,
  );
});

test("order: crear con items vacíos se rechaza con 400 (minItems 1)", async () => {
  await assert.rejects(
    () => store.create("order", { customer: "Ada", items: [] }),
    (err) => err.status === 400,
  );
});

test("payment: crea válido y se lee con type correcto", async () => {
  const created = await store.create("payment", { order: "ord1", amount: 100 });
  assert.ok(created.id);
  assert.equal(created.order, "ord1");
  assert.equal(created.type, "payment");

  const read = await store.read("payment", created.id);
  assert.equal(read.order, "ord1");
  assert.equal(read.type, "payment");
});

test("payment: crear sin amount se rechaza con 400", async () => {
  await assert.rejects(
    () => store.create("payment", { order: "ord1" }), // falta required amount
    (err) => err.status === 400,
  );
});