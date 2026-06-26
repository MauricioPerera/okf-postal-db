// Proyector: aplica eventos verificados a la vista de estado OKF.
//   record.create -> escribe el archivo OKF
//   record.update -> reescribe el archivo (conserva created_at original)
//   record.delete -> soft-delete por defecto (deleted:true, deleted_at); hard-delete opcional
//
// El proyector es "tonto": aplica el `data` que viene en el evento. La lógica de
// merge (PATCH) y validación vive en store.js, de modo que el evento ya contiene el
// estado final del registro. Esto hace la proyección idempotente y reconstruible.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { KIND_CREATE, KIND_UPDATE, KIND_DELETE } from "./events.js";
import { writeRecord, readRecord, removeRecord } from "./okf.js";

// Aplica un único evento al bundle OKF. `opts.hardDelete` borra el archivo en vez de marcarlo.
export async function applyEvent(dir, ev, opts = {}) {
  const col = ev.chat_id;
  const { record_id, data = {} } = ev.body || {};
  if (!record_id) return;

  if (ev.kind === KIND_CREATE) {
    await writeRecord(dir, col, record_id, {
      ...data,
      created_at: data.created_at || ev.created_at,
      updated_at: ev.created_at,
      _event: ev.id,
    });
    return;
  }

  if (ev.kind === KIND_UPDATE) {
    const existing = await readRecord(dir, col, record_id);
    await writeRecord(dir, col, record_id, {
      ...data,
      created_at: existing?.created_at || ev.created_at,
      updated_at: ev.created_at,
      _event: ev.id,
    });
    return;
  }

  if (ev.kind === KIND_DELETE) {
    if (opts.hardDelete) {
      await removeRecord(dir, col, record_id);
      return;
    }
    const existing = (await readRecord(dir, col, record_id)) || {};
    await writeRecord(dir, col, record_id, {
      ...existing,
      deleted: true,
      deleted_at: ev.created_at,
      _event: ev.id,
    });
  }
}

// Reconstruye TODO el bundle desde cero replayando la bitácora (para checkouts frescos).
export async function projectAll(dir, events, opts = {}) {
  await rm(join(dir, "bundle", "records"), { recursive: true, force: true });
  for (const ev of events) await applyEvent(dir, ev, opts);
}