// Tests del servidor MCP: usan callTool + buildMemoryStore con dir temporal (sin stdio).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { callTool, buildMemoryStore } from "../src/mcp.js";

const DIR = join("test", "tmp-mcp");
const IDENTITY = join(DIR, "agent.json");
let store;

// Extrae el payload de la respuesta MCP ({ content:[{type:"text",text:JSON}] }).
const parse = (res) => JSON.parse(res.content[0].text);

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  store = await buildMemoryStore({ dir: DIR, identityPath: IDENTITY });
});

after(async () => { await rm(DIR, { recursive: true, force: true }); });

test("memory_create + memory_read + memory_list + memory_search + memory_verify + memory_collections", async () => {
  // create
  const created = parse(await callTool(store, "memory_create", {
    collection: "notes", payload: { title: "Memo", body: "contenido x", tags: ["t1"] },
  }));
  assert.ok(created.id);
  assert.equal(created.title, "Memo");
  const id = created.id;

  // read
  const read = parse(await callTool(store, "memory_read", { collection: "notes", id }));
  assert.equal(read.title, "Memo");

  // list
  const list = parse(await callTool(store, "memory_list", { collection: "notes" }));
  assert.ok(list.some((r) => r.id === id));

  // search encuentra y vacía
  const hit = parse(await callTool(store, "memory_search", { collection: "notes", q: "contenido" }));
  assert.ok(hit.some((r) => r.id === id));
  const miss = parse(await callTool(store, "memory_search", { collection: "notes", q: "zzz" }));
  assert.equal(miss.length, 0);

  // verify
  const v = parse(await callTool(store, "memory_verify", {}));
  assert.equal(v.ok, true);

  // collections incluye notes
  const cols = parse(await callTool(store, "memory_collections", {}));
  assert.ok(cols.some((c) => c.name === "notes"));
});

test("memory_read de id inexistente -> isError", async () => {
  const res = await callTool(store, "memory_read", { collection: "notes", id: "no-existe" });
  assert.equal(res.isError, true);
});

test("memory_create con payload inválido -> isError (400)", async () => {
  const res = await callTool(store, "memory_create", {
    collection: "notes", payload: { description: "sin título" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /payload inválido/);
});

test("callTool con tool desconocida -> throw", async () => {
  await assert.rejects(() => callTool(store, "no_existe", {}), /tool desconocida/);
});