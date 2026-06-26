// mcp.js — servidor MCP (transport stdio) que expone la memoria/DB a un agente externo.
// 100% local. Usa el SDK oficial (@modelcontextprotocol/sdk) en su API de bajo nivel
// (Server + setRequestHandler + StdioServerTransport) para evitar la dependencia de zod:
// los inputSchema se definen como JSON Schema plano.
//
// Diseño testable sin stdio: TOOLS (handlers puros), callTool (dispatcher) y
// buildMemoryStore son piezas exportables; startStdio_only arma el transporte.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadOrCreateIdentity } from "./identity.js";
import { createStore } from "./store.js";
import { listCollections } from "./config.js";

// --- Helpers de respuesta MCP -----------------------------------------------

// Éxito: payload serializado como texto JSON dentro del content block MCP.
const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

// Texto plano (sin JSON-stringificar): para navegación OKF (index.md).
const raw = (text) => ({ content: [{ type: "text", text: String(text) }] });

// Error: isError true + mensaje legible (no se lanzan excepciones crudas al transport).
const fail = (message) => ({ isError: true, content: [{ type: "text", text: String(message) }] });

// Traduce un error del store (con .status/.errors) a un mensaje legible.
function formatError(e) {
  if (e.status === 400) return `payload inválido: ${JSON.stringify(e.errors || e.message)}`;
  if (e.status === 404) return e.message;
  return e.message;
}

// Ejecuta una operación de escritura del store y empaqueta el resultado ok/fail.
const run = async (fn) => {
  try { return ok(await fn()); }
  catch (e) { return fail(formatError(e)); }
};

// --- Handlers puros: async (store, args) -> resultadoMCP ---------------------

const handlers = {
  memory_collections: async (store) => ok(await listCollections()),

  memory_list: async (store, args) =>
    ok(await store.list(args.collection, {
      tag: args.tag, type: args.type, q: args.q, includeDeleted: args.includeDeleted,
    })),

  memory_read: async (store, args) => {
    const rec = await store.read(args.collection, args.id);
    return rec ? ok(rec) : fail(`no encontrado: ${args.collection}/${args.id}`);
  },

  memory_search: async (store, args) => {
    const rows = await store.list(args.collection, { q: args.q });
    return ok(args.limit ? rows.slice(0, args.limit) : rows);
  },

  memory_index: async (store, args) => raw(await readIndex(store, args.collection)),

  memory_create: async (store, args) =>
    run(() => store.create(args.collection, args.payload)),

  memory_update: async (store, args) =>
    run(() => store.update(args.collection, args.id, args.payload, { merge: args.merge !== false })),

  memory_delete: async (store, args) =>
    run(() => store.remove(args.collection, args.id)),

  memory_verify: async (store) => ok(await store.verify()),
};

// Lee bundle/index.md del disco; si no existe, construye un índice desde
// listCollections + store.list (navegación OKF mínima).
async function readIndex(store, collection) {
  const file = join(store.dir, "bundle", "index.md");
  if (existsSync(file)) return readFile(file, "utf8");
  return buildIndex(store, collection);
}

// Índice de respaldo: una sección "## <col>" por colección con un bullet por registro.
async function buildIndex(store, collection) {
  const cols = collection ? [{ name: collection }] : await listCollections();
  const lines = ["# Índice", ""];
  for (const c of cols) {
    lines.push(`## ${c.name}`, "");
    const rows = await store.list(c.name);
    for (const r of rows) lines.push(`- ${r.title || r.id}`);
    if (!rows.length) lines.push("_(sin registros)_");
    lines.push("");
  }
  return lines.join("\n");
}

// --- Definición de TOOLS (nombre + descripción + inputSchema JSON Schema) ----

const str = (description) => ({ type: "string", description });

const TOOLS = [
  {
    name: "memory_collections",
    description: "Lista las colecciones de la memoria y sus JSON Schemas.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: handlers.memory_collections,
  },
  {
    name: "memory_list",
    description: "Lista registros de una colección (filtros opcionales tag/type/q/includeDeleted).",
    inputSchema: {
      type: "object",
      properties: {
        collection: str("Colección a listar."),
        tag: str("Filtrar por tag."),
        type: str("Filtrar por type OKF."),
        q: str("Búsqueda de texto (title+description+body)."),
        includeDeleted: { type: "boolean", description: "Incluir registros borrados." },
      },
      required: ["collection"],
      additionalProperties: false,
    },
    handler: handlers.memory_list,
  },
  {
    name: "memory_read",
    description: "Lee un registro por id; indica no encontrado si no existe.",
    inputSchema: {
      type: "object",
      properties: { collection: str("Colección."), id: str("Id del registro.") },
      required: ["collection", "id"],
      additionalProperties: false,
    },
    handler: handlers.memory_read,
  },
  {
    name: "memory_search",
    description: "Búsqueda de texto en una colección (q); aplica limit si viene.",
    inputSchema: {
      type: "object",
      properties: {
        collection: str("Colección donde buscar."),
        q: str("Texto a buscar (title+description+body, case-insensitive)."),
        limit: { type: "number", description: "Máximo de resultados." },
      },
      required: ["collection", "q"],
      additionalProperties: false,
    },
    handler: handlers.memory_search,
  },
  {
    name: "memory_index",
    description: "Devuelve el índice de navegación OKF (bundle/index.md).",
    inputSchema: {
      type: "object",
      properties: { collection: str("Limitar a una colección (opcional).") },
      additionalProperties: false,
    },
    handler: handlers.memory_index,
  },
  {
    name: "memory_create",
    description: "Crea un registro en una colección (valida contra el schema).",
    inputSchema: {
      type: "object",
      properties: {
        collection: str("Colección destino."),
        payload: { type: "object", description: "Datos del registro." },
      },
      required: ["collection", "payload"],
      additionalProperties: false,
    },
    handler: handlers.memory_create,
  },
  {
    name: "memory_update",
    description: "Actualiza un registro (merge=true PATCH, merge=false PUT).",
    inputSchema: {
      type: "object",
      properties: {
        collection: str("Colección."),
        id: str("Id del registro."),
        payload: { type: "object", description: "Datos a aplicar." },
        merge: { type: "boolean", description: "Combinar con estado actual (default true)." },
      },
      required: ["collection", "id", "payload"],
      additionalProperties: false,
    },
    handler: handlers.memory_update,
  },
  {
    name: "memory_delete",
    description: "Borra un registro (soft-delete salvo hard-delete en el schema).",
    inputSchema: {
      type: "object",
      properties: { collection: str("Colección."), id: str("Id del registro.") },
      required: ["collection", "id"],
      additionalProperties: false,
    },
    handler: handlers.memory_delete,
  },
  {
    name: "memory_verify",
    description: "Verifica la bitácora firmada (cadenas y firmas).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: handlers.memory_verify,
  },
];

// --- Dispatcher puro (sin transport) ----------------------------------------

// Busca la tool por nombre; si no existe lanza. Devuelve la respuesta MCP.
export async function callTool(store, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool desconocida: ${name}`);
  return tool.handler(store, args || {});
}

// --- Construcción del store -------------------------------------------------

// Crea la identidad (loadOrCreate) y el store; adjunta `dir` para memory_index.
export async function buildMemoryStore({ dir, identityPath } = {}) {
  const path = identityPath || "identities/agent.json";
  const identity = await loadOrCreateIdentity(path);
  const store = createStore({ dir, identity, identityPath: path });
  store.dir = dir;
  return store;
}

// --- Arranque stdio ---------------------------------------------------------

// Mapea una entrada de TOOLS al definition shape del protocolo MCP.
const toToolDef = (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema });

// Crea el store, registra handlers ListTools/CallTool y conecta el transport stdio.
export async function startStdio({ dir, identityPath } = {}) {
  const store = await buildMemoryStore({ dir, identityPath });
  const server = new Server(
    { name: "okf-postal-memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(toToolDef) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try { return await callTool(store, req.params.name, req.params.arguments || {}); }
    catch (e) { return fail(e.message); }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

// --- Arranque directo: node src/mcp.js --------------------------------------
if (process.argv[1] && process.argv[1].endsWith("mcp.js")) {
  startStdio({ dir: process.env.DATA_DIR || "data" }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}