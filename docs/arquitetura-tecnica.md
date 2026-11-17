# Arquitetura técnica e stack utilizada

Este documento explica **como** o Plano Pneumatic foi construído, **quais ferramentas** foram usadas e **por que** cada decisão foi tomada. Para uma descrição do que o sistema faz, veja [visao-geral-e-funcionalidades.md](visao-geral-e-funcionalidades.md).

## 1. Visão geral da stack

| Camada | Tecnologia | Por quê |
| --- | --- | --- |
| Backend/API | Node.js 24 + Express | Framework leve, sem opinião excessiva, suficiente para uma API REST de porte médio sem exigir um framework "enterprise" |
| Banco de dados | PostgreSQL 16 | Relacional, transacional, adequado ao domínio (casos, usuários, auditoria) com relações claras entre tabelas |
| Acesso a dados | `pg` (driver nativo, SQL puro) | Sem ORM: consultas explícitas, mais fáceis de auditar/otimizar em um domínio que ainda está evoluindo rápido |
| Autenticação | Sessão por token *bearer* (hash SHA-256, armazenado em tabela `sessions`) | Mais simples que cookies + CSRF em uma API consumida por um front separado; token expira e pode ser revogado no servidor |
| Frontend | HTML + CSS + JavaScript "vanilla" (sem framework, sem bundler) | O app é um conjunto de páginas de operação (não uma SPA complexa de estado global); evitar um framework grande reduz build step, dependências e tempo de carregamento |
| Servidor estático (produção) | Nginx (imagem própria) | Serve arquivos estáticos com muito mais eficiência que Node para esse fim, e faz proxy `/api` para o backend |
| Servidor estático (alternativo) | Express (`express.static`) no próprio backend | Permite rodar tudo (API + frontend) em um único serviço/contêiner quando necessário (ex.: certos ambientes do Railway) |
| Containers | Docker + Docker Compose | Ambiente reprodutível local e em produção, isolando banco, API e frontend |
| CI/CD | GitHub Actions | Testes, `docker build` de validação e deploy automático (Railway) a cada push em `main` |

## 2. Backend

### 2.1 Por que Express "puro"
Não há camada de ORM (Sequelize/Prisma) nem framework de rotas adicional. O arquivo `backend/server.js` concentra rotas, middlewares de permissão e regras de negócio. Essa escolha prioriza:
- **Transparência**: toda query SQL é visível e ajustável sem "mágica" de um ORM.
- **Zero build step**: `node backend/server.js` roda direto.
- **Baixo acoplamento**: trocar de banco ou extrair um módulo depois é uma decisão isolada, não uma dependência estrutural do framework.

### 2.2 Autenticação e autorização
- Login gera um token aleatório; apenas o **hash** do token fica no banco (`sessions.token_hash`), então um vazamento do banco não expõe tokens utilizáveis.
- No navegador o token vai num cookie `HttpOnly` + `SameSite=Strict` e as alterações exigem `X-CSRF-Token`; `Authorization: Bearer <token>` continua aceito para tokens emitidos pelo próprio servidor (uso interno e testes). Detalhes (limite de login, MFA, auditoria) em [seguranca.md](seguranca.md).
- Autorização é feita por **capacidades** (`capabilities`), não só por papel: existe uma matriz (`permissionMatrix`) que mapeia `role → lista de capabilities`, e um middleware `requireCapability(capability)` que barra a requisição com `403` se o usuário não tiver a capacidade — isso deixa explícito, rota a rota, o que cada perfil pode fazer, em vez de espalhar `if (role === "admin")` pelo código.

### 2.3 Banco de dados e migrations
- Schema inicial é criado por `backend/db.js` (tabelas base: `users`, `sessions`, `cases`, `case_events`, etc.).
- Evoluções de schema vivem em `backend/migrations/*.sql`, numeradas e aplicadas em ordem, com controle de quais já rodaram (evita re-executar).
- Optou-se por **SQL puro versionado** em vez de um framework de migration (ex.: knex/umzug) para manter a mesma filosofia "sem camada extra" do resto do backend.

### 2.4 Efeitos colaterais desacoplados
- **Webhooks**: o disparo para sistemas externos é assinado com HMAC-SHA256 (`X-Webhook-Signature`), roda de forma assíncrona e **nunca derruba a requisição principal** se falhar (erro é logado, não propagado).
- **Notificações** e **auditoria** são gravadas como efeito colateral das rotas de caso/usuário, no mesmo fluxo de request, para manter consistência simples (sem fila/mensageria — desnecessário no volume atual).

## 3. Frontend

### 3.1 Por que sem framework/bundler
O frontend é um conjunto de páginas de operação (dashboard, formulários, listas, relatórios) com necessidade moderada de interatividade — não é um SPA de estado complexo. Um framework (React/Vue) + bundler (Vite/Webpack) adicionaria:
- Build step e dependências de build.
- Uma camada de abstração desnecessária para o problema (formulários, tabelas, fetch).

Em vez disso, cada página é um HTML próprio, com JS específico da tela e um "shell" compartilhado (ver 3.3) para não duplicar cabeçalho, menu lateral e navegação.

### 3.2 Organização em pastas (`frontend/`)
```
frontend/
  html/     todas as páginas (.html)
  js/       todo o JavaScript
  css/      todo o CSS, dividido por página
  icons/    ícones do PWA (gerados, ver scripts/generate-icons.ps1)
  logo.png, manifest.json, sw.js   arquivos de raiz do PWA
```
Essa separação por tipo (em vez de tudo solto na raiz de `frontend/`) foi adotada para:
- Facilitar localizar arquivos por natureza (estilo vs. comportamento vs. marcação).
- Deixar claro o que é "app shell" (PWA: manifest/sw/ícones) do que é conteúdo de página.
- Preparar o projeto para crescer sem virar uma pasta única com dezenas de arquivos misturados.

As **URLs continuam as mesmas de antes** (`/base-troca.html`, `/app.js` etc.) — só a localização física dos arquivos mudou. Isso é resolvido em tempo de infraestrutura:
- **Nginx**: a regra `try_files /html$uri $uri $uri/ /html/index.html;` tenta primeiro o caminho dentro de `html/` (para páginas), depois o caminho literal (para `css/`, `js/`, `icons/`), e por fim cai no `index.html` como fallback de SPA.
- **Express**: dois `express.static` encadeados — um para a raiz de `frontend/` (css/js/icons/manifest/sw) e outro para `frontend/html/` (páginas) — resolvem o mesmo problema quando o backend serve o frontend diretamente.

### 3.3 CSS dividido por página
Em vez de um único `styles.css` gigante, existe:
- `base.css`: reset, tipografia, layout comum (menu lateral, topo, tabelas, botões, formulários, modais) e as regras de responsividade que dependem desse layout comum.
- Um arquivo por grupo de página: `dashboard.css`, `triagem.css`, `process.css` (pedido de venda/base de troca/garantia, que compartilham estrutura), `historico.css`, `admin.css` (cadastros/configurações/conta/relatórios).

Cada página carrega `base.css` + o seu arquivo específico. O critério de corte foi: **uma regra só sai de `base.css` se todos os seletores daquela regra pertencem exclusivamente a um grupo de páginas** — isso evita duplicar ou quebrar componentes que são, na prática, compartilhados (ex.: `.panel`, `.table-status`).

### 3.4 Navegação "SPA-like" (`shared-shell.js`)
Para dar sensação de aplicativo (sem recarregar a página inteira a cada clique no menu), `shared-shell.js` implementa:
- Interceptação de cliques em links do menu.
- Busca (`fetch`) do HTML da página de destino e substituição apenas do conteúdo (`.dashboard-content`), preservando o menu lateral.
- Sincronização dos atributos do `<main class="dashboard-layout" data-...>` (necessário porque várias regras de CSS dependem desses atributos para travar o scroll da página certa).
- Sincronização das tags `<link rel="stylesheet">` do `<head>` — necessária **depois** da divisão de CSS por página (item 3.3): cada página pode ter um CSS diferente, então a troca de página via SPA precisa trocar também o CSS carregado.
- Cache em memória das páginas já visitadas, breadcrumb, rastreamento leve de navegação/clique (`POST /api/activity`) e reexecução dos `<script>` da página carregada.

Optou-se por esse mecanismo "artesanal" em vez de um router de SPA/framework porque as páginas continuam sendo documentos HTML completos e independentes (funcionam sozinhas, com F5 ou acesso direto pela URL) — o JS só otimiza a transição quando a navegação acontece pelo menu.

### 3.5 PWA (Progressive Web App)
- `manifest.json`: nome, ícones, cor de tema, modo `standalone` (some a barra do navegador quando instalado).
- `sw.js` (service worker): cacheia o "app shell" (HTML/CSS/JS/ícones) na instalação; para navegações usa **network-first** (sempre tenta buscar a versão mais nova, cai para cache se offline); para os demais recursos usa **cache-first com atualização em segundo plano**; chamadas a `/api/*` nunca passam pelo cache.
- `pwa.js`: registra o service worker em todas as páginas e captura o evento `beforeinstallprompt` do navegador, guardando-o para ser usado pelo botão de instalação.
- O botão de instalação foi colocado **apenas na tela de login** (`app.js` decide se mostra, com base no evento capturado e em `display-mode: standalone`), porque o pedido de produto foi "instalar como app" ser uma ação deliberada do usuário, não um banner insistente em toda tela.
- Os ícones do app são **gerados por script** (`scripts/generate-icons.ps1`, usando `System.Drawing`), porque o logo institucional (`logo.png`/`LogoPneumatic.png`) é um retângulo 170×52 — inadequado como ícone quadrado de app — e não havia uma arte quadrada pronta.

### 3.6 Responsividade em camadas
Além dos breakpoints tradicionais (`max-width`), foram usados dois recursos de CSS para separar "tela pequena" de "dispositivo touch":
- Faixas de largura intermediárias (ex.: `961px–1180px`) para tablets, em vez de pular direto do layout desktop para o mobile.
- `@media (pointer: coarse)`, que aumenta alvos de toque (botões, linhas de tabela, itens de menu) especificamente em dispositivos touch, independentemente da largura da tela — ou seja, um desktop com mouse não é afetado, mas um tablet touch de qualquer tamanho recebe alvos maiores.

## 4. Infraestrutura e deploy

### 4.1 Containers (Docker Compose)
Três serviços:
1. **postgres** — banco de dados, com volume persistente e healthcheck (`pg_isready`).
2. **api** — backend Node/Express (`Dockerfile`), health check em `/health/db`, não expõe porta publicamente (só acessível pelos outros serviços).
3. **frontend** — Nginx (`Dockerfile.frontend`), é o único serviço com porta publicada, serve os arquivos estáticos e faz proxy de `/api/*` para o serviço `api`.

Por que dois Dockerfiles (`Dockerfile` e `Dockerfile.frontend`) em vez de um só: o backend precisa de runtime Node; o frontend é só arquivos estáticos, e servir isso com Nginx é mais leve e mais rápido do que usar Node/Express só para estático. Além disso, alguns ambientes de deploy (Railway) preferem/exigem serviços separados por Dockerfile.

### 4.2 `Dockerfile` também consegue servir o frontend sozinho
O backend também tem `express.static` apontando para `frontend/`, então em ambientes que rodam **um único serviço** (API + frontend juntos), o próprio Node consegue servir tudo — sem depender do Nginx. Essa redundância deliberada existe para suportar diferentes topologias de deploy sem duplicar código de rota.

### 4.3 CI/CD (GitHub Actions)
`.github/workflows/ci.yml`:
1. Instala dependências e roda `npm test`.
2. Valida sintaxe do backend (`node --check`).
3. Valida `docker compose config` e builda as duas imagens (API e frontend) para garantir que o `Dockerfile`/`Dockerfile.frontend` continuam funcionando.
4. Em push para `main`, faz deploy dos dois serviços no Railway.

### 4.4 Testes
`backend/server.test.js` usa o runner nativo do Node (`node --test`, via `npm test`) — sem framework de testes adicional (Jest/Mocha), pela mesma filosofia de menos dependências, já que o Node moderno tem um runner de testes suficiente para o escopo atual.

## 5. Resumo das decisões e trade-offs

| Decisão | Ganho | Custo aceito |
| --- | --- | --- |
| Sem ORM | Controle total do SQL, sem "mágica" | Mais verboso, exige disciplina para evitar SQL duplicado |
| Sem framework front-end | Zero build step, deploy simples (estático) | Sem componentização "real"; reutilização depende de convenção (shared-shell, case-editor) |
| CSS dividido por página | Cada página carrega só o que usa, mais fácil de localizar estilos | Precisa manter `shared-shell.js` sincronizando `<link>` na navegação SPA |
| Dois servidores estáticos possíveis (Nginx e Express) | Flexibilidade de topologia de deploy | Duas configurações a manter em paralelo (`nginx.conf` e as rotas do `server.js`) |
| Migrations SQL manuais | Simplicidade e controle explícito | Sem rollback automático; exige disciplina na numeração/ordem |
