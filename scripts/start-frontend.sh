#!/bin/sh
set -eu

: "${PORT:=80}"
: "${API_UPSTREAM_URL:=${API_UPSTREAM:-http://api:3000}}"
case "$API_UPSTREAM_URL" in
	http://*|https://*) ;;
	*) API_UPSTREAM_URL="https://$API_UPSTREAM_URL" ;;
esac
API_UPSTREAM_URL="${API_UPSTREAM_URL%/}"
# DNS usado pelo Nginx para achar a API: o da propria plataforma (Railway, Docker), lido de /etc/resolv.conf.
# NGINX_RESOLVER sobrescreve; sem nenhum, cai nos DNS publicos.
if [ -z "${NGINX_RESOLVER:-}" ] || [ "$NGINX_RESOLVER" = "auto" ]; then
	NGINX_RESOLVER=""
	for ns in $(awk '/^nameserver/ { print $2 }' /etc/resolv.conf 2>/dev/null); do
		case "$ns" in *:*) ns="[$ns]" ;; esac
		NGINX_RESOLVER="$NGINX_RESOLVER $ns"
	done
	NGINX_RESOLVER="${NGINX_RESOLVER# }"
	: "${NGINX_RESOLVER:=8.8.8.8 1.1.1.1}"
	# Rede privada do Railway (*.railway.internal) so tem IPv6; fora dela, mantem IPv4 como antes.
	case "$API_UPSTREAM_URL" in *.internal*) ;; *) NGINX_RESOLVER="$NGINX_RESOLVER ipv6=off" ;; esac
fi
# Quem pode informar o IP do cliente via X-Forwarded-For (o proxy da plataforma). Localmente, sem proxy, use 127.0.0.1.
: "${REAL_IP_FROM:=0.0.0.0/0}"
# Segredo compartilhado com a API (PROXY_SHARED_SECRET); vazio = a API usa o TRUST_PROXY dela.
: "${PROXY_SHARED_SECRET:=}"
case "$PROXY_SHARED_SECRET" in *\"*|*\\*) echo "PROXY_SHARED_SECRET nao pode conter aspas ou barra invertida" >&2; exit 1 ;; esac
export API_UPSTREAM_URL NGINX_RESOLVER REAL_IP_FROM PROXY_SHARED_SECRET
envsubst '${API_UPSTREAM_URL} ${PORT} ${NGINX_RESOLVER} ${REAL_IP_FROM} ${PROXY_SHARED_SECRET}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

exec "$@"
