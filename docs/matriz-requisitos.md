# Matriz requisito × implementação

Rastreia o escopo de evolução ("Escopo de evolução do PlanoPneumatic", 19/10/2026) contra o código. Status: **Feito** (implementado e testado), **Parcial** (há o essencial; veja a nota) ou **Pendente** (depende de decisão ou de serviço externo).

## 3. Funcionalidades

| Id | Requisito | Status | Onde / como é verificado |
|----|-----------|--------|--------------------------|
| F1 | Persistir campos específicos (vendedor, valor, motivo, condição, origem, rastreio, recebimento, defeito, risco) com validação no servidor | Feito | `migrations/007_case_details.sql`, `validators/cases.js`, `services/cases.js`; teste "each case type persists its specific fields" |
| F2 | Máquina de estados, bloqueio de encerramento, motivo obrigatório, reabertura | Feito | `domain/workflow.js`; testes "transition rules", "cannot close with pending checklist" |
| F3 | Validação CPF/CNPJ, cadastro de clientes e produtos, bloqueio de duplicidade por documento de origem | Feito | `validators/document.js`, `routes/registry.js`, índice `cases_origin_document_unique`; testes de cadastro e duplicidade |
| F4 | Anexos reais (foto/PDF/laudo), limite de tamanho e tipo, tipo e etapa, leitura por perfil | Feito | `services/attachments.js` (arquivo no PostgreSQL, tipo real por assinatura, 10 MB, laudo restrito) e `services/antivirus.js`: ClamAV opcional (`CLAMAV_HOST`; serviço `clamav` no compose, perfil `antivirus`). Infectado é recusado (422); antivírus fora do ar não bloqueia e o anexo fica "Não verificado" |
| F5 | Garantia completa: laudo, decisão, destino, responsável técnico | Feito | `services/cases.js#changeStatus`, tela do caso; teste "warranty needs a technical report" |
| F6 | Pedido: itens múltiplos, totais, validação comercial | Feito | Itens e total (`case_items`). Pedido importado do Omie é conferido em segundo plano; divergência de preço/quantidade/item sinaliza o processo e avisa os gerentes (migration 011) |
| F7 | Base de troca: avaliação, aprovação/recusa, logística reversa | Feito | Campos de condição/motivo exigidos antes de aprovar; `logistics_status` e rastreio (perfil Logística) |
| F8 | SLA aplicado de verdade (por tipo, cor, alerta, pausa aguardando cliente) | Feito | `due_at`, `services/sla.js`; teste "SLA pauses while waiting for a document" |
| F9 | Central de notificações; e-mail e WhatsApp | Feito | Sino e central; cada aviso também sai por e-mail (SMTP genérico, `services/mailer.js`) e WhatsApp (Cloud API da Meta, `services/whatsapp.js`) conforme a escolha da pessoa em Minha conta (celular + opt-in). Envio após o commit, registrado em `notification_deliveries`. Canais ficam desligados até configurar as variáveis |
| F10 | Perfis Supervisor, Técnico, Logística, Auditor | Feito | `domain/permissions.js` (matriz), testes de permissão |
| F11 | Relatórios por caso/cliente/produto, XLSX e PDF, agendamento por e-mail | Feito | `services/exports.js`, `services/reportSchedules.js`: envios diário, semanal ou mensal no horário de São Paulo, com anexo XLSX/PDF/CSV, "Enviar agora", pausar e excluir (Relatórios > Envios agendados) |
| F12 | Busca global, filtros salvos, filtro por responsável e período, paginação | Feito | `Ctrl+K`, `/api/search`, `saved_filters`, histórico paginado |
| F13 | Editar usuário/perfil, redefinir senha, convite, desativação que reatribui casos | Feito | Edição, reset pelo admin, reatribuição automática, "Esqueci minha senha" no login (link de 30 min) e convite por e-mail (link de 72 h para criar a senha; reenvio na lista de usuários) |
| F14 | Integração com ERP (Omie) | Feito | `services/omie.js`, `services/omieImport.js`, migration 010: clientes e produtos (manual e diária, incremental), consulta de pedido/NF no formulário e **tela de seleção** (Cadastros > Pedidos e notas do Omie) para abrir processos a partir de pedidos e NF-e escolhidos, sem duplicar. Validado com as chaves reais |
| F15 | Dashboard avançado (metas, tempo por etapa, reincidência, custo, comparativo mensal) | Feito | `GET /api/reports/advanced`, painel no dashboard |
| F16 | Histórico de peças (série e lote) | Feito | Campos em todos os tipos, filtro `serial`, busca global |

## 4. Sistema e dados

| Item | Status | Onde |
|------|--------|------|
| Número de caso por sequência (tipo + ano) | Feito | `case_sequences`; teste de 100 criações simultâneas |
| Transação por operação de escrita | Feito | `withTransaction`; teste "creation is atomic" |
| Inicialização/migrations em um único client | Feito | `db.js#runMigrations` (advisory lock, uma transação por arquivo) |
| Migrations únicas (sem schema duplicado) | Feito | `000_initial_schema.sql` + 006–009; teste em banco vazio |
| Seed só em desenvolvimento | Feito | `seedDevelopment` vs `seedProduction`; `npm run create-admin` |
| Paginação, período padrão, índices, pg_trgm | Feito | Lista paginada com total e ordenação; índices em `006_integrity.sql`. Relatórios abrem nos últimos 90 dias (`period=all` mostra tudo) |
| Separação do `server.js` e validação por schema | Feito | `routes/`, `services/`, `middleware/`, `validators/` (Zod 4) |
| Status e tipos de uma fonte única | Feito | `domain/constants.js` + `GET /api/meta` (ADR 0001, item 2) |
| Soft delete / bloqueio de exclusão física | Feito | `archived_at` + trigger `cases_no_delete` |
| Erros com ID de correlação, SIGTERM, pool | Feito | `middleware/errors.js`, `server.js` |
| Fuso horário (America/Sao_Paulo) | Feito | `SAO_PAULO_DATE` nos filtros e no dashboard |
| `api.js` único no frontend | Feito | `frontend/js/api.js` |
| OpenAPI gerado do código | Feito | `scripts/generate-openapi.js`; teste de sincronismo |

## 5. Usabilidade e acessibilidade

| Área | Status | Nota |
|------|--------|------|
| Rascunho, autopreenchimento, máscara de CPF/CNPJ e valor, erros ao lado do campo | Feito | Triagem e formulários de processo |
| Fluxo guiado ("o que falta") e tela única do caso | Feito | `caso.html` |
| Paginação, ordenação, filtros salvos, ações em lote, "meus casos" | Feito | Histórico |
| Confirmação antes de cancelar/encerrar, desfazer curto, aviso de sessão expirada | Feito | Diálogos e toast com "Desfazer"; mensagem ao voltar ao login |
| Sino, atalhos (`Ctrl+K`, `/`) | Feito | `shell-tools.js` |
| WCAG 2.1 AA | Feito (automático) | `e2e/a11y.spec.js` roda o axe-core (WCAG 2.1 A/AA) em 15 telas, nos modos claro e escuro, sem violações. **Ainda recomendado:** um teste com leitor de tela (NVDA) feito por uma pessoa |
| Skeletons, estados vazios, tentar novamente | Feito | `PP.skeleton/emptyState/errorState` |
| PWA: cache versionado, aviso de nova versão, fila offline | Feito | `sw.js`, `pwa.js`, `PP.outbox`: a fila offline cobre criação de processos, mudança de status, checklist, comentários, laudo e logística |
| Configurações persistidas no servidor | Feito | `app_settings`, SLA por tipo |

## 6. Operação e qualidade

| Área | Status | Nota |
|------|--------|------|
| Testes (permissão, concorrência, migrations, E2E) | Feito | 37 testes em banco real + 5 E2E |
| CI: Node único, ESLint, `npm audit`, segredos, banco real | Feito | Código reformatado com Prettier e `npm run format` verificado no CI |
| Deploy: sem ação de terceiros, homologação, rollback | Parcial | Workflow reescrito com a CLI da Railway (**não executado**, valide no primeiro deploy); rollback documentado |
| Backup diário, teste mensal de restauração | Feito | `.github/workflows/backup.yml` (exige o secret `BACKUP_DATABASE_URL`) |
| Observabilidade | Feito | Log JSON com request id, `GET /api/metrics` (Prometheus), Sentry opcional (`SENTRY_DSN`) para erros do servidor e do navegador (`POST /api/client-errors`) |
| Configuração sem padrão fixo, `statement_timeout` | Feito | Em produção a API não sobe sem `FRONTEND_ORIGIN` e `API_PUBLIC_URL` (https, sem barra final). O Nginx usa o DNS da própria plataforma (`/etc/resolv.conf`, ou `NGINX_RESOLVER`) |
| Documentação: matriz, ADRs, manual, runbook | Feito | Este arquivo e `docs/adr`, `manual-usuario.md`, `runbook-incidentes.md` |

## Segurança (fora deste ciclo)

Os itens da seção 2 do escopo (cookies HttpOnly/CSRF, rate limit por e-mail, senhas padrão, e-mail de recuperação, política de senha, isolamento por time do gerente, SSRF por DNS, CSP/helmet, `USER node`, auditoria geral, sessões, LGPD, MFA) **não** foram tratados e seguem para a etapa de segurança.
