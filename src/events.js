// Eventos postal (modelo híbrido): construir, firmar, encadenar y persistir.
// Cada operación CRUD es un evento firmado (ECDSA P-256) y append-only, con
// hash-chain por autor (seq + prev). El body va en claro: es una DB
// transparente, no mensajería E2E.
//
// Convenciones:
//   - id         = makeEventId(created_at, from, rnd)
//   - signedView = el evento EXCEPTO `sig`   (lo que se firma)
//   - sig        = sign(priv, canonical(signedView(ev)))
//   - eventHash  = sha256(canonical(ev COMPLETO, con sig))  -> lo referencia `prev`

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  canonical, sha256, sign, importSignPrivate, randomBytes, utf8Bytes,
} from "./crypto.js";

export const VERSION = 1;
export const KIND_CREATE = "record.create";
export const KIND_UPDATE = "record.update";
export const KIND_DELETE = "record.delete";

const EVENTS_DIR = (dir) => join(dir, ".postal", "events");
const toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

// Vista firmada: el evento sin su firma (igual que postal).
export const signedView = (ev) => {
  const { sig, ...rest } = ev;
  return rest;
};

// Hash del evento completo (incluida su firma): lo referencia el siguiente `prev`.
export async function eventHash(ev) {
  return toHex(await sha256(utf8Bytes(canonical(ev))));
}

const rndHex = (n = 6) => toHex(randomBytes(n));
const makeEventId = (createdAt, from, rnd) =>
  `${createdAt.replace(/[:.]/g, "-")}_${from}_${rnd}`;

// Construye el evento (sin sig) a partir de los campos de entrada.
function rawEvent(identity, ts, { kind, chat_id, to = [], rnd, body, supersedes, seq, prev }) {
  const ev = {
    v: VERSION,
    kind,
    chat_id,
    from: identity.id,
    to: [...to].sort(),
    created_at: ts,
    id: makeEventId(ts, identity.id, rnd || rndHex()),
    ...(seq != null ? { seq, prev: prev || null } : {}),
    ...(supersedes !== undefined ? { supersedes: supersedes || null } : {}),
    body: body || {},
  };
  return ev;
}

// Construye y FIRMA un evento. `seq`/`prev` encadenan los eventos de un autor.
export async function buildEvent(identity, opts) {
  const ts = opts.created_at || new Date().toISOString();
  const ev = rawEvent(identity, ts, opts);
  const priv = await importSignPrivate(identity.sign.privateJwk);
  ev.sig = await sign(priv, canonical(signedView(ev)));
  return ev;
}

// Persiste un evento en la bitácora append-only (un JSON por evento).
// Si el archivo ya existe -> throw (append-only, no se sobreescribe).
export async function appendEvent(dir, ev) {
  const evdir = EVENTS_DIR(dir);
  await mkdir(evdir, { recursive: true });
  const path = join(evdir, `${ev.id}.json`);
  if (existsSync(path)) throw new Error(`append-only: el evento ya existe (${ev.id})`);
  await writeFile(path, JSON.stringify(ev, null, 2));
  return path;
}

// Carga TODA la bitácora ordenada cronológicamente (created_at asc, desempate id asc).
// Si el directorio no existe -> [].
export async function loadLog(dir) {
  const evdir = EVENTS_DIR(dir);
  if (!existsSync(evdir)) return [];
  const files = (await readdir(evdir)).filter((f) => f.endsWith(".json"));
  const events = [];
  for (const f of files) events.push(JSON.parse(await readFile(join(evdir, f), "utf8")));
  return events.sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1
      : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Calcula {seq, prev} para el próximo evento de `authorId` dado el log actual.
export async function nextChain(events, authorId) {
  const mine = events
    .filter((e) => e.from === authorId && e.seq != null)
    .sort((a, b) => a.seq - b.seq);
  if (mine.length === 0) return { seq: 0, prev: null };
  const last = mine[mine.length - 1];
  return { seq: last.seq + 1, prev: await eventHash(last) };
}