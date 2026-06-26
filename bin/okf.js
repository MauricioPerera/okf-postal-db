#!/usr/bin/env node
// CLI unificado `okf`: un único punto de entrada con subcomandos.
//   serve   -> API REST (Fastify) sobre la DB OKF + bitácora firmada.
//   mcp     -> memoria/DB expuesta a un agente externo por stdio (MCP).
//   verify  -> verifica la bitácora (cadenas + firmas) de un DATA_DIR.
//   init    -> crea (o carga) la identidad del agente en disco.
//   help    -> esta ayuda.
//
// Las dependencias pesadas (Fastify, SDK MCP) se cargan con import dinámico
// sólo en el subcomando que las usa, así `okf verify` no arranca un server.

// Descompone argv crudo en { command, rest }. Comando por defecto: "help".
export function parseCommand(argv) {
  const command = argv[0] || "help";
  return { command, rest: argv.slice(1) };
}

// Texto de ayuda: lista los 5 subcomandos válidos.
export function usage() {
  return [
    "uso: okf <comando> [args]",
    "",
    "comandos:",
    "  serve              Arranca la API REST (Fastify). Env DATA_DIR, PORT.",
    "  mcp                Arranca la memoria MCP por stdio. Env DATA_DIR.",
    "  verify [dir]       Verifica la bitácora firmada de <dir> (o DATA_DIR).",
    "  init [path]        Crea/carga la identidad del agente (default identities/agent.json).",
    "  help               Muestra esta ayuda.",
  ].join("\n");
}

// --- Subcomandos (uno por comando) ------------------------------------------

// `okf serve`: construye la app Fastify y escucha en 0.0.0.0:PORT.
async function cmdServe() {
  const { buildServer } = await import("../src/server.js");
  const app = await buildServer({});
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

// `okf mcp`: arranca el servidor MCP por stdio sobre DATA_DIR.
async function cmdMcp() {
  const { startStdio } = await import("../src/mcp.js");
  await startStdio({ dir: process.env.DATA_DIR || "data" });
}

// `okf verify [dir]`: verifica cadena+firmas de la bitácora; exit 0/1 según ok.
async function cmdVerify(rest) {
  const { loadOrCreateIdentity } = await import("../src/identity.js");
  const { loadLog } = await import("../src/events.js");
  const { verifyLog } = await import("../src/gate.js");
  const dir = rest[0] || process.env.DATA_DIR || "data";
  const identity = await loadOrCreateIdentity();
  const events = await loadLog(dir);
  const r = await verifyLog(events, { [identity.id]: identity.sign.publicKey });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

// `okf init [path]`: crea/carga la identidad y la deja en disco.
async function cmdInit(rest) {
  const { loadOrCreateIdentity } = await import("../src/identity.js");
  const path = rest[0] || "identities/agent.json";
  const id = await loadOrCreateIdentity(path);
  console.log("identity:", id.id, "->", path);
}

// `okf help`: imprime la ayuda y termina 0.
async function cmdHelp() {
  console.log(usage());
  process.exit(0);
}

// Despachador comando -> handler. Desconocido: ayuda + exit 2.
const HANDLERS = {
  serve: cmdServe,
  mcp: cmdMcp,
  verify: cmdVerify,
  init: cmdInit,
  help: cmdHelp,
};

// Ejecuta el comando pedido. Comandos desconocidos imprimen la ayuda y salen 2.
export async function run(command, rest) {
  const handler = HANDLERS[command];
  if (handler) return handler(rest);
  console.log(usage());
  process.exit(2);
}

// Arranque directo: `node bin/okf.js <cmd> ...`. Cubre rutas absolutas/relativas.
if (process.argv[1] && process.argv[1].endsWith("okf.js")) {
  const { command, rest } = parseCommand(process.argv.slice(2));
  run(command, rest).catch((e) => { console.error(e); process.exit(1); });
}