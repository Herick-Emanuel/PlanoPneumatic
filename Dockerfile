# Imagem base: depois de fixar o digest (scripts/pin-docker-digests.sh), o Dependabot (ecossistema docker)
# abre PR quando sair uma versao nova da imagem.
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
# O codigo fica com dono root e somente leitura para o processo: a aplicacao roda como "node" (sem privilegios)
# e nao consegue alterar os proprios arquivos.
COPY backend ./backend
COPY frontend ./frontend
COPY docs/openapi.yaml ./docs/openapi.yaml
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --spider --quiet http://127.0.0.1:3000/health || exit 1
CMD ["node", "backend/server.js"]
