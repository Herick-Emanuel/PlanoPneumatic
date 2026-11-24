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

## Guia do app
O ícone de **caderno** no topo de toda tela (ou a tecla **F1**) abre o Guia do app já na explicação da tela atual: para que serve, passo a passo e dicas. O guia tem busca e mostra só as telas que o seu perfil acessa.

## Relatórios
Resumo, por cliente, por produto (reincidência) e por processo, com os mesmos filtros e exportação. **Desempenho por time** permite definir a meta mensal (gerente/administrador).
- **Exportar em cada relatório:** toda tabela tem os botões Excel, CSV e PDF, que baixam exatamente o que está na tela.
- **Abrir planilha (importar para comparar):** carrega um .xlsx ou .csv exportado antes e compara com a tabela atual pela primeira coluna, mostrando o que mudou, o que é novo e o que só existe na planilha. Nada é gravado no sistema.
- **Construtor de relatórios (gerente/administrador):** escolha a fonte (processos ou eventos), lista ou totais agrupados, colunas/métricas, filtros e ordenação; pré-visualize, salve como modelo (opcionalmente compartilhado com outros gerentes e administradores) e baixe em Excel, CSV ou PDF (até 5.000 linhas). Modelos podem ser exportados e importados como arquivo .json.

## Cadastros (conforme o perfil)
Clientes e produtos, importação de pedidos por CSV (modelo para baixar), usuários, auditoria, integrações (webhooks) e configurações (alertas, atualização automática, exigir documentação e SLA por tipo).

## Controle de carcaças (aba Base de troca)
A aba **Base de troca** tem duas partes: **Registrar troca** (o processo de troca que já existia) e **Controle de carcaças**.
- Quem recebe uma peça remanufaturada fica devendo a carcaça. A saída é registrada à mão ou vem sozinha das NF-e de saída do Omie com peças marcadas como "Remanufaturada" (em Clientes e produtos), a partir da data definida em "Prazo e Omie".
- Saldo por cliente e por representante (o representante vem do cadastro do cliente e pode ser trocado em um lançamento), com vencidas e próximo vencimento. O prazo padrão é configurável (30 dias por padrão).
- Devolução aproveitável abate o saldo; refugada fica registrada e não abate. Ajustes pedem motivo; estorno (gerente/administrador) mantém o histórico.
- Gerentes e administradores recebem um aviso diário quando há carcaças vencidas.

## Omie (ERP)
- **Pedidos e notas do Omie:** os dados ficam guardados no app e são atualizados pelo próprio Omie (aviso em tempo real por webhook) e por uma busca automática a cada 10 minutos. A tela abre na hora, se atualiza sozinha a cada 30 segundos e tem o botão "Atualizar agora".
- **Peça nova vai para o Omie:** ao cadastrar, informe a unidade; a peça fica "Aguardando aprovação". Gerente, supervisor ou administrador aprova (uma ou várias de uma vez), informa o NCM e a peça é criada no Omie com o mesmo código. Se o código já existir lá, os cadastros só são ligados. Erros de dados aparecem na peça para corrigir e reenviar; se o Omie estiver fora do ar, o app tenta de novo sozinho (até 3 vezes).

## Atualização do app
Ao abrir o app (aba ou janela nova), uma tela de abertura verifica se há versão nova e já atualiza, sem depender do aviso. Durante o uso, uma versão nova aparece como aviso "Nova versão disponível", para não interromper o que você está fazendo.

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

## Segurança da conta

- **Primeiro acesso:** se a sua senha foi criada pelo administrador, o sistema pede uma senha pessoal antes de abrir. Use pelo menos 12 caracteres; uma frase com várias palavras é fácil de lembrar e difícil de adivinhar.
- **Esqueci a senha:** peça ao administrador uma senha provisória (Usuários > Redefinir senha). No próximo acesso você cria a sua.
- **Muitas tentativas:** depois de 5 senhas erradas o acesso daquele e-mail fica bloqueado por alguns minutos (o tempo aumenta a cada nova falha). No computador ou tablet que você já usa, o bloqueio por ataques vindos de outros lugares não te afeta. Se precisar, o administrador desbloqueia em Usuários > Desbloquear login.
- **Minha conta:** troque a senha (pede a senha atual e desconecta os outros aparelhos), veja os aparelhos conectados e encerre os que não reconhecer.
- **Verificação em duas etapas (MFA):** em Minha conta, ative e leia o QR Code com o Google Authenticator ou Microsoft Authenticator. A partir daí o login pede também o código de 6 dígitos do celular. Guarde os códigos de recuperação: cada um permite entrar uma vez se você perder o celular. Se perder tudo, o administrador remove o MFA da sua conta.
- **Inatividade:** a sessão termina sozinha depois de 2 horas sem uso.
