# Segurança (seção 2 do escopo)

Este documento descreve como cada item de segurança do escopo foi tratado, o que precisa ser configurado no
deploy e o que ainda depende de decisão. Os testes ficam em `backend/test/security.test.js` (API) e
`e2e/flows.spec.js` (navegador, incluindo a checagem de que nenhuma tela viola a CSP).

## Antes do próximo deploy (obrigatório)

1. **Troque as chaves do Omie.** Até este commit o `.env.example` (público no GitHub) tinha `OMIE_APP_KEY` e
   `OMIE_APP_SECRET` reais. Elas continuam no histórico do Git: gere chaves novas no Omie
   (Configurações > Integrações > Aplicativos) e atualize só nas variáveis do Railway.
2. **API: defina `APP_ENCRYPTION_KEY`** (32 bytes em base64). Sem ela a API **não sobe em produção**.
   Gere uma vez e guarde em local seguro: perder a chave significa recadastrar os segredos dos webhooks e
   pedir para quem usa MFA ativar de novo.
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. **API e frontend: defina o mesmo `PROXY_SHARED_SECRET`** nos dois serviços
   (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`). É assim que a API sabe o IP
   real de quem acessa (limite de tentativas e auditoria). Sem ele, todos os acessos que passam pelo Nginx
   aparecem com o mesmo IP e o limite por IP passa a valer para a empresa inteira.
4. **Remova `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD`** do Railway se o banco já tem usuários (o log
   avisa enquanto elas existirem). Na primeira subida, a senha de seed precisa ser forte e é trocada
   obrigatoriamente no primeiro login.
5. Depois do deploy, todo mundo precisa **entrar de novo** uma vez: a migration encerra as sessões antigas
   (os tokens que ficaram no `localStorage` deixam de valer) e o service worker novo assume na hora,
   recarregando a página uma vez para não misturar scripts antigos e novos.
6. Homologação (`NODE_ENV=staging`) também exige `APP_ENCRYPTION_KEY`.

## P0

| Item | Como ficou |
| --- | --- |
| XSS e sessão em `localStorage` | O token de sessão fica num cookie `HttpOnly` + `Secure` + `SameSite=Strict` (prefixo `__Host-`), invisível para o JavaScript da página. O navegador guarda só nome/perfil para montar o menu. A API é sempre chamada pela própria origem (o Nginx faz o proxy de `/api`). O login não devolve mais o token no corpo; a API ainda aceita `Authorization: Bearer` para tokens emitidos pelo servidor (uso interno e testes), mas não há emissão de token para integrações externas: para enviar dados a outros sistemas use os webhooks. |
| CSRF | Toda requisição que altera dados com cookie exige o cabeçalho `X-CSRF-Token` (valor do cookie `pp_csrf`, derivado do token da sessão por HMAC). Além disso, requisições com `Origin` de outro site são recusadas (`ORIGIN_NOT_ALLOWED`), o que também bloqueia login CSRF. |
| Login sem limite real | Limite no banco, para qualquer e-mail digitado (existindo ou não, para não revelar contas): por **e-mail + IP**, 4 tentativas livres e a 5ª errada bloqueia por 1 min, depois 2, 4, 8, 16, 32 e no máximo 60 min; e por **e-mail em qualquer IP** (ataque distribuído), a mesma progressão a partir de 20 falhas. Cada tentativa é reservada de forma atômica antes de conferir a senha, então requisições em paralelo não passam do limite. O navegador onde a pessoa já entrou recebe um cookie de "aparelho conhecido" e não passa pelo bloqueio só por e-mail: um atacante não consegue deixar o dono da conta trancado do lado de fora. O administrador (ou o gerente, no time dele) desbloqueia em Usuários > Desbloquear login, ou `npm run unlock-login -- email`. A tabela guarda só hashes. Continua o limite de 20 tentativas por IP em 15 min, com o IP real (veja "IP do cliente"). |
| Senhas padrão | `Admin123!` e `Operador123!` saíram do `docker-compose.yml` e do `.env.example` (o Compose agora exige `SEED_ADMIN_PASSWORD` no `.env`). A API recusa subir com senha de seed fraca, de exemplo ou de placeholder. Usuários criados por seed, pelo administrador ou com senha provisória precisam trocar a senha no primeiro acesso (`PASSWORD_CHANGE_REQUIRED`): até lá, só conseguem trocar a senha ou sair. |
| Recuperação de senha | Dois caminhos. **Pelo administrador:** senha provisória (Usuários > Redefinir senha) e a pessoa cria a própria no próximo acesso. **Pelo e-mail** (só com SMTP configurado): "Esqueci minha senha" no login envia um link de uso único que vale 30 minutos; convites de conta nova usam o mesmo mecanismo com 72 horas. O banco guarda só o hash do token; a resposta é igual exista ou não a conta; o pedido tem limite de tentativas; a nova senha segue a política abaixo; ao trocar, todas as sessões são encerradas, o bloqueio por tentativas do e-mail é liberado e tudo fica na auditoria (`PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_BY_LINK`, `INVITE_SENT`, `INVITE_ACCEPTED`). Sem SMTP, nenhum link é gerado. |

## P1

| Item | Como ficou |
| --- | --- |
| Troca de senha | Exige a senha atual, segue a política e encerra as outras sessões (`POST /api/auth/change-password` e Minha conta). |
| Política de senha | Mínimo de 12 caracteres (máximo de 72 bytes, limite do bcrypt), sem regras artificiais de composição, bloqueando senhas comuns (lista com variações em português e "leet"), sequências numéricas, os exemplos do repositório e o nome/e-mail da pessoa ou o nome da empresa (`backend/security/passwords.js`). |
| Isolamento por time | Configuração **"Gerente vê só o próprio time"** (Configurações > Segurança, só o administrador altera). Ligada, o gerente vê apenas processos criados por ou atribuídos a ele e aos usuários com `manager_id` = ele, em listas, busca, relatórios, exportações e no detalhe. **Vem desligada** para não esconder processos de operadores que ainda não têm time: monte os times em Usuários e depois ligue. Independente da configuração, o gerente só lista, bloqueia e encerra sessões de usuários do próprio time e nunca de administradores (antes ele conseguia bloquear qualquer conta, inclusive de administrador). |
| Escopo do supervisor | Mantido como estava: o supervisor vê todos os processos (`cases.view.all`), atribui, importa e mantém cadastros, mas não administra usuários, configurações nem auditoria. Se a decisão for limitá-lo a um time, a mesma regra do gerente pode ser estendida. |
| Webhooks (SSRF) | O endereço é validado na criação (HTTPS, sem usuário/senha na URL, sem host interno) e **na conexão**: o DNS é resolvido e qualquer IP interno (loopback, redes privadas, link-local/metadados de nuvem 169.254.169.254, CGNAT, IPv6 local, IPv4 mapeado em IPv6, formas numéricas como `2130706433`) recusa a entrega. O IP checado é o mesmo usado na conexão, o que impede DNS rebinding. Redirecionamentos não são seguidos. |
| Segredo do webhook | Guardado cifrado com AES-256-GCM (`APP_ENCRYPTION_KEY`); segredos antigos em texto puro são cifrados automaticamente na subida. O segredo nunca volta pela API. |
| Cabeçalhos HTTP | `helmet` na API (o relatório para impressão `/api/reports/export.html` usa CSP própria com *nonce*, também sem `unsafe-inline`) e cabeçalhos equivalentes no Nginx: CSP sem `unsafe-inline` em scripts **e estilos** (larguras de gráficos passaram para `data-w`/`data-h`, aplicadas por CSSOM), `connect-src 'self'`, `frame-ancestors 'none'`, HSTS de 1 ano (com HTTPS), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP e `Cache-Control: no-store` em `/api`. O E2E falha se qualquer tela gerar violação de CSP. |

## P2

| Item | Como ficou |
| --- | --- |
| Auditoria geral | Tabela `audit_log` com quem, ação, alvo, IP, navegador e request id: login, falha de login, bloqueio, saída, troca e redefinição de senha, sessões encerradas, MFA, usuários, configurações, webhooks e **todos os eventos de processo** (com antes/depois das edições). Tela Auditoria com filtros por ação, processo e período; no processo, o link "Auditoria (IP e alterações)". O gerente vê só a auditoria do próprio time. |
| Sessões | Minha conta mostra as sessões ativas (aparelho, IP, entrada, último uso) com "Encerrar", "Sair dos outros aparelhos" e "Sair de todos". O administrador (ou o gerente, no time dele) encerra as sessões de um usuário. Sessão sem uso por `SESSION_IDLE_MINUTES` (padrão 120) expira; no máximo 10 sessões por pessoa. Limpeza agendada de hora em hora remove sessões vencidas, desafios de MFA, contadores de login antigos e o registro de navegação vencido. |
| Container | A API roda como usuário `node` (sem root), com o código somente leitura. `.env`, chaves e testes ficam fora da imagem (`.dockerignore`). **Digest:** esta sessão não conseguiu acessar o Docker Hub para obter os digests; rode `sh scripts/pin-docker-digests.sh` numa máquina com Docker para fixar `node`, `nginx` e `postgres` por `sha256` (o Dependabot passa a atualizar por PR). |
| LGPD | CPF/CNPJ mascarado nas telas de consulta (`***.456.789-**`; completo só nos formulários de edição). O monitoramento de cliques foi revisto: registra só a tela visitada (sem parâmetros da URL) e cliques em itens do menu ou marcados com `data-track`, nunca o texto do link (que podia conter nome de cliente); pode ser desligado em Configurações e é apagado depois de `ACTIVITY_RETENTION_DAYS` (padrão 90). Ao sair, rascunhos de formulários com dados de clientes são apagados do aparelho. |

## P3: MFA (TOTP)

- Opcional para qualquer perfil em Minha conta: confirma a senha, lê o QR Code (ou digita a chave) no
  Google Authenticator, Microsoft Authenticator, Authy ou 1Password e confirma o código. Não depende de
  serviço externo.
- Gera 10 códigos de recuperação de uso único (para celular perdido); dá para gerar novos com o código atual.
- No login, depois da senha, pede o código. Desafio de 5 minutos com no máximo 5 tentativas (contadas de forma
  atômica, também em paralelo); as falhas contam no bloqueio do e-mail; o mesmo código não vale duas vezes.
- Configuração **"Verificação em duas etapas obrigatória"** (só o administrador): administradores e gerentes
  sem MFA só conseguem ativar o MFA ou sair (`MFA_ENROLLMENT_REQUIRED`). Vem desligada.
- O administrador remove o MFA de quem perdeu o celular e os códigos (Usuários > Remover MFA). A semente
  fica cifrada com `APP_ENCRYPTION_KEY`.

## IP do cliente

O caminho em produção é navegador → proxy do Railway → Nginx (frontend) → API. O Nginx pega o IP real do
`X-Forwarded-For` acrescentado pelo proxy do Railway (`REAL_IP_FROM`, padrão `0.0.0.0/0`) e envia à API em
`X-Real-IP` junto com `X-Proxy-Secret`. A API só aceita esse IP com o segredo certo (`PROXY_SHARED_SECRET`);
sem ele, usa o `trust proxy` do Express (`TRUST_PROXY`, padrão `1` em produção). Quem acessa a API direto não
consegue forjar o IP mandando cabeçalhos.

## Variáveis novas

| Variável | Serviço | Padrão | Para quê |
| --- | --- | --- | --- |
| `APP_ENCRYPTION_KEY` | API | obrigatória em produção | Cifrar segredos de webhook e de MFA |
| `PROXY_SHARED_SECRET` | API e frontend | vazio | IP real do cliente vindo do Nginx |
| `TRUST_PROXY` | API | `1` em produção, `loopback` fora | Saltos de proxy confiáveis (sintaxe do Express) |
| `COOKIE_SECURE` | API | `true` em produção/staging | Cookie só por HTTPS (e prefixo `__Host-`) |
| `SESSION_IDLE_MINUTES` | API | `120` | Expiração por inatividade |
| `ACTIVITY_RETENTION_DAYS` | API | `90` | Retenção do registro de navegação |
| `FRONTEND_ORIGIN` | API | URL do Railway | Origens aceitas em POST/PUT/PATCH/DELETE (pode ser lista separada por vírgula) |
| `SEED_FORCE_PASSWORD_CHANGE` | API | `true` | `false` só em testes automatizados |
| `NODE_ENV` | Compose local | `development` | O `docker compose` sobe em modo desenvolvimento (sem exigir a chave nem cookie `Secure`) |
| `REAL_IP_FROM` | frontend | `0.0.0.0/0` | Quem pode informar o IP do cliente ao Nginx (`127.0.0.1` local) |
| `NGINX_RESOLVER` | frontend | DNS do container (`/etc/resolv.conf`) | DNS do Nginx; sem valor (ou `auto`) usa o da plataforma e cai em `8.8.8.8 1.1.1.1` se não houver |

## Decisões que continuam com vocês

- Ligar "Gerente vê só o próprio time" (depois de montar os times) e se o supervisor também deve ser limitado.
- Ligar "Verificação em duas etapas obrigatória" para administradores e gerentes.
- Política de retenção e exclusão de dados de clientes (LGPD): hoje só o registro de navegação tem prazo.
- Cadastrar o SMTP (liga a recuperação de senha e os convites por e-mail).
