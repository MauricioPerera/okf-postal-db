# Quickstart — okf-postal-db

Memoria/KB local para agentes: estado materializado en OKF (Markdown+YAML) +
bitácora firmada append-only, expuesta vía REST y MCP. 100% local.

## Requisitos

- Node.js **>= 18**.
- Dependencias: `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `fastify`,
  `gray-matter` (se instalan con `npm install`).

## Instalación

```bash
npm install
```

Inicializa la identidad del agente (par de claves ECDSA P-256):

```bash
node bin/okf.js init
# o, si instalaste globalmente:
npm i -g .        # (o npm link) y luego:
okf init
```

El archivo de identidad queda en `identities/agent.json` (mencionar ruta si no es
la default: `okf init /ruta/agent.json`).

## Uso

Arrancar la **API REST** (Fastify):

```bash
okf serve
# VARIABLES: DATA_DIR (directorio de datos, default "data"), PORT (default 3000)
DATA_DIR=/ruta/a/los/datos PORT=4000 okf serve
```

Arrancar la **memoria MCP** (stdio, para un agente externo):

```bash
okf mcp
# usa DATA_DIR (default "data")
DATA_DIR=/ruta/a/los/datos okf mcp
```

**Verificar la bitácora** firmada (cadenas por autor + firmas ECDSA):

```bash
okf verify            # verifica DATA_DIR
okf verify /ruta/dir  # verifica un directorio concreto
# exit code 0 = íntegra, 1 = fallo (detalla el motivo en JSON)
```

## Conectar un agente (Claude Desktop)

Apunta la config MCP del cliente a `okf` por stdio, con **rutas absolutas**:

```jsonc
{
  "mcpServers": {
    "okf-postal-memory": {
      "command": "node",
      "args": ["/ruta/absoluta/al/repo/bin/okf.js", "mcp"]
    }
  }
}
```

Detalles completos en la sección **MCP** del `README.md`.

## Docker

```bash
docker build -t okf-postal-db .
docker run -p 3000:3000 \
  -v "$PWD/data:/data" \
  -v "$PWD/identities:/app/identities" \
  okf-postal-db
```

Para servir MCP por stdio dentro de un contenedor, **no** uses el server HTTP:
ejecuta `docker run ... node bin/okf.js mcp` con el stdio conectado al agente.

## Cifrado en reposo

La DB **no cifra a nivel aplicación**: hacerlo rompería el texto legible OKF
(la transparencia es una característica, no un bug). Para confidencialidad en
reposo usa **cifrado de disco del SO**: BitLocker (Windows), FileVault (macOS),
LUKS o VeraCrypt (Linux). Ver `SECURITY.md`.

## Privacidad ("sin datos en la red")

Para que la memoria sea estrictamente local, el **modelo/agente que la consume
debe ser LOCAL** (Ollama, LM Studio). Un modelo en la nube envía contexto fuera
del equipo. Ver `SECURITY.md`.