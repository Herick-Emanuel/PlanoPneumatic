# Runbook de incidentes

Toda resposta da API traz `X-Request-Id`; peça esse ID ao usuário e procure-o nos logs (`requestId`). Logs são JSON: `event`, `method`, `path`, `status`, `durationMs`.

## Checagens rápidas
| Sintoma | Verifique |
|---------|-----------|
| Tela diz "sem conexão" | `GET /health` (API) e `GET /api/health` (via frontend). 503 = banco indisponível |
| Muitos erros 500 | Logs `http_error` (traz o `requestId` e o erro). Se for `statement timeout`, veja consultas lentas |
| Lentidão | `GET /api/metrics` (com `METRICS_TOKEN`): `pp_http_request_duration_ms`, `pp_db_pool_connections{state="waiting"}` |
| Usuários não veem prazos/alertas | Configuração "Alertas de prazo"; job de SLA (`sla_alerts_sent` nos logs a cada 15 min) |
| Webhook não chega | Integrações → Entregas (tentativas e erro); `pp_webhook_deliveries_24h{result="failed"}` |
| Tela antiga após deploy | O PWA avisa "Nova versão disponível"; confira que `BUILD_ID` mudou no deploy |

## Banco indisponível
1. Confirme o serviço do PostgreSQL no provedor e `DATABASE_URL`.
2. A API volta sozinha quando o banco volta (o pool reconecta); reinicie o serviço se não voltar.
3. Se houve perda de dados, restaure o último backup (abaixo).

## Migration falhou no deploy
A API não sobe (`startup_error`, mensagem "Migration NNN falhou"). A migration roda em transação e foi revertida por inteiro. Corrija o SQL e faça novo deploy, ou volte o deploy anterior (rollback abaixo).

## Rollback de deploy
1. Railway → serviço → Deployments → escolha a última versão estável → **Redeploy**; ou reverta o commit em `main` e deixe o CI publicar.
2. Migrations já aplicadas **não** são desfeitas. As migrations 006–009 só adicionam colunas/tabelas, então a versão anterior da API continua funcionando; se uma migration futura for destrutiva, restaure o backup anterior ao deploy.

## Restaurar backup
1. Baixe o artefato `backup-<id>` do workflow "Backup do banco" (retém 30 dias) ou use `scripts/backup-postgres.*`.
2. Restaure em um banco novo e valide: `gunzip -c backup.dump.gz > backup.dump && pg_restore --no-owner -d <url> backup.dump`.
3. Aponte `DATABASE_URL` para o banco restaurado (ou restaure sobre o atual com a API parada).
4. O teste mensal automático imprime `cases=` e `users=` do banco restaurado; confira se bate com a produção.
Metas sugeridas: RPO de 24 h (backup diário) e RTO de 1 h — ajuste conforme a necessidade do negócio.

## Primeiro administrador / acesso perdido
`ADMIN_PASSWORD='...' npm run create-admin -- email@empresa.com "Nome"` (idempotente: não altera quem já existe). Para trocar a senha de um usuário, o administrador usa Usuários → Redefinir senha.

## Fila de SLA ou notificações duplicadas
O job marca `sla_notified_at`; para reenviar um alerta, zere o campo do caso (`UPDATE cases SET sla_notified_at = NULL WHERE case_number = '...'`).
