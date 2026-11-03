# ADR 0001 — Decisões da evolução (nov/2026)

Registro das decisões tomadas com o time ao implementar o escopo de evolução. Cada item: contexto, decisão, consequências.

## 1. Anexos guardados no PostgreSQL
- **Contexto:** o sistema só guardava nome e link livre. Era preciso upload real sem nova infraestrutura.
- **Decisão:** coluna `bytea` em `case_attachments` (limite de 10 MB, tipo verificado pelos primeiros bytes), leitura por rota autenticada com `Content-Security-Policy: sandbox`.
- **Consequências:** backup único e consistente; o banco e os dumps crescem com os arquivos. Migrar para S3 depois exige trocar `services/attachments.js` e copiar o conteúdo.

## 2. Status: código estável no banco, rótulo na tela
- **Contexto:** "Concluido" (banco) vs "Concluído" (tela).
- **Decisão:** manter os valores atuais como códigos e servir os rótulos acentuados por `GET /api/meta`. Mensagens e eventos novos usam o rótulo.
- **Consequências:** sem migração de dados; integrações/webhooks continuam recebendo o código. Eventos antigos mantêm o texto original.

## 3. Paginação por página + total
- **Decisão:** `?page`, `?pageSize`, `?sort`, `?direction` com total de páginas (em vez de cursor), porque a ordenação por coluna é requisito de uso.
- **Consequências:** para listas muito grandes a contagem custa mais; os índices (`updated_at`, `type`, trigram) cobrem o volume esperado.

## 4. Migrations como único caminho
- **Decisão:** `backend/migrations/*.sql` em ordem, uma transação por arquivo, `pg_advisory_lock`, sem ferramenta externa. `000_initial_schema.sql` é a base; bancos existentes a reaplicam sem efeito (`IF NOT EXISTS`).
- **Consequências:** não há rollback automático; reverter exige uma migration nova (ou restaurar backup — ver `operacao-suporte.md`).

## 5. Perfis e permissões
- **Decisão:** matriz em `domain/permissions.js`. Supervisor vê tudo e atribui, mas não decide; Técnico decide e escreve laudo; Logística cuida de rastreio e retorno; Auditor só lê e vê a auditoria. Aprovar, improceder e encerrar exigem gerente, técnico ou administrador.
- **Consequências:** a escolha de o supervisor *não* decidir pode ser revista alterando uma linha da matriz.

## 6. Regras de negócio assumidas (editáveis)
- SLA padrão: pedido 3 dias, troca 5, garantia 7 (editável em Configurações); o prazo pausa em "Aguardando documento".
- Documento de origem único por tipo, ignorando casos cancelados ou improcedentes.
- Desativar usuário reatribui os casos abertos ao gerente do time (ou a quem desativou).
- Base de troca só aprova com motivo e condição do item; a triagem rápida (`intake`) cria a troca sem esses campos.

## 7. Dependências adicionadas
`zod` 4 (validação e geração do OpenAPI), `exceljs` e `pdfkit` (exportações), `eslint`/`prettier` e `@playwright/test` (qualidade).
