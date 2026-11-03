# Manual do usuário

## Entrar e navegar
Acesse com seu e-mail e senha. O menu lateral mostra só o que seu perfil pode usar. **Ctrl+K** (ou `/`) abre a busca global por processo, cliente, produto, código, série ou lote. O sino mostra as notificações (atribuições, mudanças de status e prazos).

## Abrir um processo
- **Triagem:** entrada rápida (tipo, cliente, produto). Você pode completar depois na tela do processo.
- **Pedido de venda / Base de troca / Garantia:** formulários completos. O CPF/CNPJ é validado e o valor é formatado. Digite 2+ letras no cliente ou no código do produto para preencher a partir do cadastro. O sistema guarda um **rascunho** no seu navegador; se a conexão cair ao salvar, o processo entra numa fila e é enviado quando a internet voltar.

## Tela do processo
Mostra status, prazo (SLA), responsável, etapas, checklist, anexos, linha do tempo e comentários.
- **Botões de status:** só aparecem as transições válidas para o tipo e para o seu perfil. "O que falta para avançar" lista o que bloqueia o próximo passo.
- **Motivo obrigatório:** ao cancelar ou marcar como improcedente. Reabrir um processo encerrado/cancelado exige justificativa (gerente ou administrador).
- **Concluir/encerrar:** exige checklist completo e ao menos um documento anexado (configurável).
- **Garantia:** o técnico registra o laudo e assume a responsabilidade técnica; ao aprovar escolhe o destino (reposição, devolução, troca ou arquivo).
- **Anexos:** JPG, PNG, WEBP ou PDF até 10 MB, escolhendo o tipo (foto, laudo, comprovante, documento). Laudos só são lidos por quem pode vê-los.
- **Desfazer:** após uma mudança simples de status aparece "Desfazer" por alguns segundos.

## Histórico
Filtre por processo, cliente, produto, código, documento, série/lote, tipo, status, responsável e período; marque "Somente meus casos" ou "Somente atrasados". Ordene clicando nos títulos, salve filtros, exporte em XLSX, PDF ou CSV e (supervisor/gerente) atribua vários processos de uma vez.

## Relatórios
Resumo, por cliente, por produto (reincidência) e por processo, com os mesmos filtros e exportação. **Desempenho por time** permite definir a meta mensal (gerente/administrador).

## Cadastros (conforme o perfil)
Clientes e produtos, importação de pedidos por CSV (modelo para baixar), usuários, auditoria, integrações (webhooks) e configurações (alertas, atualização automática, exigir documentação e SLA por tipo).

## Perfis
| Perfil | O que faz |
|--------|-----------|
| Operador | Abre e acompanha os próprios processos |
| Supervisor | Vê todos, atribui, importa e mantém cadastros; não decide |
| Técnico | Laudo e decisão de garantias e trocas |
| Logística | Rastreio e logística reversa |
| Auditor | Somente leitura e auditoria |
| Gerente | Tudo acima, encerra, reabre, arquiva e gerencia o time |
| Administrador | Acesso total, usuários e integrações |
