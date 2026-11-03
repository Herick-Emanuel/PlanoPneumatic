// Metricas em formato Prometheus (texto). Em memoria por processo; protegidas por METRICS_TOKEN.
const { database } = require("../db");

const BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000];
const requests = new Map();
const durations = BUCKETS_MS.map(() => 0);
let durationCount = 0;
let durationSum = 0;
const startedAt = Date.now();

function metricsMiddleware(request, response, next) {
	const started = process.hrtime.bigint();
	response.on("finish", () => {
		const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
		const key = `${request.method}|${Math.floor(response.statusCode / 100)}xx`;
		requests.set(key, (requests.get(key) || 0) + 1);
		durationCount += 1;
		durationSum += elapsed;
		BUCKETS_MS.forEach((bucket, index) => { if (elapsed <= bucket) durations[index] += 1; });
	});
	next();
}

async function render() {
	const lines = ["# TYPE pp_http_requests_total counter"];
	for (const [key, value] of requests) {
		const [method, status] = key.split("|");
		lines.push(`pp_http_requests_total{method="${method}",status="${status}"} ${value}`);
	}
	lines.push("# TYPE pp_http_request_duration_ms histogram");
	BUCKETS_MS.forEach((bucket, index) => lines.push(`pp_http_request_duration_ms_bucket{le="${bucket}"} ${durations[index]}`));
	lines.push(`pp_http_request_duration_ms_bucket{le="+Inf"} ${durationCount}`, `pp_http_request_duration_ms_sum ${durationSum.toFixed(2)}`, `pp_http_request_duration_ms_count ${durationCount}`);
	lines.push("# TYPE pp_uptime_seconds gauge", `pp_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
	const [{ rows: open }, { rows: overdue }, { rows: hooks }, { rows: pool }] = await Promise.all([
		database.query("SELECT COUNT(*)::int AS n FROM cases WHERE archived_at IS NULL AND status NOT IN ('Concluido', 'Encerrado', 'Cancelado')"),
		database.query("SELECT COUNT(*)::int AS n FROM cases WHERE archived_at IS NULL AND status NOT IN ('Concluido', 'Encerrado', 'Cancelado') AND sla_paused_at IS NULL AND due_at < NOW()"),
		database.query("SELECT COUNT(*) FILTER (WHERE success)::int AS ok, COUNT(*) FILTER (WHERE NOT success)::int AS failed FROM webhook_deliveries WHERE created_at > NOW() - INTERVAL '24 hours'"),
		database.query("SELECT 1")
	]);
	lines.push("# TYPE pp_cases_open gauge", `pp_cases_open ${open[0].n}`, "# TYPE pp_cases_overdue gauge", `pp_cases_overdue ${overdue[0].n}`);
	lines.push("# TYPE pp_webhook_deliveries_24h gauge", `pp_webhook_deliveries_24h{result="success"} ${hooks[0].ok}`, `pp_webhook_deliveries_24h{result="failed"} ${hooks[0].failed}`);
	lines.push("# TYPE pp_db_pool_connections gauge", `pp_db_pool_connections{state="total"} ${database.totalCount}`, `pp_db_pool_connections{state="idle"} ${database.idleCount}`, `pp_db_pool_connections{state="waiting"} ${database.waitingCount}`, `pp_db_up ${pool.length}`);
	return `${lines.join("\n")}\n`;
}

module.exports = { metricsMiddleware, render };
