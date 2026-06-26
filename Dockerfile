# Dockerfile — okf-postal-db
# Arranca la API REST por defecto (CMD serve). Para servir la memoria por MCP
# (stdio), NO usar este server HTTP: ejecutar `docker run ... node bin/okf.js mcp`
# con stdio conectado al agente (p.ej. -i con el cliente MCP pegado al stdin/out).
FROM node:20-alpine

WORKDIR /app

# Instala sólo dependencias de producción (usa lockfile si existe).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copia el resto del proyecto.
COPY . .

# Datos e identidades persisten fuera del contenedor (volúmenes).
ENV DATA_DIR=/data
ENV PORT=3000
VOLUME ["/data", "/app/identities"]

EXPOSE 3000

CMD ["node", "bin/okf.js", "serve"]