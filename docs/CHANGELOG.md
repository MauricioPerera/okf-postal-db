# Changelog

Cambios del proyecto `okf-postal-db`. Fechas en ISO (local).

## [0.1.0] — 2026-06-25

Versión inicial documentada: DB para agentes con OKF + bitácora postal híbrida sobre
Fastify. Core escrito por instancias GLM bajo gate de complejidad (CCDD);
`src/crypto.js` vendorizado de postal.

### Modelo
- OKF: registros como `data/bundle/records/<col>/<id>.md` (Markdown + frontmatter YAML).
- postal híbrido: cada CRUD = evento firmado ECDSA P-256, append-only en
  `data/.postal/events/<id>.json`, hash-chain por autor (`seq` + `prev`). Sin
  sellado/cifrado (DB transparente).
- Archivos especiales OKF: `data/bundle/index.md` (índice por colección) y
  `data/bundle/log.md` (bitácora por fecha), regenerados en cada escritura.
- Delete = soft-delete por defecto (`deleted:true`); hard-delete por colección vía
  `x-hard-delete`.

### Módulos
- `identity.js` — identidad + **rotación de clave** (historial `keys[]`,
  `rotateIdentity`, `saveIdentity`, `loadOrCreateIdentity`, `publicIdentity`).
- `crypto.js` — vendorizado de postal (ECDSA P-256).
- `events.js` — `buildEvent` / `appendEvent` / `loadLog` / `nextChain`.
- `gate.js` — `verifyEvent` / `verifyLog`; resuelve la clave por fecha del evento si
  hay rotación (acepta `pubKeys` como string o array `{ from, publicKey }`).
- `okf.js` — `writeRecord` / `readRecord` / `listRecords` (filtro `q` de texto),
  `removeRecord`, `writeIndex`, `writeLog`.
- `projector.js` — `applyEvent` / `projectAll`.
- `config.js` — colecciones dinámicas desde `schema/collections/*.schema.json`.
- `store.js` — orquesta CRUD, mutex, rotate persistente.
- `server.js` — Fastify; `registerRoutes` dividido en `registerRecordRoutes` /
  `registerMetaRoutes` / `registerAdminRoutes`; hook auth `apiKeyGuard`.
- `gitlog.js` — `commitData` opt-in (`GIT_COMMIT="true"`).
- `cli.js` — `verify [dataDir]`.

### Endpoints REST (12)
- `GET /health` (exento de auth) → `{ ok, agent }`.
- `GET /collections` → `{ collections:[{ name, okfType, hardDelete, schema }] }`.
- `POST /collections/:col/records` → 201 (400 inválido, 404 colección desconocida).
- `GET /collections/:col/records` → `{ records, total, limit, offset }` con
  `?tag=`, `?type=`, `?q=`, `?includeDeleted=true`, `?limit=`, `?offset=`.
- `GET /collections/:col/records/:id` → 200 / 404.
- `PUT /collections/:col/records/:id` (reemplazo).
- `PATCH /collections/:col/records/:id` (merge parcial).
- `DELETE /collections/:col/records/:id` (soft-delete / tombstone).
- `POST /rebuild` → `{ ok, events:N }`.
- `POST /rotate` → `{ ok, identity }`.
- `GET /log` → `{ events }`.
- `GET /verify` → 200 `{ ok:true, count }` / 409 `{ ok:false, reason }`.

### Variables de entorno
- `DATA_DIR` (default `data`).
- `PORT` (default `3000`).
- `API_KEY` — si está definida, exige `x-api-key` en todas las rutas salvo `/health`.
- `GIT_COMMIT="true"` — `git add` + `git commit` best-effort en `DATA_DIR` por escritura.

### Colecciones de ejemplo
- `notes` — `title` (req), `description`, `tags`, `resource`, `body`. `x-okf-type "note"`.
- `contacts` — `name` (req), `email` (format email), `phone`, `tags`, `resource`, `body`.
  `x-okf-type "contact"`.

### Scripts
- `npm start`, `npm test` (node --test), `npm run init-identity`,
  `npm run verify` (`node src/cli.js verify [dataDir]`).

### Auditoría / seguridad
- Firma ECDSA P-256 por evento; `signedView` = evento sin `sig`; firma sobre
  `canonical(signedView)`.
- Append-only: ids únicos, hash-chain por autor (`seq` 0,1,2… sin huecos;
  `prev` = hash del anterior). Manipular un evento → `/verify` y `cli verify` fallan
  (exit 1, `reason bad-signature`).
- Rotación de clave: identidad con historial; el gate elige la clave por la fecha del
  evento; el `id` del agente permanece estable.

### Tests
- 23 tests (node:test): `db`, `okf-special`, `contacts`, `query`, `auth`, `rebuild`,
  `rotation`, `rotate-endpoint`, `gitlog`. `npm test` → 23/23 verde.