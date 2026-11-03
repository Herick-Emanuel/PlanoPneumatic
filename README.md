# PlanoPneumatic

Aplicacao operacional para acompanhar pedidos de venda, bases de troca e garantias, desde a triagem ate o encerramento do processo.

## Visao geral

O projeto possui frontend estatico, API HTTP em Express e PostgreSQL.

```mermaid
flowchart LR
    U[Usuario] --> F[Frontend Nginx]
    F -->|/api| A[API Express]
    A --> D[(PostgreSQL)]
```

### Principais areas

- Dashboard operacional com indicadores, atencao e proximas acoes.
- Triagem de pedidos de venda, bases de troca e garantias.
- Historico com filtros, consulta de detalhes, alteracao de status e edicao de dados.
- Relatorios operacionais.
- Administracao de usuarios e criacao de contas.
- Conta do usuario e configuracoes do sistema.

## Requisitos

- Docker Desktop com Docker Compose.
- Ou Node.js 20+ e PostgreSQL 16+ para executar os processos separadamente.
- PowerShell, Bash ou terminal equivalente.

## Executar localmente

A forma recomendada e subir os tres servicos com Docker Compose:

```bash
docker compose up -d --build
```

Acesse:

- Aplicacao: http://localhost:3000
- Health check da API: http://localhost:3000/health
- Health check atraves do frontend: http://localhost:3000/api/health

Para acompanhar os logs:

```bash
docker compose logs -f api
docker compose logs -f frontend
```

Para parar os containers sem remover os dados do PostgreSQL:

```bash
docker compose down
```

Para remover tambem o volume local do banco, somente quando for necessario recriar o ambiente:

```bash
docker compose down -v
```

## Acesso de desenvolvimento

Os usuarios iniciais sao criados na primeira inicializacao do banco. Os valores padrao estao em `.env.example` e servem apenas para desenvolvimento local.

- Administrador: `admin@planopneumatic.com`
- Operador: `operador@planopneumatic.com`

Altere as senhas antes de compartilhar o ambiente ou publicar a aplicacao.

## Estrutura do projeto

```text
backend/
  app.js, server.js  Express (app) e inicializacao (migrations, agendador de SLA, SIGTERM)
  config.js          Variaveis de ambiente e validacao na subida
  db.js              Pool, transacoes, migrations com advisory lock, seeds
  domain/            Tipos, status, papeis, permissoes e maquina de estados (fonte unica)
  validators/        Schemas Zod e validacao de CPF/CNPJ
  services/          Regras de negocio (casos, anexos, SLA, relatorios, exportacoes, webhooks...)
  routes/            Rotas HTTP por area
  middleware/        Autenticacao, erros com request id, cabecalhos e rate limit
  migrations/        Unico caminho de schema (000 = base, 006+ = evolucao)
  scripts/           Comandos operacionais (create-admin)
  test/              Testes em banco real (API, permissoes, concorrencia, migrations)
frontend/            HTML/CSS/JS do navegador (api.js = sessao/fetch/formatadores comuns)
e2e/                 Testes Playwright dos fluxos de triagem a encerramento
docs/                Requisitos, ADRs, manual, runbook e OpenAPI gerado
scripts/             Backup/restore, geracao do OpenAPI, healthchecks
```

## Documentacao tecnica

- [Executar o backend](docs/backend.md)
- [Executar o frontend](docs/frontend.md)
- [Publicar no Railway](docs/railway.md)
- [Operacao e suporte](docs/operacao-suporte.md)
- [Runbook de incidentes](docs/runbook-incidentes.md)
- [Manual do usuario](docs/manual-usuario.md)
- [Matriz requisito x implementacao](docs/matriz-requisitos.md)
- [Decisoes de arquitetura (ADR)](docs/adr/0001-decisoes-de-evolucao.md)
- [Requisitos funcionais](docs/)

## API

A especificacao completa (72 rotas, com schemas de entrada) fica em [docs/openapi.yaml](docs/openapi.yaml) e e servida em `GET /api/openapi.yaml`; ela e gerada do codigo e o CI falha se ficar desatualizada. Principais grupos: `/api/auth`, `/api/cases` (lista paginada, detalhe, status, anexos, checklist, comentarios, atribuicao, arquivamento), `/api/customers` e `/api/products`, `/api/reports` (XLSX/PDF/CSV), `/api/users`, `/api/notifications`, `/api/search`, `/api/settings`, `/api/sla` e `/api/integrations/webhooks`.

As rotas protegidas exigem o header `Authorization: Bearer <token>`. Erros de validacao devolvem `code: VALIDATION_ERROR` e `errors[]` por campo; regras de negocio devolvem 422 com `code`; toda resposta traz `X-Request-Id`.

## Qualidade antes do deploy

Os testes rodam contra um PostgreSQL real (o nome do banco deve conter `test`). Com o Docker Compose ativo, crie os bancos de teste uma vez:

```bash
docker run -d --name pp-test-db -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
docker exec pp-test-db psql -U postgres -c "CREATE DATABASE plano_pneumatic_test"
docker exec pp-test-db psql -U postgres -c "CREATE DATABASE plano_pneumatic_migrations_test"
docker exec pp-test-db psql -U postgres -c "CREATE DATABASE plano_pneumatic_e2e"
```

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/plano_pneumatic_test
export E2E_DATABASE_URL=postgres://postgres:postgres@localhost:55432/plano_pneumatic_e2e
npm run lint        # ESLint
npm test            # API, permissoes, numeracao concorrente, migrations em banco limpo, OpenAPI sincronizado
npm run e2e         # Playwright: triagem -> encerramento, XSS, busca global
npm run docs:api    # regenera docs/openapi.yaml a partir das rotas e dos schemas
npm audit --omit=dev --audit-level=high
docker compose config
```

As migrations SQL ficam em `backend/migrations` e sao o unico caminho de schema: aplicadas em ordem, uma transacao por arquivo, sob `pg_advisory_lock`, com controle em `schema_migrations`. Dados de exemplo e usuarios de demonstracao so existem fora de producao; em producao crie o primeiro administrador com:

```bash
ADMIN_PASSWORD='uma-senha-forte' npm run create-admin -- admin@empresa.com "Nome do Admin"
```

(se a tabela de usuarios estiver vazia, `SEED_ADMIN_EMAIL` e `SEED_ADMIN_PASSWORD` tambem criam o primeiro administrador na subida).

## Versionamento e publicacao

O nome recomendado para o repositorio e `PlanoPneumatic`. Antes de publicar:

1. Remova ou substitua credenciais de desenvolvimento.
2. Confirme que `.env` nao esta sendo versionado.
3. Execute os checks acima.
4. Inicialize o repositorio Git e crie o primeiro commit.
5. Conecte o repositorio remoto.
6. Configure os servicos do Railway conforme [docs/railway.md](docs/railway.md).

Nao coloque senhas, tokens ou `DATABASE_URL` no repositorio.

## CI/CD e ambientes

O workflow `.github/workflows/ci.yml` roda lint, `npm audit`, varredura de segredos (gitleaks), testes com PostgreSQL real, E2E e builds das imagens em pull requests e na `main`. A homologacao (`deploy-staging`) e opcional: ative com a variavel de repositorio `STAGING_ENABLED=true` e os secrets `RAILWAY_STAGING_*`. O deploy de producao usa a CLI oficial da Railway, exige o ambiente protegido `production` e os secrets `RAILWAY_TOKEN`, `RAILWAY_API_SERVICE` e `RAILWAY_FRONTEND_SERVICE`. Rollback e restauracao: [docs/runbook-incidentes.md](docs/runbook-incidentes.md).

`.github/dependabot.yml` mantem npm, Docker e GitHub Actions atualizados. `.github/workflows/backup.yml` faz o dump diario (artefato com retencao de 30 dias, fora do provedor) e o teste mensal de restauracao; configure o secret `BACKUP_DATABASE_URL`.

Use `.env.homolog.example` e `.env.production.example` como modelos; valores reais ficam nos secrets da plataforma. Novas variaveis: `BUILD_ID` (versiona o cache do PWA), `MAX_ATTACHMENT_BYTES`, `DATABASE_STATEMENT_TIMEOUT_MS`, `METRICS_TOKEN` (habilita `GET /api/metrics`), `SLA_CHECK_INTERVAL_MS`.
