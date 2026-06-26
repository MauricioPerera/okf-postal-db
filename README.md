# okf-postal-db

DB con CRUD para agentes que combina **estado materializado legible** (OKF) con una
**bitácora de eventos firmada y append-only** (modelo postal híbrido). Node.js ESM.

Se expone a través de **tres interfaces** unificadas bajo el bin `okf`:

- **REST** (Fastify) — `src/server.js`, `okf serve` o `npm start`.
- **MCP** (Model Context Protocol, stdio) — `src/mcp.js`, `okf mcp` o `npm run mcp`.
- **CLI `okf`** — `bin/okf.js` (subcomandos `serve` / `mcp` / `verify` / `init` / `help`).

El core fue escrito por instancias GLM bajo un **gate de complejidad** (CCDD); solo
`src/crypto.js` está **vendorizado** de postal.

---

## Qué es y por qué

Esta es una "DB para agentes". El problema que resuelve: un agente necesita
**leer y escribir datos** (notas, recursos, conocimiento) de forma habitual, pero
también necesita **auditar** quién hizo qué y **detectar manipulación**. Las DB
tradicionales dan lo primero y no lo segundo; una bitácora criptográfica pura da
lo segundo y es incómoda para leer estado actual.

La solución combina dos ideas:

- **OKF (Open Knowledge Format):** cada registro es un archivo **Markdown + frontmatter
  YAML** materializado en disco (`data/bundle/records/<coleccion>/<id>.md`). Es el
  **estado actual**, legible y diffeable con cualquier herramienta de texto/git. No
  hay que "replayar" nada para saber cómo está el mundo ahora.

- **postal (modelo híbrido):** cada operación CRUD es un **EVENTO firmado**
  (ECDSA P-256) que se **appendea** a una bitácora en `data/.postal/events/<id>.json`,
  con **hash-chain** (`seq` + `prev`) por autor. El body va en claro: **no hay sellado
  ni cifrado por destinatario** — es una DB **transparente**, no mensajería E2E. La
  firma se vendoriza de postal (`src/crypto.js`).

Así, **las escrituras son auditables** (bitácora firmada e inmutable) y **las lecturas
son baratas** (salen del estado OKF materializado). La bitácora es la fuente de verdad;
el bundle OKF es una proyección rebuildable desde ella. Además, la **rotación de clave**
del agente está soportada: los eventos viejos siguen verificando con su clave de época
mientras el `id` del agente permanece estable.

> Convenciones tomadas de postal:
> - `id` del evento = `makeEventId(created_at, from, rnd)`
> - `signedView` = todo el evento **excepto** `sig`
> - `sig` = `sign(priv, canonical(signedView(ev)))`
> - hash-chain = `seq` (contador por autor) + `prev` (hash del evento anterior del autor)

---

## Arquitectura

```
                         AGENTE (cliente REST)
                                 |
                                 |  HTTP (Fastify, src/server.js)  + hook auth apiKeyGuard
                                 v
                       +-------------------+
                       |      store.js     |   orquestación CRUD + mutex (serializa seq)
                       +-------------------+
                          |   |   |   |
         +----------------+   |   |   +----------------+
         |                    |   |                    |
         v                    v   v                    v
  src/config.js        src/events.js   src/gate.js   src/projector.js / src/okf.js
  (ajv + schemas       (construye,     (verifica      (proyección a OKF:
   en schema/           firma, encadena, firma +      bundle/records/<col>/<id>.md
   collections/)        append)         append-only;   + index.md + log.md)
         |              (nextChain)     resuelve clave |
         |                    |   |     por fecha si   |
         |                    v   v     hay rotación)  |
         |              data/.postal/events/<id>.json  |
         |              (bitácora append-only firmada) |
         |                                         |
         +--------------> lecturas <----------------+
                          (gray-matter sobre OKF)

  src/identity.js  -> identities/agent.json  (ECDSA P-256, historial keys[] para rotación)
  src/crypto.js    -> primitivas vendorizadas de postal (canonical, sha256, sign/verify)
  src/gitlog.js    -> commit git opt-in (GIT_COMMIT="true") best-effort por escritura
  src/cli.js       -> `verify` por CLI
```

### Flujo de escritura (create / update / delete)

```
payload (JSON)
   |
   v
1. validar payload            (ajv draft 2020-12 contra schema/collections/<col>.schema.json)  -> 400 si inválido
   |
   v
2. construir evento firmado   (src/events.buildEvent)  con seq/prev (nextChain sobre el log)
   |
   v
3. gate                       (src/gate.verifyEvent: schema + firma ECDSA + append-only)
   |                          -> rechazado => no se persiste
   v
4. append a la bitácora       (src/events.appendEvent)  data/.postal/events/<id>.json  (append-only)
   |
   v
5. proyectar a OKF            (src/projector.applyEvent -> src/okf.writeRecord)
                              data/bundle/records/<col>/<id>.md
   |
   v
6. regenerar index/log        (src/okf.writeIndex / writeLog)  data/bundle/index.md + log.md
   |
   v
7. (opcional) commit git      (src/gitlog.commitData)  si GIT_COMMIT="true"  (best-effort)
```

Las escrituras se **serializan** con un mutex interno para que el contador `seq` por
autor no sufra carreras dentro del proceso.

### Flujo de lectura

Las lecturas **salen del estado OKF** materializado (`src/okf.readRecord` /
`listRecords` vía `gray-matter`). No se replaya la bitácora en cada read.

---

## Modelo de datos

### OKF — registro materializado

`data/bundle/records/<coleccion>/<id>.md`:

```markdown
---
type: note
title: Título de la nota
description: Resumen de una frase
tags: [foo, bar]
resource: https://...
created_at: 2026-06-25T12:00:00.000Z
updated_at: 2026-06-25T12:05:00.000Z
_event: <id del último evento que tocó este registro>
deleted: true            # solo presentes tras un soft-delete
deleted_at: ...
---

Cuerpo Markdown de la nota (campo `body`).
```

- Frontmatter requerido por OKF: `type` (no vacío).
- `id` y `collection` **no** se persisten en el frontmatter: son redundantes (el `id`
  es el nombre del archivo; la colección, el directorio).
- El projector los re-hidrata al leer (`readRecord` devuelve `{ id, collection, ...frontmatter, body }`).

### Archivos especiales OKF

Regenerados en cada escritura (idempotentes):

- `data/bundle/index.md` — índice por colección (una sección `## <name>` por colección,
  un bullet por registro con link al archivo y la `description`).
- `data/bundle/log.md` — bitácora agrupada por fecha (`## YYYY-MM-DD`), una línea por
  evento (`kind · chat_id · record_id · event_id`).

### Bitácora postal — evento

`data/.postal/events/<id>.json` (uno por evento, append-only):

```json
{
  "v": 1,
  "kind": "record.create",
  "chat_id": "notes",
  "from": "<fingerprint del autor>",
  "to": [],
  "created_at": "2026-06-25T12:00:00.000Z",
  "id": "2026-06-25T12-00-00-000Z_<from>_<rnd>",
  "seq": 0,
  "prev": null,
  "supersedes": null,
  "body": { "record_id": "<id del registro>", "data": { "type": "note", "title": "...", "body": "..." } },
  "sig": "<ECDSA P-256 sobre canonical(signedView(ev))>"
}
```

- `kind`: `record.create` | `record.update` | `record.delete`.
- `chat_id`: nombre de la colección.
- `from`: id del autor (fingerprint de su clave pública).
- `seq` / `prev`: hash-chain **por autor**. `prev` = `sha256(canonical(evento anterior))`.
- `supersedes`: id del último evento que tocó el mismo registro (encadena versiones).
- `body.record_id`: id del registro OKF afectado.
- `body.data`: payload validado por el schema (en `record.delete` no va `data`).

---

## Endpoints REST

| Método | Ruta | Descripción | Errores |
|--------|------|-------------|---------|
| `GET`  | `/health` | `{ ok, agent }` — **EXENTO de auth** | — |
| `GET`  | `/collections` | `{ collections:[{ name, okfType, hardDelete, schema }] }` | — |
| `POST` | `/collections/:col/records` | **Create** — valida schema y crea registro | `400` payload inválido, `404` colección desconocida |
| `GET`  | `/collections/:col/records` | **List** — `{ records, total, limit, offset }` | — |
| `GET`  | `/collections/:col/records/:id` | **Read** | `404` no existe o borrado |
| `PUT`  | `/collections/:col/records/:id` | **Update reemplazo** (merge=false) | `400` inválido, `404` no existe/borrado |
| `PATCH`| `/collections/:col/records/:id` | **Update parcial / merge** (merge=true) | `400` inválido, `404` no existe/borrado |
| `DELETE` | `/collections/:col/records/:id` | **Soft-delete** (tombstone, `deleted:true`) salvo `x-hard-delete` | `404` no existe/borrado |
| `POST` | `/rebuild` | `{ ok, events:N }` — reconstruye el bundle OKF desde la bitácora | — |
| `POST` | `/rotate` | `{ ok, identity }` — rota la clave del agente y la persiste a disco | — |
| `GET`  | `/log` | `{ events }` — bitácora de eventos (ordenada por `created_at`) | — |
| `GET`  | `/verify` | Corre el gate sobre toda la bitácora | `200` `{ ok:true, count }`, `409` `{ ok:false, reason }` |

### Query params de `GET /collections/:col/records`

| Param | Descripción |
|-------|-------------|
| `tag` | Filtra registros cuyo `tags` contiene el valor |
| `type` | Filtra por campo OKF `type` |
| `q` | Búsqueda de texto (case-insensitive) sobre `title` + `description` + `body` |
| `includeDeleted` | `true` ⇒ incluye registros con `deleted:true` (por defecto se ocultan) |
| `limit` | Tamaño de página (nº máx. de registros devueltos) |
| `offset` | Índice de inicio para paginación |

La respuesta siempre incluye `total` (total de registros que pasan el filtro, sin
paginar), `limit` y `offset`.

Todas las escrituras devuelven el registro OKF proyectado (salvo `DELETE`, que
devuelve `{ id, deleted: true }`). Los errores vienen como
`{ error, details?, gate? }`.

---

## Mapeo CRUD → evento → OKF

| Operación HTTP | Evento (`kind`) | Efecto sobre el OKF |
|----------------|-----------------|---------------------|
| `POST`   `/collections/:col/records` | `record.create` | Crea `data/bundle/records/<col>/<id>.md` |
| `PUT`    `/collections/:col/records/:id` | `record.update` (con `supersedes`) | Reescribe `<id>.md` (conserva `created_at`) |
| `PATCH`  `/collections/:col/records/:id` | `record.update` (con `supersedes`, merge) | Reescribe `<id>.md` combinando con el estado actual |
| `DELETE` `/collections/:col/records/:id` | `record.delete` (tombstone) | Marca `deleted: true` (soft-delete) o borra el archivo si `x-hard-delete: true` |

- `PUT` = reemplazo: el payload enviado se valida como el estado completo.
- `PATCH` = merge: se combina con el estado actual y se valida el resultado.
- En ambos casos se conserva `created_at` y se actualiza `updated_at`.
- Tras cada operación se regeneran `index.md` y `log.md` y (si `GIT_COMMIT="true"`)
  se hace un commit best-effort en `DATA_DIR`.

---

## Servidor MCP (memoria para agentes)

Además de la API REST, la base se expone como **memoria** para un agente externo vía
**MCP** (Model Context Protocol). El servidor MCP es el mismo proceso que conoce la
DB OKF + bitácora; el **agente lo pone el usuario** y se conecta como cliente MCP.

- **Archivo:** `src/mcp.js` · **Script:** `npm run mcp` (=`node src/mcp.js`)
- **Transport:** stdio · **100 % local, sin red.**
- **Dependencia:** `@modelcontextprotocol/sdk`
- **`DATA_DIR`** (default `data`) selecciona el directorio de la DB, igual que en REST.

### Arranque

```bash
npm run mcp                       # usa DATA_DIR=./data
DATA_DIR=/ruta/a/los/datos npm run mcp
```

### Tools expuestas (9)

Todas operan sobre la memoria OKF (mismas colecciones/schemas que la API REST):

| Tool | Argumentos | Qué hace |
|------|------------|----------|
| `memory_collections` | _(ninguno)_ | Lista las colecciones y sus esquemas. |
| `memory_list` | `{ collection, tag?, type?, q?, includeDeleted? }` | Lista registros (con filtros opcionales). |
| `memory_read` | `{ collection, id }` | Lee un registro OKF. |
| `memory_search` | `{ collection, q, limit? }` | Búsqueda de texto sobre `title` / `description` / `body`. |
| `memory_index` | `{ collection? }` | Devuelve el `index.md` (navegación OKF). |
| `memory_create` | `{ collection, payload }` | Crea un registro (valida contra el esquema). |
| `memory_update` | `{ collection, id, payload, merge? }` | Actualiza un registro (`merge` por defecto). |
| `memory_delete` | `{ collection, id }` | Soft-delete del registro. |
| `memory_verify` | `{}` | Verifica la bitácora firmada (equivalente a `GET /verify`). |

### Configuración en un cliente MCP (ej. Claude Desktop)

Bloque para `claude_desktop_config.json`. **Las rutas deben ser absolutas** — ajústalas
a tu máquina:

```json
{
  "mcpServers": {
    "okf-memory": {
      "command": "node",
      "args": ["/ruta/absoluta/al/repo/src/mcp.js"],
      "env": { "DATA_DIR": "/ruta/a/los/datos" }
    }
  }
}
```

### Modelo de recuperación

**NAVEGACIÓN OKF**, no embeddings/vectores: el agente lee `memory_index` →
`memory_list`/`memory_read` y razona sobre el contenido. Apto para el corpus de un
profesional (volumen modesto).

### Privacidad — léelo antes de asumir "sin red"

> **La memoria es local; el eslabón de exposición es el MODELO.**
>
> El servidor MCP no abre sockets hacia fuera y los datos no salen por sí mismos. Pero
> la promesa "sin exponer datos en la red" **solo se cumple si el agente usa un modelo
> LOCAL** (Ollama, LM Studio, llama.cpp…). Si el agente usa un modelo en la **nube**
> (p. ej. Claude, GPT, Gemini vía API), el contenido que le pases viaja a los
> servidores del proveedor: la memoria queda local, pero los datos salen igual por el
> modelo.
>
> Para el modelo de amenazas completo y las limitaciones, ver
> [`SECURITY.md`](SECURITY.md).

---

## CLI (`okf`)

Un único punto de entrada unificado en `bin/okf.js` (expuesto por `package.json`
como `"bin": { "okf": "bin/okf.js" }`). Las dependencias pesadas (Fastify, SDK MCP)
se cargan con import dinámico **solo en el subcomando que las usa**, así `okf verify`
no arranca un servidor.

### Instalación

```bash
# opción A: instala el bin globalmente enlazándolo
npm link              # (o npm i -g .)  -> queda disponible el comando `okf`

# opción B: sin instalar, invoca directamente al intérprete
node bin/okf.js <comando>   # cubre rutas absolutas/relativas
```

### Subcomandos

| Comando | Qué hace | Equivale a |
|---------|----------|------------|
| `okf serve` | Arranca la API REST (Fastify) en `0.0.0.0:PORT`. Env `DATA_DIR`, `PORT`. | `npm start` |
| `okf mcp` | Arranca la memoria MCP por stdio sobre `DATA_DIR`. | `npm run mcp` |
| `okf verify [dir]` | Verifica la bitácora firmada de `<dir>` (o `DATA_DIR`); `exit 0` íntegra, `exit 1` manipulada. | `node src/cli.js verify [dir]` |
| `okf init [path]` | Crea/carga la identidad del agente (default `identities/agent.json`). | `npm run init-identity` |
| `okf help` | Muestra la ayuda y termina `0`. | — |

> Comando desconocido → ayuda + `exit 2`.

### Ejemplo

```bash
okf init                    # crea identities/agent.json
okf serve                   # API REST en :3000
okf verify ./data           # verifica la bitácora de ./data
```

Para el modelo de amenazas y limitaciones, ver [`SECURITY.md`](SECURITY.md).

---

## Despliegue (Docker)

El `Dockerfile` (imagen `node:20-alpine`) arranca la API REST por defecto
(`CMD ["node", "bin/okf.js", "serve"]`). Los datos y la identidad se montan como
**volúmenes** (`/data`, `/app/identities`) para que persistan fuera del contenedor.

```bash
# Build
docker build -t okf-postal-db .

# Run (REST en :3000)
docker run -p 3000:3000 \
  -v "$PWD/data:/data" \
  -v "$PWD/identities:/app/identities" \
  okf-postal-db
```

> Para servir la memoria por **MCP** (stdio) **no** uses este server HTTP: ejecuta
> `docker run -i ... node bin/okf.js mcp` con el stdio conectado al agente/cliente MCP.

Guía paso a paso (instalación, identidad, primer registro, MCP): ver
[`QUICKSTART.md`](QUICKSTART.md).

---

## Instalación y arranque

Requisitos: Node.js >= 18.

```bash
# 1. Instalar dependencias
npm install

# 2. Crear la identidad del agente (par ECDSA P-256 en identities/agent.json)
npm run init-identity
#   -> imprime: identity: <id> -> identities/agent.json

# 3. Arrancar el servidor
npm start
#   -> escucha en 0.0.0.0:3000 por defecto
```

### Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `DATA_DIR` | `data` | Directorio raíz de la DB (contiene `bundle/` y `.postal/`) |
| `PORT` | `3000` | Puerto del servidor |
| `API_KEY` | _(sin definir)_ | Si está definida, exige header `x-api-key` en todas las rutas salvo `GET /health`; si no, **sin auth** |
| `GIT_COMMIT` | _(sin definir)_ | `"true"` ⇒ hace `git add -A` + `git commit` en `DATA_DIR` tras cada escritura (best-effort; requiere repo git ya inicializado; **no** crea el repo) |

Ejemplos:

```bash
# sin auth, sin git
DATA_DIR=./data-demo PORT=4000 npm start

# con auth por API key
API_KEY=secreto123 PORT=3000 npm start

# con commits git automáticos (requiere `git init` previo en DATA_DIR)
GIT_COMMIT=true npm start
```

> La identidad se crea automáticamente en `identities/agent.json` si no existe al
> arrancar; `npm run init-identity` es solo para crearla a propósito.

---

## Ejemplos curl

Asumiendo el servidor en `http://localhost:3000` y la colección de ejemplo `notes`
(schema: `title` **requerido**; `description`, `tags`, `resource`, `body` opcionales).

### Health

```bash
curl -s http://localhost:3000/health
# -> { ok: true, agent: { id, displayName, created_at, signPublicKey, keys:[...] } }
```

### Colecciones disponibles

```bash
curl -s http://localhost:3000/collections
# -> { collections: [ { name:"notes", okfType:"note", hardDelete:false, schema:{...} },
#                      { name:"contacts", okfType:"contact", hardDelete:false, schema:{...} } ] }
```

### CREATE — `POST /collections/notes/records`

```bash
curl -s -X POST http://localhost:3000/collections/notes/records \
  -H "Content-Type: application/json" \
  -d '{
        "title": "Nota de prueba",
        "description": "Una frase",
        "tags": ["foo", "bar"],
        "resource": "https://example.com/x",
        "body": "Cuerpo en **Markdown**."
      }'
# -> 201  { id, collection, type, title, ..., body, created_at, updated_at, _event }
```

Guarda el `id` devuelto para los ejemplos siguientes:

```bash
ID=<pegar-el-id>
```

### LIST — `GET /collections/notes/records`

```bash
# todos
curl -s "http://localhost:3000/collections/notes/records"

# filtrar por tag
curl -s "http://localhost:3000/collections/notes/records?tag=foo"

# filtrar por type
curl -s "http://localhost:3000/collections/notes/records?type=note"

# búsqueda de texto (?q= busca en title + description + body)
curl -s "http://localhost:3000/collections/notes/records?q=Markdown"

# paginación
curl -s "http://localhost:3000/collections/notes/records?limit=10&offset=0"

# incluir borrados
curl -s "http://localhost:3000/collections/notes/records?includeDeleted=true"
```

### READ — `GET /collections/notes/records/:id`

```bash
curl -s "http://localhost:3000/collections/notes/records/$ID"
# -> 200  el registro OKF   (404 si no existe o está borrado)
```

### UPDATE reemplazo — `PUT /collections/notes/records/:id`

```bash
curl -s -X PUT "http://localhost:3000/collections/notes/records/$ID" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Título nuevo", "body": "Reemplazo completo." }'
```

### UPDATE parcial — `PATCH /collections/notes/records/:id`

```bash
curl -s -X PATCH "http://localhost:3000/collections/notes/records/$ID" \
  -H "Content-Type: application/json" \
  -d '{ "tags": ["foo", "bar", "baz"] }'
```

### DELETE (soft-delete) — `DELETE /collections/notes/records/:id`

```bash
curl -s -X DELETE "http://localhost:3000/collections/notes/records/$ID"
# -> { id, deleted: true }   (el frontmatter queda con deleted:true)
```

### Auth con `x-api-key`

Si el servidor arrancó con `API_KEY=secreto123`, toda escritura/lectura (salvo
`/health`) requiere el header:

```bash
# sin header -> 401 { error: "unauthorized" }
curl -s http://localhost:3000/collections/notes/records

# con header -> 200
curl -s -H "x-api-key: secreto123" http://localhost:3000/collections/notes/records

# /health sigue exento
curl -s http://localhost:3000/health
```

### Bitácora — `GET /log`

```bash
curl -s http://localhost:3000/log
# -> { events: [ ...todos los eventos firmados, en orden cronológico... ] }
```

### Rebuild — `POST /rebuild`

```bash
curl -s -X POST http://localhost:3000/rebuild
# -> { ok: true, events: N }   reconstruye el bundle OKF desde la bitácora
```

### Rotación de clave — `POST /rotate`

```bash
curl -s -X POST http://localhost:3000/rotate
# -> { ok: true, identity: { id, displayName, ..., keys:[ {publicKey, from}, ... ] } }
#    el id del agente NO cambia; se agrega una clave vigente al historial.
```

### Verificación — `GET /verify`

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3000/verify
# -> 200  { ok: true, count }   bitácora íntegra
# -> 409  { ok: false, reason } bitácora manipulada (firma/cadena/append rotos)
```

También por CLI:

```bash
npm run verify                 # verifica ./data
node src/cli.js verify demo    # verifica un dataDir arbitrario
```

---

## Cómo configurar nuevas colecciones

Las colecciones se definen con **JSON Schema 2020-12** en
`schema/collections/<col>.schema.json`. Al arrancar, `src/config.js` los carga y
compila un validador ajv por colección. **No hace falta tocar código** para añadir una
colección: basta con crear el schema.

### Colecciones incluidas (9)

Se definen en `schema/collections/*.schema.json` y se cargan dinámicamente al
arrancar (no requiere tocar código). Dos de demostración, cuatro de **dominio**
medicina/legal y tres de **compra-venta** (plantillas de **ejemplo**: no afirman
cumplimiento regulatorio HIPAA/GDPR ni ninguno otro — son puntos de partida a
adaptar).

| Colección | `x-okf-type` | Tipo | Campos | Requerido |
|-----------|--------------|------|--------|-----------|
| `notes` | `note` | demo | `title`, `description`, `tags`, `resource`, `body` | `title` |
| `contacts` | `contact` | demo | `name`, `email` (format `email`), `phone`, `tags`, `resource`, `body` | `name` |
| `patient` | `patient` | dominio (médico) | datos de paciente (ejemplo, sin afirmar cumplimiento HIPAA) | ver schema |
| `prescription` | `prescription` | dominio (médico) | receta (ejemplo, sin afirmar cumplimiento) | ver schema |
| `legal_case` | `legal_case` | dominio (legal) | caso/expediente legal (ejemplo) | ver schema |
| `contract` | `contract` | dominio (legal) | contrato (ejemplo) | ver schema |
| `product` | `product` | dominio (compra-venta) | catálogo: `name`, `sku`, `price`, `currency`, `stock`, `description`, `tags`, `body` | `name` |
| `order` | `order` | dominio (compra-venta) | pedido: `customer`, `items[]` (`sku`,`qty`,`unit_price`), `status`, `total`, `currency`, `placed_date`, `tags`, `body` | `customer`, `items` |
| `payment` | `payment` | dominio (compra-venta) | pago: `order`, `amount`, `currency`, `method`, `status`, `paid_date`, `tags`, `body` | `order`, `amount` |

> **`product` / `order` / `payment` son para MEMORIA + AUDIT-TRAIL del proceso de
> compra-venta, NO un ledger transaccional.** Esta DB no da atomicidad
> multi-registro, no controla concurrencia (un solo escritor) y no enforce
> invariantes de negocio (stock ≥ 0, totales, doble cobro): registrar y auditar el
> historial firmado, no actuar de caja registradora. La lógica de negocio (totales,
> stock, pagos) va en el agente o en un sistema ACID aparte.

Para agregar una colección nueva (p. ej. `tasks`):

1. Crear `schema/collections/tasks.schema.json`:

   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "okf-postal-db/collections/tasks",
     "title": "Task",
     "description": "Tarea de un agente.",
     "x-okf-type": "task",
     "x-hard-delete": false,
     "type": "object",
     "additionalProperties": false,
     "required": ["title"],
     "properties": {
       "type": { "type": "string", "default": "task" },
       "title": { "type": "string", "minLength": 1 },
       "status": { "type": "string", "enum": ["todo", "doing", "done"], "default": "todo" },
       "tags": { "type": "array", "items": { "type": "string" }, "default": [] },
       "body": { "type": "string", "default": "" }
     }
   }
   ```

2. (Re)arrancar el servidor. La colección aparece en `GET /collections` y ya
   acepta `POST /collections/tasks/records`, etc.

### Extensiones `x-*` (ignoradas por ajv, leídas por la app)

| Clave | Default | Significado |
|-------|---------|-------------|
| `x-okf-type` | nombre de la colección | Valor del campo OKF `type` de los registros de esta colección |
| `x-hard-delete` | `false` | `true` ⇒ `DELETE` hace **borrado físico** del archivo OKF en vez de soft-delete (tombstone) |

> El `type` de cada registro se setea automáticamente al `x-okf-type` de la
> colección; el agente **no** necesita enviarlo (y si lo envía, se sobrescribe con
> el valor canónico de la colección).

---

## Auditoría y rotación de clave

La bitácora es la fuente de verdad. Tres propiedades la hacen auditable:

1. **Firma ECDSA P-256 por evento.** Cada evento lleva `sig` sobre
   `canonical(signedView(ev))` (todo el evento salvo `sig`). La clave pública del
   autor está en `identities/agent.json` y su `id` es el fingerprint de esa clave.
   Verificar la firma prueba **autoría e integridad** del evento: cualquier byte
   cambiado invalida la firma.

2. **Append-only.** Cada evento se guarda en su propio archivo
   `data/.postal/events/<id>.json`. El `appendEvent` rechaza escribir sobre un
   `<id>` ya existente. **Borrar o modificar un evento existente** es la huella de
   manipulación más visible (ver `/verify`).

3. **Hash-chain por autor (`seq` + `prev`).** `seq` es un contador por autor
   (0, 1, 2... sin huecos); `prev` es `sha256(canonical(evento anterior del autor))`.
   Reordenar, omitir o insertar eventos rompe la cadena: el `prev` esperado para un
   `seq` dado no coincidirá con el hash del evento que lo precede.

### Cómo se detecta manipulación

`GET /verify` (o `npm run verify` / `node src/cli.js verify [dataDir]`) corre
`src/gate.verifyLog` sobre toda la bitácora y verifica, para cada evento en orden:

- que la **firma** sea válida contra la clave pública del autor;
- que la **cadena** `seq`/`prev` sea consistente (el `prev` calculado del evento
  anterior coincide);
- invariantes de **append-only** (sin huecos ni duplicados en `seq` por autor).

Resultado:

- **`200 { ok:true, count }`** — la bitácora está íntegra: todas las firmas válidas y
  la cadena consistente. El estado OKF es proyección fiel de eventos firmados.
- **`409 { ok:false, reason }`** — la bitácora fue manipulada. El cuerpo indica el
  primer evento/motivo del fallo (`bad-signature`, `prev` roto, `seq` duplicado/hueco,
  etc.). El CLI además termina con **exit 1**.

Para **reconstruir** el bundle OKF desde la bitácora (p. ej. tras un `clone`),
`POST /rebuild` reaplica todos los eventos con `projector.projectAll` y reporta
`{ ok, events:N }`.

### Rotación de clave (`POST /rotate`)

La identidad mantiene un **historial de claves** (`keys[]`, ordenado por `from`).
`POST /rotate`:

- genera una clave nueva ECDSA P-256, la agrega a `keys[]` y la pone como vigente
  (`sign`);
- **persiste** la identidad a disco (`identities/agent.json`) para que la rotación
  sobreviva a reinicios;
- el **`id` del agente no cambia** (deriva de la primera clave, `keys[0]`).

El gate (`src/gate.js`) **resuelve la clave por la fecha del evento**: un evento
viejo verifica con la clave vigente en su `created_at`; un evento nuevo verifica con
la clave actual. Por eso, tras una rotación, **toda la bitácora sigue verificando**
y el `id` del agente permanece estable.

> Recordatorio: **no hay cifrado**. El body de los eventos y los archivos OKF están
> en claro. Esto es una DB transparente, no un canal E2E. La garantía es de
> **integridad y autoría**, no de confidencialidad.

---

## Tests

```bash
npm test
# -> node --test "test/**/*.test.js"
```

**46 tests** (node:test) en `test/`: `db`, `okf-special` (index/log), `contacts`,
`query` (paginación/búsqueda `?q=`), `auth` (API key), `rebuild`, `rotation`,
`rotate-endpoint`, `gitlog`, `mcp` (servidor MCP), `domain-schemas` (medicina/legal),
`commerce-schemas` (compra-venta), `bin` (CLI `okf`). `npm test` → **46/46 verde**.

Los tests cubren el flujo completo (validación, construcción/firma de eventos, gate,
proyección OKF, archivos especiales y los endpoints REST) usando la bitácora y el
bundle reales.

### CLI verify

```bash
npm run verify                 # exit 0 = bitácora válida; exit 1 = inválida
node src/cli.js verify demo    # verifica un dataDir arbitrario
```

---

## Estructura del repo

```
.
├── bin/
│   └── okf.js            # CLI unificado: serve / mcp / verify / init / help (expuesto como bin "okf")
├── src/
│   ├── identity.js     # par ECDSA P-256 + ROTACIÓN (keys[], rotateIdentity, save/load)
│   ├── crypto.js       # primitivas vendorizadas de postal (canonical, sha256, sign/verify)
│   ├── events.js       # construir, firmar, encadenar (nextChain) y persistir eventos
│   ├── gate.js         # verificación de firma + append-only + hash-chain (clave por fecha)
│   ├── okf.js          # estado OKF (Markdown+frontmatter) + index.md/log.md + filtro q
│   ├── projector.js    # aplica eventos -> estado OKF (applyEvent / projectAll)
│   ├── config.js       # registro de colecciones + validación ajv (x-okf-type, x-hard-delete)
│   ├── store.js        # orquestación CRUD (mutex sobre seq) + rotate/rebuild persistentes
│   ├── server.js       # API REST (Fastify): registerRecord/Meta/AdminRoutes + hook apiKeyGuard
│   ├── mcp.js          # servidor MCP (stdio): 9 tools memory_* (memoria para agentes)
│   ├── gitlog.js       # commit git opt-in (GIT_COMMIT="true") best-effort por escritura
│   └── cli.js          # `verify [dataDir]` por CLI (legacy; el unificado es bin/okf.js)
├── schema/collections/
│   ├── notes.schema.json        # demo (x-okf-type "note")
│   ├── contacts.schema.json     # demo (x-okf-type "contact")
│   ├── patient.schema.json      # dominio médico (ejemplo, sin cumplimiento regulatorio)
│   ├── prescription.schema.json # dominio médico (ejemplo)
│   ├── legal_case.schema.json   # dominio legal (ejemplo)
│   ├── contract.schema.json     # dominio legal (ejemplo)
│   ├── product.schema.json      # dominio compra-venta (ejemplo, memoria/audit-trail)
│   ├── order.schema.json        # dominio compra-venta (ejemplo, memoria/audit-trail)
│   └── payment.schema.json      # dominio compra-venta (ejemplo, memoria/audit-trail)
├── Dockerfile          # node:20-alpine, CMD serve
├── QUICKSTART.md       # guía rápida
├── SECURITY.md        # modelo de amenazas y limitaciones
├── data/               # (generado) DATA_DIR: bundle/records + index.md + log.md + .postal/events/
├── identities/         # (generado) agent.json
└── test/               # 39 tests node:test
```

`data/`, `data-*/`, `identities/`, `node_modules/`, `vendor-postal/`, `*.log` y `.pm/`
están excluidos por `.gitignore`.