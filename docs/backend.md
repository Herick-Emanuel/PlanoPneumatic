# Backend

O backend do PlanoPneumatic e uma API Express conectada ao PostgreSQL.

## Responsabilidades

- Autenticacao por sessao em cookie HttpOnly com protecao CSRF (ou token Bearer), MFA opcional e limite de login por e-mail ([seguranca.md](seguranca.md)).
- Autorizacao por perfil e por processo.
- Criacao, consulta, edicao e alteracao de status de casos.
- Consulta de pendencias, dashboard e relatorios.
- Administracao de usuarios.
- Inicializacao do schema e seeds de desenvolvimento.

## Executar com Docker

Na raiz do projeto:

```bash
docker compose up -d postgres api
```

A API fica disponivel internamente na porta `3000`. Para consultar os logs:

```bash
docker compose logs -f api
```

O endpoint de disponibilidade e:

```text
GET http://localhost:3000/health
GET http://localhost:3000/health/db
```

Quando acessada pelo frontend Nginx, a mesma verificacao fica em:

```text
GET http://localhost:3000/api/health
```

## Executar sem Docker

Instale as dependencias:

```bash
npm ci
```

Configure as variaveis de ambiente, principalmente `DATABASE_URL`:

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/plano_pneumatic"
$env:PORT = "3000"
$env:HOST = "0.0.0.0"
```

Inicialize o banco:

```bash
npm run migrate
```

Inicie em modo de desenvolvimento:

```bash
npm run dev
```

Ou inicie como processo de producao:

```bash
npm start
```

## Variaveis

| Variavel | Obrigatoria | Uso |
| --- | --- | --- |
| `DATABASE_URL` | Sim | Conexao com PostgreSQL |
| `PORT` | Nao | Porta HTTP, padrao `3000` |
| `HOST` | Nao | Endereco de bind, padrao `0.0.0.0` |
| `DATABASE_POOL_SIZE` | Nao | Limite do pool PostgreSQL |
| `SEED_ADMIN_EMAIL` | Apenas primeiro seed | E-mail do administrador inicial |
| `SEED_ADMIN_PASSWORD` | Apenas primeiro seed | Senha do administrador inicial |
| `SEED_ADMIN_NAME` | Nao | Nome do administrador inicial |
| `SEED_OPERATOR_EMAIL` | Apenas primeiro seed | E-mail do operador inicial |
| `SEED_OPERATOR_PASSWORD` | Apenas primeiro seed | Senha do operador inicial |
| `SEED_OPERATOR_NAME` | Nao | Nome do operador inicial |

Em producao, defina todas as credenciais de seed explicitamente no ambiente. Nao use as senhas do `.env.example`.

## Comandos de verificacao

```bash
node --check backend/server.js
npm run migrate
```

O `migrate` cria as tabelas caso ainda nao existam e executa os seeds iniciais sem duplicar usuarios ou casos existentes.

## Regras importantes

- O banco deve ser persistente em producao.
- A API deve escutar em `0.0.0.0` para funcionar em containers e no Railway.
- O frontend deve acessar a API pelo proxy `/api`.
- Rotas protegidas retornam `401` sem sessao e `403` quando o perfil nao possui permissao.
- Admins podem criar operadores e gerentes; gerentes podem criar apenas operadores.
- O reset de senha usa tokens hash de uso unico, com validade de 30 minutos; o token de desenvolvimento e retornado no header `X-Password-Reset-Token` e nunca e retornado em producao.
