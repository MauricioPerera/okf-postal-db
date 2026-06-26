// Gate de verificación (parte "hard" del contrato híbrido de postal):
//   1. schema       — el evento valida contra schema/event.schema.json (ajv 2020 + formats)
//   2. firma        — sig es una firma ECDSA válida del autor sobre canonical(signedView)
//   3. append-only  — ids únicos y cadena por autor (seq 0,1,2... sin huecos; prev = hash anterior)
//
// La parte "soft" (confiar en una clave nueva, admitir un autor) queda fuera: aquí un único
// agente conocido firma. El gate corre al escribir (store) y on-demand (/verify, cli).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { canonical, importSignPublic, verify } from "./crypto.js";
import { signedView, eventHash } from "./events.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dir, "..", "schema", "event.schema.json");

// Validador del schema compilado UNA vez y cacheado a nivel módulo (lazy).
let _validate = null;
async function eventValidator() {
  if (_validate) return _validate;
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  _validate = ajv.compile(schema);
  return _validate;
}

// Resuelve la publicKey b64 aplicable a un evento dado su `created_at`.
// `entry` admite DOS formas (backward-compat):
//   (a) STRING (clave única, b64) -> se devuelve tal cual (comportamiento histórico).
//   (b) ARRAY de { from, publicKey } -> la de mayor `from` con from <= createdAt;
//       si ninguna aplica (evento anterior a la primera), la de menor `from`.
export function resolveKey(entry, createdAt) {
  if (!Array.isArray(entry)) return entry;
  let best = null;
  let earliest = null;
  for (const k of entry) {
    if (!earliest || k.from < earliest.from) earliest = k;
    if (k.from <= createdAt && (!best || k.from > best.from)) best = k;
  }
  return (best || earliest).publicKey;
}

// Verifica un evento aislado: schema + firma.
// `pubKeys`: { [authorId]: signPublicKeyB64 }  o  { [authorId]: [{from,publicKey}] }.
export async function verifyEvent(ev, pubKeys) {
  const validate = await eventValidator();
  if (!validate(ev)) return { ok: false, reason: "schema", errors: validate.errors };
  const entry = pubKeys[ev.from];
  if (!entry) return { ok: false, reason: "unknown-author", author: ev.from };
  const pub = resolveKey(entry, ev.created_at);
  const key = await importSignPublic(pub);
  const good = await verify(key, ev.sig, canonical(signedView(ev)));
  return good ? { ok: true } : { ok: false, reason: "bad-signature", id: ev.id };
}

// Recorre la bitácora: cada evento (schema+firma) + ids únicos.
// Devuelve el primer fallo con su id, o { ok: true } si todos pasan.
async function verifyEachEvent(events, pubKeys) {
  const seen = new Set();
  for (const ev of events) {
    const r = await verifyEvent(ev, pubKeys);
    if (!r.ok) return { ok: false, id: ev.id, ...r };
    if (seen.has(ev.id)) return { ok: false, reason: "duplicate-id", id: ev.id };
    seen.add(ev.id);
  }
  return { ok: true };
}

// Agrupa por autor los eventos encadenados (los que tienen seq). No muta el orden de entrada.
function groupChainedByAuthor(events) {
  const byAuthor = {};
  for (const ev of events) {
    if (ev.seq == null) continue;
    (byAuthor[ev.from] ||= []).push(ev);
  }
  return byAuthor;
}

// Verifica la cadena de un autor: seq 0,1,2... sin huecos y prev = hash del evento anterior.
async function verifyAuthorChain(author, list) {
  list.sort((a, b) => a.seq - b.seq);
  let expectedPrev = null;
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (ev.seq !== i) return { ok: false, reason: "seq-gap", author, expected: i, got: ev.seq };
    if ((ev.prev || null) !== expectedPrev) return { ok: false, reason: "broken-chain", author, id: ev.id };
    expectedPrev = await eventHash(ev);
  }
  return { ok: true };
}

// Verifica la bitácora completa: cada evento (schema+firma) y la integridad de la cadena
// por autor (seq sin huecos desde 0; prev = hash del anterior; ids únicos).
export async function verifyLog(events, pubKeys) {
  const each = await verifyEachEvent(events, pubKeys);
  if (!each.ok) return each;
  for (const [author, list] of Object.entries(groupChainedByAuthor(events))) {
    const r = await verifyAuthorChain(author, list);
    if (!r.ok) return r;
  }
  return { ok: true, count: events.length };
}