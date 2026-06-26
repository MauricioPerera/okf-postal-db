// store.js — orquestación CRUD. Une identidad, config (schemas), eventos, gate, projector y OKF.
//
// Flujo de escritura (create/update/delete):
//   validar payload (ajv) -> construir evento firmado con cadena (seq/prev)
//   -> gate (schema+firma) -> APPEND a la bitácora -> proyectar a archivo OKF
//
// Las escrituras se serializan con un mutex para que el contador `seq` por autor no
// sufra carreras dentro del proceso.

import { randomBytes } from "./crypto.js";
import {
  buildEvent, appendEvent, loadLog, nextChain,
  KIND_CREATE, KIND_UPDATE, KIND_DELETE,
} from "./events.js";
import { verifyEvent, verifyLog } from "./gate.js";
import { applyEvent, projectAll } from "./projector.js";
import { readRecord, listRecords, writeIndex, writeLog } from "./okf.js";
import { getCollection, listCollections, validatePayload } from "./config.js";
import { commitData } from "./gitlog.js";
import { rotateIdentity, publicIdentity, saveIdentity } from "./identity.js";

const newRecordId = () => Array.from(randomBytes(8)).map((b) => b.toString(16).padStart(2, "0")).join("");

// Deriva el mapa de pubKeys para el gate. Si la identidad tiene historial `keys`,
// expone un ARRAY de { from, publicKey } (resolución por tiempo); si no, la clave
// única en `sign` (string b64) — backward-compat con el gate histórico.
function buildPubKeys(idy) {
  const arr = Array.isArray(idy.keys)
    ? idy.keys.map((k) => ({ from: k.from, publicKey: k.publicKey }))
    : idy.sign.publicKey;
  return { [idy.id]: arr };
}

export function createStore({ dir, identity, identityPath }) {
  let id = identity;
  let pubKeys = buildPubKeys(id);
  let chain = Promise.resolve(); // mutex
  const lock = (fn) => (chain = chain.then(fn, fn)); // serializa, no rompe la cadena en error

  // Construye, verifica, persiste y proyecta un evento. Devuelve el evento.
  async function commit({ kind, collection, record_id, data, supersedes }) {
    const events = await loadLog(dir);
    const { seq, prev } = await nextChain(events, id.id);
    const ev = await buildEvent(id, {
      kind, chat_id: collection, body: { record_id, ...(data ? { data } : {}) },
      supersedes, seq, prev,
    });
    const v = await verifyEvent(ev, pubKeys);
    if (!v.ok) throw Object.assign(new Error(`gate rechazó el evento: ${v.reason}`), { gate: v });
    await appendEvent(dir, ev);
    const col = await getCollection(collection);
    await applyEvent(dir, ev, { hardDelete: col?.hardDelete });
    await rebuildSpecial();
    await commitData(dir, `${kind} ${collection}/${record_id}`);
    return ev;
  }

  // Regenera los archivos especiales OKF (index.md + log.md) desde estado y bitácora.
  async function rebuildSpecial() {
    const cols = await listCollections();
    const collections = [];
    for (const c of cols) {
      const records = (await listRecords(dir, c.name)).map((r) => ({
        id: r.id, title: r.title, description: r.description,
      }));
      collections.push({ name: c.name, records });
    }
    await writeIndex(dir, collections);
    await writeLog(dir, await loadLog(dir));
  }

  // id del último evento que tocó este registro (para encadenar supersedes).
  async function lastEventFor(collection, record_id) {
    const events = await loadLog(dir);
    const touching = events.filter((e) => e.chat_id === collection && e.body?.record_id === record_id);
    return touching.length ? touching[touching.length - 1].id : null;
  }

  return {
    get identity() { return id; },

    async create(collection, payload) {
      const col = await getCollection(collection);
      if (!col) throw Object.assign(new Error(`colección desconocida: ${collection}`), { status: 404 });
      const { ok, errors } = await validatePayload(collection, payload);
      if (!ok) throw Object.assign(new Error("payload inválido"), { status: 400, errors });
      return lock(async () => {
        const record_id = newRecordId();
        const data = { type: col.okfType, ...payload };
        await commit({ kind: KIND_CREATE, collection, record_id, data });
        return readRecord(dir, collection, record_id);
      });
    },

    async read(collection, id) {
      return readRecord(dir, collection, id);
    },

    async list(collection, filter) {
      return listRecords(dir, collection, filter);
    },

    // merge=true -> PATCH (combina con el estado actual); merge=false -> PUT (reemplazo).
    async update(collection, id, payload, { merge = false } = {}) {
      const col = await getCollection(collection);
      if (!col) throw Object.assign(new Error(`colección desconocida: ${collection}`), { status: 404 });
      const current = await readRecord(dir, collection, id);
      if (!current || current.deleted) throw Object.assign(new Error("no encontrado"), { status: 404 });

      // Reconstruye el payload "limpio" (sin metadatos de proyección) para validar/mergear.
      const { collection: _c, id: _i, created_at, updated_at, _event, deleted, deleted_at, ...currentData } = current;
      const base = merge ? currentData : { type: col.okfType };
      const next = { ...base, ...payload };
      const { ok, errors } = await validatePayload(collection, next);
      if (!ok) throw Object.assign(new Error("payload inválido"), { status: 400, errors });

      return lock(async () => {
        const supersedes = await lastEventFor(collection, id);
        await commit({ kind: KIND_UPDATE, collection, record_id: id, data: { type: col.okfType, ...next }, supersedes });
        return readRecord(dir, collection, id);
      });
    },

    async remove(collection, id) {
      const col = await getCollection(collection);
      if (!col) throw Object.assign(new Error(`colección desconocida: ${collection}`), { status: 404 });
      const current = await readRecord(dir, collection, id);
      if (!current || current.deleted) throw Object.assign(new Error("no encontrado"), { status: 404 });
      return lock(async () => {
        const supersedes = await lastEventFor(collection, id);
        await commit({ kind: KIND_DELETE, collection, record_id: id, supersedes });
        return { id, deleted: true };
      });
    },

    async log() {
      return loadLog(dir);
    },

    async verify() {
      return verifyLog(await loadLog(dir), pubKeys);
    },

    // Reconstruye el bundle OKF desde la bitácora (útil tras un clone).
    async rebuild() {
      await projectAll(dir, await loadLog(dir));
      await rebuildSpecial();
    },

    // Rota la clave de firma del autor: nueva clave vigente, id intacto.
    // Los eventos viejos siguen verificando con la clave de su época (resolución por tiempo).
    // Si se pasó `identityPath` al store, persiste la identidad rotada a disco; si no,
    // se comporta como antes (rotación sólo en memoria — backward-compat con tests).
    async rotate(created_at) {
      id = await rotateIdentity(id, created_at);
      pubKeys = buildPubKeys(id);
      if (identityPath) await saveIdentity(id, identityPath);
      return publicIdentity(id);
    },
  };
}
