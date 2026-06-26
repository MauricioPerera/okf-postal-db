// Estado materializado en formato OKF (Open Knowledge Format):
// cada registro es un archivo Markdown con frontmatter YAML en
// bundle/records/<coleccion>/<id>.md. Frontmatter requerido por OKF: `type`.
// `id` y `collection` NO se guardan en el frontmatter: son redundantes
// (el id es el nombre del archivo; la colección, el directorio).

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const recordsDir = (dir, col) => join(dir, "bundle", "records", col);
const recordPath = (dir, col, id) => join(recordsDir(dir, col), `${id}.md`);
const bundleFile = (dir, name) => join(dir, "bundle", name);

// Separa el cuerpo markdown del frontmatter y descarta id/collection
// (no se persisten: son redundantes con archivo/directorio).
function splitRecord(record) {
  const { body = "", id: _id, collection: _col, ...frontmatter } = record;
  return { frontmatter, body };
}

// Escribe (crea o reescribe) un registro OKF.
// record = { type, title, ..., body }. Si falta type, toma el de la colección.
export async function writeRecord(dir, col, id, record) {
  const { frontmatter, body } = splitRecord(record);
  if (!frontmatter.type) frontmatter.type = col;
  await mkdir(recordsDir(dir, col), { recursive: true });
  const md = matter.stringify(body ? `${body}\n` : "", frontmatter);
  await writeFile(recordPath(dir, col, id), md);
}

export function recordExists(dir, col, id) {
  return existsSync(recordPath(dir, col, id));
}

// Lee y parsea un registro OKF -> { id, collection, ...frontmatter, body }.
// Devuelve null si el archivo no existe.
export async function readRecord(dir, col, id) {
  const p = recordPath(dir, col, id);
  if (!existsSync(p)) return null;
  const parsed = matter(await readFile(p, "utf8"));
  return { id, collection: col, ...parsed.data, body: parsed.content.trim() };
}

// Borrado físico del archivo (hard-delete).
export async function removeRecord(dir, col, id) {
  const p = recordPath(dir, col, id);
  if (existsSync(p)) await unlink(p);
}

// --- Archivos especiales OKF: index.md y log.md ---
// Regeneración idempotente. Funciones puras de formateo + una escritura.

// Formatea el cuerpo del índice: una sección "## <name>" por colección,
// con un bullet por registro. Colección vacía -> "_(sin registros)_".
function formatIndexBody(collections) {
  const lines = [];
  for (const col of collections) {
    lines.push(`## ${col.name}`, "");
    if (!col.records || col.records.length === 0) {
      lines.push("_(sin registros)_", "");
      continue;
    }
    for (const r of col.records) {
      const desc = r.description ? ` — ${r.description}` : "";
      lines.push(`- [${r.title || r.id}](records/${col.name}/${r.id}.md)${desc}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Escribe bundle/index.md (progressive disclosure agrupado por colección).
// collections: [{ name, records: [{ id, title, description }] }] ya filtrados.
export async function writeIndex(dir, collections) {
  const body = `# Índice\n\n${formatIndexBody(collections)}`;
  const md = matter.stringify(`${body}\n`, { type: "index" });
  await mkdir(bundleFile(dir, ""), { recursive: true });
  await writeFile(bundleFile(dir, "index.md"), md);
}

const isoDate = (iso) => (iso || "").slice(0, 10);

// Agrupa eventos por fecha ISO (YYYY-MM-DD) y ordena las fechas ascendentemente.
function groupEventsByDate(events) {
  const groups = new Map();
  for (const ev of events) {
    const d = isoDate(ev.created_at);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(ev);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Formatea el cuerpo del log: una sección por fecha, una línea por evento.
function formatLogBody(events) {
  const lines = [];
  for (const [date, evs] of groupEventsByDate(events)) {
    lines.push(`## ${date}`, "");
    for (const ev of evs) {
      const rid = ev.body?.record_id || "-";
      lines.push(`- ${ev.kind} · ${ev.chat_id} · ${rid} · ${ev.id}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Escribe bundle/log.md (historial cronológico agrupado por fecha).
// events: bitácora [{ kind, chat_id, created_at, body:{record_id}, id }].
export async function writeLog(dir, events) {
  const body = `# Bitácora\n\n${formatLogBody(events)}`;
  const md = matter.stringify(`${body}\n`, { type: "log" });
  await mkdir(bundleFile(dir, ""), { recursive: true });
  await writeFile(bundleFile(dir, "log.md"), md);
}

// Busqueda de texto: q coincide (case-insensitive) si aparece en la concatenacion
// de title + description + body. Pura: no toca el registro ni dependencias.
export function matchesQuery(record, q) {
  const haystack = `${record.title || ""} ${record.description || ""} ${record.body || ""}`;
  return haystack.toLowerCase().includes(String(q).toLowerCase());
}

// Predicado de filtrado por registro: aplica includeDeleted, type, tag y q.
// Devuelve true si el registro pasa todos las condiciones activas del filter.
function matchesFilters(rec, filter) {
  if (!filter.includeDeleted && rec.deleted) return false;
  if (filter.type && rec.type !== filter.type) return false;
  if (filter.tag && !(Array.isArray(rec.tags) && rec.tags.includes(filter.tag))) return false;
  if (filter.q && !matchesQuery(rec, filter.q)) return false;
  return true;
}

// Lista los registros de una colección. filter: { tag, type, includeDeleted, q }.
// Si el directorio no existe -> []. Excluye rec.deleted salvo includeDeleted.
// Sigue devolviendo un array sin paginar: la paginación es responsabilidad de presentación.
export async function listRecords(dir, col, filter = {}) {
  const d = recordsDir(dir, col);
  if (!existsSync(d)) return [];
  const ids = (await readdir(d))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
  const out = [];
  for (const id of ids) {
    const rec = await readRecord(dir, col, id);
    if (rec && matchesFilters(rec, filter)) out.push(rec);
  }
  return out;
}