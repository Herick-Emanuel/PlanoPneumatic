# Matriz requisito × implementação

Rastreia o escopo de evolução ("Escopo de evolução do PlanoPneumatic", 19/10/2026) contra o código. Status: **Feito** (implementado e testado), **Parcial** (há o essencial; veja a nota) ou **Pendente** (depende de decisão ou de serviço externo).

## 3. Funcionalidades

| Id | Requisito | Status | Onde / como é verificado |
|----|-----------|--------|--------------------------|
| F1 | Persistir campos específicos (vendedor, valor, motivo, condição, origem, rastreio, recebimento, defeito, risco) com validação no servidor | Feito | `migrations/007_case_details.sql`, `validators/cases.js`, `services/cases.js`; teste "each case type persists its specific fields" |
| F2 | Máquina de estados, bloqueio de encerramento, motivo obrigatório, reabertura | Feito | `domain/workflow.js`; testes "transition rules", "cannot close with pending checklist" |
| F3 | Validação CPF/CNPJ, cadastro de clientes e produtos, bloqueio de duplicidade por documento de origem | Feito | `validators/document.js`, `routes/registry.js`, índice `cases_origin_document_unique`; testes de cadastro e duplicidade |
| F4 | Anexos reais (foto/PDF/laudo), limite de tamanho e tipo, tipo e etapa, leitura por perfil | Parcial | `services/attachments.js` (arquivo no PostgreSQL, tipo real por assinatura, 10 MB, laudo restrito). Antivírus opcional **não** implementado |
| F5 | Garantia completa: laudo, decisão, destino, responsável técnico | Feito | `services/cases.js#changeStatus`, tela do caso; teste "warranty needs a technical report" |
| F6 | Pedido: itens múltiplos, totais | Parcial | Itens e total (`case_items`); "validação comercial com divergência de preço" ainda não tem regra específica |
| F7 | Base de troca: avaliação, aprovação/recusa, logística reversa | Feito | Campos de condição/motivo exigidos antes de aprovar; `logistics_status` e rastreio (perfil Logística) |
| F8 | SLA aplicado de verdade (por tipo, cor, alerta, pausa aguardando cliente) | Feito | `due_at`, `services/sla.js`; teste "SLA pauses while waiting for a document" |
| F9 | Central de notificações; e-mail e WhatsApp | Parcial | Sino, central, alertas de SLA por job. **E-mail/WhatsApp pendentes** (precisam de provedor) |
| F10 | Perfis Supervisor, Técnico, Logística, Auditor | Feito | `domain/permissions.js` (matriz), testes de permissão |
| F11 | Relatórios por caso/cliente/produto, XLSX e PDF, agendamento por e-mail | Parcial | `services/exports.js`, `routes/reports.js`. **Agendamento por e-mail pendente** (precisa de SMTP) |
| F12 | Busca global, filtros salvos, filtro por responsável e período, paginação | Feito | `Ctrl+K`, `/api/search`, `saved_filters`, histórico paginado |
| F13 | Editar usuário/perfil, redefinir senha, convite, desativação que reatribui casos | Parcial | Edição, reset pelo admin, reatribuição automática. **Convite por e-mail pendente** |
| F14 | Integração com ERP (Omie) | Pendente | Próxima etapa combinada |
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
| Paginação, período padrão, índices, pg_trgm | Feito | Lista paginada com total e ordenação; índices em `006_integrity.sql`. Relatórios não têm período padrão |
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
| WCAG 2.1 AA | Parcial | Foco visível, rótulos/aria nos componentes novos, diálogos com foco preso, `aria-sort`. **Falta auditoria com leitor de tela** e verificação de contraste das cores de status |
| Skeletons, estados vazios, tentar novamente | Feito | `PP.skeleton/emptyState/errorState` |
| PWA: cache versionado, aviso de nova versão, fila offline | Feito | `sw.js`, `pwa.js`, `PP.outbox` (fila offline cobre a criação de processos) |
| Configurações persistidas no servidor | Feito | `app_settings`, SLA por tipo |

## 6. Operação e qualidade

| Área | Status | Nota |
|------|--------|------|
| Testes (permissão, concorrência, migrations, E2E) | Feito | 37 testes em banco real + 5 E2E |
| CI: Node único, ESLint, `npm audit`, segredos, banco real | Feito | Prettier configurado (`npm run format`), mas o código existente **não foi reformatado** |
| Deploy: sem ação de terceiros, homologação, rollback | Parcial | Workflow reescrito com a CLI da Railway (**não executado**, valide no primeiro deploy); rollback documentado |
| Backup diário, teste mensal de restauração | Feito | `.github/workflows/backup.yml` (exige o secret `BACKUP_DATABASE_URL`) |
| Observabilidade | Parcial | Log JSON com request id, `GET /api/metrics` (Prometheus). Sentry/alertas externos pendentes |
| Configuração sem padrão fixo, `statement_timeout` | Parcial | Validação na subida e timeout feitos; `FRONTEND_ORIGIN`/`API_PUBLIC_URL` ainda têm padrão embutido (aviso no log) e o DNS fixo do Nginx não foi alterado |
| Documentação: matriz, ADRs, manual, runbook | Feito | Este arquivo e `docs/adr`, `manual-usuario.md`, `runbook-incidentes.md` |

## Segurança (fora deste ciclo)

Os itens da seção 2 do escopo (cookies HttpOnly/CSRF, rate limit por e-mail, senhas padrão, e-mail de recuperação, política de senha, isolamento por time do gerente, SSRF por DNS, CSP/helmet, `USER node`, auditoria geral, sessões, LGPD, MFA) **não** foram tratados e seguem para a etapa de segurança.
