#!/bin/sh
# Fixa as imagens base dos Dockerfiles e do docker-compose.yml pelo digest (sha256) atual, para que o build
# use sempre exatamente a mesma imagem. Rode em uma maquina com Docker e acesso ao Docker Hub:
#   sh scripts/pin-docker-digests.sh
# Depois o Dependabot (ecossistema docker) atualiza os digests por pull request.
set -eu
cd "$(dirname "$0")/.."
for image in node:24-alpine nginx:1.27-alpine postgres:16-alpine; do
	digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}' | tr -d '"')"
	case "$digest" in sha256:*) ;; *) echo "Nao foi possivel obter o digest de $image" >&2; exit 1 ;; esac
	for file in Dockerfile Dockerfile.frontend docker-compose.yml; do
		# Troca "image:tag" ou "image:tag@sha256:..." por "image:tag@<digest atual>".
		sed -i.bak -E "s#${image}(@sha256:[0-9a-f]{64})?#${image}@${digest}#g" "$file" && rm -f "$file.bak"
	done
	echo "$image -> $digest"
done
