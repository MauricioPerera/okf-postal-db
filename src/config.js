// Registro de colecciones y sus JSON Schemas (esquema de datos CONFIGURABLE).
// Cada archivo schema/collections/<col>.schema.json define la forma del payload que
// el agente envía para esa colección. Se valida con ajv en create/update.
//
// Extensiones opcionales en el schema (claves `x-*`, ignoradas por ajv):
//   x-okf-type   : valor del campo OKF `type` para los registros (default: nombre de la colección)
//   x-hard-delete: true para borrado físico en vez de soft-delete (default: false)

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dir = dirname(fileURLToPath(import.meta.url));
const COLLECTIONS_DIR = join(__dir, "..", "schema", "collections");

let _collections = null;

// Carga y cachea (a nivel módulo) las colecciones desde schema/collections.
// Devuelve un Map(name -> { name, schema, validate, okfType, hardDelete }).
export async function loadCollections() {
  if (_collections) return _collections;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  addFormats(ajv);
  const map = new Map();
  if (existsSync(COLLECTIONS_DIR)) {
    const files = (await readdir(COLLECTIONS_DIR)).filter((f) => f.endsWith(".schema.json"));
    for (const f of files) {
      const name = f.replace(/\.schema\.json$/, "");
      const schema = JSON.parse(await readFile(join(COLLECTIONS_DIR, f), "utf8"));
      map.set(name, {
        name,
        schema,
        validate: ajv.compile(schema),
        okfType: schema["x-okf-type"] || name,
        hardDelete: schema["x-hard-delete"] === true,
      });
    }
  }
  _collections = map;
  return map;
}

// Devuelve la colección `name` o null si no existe.
export async function getCollection(name) {
  return (await loadCollections()).get(name) || null;
}

// Lista las colecciones como [{ name, okfType, hardDelete, schema }].
export async function listCollections() {
  return [...(await loadCollections()).values()].map((c) => ({
    name: c.name, okfType: c.okfType, hardDelete: c.hardDelete, schema: c.schema,
  }));
}

// Valida un payload contra el schema de la colección. Devuelve { ok, errors }.
export async function validatePayload(name, payload) {
  const col = await getCollection(name);
  if (!col) return { ok: false, errors: [{ message: `colección desconocida: ${name}` }] };
  const ok = col.validate(payload);
  return { ok, errors: ok ? null : col.validate.errors };
}