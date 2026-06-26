// CLI del gate (paridad con postal): `node src/cli.js verify [dataDir]`.
// Verifica la bitácora firmada de un directorio de datos.
//   exit 0 -> bitácora válida (schema + firma + cadena)
//   exit 1 -> inválida
//   exit 2 -> uso incorrecto

import { loadOrCreateIdentity } from "./identity.js";
import { loadLog } from "./events.js";
import { verifyLog } from "./gate.js";

const [cmd, dir = "data"] = process.argv.slice(2);

if (cmd === "verify") {
  const identity = await loadOrCreateIdentity();
  const pubKeys = { [identity.id]: identity.sign.publicKey };
  const r = await verifyLog(await loadLog(dir), pubKeys);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else {
  console.error("uso: node src/cli.js verify [dataDir]");
  process.exit(2);
}