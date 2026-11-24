// Conteudo do Guia do app (/guia.html). Cada secao explica uma tela: para que serve, passo a passo e dicas.
// `capability` esconde secoes de telas que o perfil nao acessa; `paths` liga o botao do topo a secao certa.
window.PPGuide = [
	{
		id: "comecar",
		title: "Primeiros passos",
		icon: "guide",
		paths: [],
		summary:
			"O Plano Pneumatic controla, do começo ao fim, os três tipos de processo da empresa: pedido de venda, base de troca e garantia. Tudo o que acontece com um processo fica registrado na linha do tempo.",
		steps: [
			"Entre com seu e-mail e senha. No primeiro acesso o sistema pede que você crie uma senha pessoal.",
			"Use o menu lateral para ir às telas. Ele mostra só o que o seu perfil pode usar.",
			"No topo de toda tela ficam a busca (Ctrl+K), o guia (ícone de caderno), o tema claro/escuro e o sino de notificações.",
			"Para abrir um processo novo, comece pela Triagem. Para acompanhar um que já existe, use a busca ou o Histórico."
		],
		tips: [
			"Ícone de caderno: abre este guia já na explicação da tela em que você está.",
			"Se a internet cair enquanto você salva, o processo fica numa fila e é enviado sozinho quando a conexão voltar."
		]
	},
	{
		id: "atalhos",
		title: "Busca e atalhos",
		icon: "search",
		paths: [],
		summary: "A busca global encontra qualquer processo pelo número, cliente, produto, código, série ou lote.",
		steps: [
			"Pressione Ctrl+K (ou /) em qualquer tela, ou clique em “Buscar processo…” no topo.",
			"Digite parte do que procura. Use as setas ↑ ↓ para escolher e Enter para abrir.",
			"Esc fecha a busca."
		],
		tips: ["Não precisa digitar o número completo: “0045” já encontra GAR-2026-0045."]
	},
	{
		id: "dashboard",
		title: "Dashboard",
		icon: "dashboard",
		paths: ["/"],
		summary: "Visão geral da operação: quantos processos estão abertos, concluídos, atrasados e o que precisa da sua atenção hoje.",
		steps: [
			"Os cartões do topo mostram os indicadores do período e o comparativo com o período anterior.",
			"Use os filtros (período, tipo, status, cliente, responsável) para recortar os números.",
			"“Minhas pendências” lista o que está com você; “Alertas” mostra prazos que vencem nas próximas 24 horas.",
			"Clique em qualquer processo das listas para abri-lo."
		],
		tips: ["Comece o dia pelos Alertas: eles mostram o que vai estourar o prazo (SLA) primeiro."]
	},
	{
		id: "triagem",
		title: "Triagem (abrir um processo)",
		icon: "triage",
		capability: "cases.create",
		paths: ["/triagem.html"],
		summary: "Entrada rápida de um processo novo em etapas. Você informa o mínimo e completa o resto depois, na tela do processo.",
		steps: [
			"Identifique o cliente e o item (digite 2 letras para puxar do cadastro).",
			"Escolha o tipo: pedido de venda, base de troca ou garantia.",
			"Confira o resumo ao lado e confirme. O processo recebe um número (PV-, TRO- ou GAR- + ano + sequência).",
			"Em seguida você é levado à tela do tipo escolhido para completar os dados."
		],
		tips: ["Na dúvida sobre o tipo: venda nova = pedido de venda; peça usada trocada por nova = base de troca; defeito = garantia."]
	},
	{
		id: "pedido",
		title: "Pedido de venda",
		icon: "order",
		capability: "cases.create",
		paths: ["/pedido-venda.html"],
		summary: "Formulário completo de um pedido de venda: cliente, produto, quantidade, valor e documento de origem.",
		steps: [
			"Preencha cliente (o CPF/CNPJ é validado), produto e quantidade.",
			"Informe o valor unitário e o documento de origem (pedido ou nota).",
			"Salve. O pedido segue o fluxo Criado → Em análise → Aprovado → Em faturamento → Concluído."
		],
		tips: ["O sistema guarda um rascunho no seu navegador: se fechar a tela sem querer, os dados voltam."]
	},
	{
		id: "troca",
		title: "Base de troca",
		icon: "exchange",
		capability: "cases.create",
		paths: ["/base-troca.html"],
		summary: "Registra a troca de uma peça usada por uma nova, com o motivo e a condição do item recebido.",
		steps: [
			"Identificação: cliente, produto e quantidade.",
			"Avaliação: motivo da troca e condição do item (obrigatórios).",
			"Observações e salvar. O técnico avalia e decide a troca na tela do processo."
		]
	},
	{
		id: "carcacas",
		title: "Controle de carcaças",
		icon: "exchange",
		paths: ["/carcacas.html"],
		summary:
			"Na aba Base de troca: quem recebe uma peça remanufaturada fica devendo a carcaça (a peça usada). Aqui fica o saldo por cliente e por representante, com prazo de devolução.",
		steps: [
			"Saída: “Registrar saída (cliente deve)” — cliente, peça, quantidade e documento. O prazo padrão é preenchido sozinho.",
			"Notas do Omie: NF de saída com peça marcada como “Remanufaturada” (em Clientes e produtos) já gera a saída automaticamente.",
			"Devolução: “Registrar devolução de carcaça” (ou o botão na linha do cliente). Aproveitável abate o saldo; refugada fica registrada e o cliente continua devendo.",
			"Saldo por cliente ou por representante: veja o que está em aberto, o que venceu e o próximo vencimento; “Detalhar por peça” abre por código.",
			"Lançamentos: o histórico completo. Errou? Gerente ou administrador estorna (o registro fica, mas deixa de contar)."
		],
		tips: [
			"O representante vem do cadastro do cliente; dá para trocar em um lançamento específico.",
			"Ajuste serve para corrigir o saldo (positivo aumenta, negativo diminui) e sempre pede o motivo.",
			"Gerentes e administradores recebem um aviso diário quando há carcaças vencidas. O prazo padrão fica em “Prazo e Omie”.",
			"Todas as tabelas têm Excel, CSV e PDF, e “Abrir planilha” para comparar com um saldo exportado antes."
		]
	},
	{
		id: "garantia",
		title: "Garantia",
		icon: "warranty",
		capability: "cases.create",
		paths: ["/garantia.html"],
		summary: "Fluxo completo de garantia: recebimento da peça, análise técnica (laudo), decisão e destino.",
		steps: [
			"Recebimento: cliente, produto, série/lote e o defeito relatado.",
			"Análise inicial: anexe fotos e documentos da peça.",
			"Encaminhamento: o técnico registra o laudo e decide procedente ou improcedente (improcedente exige motivo).",
			"Ao aprovar, escolha o destino: reposição, devolução, troca ou arquivo. A logística acompanha coleta e transporte."
		],
		tips: ["“O que falta para avançar”, na tela do processo, lista exatamente o que bloqueia o próximo passo."]
	},
	{
		id: "processo",
		title: "Tela do processo",
		icon: "order",
		paths: ["/caso.html"],
		summary: "Tudo de um processo num só lugar: status, prazo (SLA), responsável, checklist, anexos, linha do tempo e comentários.",
		steps: [
			"Botões de status: só aparecem as mudanças permitidas para o tipo e para o seu perfil.",
			"Checklist: marque as etapas concluídas. Concluir/encerrar exige checklist completo e ao menos um documento anexado (configurável).",
			"Anexos: JPG, PNG, WEBP ou PDF até 10 MB, escolhendo o tipo (foto, laudo, comprovante, documento).",
			"Comentários: conversa interna da equipe sobre o processo.",
			"Linha do tempo: quem fez o quê e quando. Tudo fica registrado."
		],
		tips: [
			"Cancelar ou marcar improcedente pede motivo. Reabrir um processo encerrado pede justificativa (gerente/administrador).",
			"Após uma mudança simples de status aparece “Desfazer” por alguns segundos.",
			"O prazo fica pausado enquanto o processo está em “Aguardando documento”."
		]
	},
	{
		id: "historico",
		title: "Histórico",
		icon: "history",
		paths: ["/historico.html"],
		summary: "Encontre, filtre e gerencie processos já abertos.",
		steps: [
			"Filtre por processo, cliente, produto, código, documento, série/lote, tipo, status, responsável e período.",
			"Marque “Somente meus casos” ou “Somente atrasados” para focar.",
			"Clique nos títulos das colunas para ordenar; salve filtros que você usa sempre.",
			"Exporte o resultado em XLSX, PDF ou CSV. Supervisor/gerente podem selecionar vários processos e atribuí-los de uma vez."
		]
	},
	{
		id: "relatorios",
		title: "Relatórios",
		icon: "reports",
		paths: ["/relatorios.html", "/relatorios-time.html", "/relatorios-gerentes.html"],
		summary:
			"Visões gerenciais prontas: resumo, por cliente, por produto (reincidência), por processo, desempenho por time e de gerentes. Cada tabela pode ser exportada e comparada com uma planilha antiga.",
		steps: [
			"Escolha o período (padrão: últimos 90 dias; apague as datas para ver tudo) e o tipo, e clique em Aplicar.",
			"Troque a visão pelas abas: Resumo, Por cliente, Por produto, Por processo e Envios agendados.",
			"Exportar: em cada tabela, os botões Excel, CSV e PDF baixam exatamente o que está na tela. No topo, Excel/PDF/CSV baixam a lista completa de processos do filtro.",
			"Importar (comparar): em cada tabela, “Abrir planilha” carrega um arquivo exportado antes (.xlsx ou .csv). O sistema compara pela primeira coluna e destaca o que mudou, o que é novo e o que sumiu. Nada é gravado.",
			"Envios agendados: receba um relatório por e-mail todo dia, semana ou mês."
		],
		tips: [
			"Use a comparação para conferir a evolução: exporte hoje, abra a mesma planilha no mês que vem e veja as diferenças.",
			"Em Desempenho por time, gerentes e administradores definem a meta mensal de cada time."
		]
	},
	{
		id: "construtor",
		title: "Construtor de relatórios",
		icon: "builder",
		capability: "reports.builder",
		paths: ["/relatorios-personalizados.html"],
		summary: "Para gerentes e administradores: monte o relatório que precisar, salve como modelo e baixe sempre que quiser.",
		steps: [
			"Comece por um modelo pronto (à esquerda) ou clique em Novo.",
			"Fonte: Processos (um registro por processo) ou Eventos (cada movimentação da linha do tempo).",
			"Formato: “Lista de registros” para ver item a item, ou “Totais agrupados” para somar por tipo, status, responsável, cliente, produto ou mês.",
			"Marque as colunas (ou as métricas), ajuste os filtros e a ordenação.",
			"Clique em Pré-visualizar para conferir, Salvar modelo para guardar, e Excel/CSV/PDF para baixar (até 5.000 linhas)."
		],
		tips: [
			"Marque “Compartilhar” para que outros gerentes e administradores usem o seu modelo (só você altera ou exclui).",
			"“Exportar modelo (.json)” e “Importar modelo” levam a configuração do relatório para outra pessoa ou outro ambiente.",
			"O construtor respeita o seu perfil: você só vê os processos que já pode ver no sistema."
		]
	},
	{
		id: "cadastro-base",
		title: "Clientes e produtos",
		icon: "registry",
		capability: "cases.create",
		paths: ["/cadastro-base.html"],
		summary: "Cadastro de clientes e produtos usado para preencher os formulários automaticamente. Peças novas também são enviadas ao Omie, com aprovação.",
		steps: [
			"Alterne entre as abas Clientes e Produtos.",
			"Pesquise, inclua ou edite um registro (supervisor, gerente e administrador).",
			"Peça nova: informe código, descrição e unidade. Ela fica “Aguardando aprovação”.",
			"Gerente, supervisor ou administrador clica em “Aprovar e enviar” (ou marca várias e envia em lote), informa o NCM e a peça vai ao Omie com o mesmo código.",
			"Acompanhe a coluna Omie: Enviando → No Omie, ou Erro no envio com a mensagem do Omie.",
			"Nos formulários, digite 2 letras do cliente ou do código do produto para puxar daqui."
		],
		tips: [
			"Se o código já existir no Omie, o app só liga os cadastros, sem duplicar.",
			"Erro de dados (ex.: NCM inválido): corrija em Editar e clique em “Reenviar ao Omie”. Se o Omie estiver fora do ar, o app tenta de novo sozinho.",
			"Peças antigas aparecem como “Não enviada” e podem ser enviadas em lote."
		]
	},
	{
		id: "importar",
		title: "Importar pedidos",
		icon: "import",
		capability: "cases.import",
		paths: ["/importar.html"],
		summary: "Cria vários processos de uma vez a partir de uma planilha CSV.",
		steps: [
			"Clique em “Baixar modelo” e preencha uma linha por processo (separador ; ou ,).",
			"Colunas obrigatórias: type, client, product, productCode e quantity. Base de troca exige também exchangeReason e itemCondition.",
			"Envie o arquivo, confira a prévia das primeiras linhas e clique em Importar (máximo 500 linhas).",
			"Linhas com erro aparecem numa tabela com o motivo; as demais são criadas normalmente."
		]
	},
	{
		id: "omie",
		title: "Pedidos e notas do Omie",
		icon: "integrations",
		capability: "cases.import",
		paths: ["/omie.html"],
		summary:
			"Pedidos e notas fiscais do ERP Omie para abrir processos sem redigitar. Os dados ficam guardados no app e o Omie avisa quando algo muda, então a tela abre na hora e se atualiza sozinha.",
		steps: [
			"A barra de situação mostra quantos registros estão no app, quando foi a última busca e o último aviso do Omie.",
			"Filtre pelo período; a página 1 traz os mais recentes.",
			"Marque até 20 registros por vez e escolha o tipo de processo a criar.",
			"O que já virou processo aparece com o número e não pode ser marcado de novo.",
			"“Atualizar agora” busca no Omie só o que mudou desde a última vez."
		],
		tips: [
			"A tela confere novidades a cada 30 segundos e recarrega a lista sozinha (se você não tiver nada marcado).",
			"Na primeira vez a carga completa leva alguns minutos; enquanto isso, a lista mostra os mais recentes direto do Omie.",
			"Clientes e produtos do Omie também são sincronizados automaticamente."
		]
	},
	{
		id: "notificacoes",
		title: "Notificações",
		icon: "bell",
		paths: ["/notificacoes.html"],
		summary: "Avisos de atribuições, mudanças de status e prazos.",
		steps: [
			"O número vermelho no sino mostra quantas não foram lidas.",
			"Clique numa notificação para abrir o processo; “Marcar como lidas” limpa o contador.",
			"Em Notificações, escolha também canais externos (quando configurados)."
		]
	},
	{
		id: "usuarios",
		title: "Usuários",
		icon: "users",
		capability: "users.view",
		paths: ["/cadastros.html"],
		summary: "Criação e gestão de contas e times.",
		steps: [
			"Crie a pessoa com nome, e-mail e perfil; passe a senha provisória por um canal seguro.",
			"Ative/desative contas, mude o perfil ou transfira entre times (mudar o perfil encerra as sessões).",
			"“Redefinir senha” gera uma senha provisória; “Desbloquear login” libera quem errou a senha várias vezes."
		]
	},
	{
		id: "auditoria",
		title: "Auditoria",
		icon: "audit",
		capability: "users.audit.view",
		paths: ["/auditoria.html"],
		summary: "Registro de quem fez o quê: ações administrativas e alterações em processos, com data e IP.",
		steps: ["Filtre por pessoa, ação, processo ou período.", "Abra a partir de um processo para ver só o histórico dele."]
	},
	{
		id: "integracoes",
		title: "Integrações",
		icon: "integrations",
		capability: "integrations.manage",
		paths: ["/integracoes.html"],
		summary: "Webhooks que avisam sistemas externos quando um processo muda, e a conexão com o Omie.",
		steps: ["Cadastre a URL de destino e os eventos desejados.", "Cada envio é assinado (HMAC) para o destino validar a origem."]
	},
	{
		id: "configuracoes",
		title: "Configurações",
		icon: "settings",
		paths: ["/configuracoes.html"],
		summary: "Preferências da operação: alertas, atualização automática, exigência de documentos e prazos (SLA) por tipo.",
		steps: [
			"Somente gerentes e administradores alteram as opções da operação.",
			"O prazo conta da abertura e fica pausado enquanto o processo aguarda documento."
		]
	},
	{
		id: "conta",
		title: "Minha conta",
		icon: "account",
		paths: ["/conta.html"],
		summary: "Seus dados, senha, aparelhos conectados e verificação em duas etapas (MFA).",
		steps: [
			"Troque a senha (os outros aparelhos saem da conta).",
			"Veja os aparelhos conectados e encerre os que não reconhecer.",
			"Ative o MFA lendo o QR Code com o Google ou Microsoft Authenticator e guarde os códigos de recuperação."
		],
		tips: ["Após 5 senhas erradas o acesso fica bloqueado por alguns minutos. A sessão termina sozinha após 2 horas sem uso."]
	},
	{
		id: "perfis",
		title: "Perfis de acesso",
		icon: "users",
		paths: [],
		summary: "O que cada perfil pode fazer.",
		table: [
			["Operador", "Abre e acompanha os próprios processos"],
			["Supervisor", "Vê todos, atribui, importa e mantém cadastros; não decide"],
			["Técnico", "Laudo e decisão de garantias e trocas"],
			["Logística", "Rastreio e logística reversa"],
			["Auditor", "Somente leitura e auditoria"],
			["Gerente", "Tudo acima, encerra, reabre, arquiva, gerencia o time e monta relatórios"],
			["Administrador", "Acesso total, usuários e integrações"]
		]
	}
];
