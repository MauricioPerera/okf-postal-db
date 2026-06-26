// Identidad del agente: par de claves ECDSA P-256 para firmar eventos.
// Modelo híbrido: solo firma (sin sellado/cifrado por destinatario). El id se deriva
// criptográficamente de la clave pública de firma (16 hex en MAYÚSCULAS), igual que postal.
//
// Rotación de clave: la identidad mantiene un HISTORIAL de claves (`keys`, ordenado por
// `from` ascendente). La clave VIGENTE es la última y se expone también en `sign` (compat
// con buildEvent, que firma con identity.sign.privateJwk). El `id` se deriva de la PRIMERA
// clave (keys[0]) y NO cambia al rotar: los eventos viejos verifican con la clave de su
// época y los nuevos con la vigente.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { generateSignKeypair, fingerprintId } from "./crypto.js";

const DEFAULT_PATH = "identities/agent.json";

// Crea una identidad nueva con una primera clave.
// { id, displayName, created_at, sign:{publicKey,privateJwk}, keys:[{publicKey,privateJwk,from}] }
export async function createIdentity(displayName = "agent", created_at) {
  const ts = created_at || new Date().toISOString();
  const kp = await generateSignKeypair();
  const id = await fingerprintId(kp.publicKey);
  const keys = [{ publicKey: kp.publicKey, privateJwk: kp.privateJwk, from: ts }];
  const sign = { publicKey: kp.publicKey, privateJwk: kp.privateJwk };
  return { id, displayName, created_at: ts, sign, keys };
}

// Rotación: agrega una clave nueva al historial y la pone como vigente (`sign`).
// El `id` se mantiene intacto (derivado de la primera clave).
export async function rotateIdentity(identity, created_at, _reason) {
  const ts = created_at || new Date().toISOString();
  const kp = await generateSignKeypair();
  const newKey = { publicKey: kp.publicKey, privateJwk: kp.privateJwk, from: ts };
  return {
    ...identity,
    sign: { publicKey: kp.publicKey, privateJwk: kp.privateJwk },
    keys: [...identity.keys, newKey],
  };
}

// Carga la identidad desde disco, creándola (y persistiéndola) si no existe.
// Backward-compat: un archivo viejo sin `keys` se sintetiza desde `sign`.
export async function loadOrCreateIdentity(path = DEFAULT_PATH) {
  if (existsSync(path)) {
    const obj = JSON.parse(await readFile(path, "utf8"));
    if (!obj.keys) {
      return { ...obj, keys: [{ ...obj.sign, from: obj.created_at }] };
    }
    return obj;
  }
  const identity = await createIdentity();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(identity, null, 2));
  return identity;
}

// Documento público (sin privateJwk) para auditoría/verificación.
export function publicIdentity(identity) {
  return {
    id: identity.id,
    displayName: identity.displayName,
    created_at: identity.created_at,
    signPublicKey: identity.sign.publicKey,
    keys: (identity.keys || []).map((k) => ({ publicKey: k.publicKey, from: k.from })),
  };
}

// Persiste la identidad (completa, con privateJwk) a disco. Usado por store.rotate
// para que la rotación de clave sobreviva a reinicios. Crea el directorio si hace falta.
export async function saveIdentity(identity, path = DEFAULT_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(identity, null, 2));
  return path;
}

// CLI: `node src/identity.js init [path]`. Detección de ejecución directa robusta:
// process.argv[1] terminando en "identity.js" cubre symlinks/rutas absolutas/relativas.
if (process.argv[1] && process.argv[1].endsWith("identity.js")) {
  const [cmd, path] = process.argv.slice(2);
  if (cmd === "init") {
    const id = await loadOrCreateIdentity(path || DEFAULT_PATH);
    console.log("identity:", id.id, "->", path || DEFAULT_PATH);
  }
}