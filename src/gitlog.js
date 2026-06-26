// gitlog.js — commit git best-effort por operación de escritura, OPT-IN.
//
// Si process.env.GIT_COMMIT !== "true" no hace nada (comportamiento por defecto,
// idéntico al anterior). Si está en "true", ejecuta `git add -A` + `git commit`
// dentro de <dir>. Best-effort: nunca lanza; cualquier fallo (sin repo, sin
// cambios, git ausente) se captura y se devuelve como { ok:false, error }.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function commitData(dir, message) {
  if (process.env.GIT_COMMIT !== "true") return { skipped: true };
  try {
    await execFileP("git", ["add", "-A"], { cwd: dir });
    await execFileP("git", ["commit", "-m", message, "--no-gpg-sign"], { cwd: dir });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}