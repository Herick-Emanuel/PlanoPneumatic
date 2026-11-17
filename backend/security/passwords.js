// Politica de senha unica para cadastro, troca, redefinicao e senhas de seed.
// Segue a linha do NIST SP 800-63B: comprimento minimo alto, sem regras de composicao artificiais,
// bloqueio de senhas comuns/vazadas e de palavras do proprio contexto (e-mail, nome, empresa).

const MIN_LENGTH = 12;
// O bcrypt so considera os primeiros 72 bytes; acima disso a senha seria truncada em silencio.
const MAX_BYTES = 72;

// Senhas mais usadas (listas publicas de vazamentos) + variacoes comuns em portugues e do proprio sistema.
// A comparacao e feita sobre a senha normalizada (minusculas, sem numeros/simbolos nas pontas, sem "leet").
const COMMON = new Set(`
123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football monkey
letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael 654321 superman 1qaz2wsx 7777777
121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter buster soccer harley batman andrew
tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel starwars klaster 112233 george computer
michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass maggie 159753 aaaaaa ginger princess
joshua cheese amanda summer love ashley nicole chelsea biteme matthew access yankees 987654321 dallas austin thunder
taylor matrix minecraft william corvette hello martin heather secret merlin diamond 1234qwer gfhjkm hammer silver
222222 88888888 anthony justin test bailey q1w2e3r4t5 patrick internet scooter orange 11111 golfer cookie richard
samantha bigdog guitar jackson whatever mickey chicken sparky snoopy maverick phoenix camaro peanut morgan welcome
falcon cowboy ferrari samsung andrea smokey steelers joseph mercedes dakota arsenal eagles melissa boomer booboo
spider nascar monster tigers yellow xxxxxx 123123123 gateway marina diablo bulldog qwer1234 compaq purple hardcore
banana junior hannah 123654 porsche lakers iceman money cowboys 987654 london tennis 999999 ncc1701 coffee scooby
0000 miller boston q1w2e3r4 fuckme brandon yamaha chester mother forever johnny edward 333333 oliver redsox player
nikita knight fender barney midnight please brandy chicago badboy slayer rangers charles angel flower bigdaddy rabbit
wizard bigdick jasper enter rachel chris steven winner adidas victoria natasha 1q2w3e4r jasmine winter prince panties
marine ghbdtn fishing cocacola casper james 232323 raiders 888888 marlboro gandalf asdfasdf crystal 87654321 12344321
golden 8675309 hello123 welcome1 password1 passw0rd p@ssw0rd admin administrator root toor changeme default guest
login senha senha123 senha1234 mudar mudar123 mudarsenha trocar trocarsenha minhasenha suasenha senhaforte
senhasegura novasenha temporaria provisoria acesso acesso123 brasil brasil123 saopaulo mudeme flamengo corinthians
palmeiras santos gremio cruzeiro vasco botafogo fluminense internacional amor amorzinho familia jesus deus
jesuscristo meuamor teamo felicidade benfica futebol garantia pedido troca operador operacao gerente supervisor
tecnico logistica auditor usuario usuarios empresa sistema plano pneumatic planopneumatic pneumatica pneumatico
qwerty123 qwertyui asdfghjkl zaq12wsx 1qazxsw2 abcd1234 abcdef abcdefgh 1q2w3e 1q2w3e4r5t aa123456 a123456 iloveu
`.trim().split(/\s+/));

// Valores de exemplo que ja apareceram em arquivos do repositorio: nunca aceitos como senha real.
const KNOWN_EXAMPLES = new Set(["admin123!", "operador123!", "seedpass123!", "strongpass123!", "e2eadminpass1", "e2eoperadorpass1"]);

const LEET = { "@": "a", 4: "a", 8: "b", 3: "e", 1: "i", "!": "i", 0: "o", $: "s", 5: "s", 7: "t", 2: "z" };

function normalize(password) {
	const lower = password.toLowerCase();
	const trimmed = lower.replace(/^[^a-z]+|[^a-z]+$/g, "");
	const unleet = lower.replace(/[@483!1$0572]/g, (character) => LEET[character] || character).replace(/[^a-z]/g, "");
	return [lower, trimmed, unleet, lower.replace(/[^a-z0-9]/g, "")];
}

function contextWords({ email, name } = {}) {
	const words = new Set(["planopneumatic", "pneumatic"]);
	const local = String(email || "").toLowerCase().split("@")[0];
	for (const part of local.split(/[^a-z0-9]+/)) if (part.length >= 4) words.add(part);
	for (const part of String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) if (part.length >= 4) words.add(part);
	return words;
}

/**
 * Avalia a senha e devolve a mensagem do primeiro problema encontrado (ou null se aceitavel).
 * `context` = { email, name } do dono da senha.
 */
function passwordProblem(password, context = {}) {
	const value = String(password || "");
	if (value.length < MIN_LENGTH) return `A senha deve ter pelo menos ${MIN_LENGTH} caracteres.`;
	if (Buffer.byteLength(value, "utf8") > MAX_BYTES) return `A senha deve ter no maximo ${MAX_BYTES} bytes.`;
	if (/^<.*>$/.test(value.trim())) return "Use uma senha real, nao o texto de exemplo.";
	if (new Set(value.toLowerCase()).size < 5) return "A senha repete poucos caracteres diferentes. Use uma frase ou combinacao mais variada.";
	if (/^[\d\W_]+$/.test(value) && /0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321/.test(value)) return "A senha e uma sequencia numerica. Escolha outra.";
	if (KNOWN_EXAMPLES.has(value.toLowerCase())) return "Essa senha aparece nos exemplos do sistema e nao pode ser usada.";
	const variants = normalize(value);
	if (variants.some((variant) => COMMON.has(variant))) return "Essa senha e muito comum. Escolha outra (uma frase com varias palavras funciona bem).";
	const lower = value.toLowerCase();
	for (const word of contextWords(context)) {
		if (lower.includes(word) || variants[2].includes(word)) return "A senha nao pode conter seu nome, seu e-mail ou o nome da empresa.";
	}
	return null;
}

function assertStrongPassword(password, context, createError = (message) => Object.assign(new Error(message), { status: 400, code: "WEAK_PASSWORD" })) {
	const problem = passwordProblem(password, context);
	if (problem) throw createError(problem);
}

// Recusa subir com senha de seed fraca ou igual aos exemplos (P0: senhas padrao conhecidas).
function validateSeedPasswords(env) {
	const seeds = [
		["SEED_ADMIN_PASSWORD", env.SEED_ADMIN_PASSWORD, env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_NAME],
		["SEED_OPERATOR_PASSWORD", env.SEED_OPERATOR_PASSWORD, env.SEED_OPERATOR_EMAIL, env.SEED_OPERATOR_NAME]
	];
	for (const [variable, password, email, name] of seeds) {
		if (!password) continue;
		const problem = passwordProblem(password, { email, name });
		if (problem) throw new Error(`${variable} recusada: ${problem} Defina uma senha forte antes de subir a aplicacao.`);
	}
}

module.exports = { MIN_LENGTH, passwordProblem, assertStrongPassword, validateSeedPasswords };
