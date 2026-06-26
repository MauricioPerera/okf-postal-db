// POST /rotate: rota la clave del agente vía HTTP, persiste la identidad a disco y
// los eventos viejos+nuevos siguen verificando. Usa un tmpdir propio (con identityPath
// temporal) para NO tocar el identities/agent.json real del repo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

const DIR = join("test", "tmp-rotate-endpoint");
const IDENTITY = join(DIR, "agent.json");
let app;

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  app = await buildServer({ dir: DIR, identityPath: IDENTITY });
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await rm(DIR, { recursive: true, force: true });
});

test("POST /rotate: rota, persiste 2 claves y ambos eventos verifican (id estable)", async () => {
  // 1) evento firmado con la clave original
  const c1 = await app.inject({
    method: "POST",
    url: "/collections/notes/records",
    payload: { title: "a" },
  });
  assert.equal(c1.statusCode, 201, `create 1 falló: ${c1.body}`);

  // id del autor ANTES de rotar (lo sacamos de /health)
  const h0 = await app.inject({ method: "GET", url: "/health" });
  const idBefore = h0.json().agent.id;

  // 2) rotación HTTP
  const rot = await app.inject({ method: "POST", url: "/rotate" });
  assert.equal(rot.statusCode, 200, `rotate falló: ${rot.body}`);
  const rotBody = rot.json();
  assert.equal(rotBody.ok, true);
  assert.equal(rotBody.identity.keys.length, 2, "debe tener 2 claves tras una rotación");
  const idAfter = rotBody.identity.id;
  assert.equal(idAfter, idBefore, "el id del autor NO cambia al rotar");

  // 3) evento firmado con la clave nueva
  const c2 = await app.inject({
    method: "POST",
    url: "/collections/notes/records",
    payload: { title: "b" },
  });
  assert.equal(c2.statusCode, 201, `create 2 falló: ${c2.body}`);

  // 4) ambos eventos verifican (clave vieja y nueva)
  const v = await app.inject({ method: "GET", url: "/verify" });
  assert.equal(v.statusCode, 200, `verify falló: ${v.body}`);
  const vBody = v.json();
  assert.equal(vBody.ok, true, "la bitácora debe verificar tras la rotación");
  assert.equal(vBody.count, 2, "deben verificar los 2 eventos");

  // 5) la identidad persistida en disco tiene 2 claves
  const onDisk = JSON.parse(await readFile(IDENTITY, "utf8"));
  assert.equal(onDisk.id, idBefore, "el id en disco coincide");
  assert.equal(onDisk.keys.length, 2, "el archivo agent.json en disco tiene 2 claves");
});