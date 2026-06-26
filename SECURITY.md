# Seguridad de `okf-postal-db`

> Documentación honesta de seguridad. **No sobrevende** capacidades. Lee esto antes de
> desplegar nada sensible.

`okf-postal-db` es una base de datos local-first para agentes, con estado materializado en
OKF (Markdown + YAML) y una bitácora append-only firmada (ECDSA P-256) estilo postal,
expuesta vía REST con Fastify. Autenticación opcional por API key (header `x-api-key`),
rotación de clave, y soft-delete.

---

## 1. Modelo de amenazas y garantías REALES

### Qué SÍ garantiza

- **Integridad de la cadena frente a un actor sin la clave privada.** Cada evento de la
  bitácora se firma (ECDSA P-256) y encadena con el hash del evento anterior (`prev`). Un
  atacante que **no** tenga la clave privada no puede alterar, reordenar ni borrar eventos
  sin romper la cadena: la verificación (`node src/cli.js verify`) detecta la
  manipulación.
- **Orden relativo verificable.** El campo `seq` y el encadenamiento `prev` permiten
  reconstruir el orden de los eventos de forma verificable.

### Qué NO garantiza

- **NO es prueba irrefutable frente a un actor local/insider.** La clave privada del
  agente vive en el mismo disco que los datos (`identities/agent.json`, gitignored).
  Quien tenga acceso al disco puede **re-firmar una cadena falsa desde cero** con la
  clave. La firma prueba consistencia interna, **no** que la cadena sea la "original"
  frente a quien controla el disco.
- **NO prueba el momento absoluto.** `created_at` de cada evento lo escribe el firmante:
  es un valor **autodeclarado**. El hash-chain garantiza el ORDEN relativo (`seq`), **no**
  el instante real. Sin sellado de tiempo externo (TSA) no existe prueba criptográfica de
  "cuándo" ocurrió un evento; solo el orden relativo entre eventos.

### Resumen

| Garantía | Estado |
| --- | --- |
| Detección de manipulación de eventos (atacante sin clave) | ✅ Sí |
| Orden relativo verificable (`seq` / `prev`) | ✅ Sí |
| No repudio / prueba frente a insider con acceso al disco | ❌ No |
| Momento absoluto verificable (timestamp) | ❌ No (sin TSA externo) |
| Cifrado en reposo | ❌ No |
| Atribución por persona/usuario | ❌ No (una sola identidad de agente) |

---

## 2. Limitaciones conocidas

- **Una sola identidad/clave de agente.** El log **no atribuye** acciones por
  persona/usuario. No hay multi-identidad criptográfica; todo evento queda firmado por el
  mismo agente.
- **Sin cifrado en reposo.** El bundle OKF y la bitácora están en texto claro. Requiere
  cifrado de disco del SO (BitLocker / FileVault / LUKS / VeraCrypt) para proteger el
  contenido en descanso.
- **Auth = una API key global, sin RBAC.** No hay roles ni permisos granulares. Para
  control de acceso por rol, envolver la API en un proxy/gateway que valide permisos
  **antes** de llegar a ella.
- **Concurrencia intra-proceso.** El mutex de escritura es **solo intra-proceso**.
  Múltiples procesos o instancias escribiendo a la vez sobre el mismo directorio de datos
  pueden corromper la cadena (`seq`/`prev`). **Un solo escritor por directorio de datos.**
- **Sin backup/replicación nativa.** Archivos planos; un fallo de disco implica pérdida
  total. Implementar backups y retención **aparte**.
- **Append-only vs. borrado real (GDPR/RGPD "derecho al olvido").** No se puede borrar de
  verdad un dato sin romper la cadena. El soft-delete conserva el dato (lo marca como
  borrado, no lo elimina). Esta tensión legal debe resolverse **fuera** de esta herramienta.

---

## 3. Uso previsto (intended use)

### Apto para

- Memoria auditable de **un solo agente**.
- Base de conocimiento versionada de volumen modesto.
- Borradores/contratos en flujo de un solo operador, con diffs Git.
- Prototipos y demos.

### NO apto tal cual para

- Sistema de registro con **valor probatorio / forense**.
- Entornos clínicos multiusuario en producción.
- Datos que requieran **borrado garantizado**.
- Alta concurrencia o alto volumen.

---

## 4. Endurecimiento recomendado antes de producción sensible

Lista accionable, ordenada por impacto:

1. **(a) Identidad/clave por persona** — para atribución criptográfica de acciones a
   usuarios concretos.
2. **(b) Sellado de tiempo externo (TSA RFC 3161)** o anclaje WORM / notarización, para
   fecha verificable y no repudio.
3. **(c) Clave privada fuera del disco de datos** — HSM o keystore del SO.
4. **(d) Modelo de concurrencia multi-proceso** — lock de archivo o un único escritor
   serializado por directorio de datos.
5. **(e) Backup/retención y verificación periódica** con `node src/cli.js verify`.
6. **(f) Política explícita para el derecho de borrado (GDPR/RGPD).**
7. **(g) Cifrado de disco del SO** (BitLocker / FileVault / LUKS / VeraCrypt).
8. **(h) Auditoría de seguridad independiente** antes de producción sensible.

---

## 5. Reporte de vulnerabilidades

Para reportar una vulnerabilidad, abre un issue en el repositorio del proyecto o contacta
al mantenedor.

Este proyecto se ofrece **"as is"** bajo licencia MIT, **sin garantía de ningún tipo**,
expresa o implícita. No hay SLA de respuesta ni compromiso de parche.