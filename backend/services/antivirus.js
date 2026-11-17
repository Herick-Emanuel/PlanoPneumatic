// F4: verificacao antivirus dos anexos com ClamAV (clamd, protocolo INSTREAM por TCP).
// Opcional: so liga com CLAMAV_HOST. Resultados: "clean", "infected", "error" (clamd fora do ar) e "skipped".
const net = require("node:net");
const { logEvent } = require("../middleware/errors");

const CHUNK = 64 * 1024;
let override = null;

const isConfigured = () => Boolean(process.env.CLAMAV_HOST);

// Nos testes, substitui a conexao real por uma funcao (buffer) => resposta do clamd.
function setScanner(next) {
	override = next;
}

function streamToClamd(buffer, { host, port, timeoutMs }) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host, port });
		let reply = "";
		const fail = (error) => {
			socket.destroy();
			reject(error);
		};
		socket.setTimeout(timeoutMs, () => fail(new Error("Tempo esgotado ao falar com o ClamAV.")));
		socket.on("error", fail);
		socket.on("data", (data) => {
			reply += data.toString("utf8");
		});
		socket.on("end", () => resolve(reply.replace(/\0/g, "").trim()));
		socket.on("connect", () => {
			socket.write("zINSTREAM\0");
			for (let offset = 0; offset < buffer.length; offset += CHUNK) {
				const chunk = buffer.subarray(offset, offset + CHUNK);
				const size = Buffer.alloc(4);
				size.writeUInt32BE(chunk.length, 0);
				socket.write(size);
				socket.write(chunk);
			}
			socket.write(Buffer.alloc(4));
		});
	});
}

// Resposta do clamd: "stream: OK" | "stream: Eicar-Signature FOUND" | "... ERROR".
function parseReply(reply) {
	if (/\bOK$/.test(reply)) return { status: "clean" };
	const found = reply.match(/:\s*(.+)\s+FOUND$/);
	if (found) return { status: "infected", signature: found[1] };
	return { status: "error", detail: reply };
}

async function scan(buffer) {
	if (!override && !isConfigured()) return { status: "skipped" };
	try {
		const reply = override
			? await override(buffer)
			: await streamToClamd(buffer, {
					host: process.env.CLAMAV_HOST,
					port: Number(process.env.CLAMAV_PORT || 3310),
					timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS || 20000)
				});
		const result = parseReply(reply);
		if (result.status === "error") logEvent("antivirus_error", { detail: result.detail });
		return result;
	} catch (error) {
		// ClamAV fora do ar nao bloqueia o trabalho: o anexo entra marcado como "nao verificado".
		logEvent("antivirus_unreachable", { error: error.message });
		return { status: "error", detail: error.message };
	}
}

module.exports = { scan, isConfigured, setScanner, parseReply };
