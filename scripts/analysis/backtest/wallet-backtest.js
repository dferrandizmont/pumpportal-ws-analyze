import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";
import { ensureDirSync, writeCsv } from "../../analysis/lib/jsonl.js";
import { parseTrackingSessions } from "./lib/tracking-parse.js";

dotenv.config();

const OUTPUT_DIR = path.join("backtest-output", "wallet");
ensureDirSync(OUTPUT_DIR);

function readStrategies() {
	try {
		const strategiesFile = process.env.STRATEGIES_FILE || path.join(process.cwd(), "strategies.json");
		if (fs.existsSync(strategiesFile)) {
			const raw = fs.readFileSync(strategiesFile, "utf8");
			const arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		}
	} catch (_e) {
		void 0; // ignore
	}
	return [];
}

function getStrategyLogDir(strategyId) {
	const strategies = readStrategies();
	const s = strategies.find((x) => x.id === strategyId);
	if (s && s.tracking && typeof s.tracking.logDir === "string" && s.tracking.logDir.trim() !== "") {
		return s.tracking.logDir;
	}
	// Fallback: tracking/<strategyId>
	return path.join("tracking", strategyId);
}

function listTokenLogs(dir) {
	try {
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith("-websocket.log"))
			.map((f) => path.join(dir, f));
	} catch (_e) {
		return [];
	}
}

function tokenFromFilename(filePath) {
	const base = path.basename(filePath);
	return base.endsWith("-websocket.log") ? base.slice(0, -"-websocket.log".length) : base;
}

async function parseAllSessions(files, { concurrency = Math.max(4, os.cpus().length - 1), limit = 0 } = {}) {
	const results = [];
	let idx = 0;
	async function worker() {
		while (idx < files.length && (limit <= 0 || results.length < limit)) {
			const myIdx = idx++;
			const file = files[myIdx];
			try {
				const ses = await parseTrackingSessions(file);
				const token = tokenFromFilename(file);
				for (const s of ses) {
					results.push({ ...s, token });
					if (limit > 0 && results.length >= limit) break;
				}
			} catch (_e) {
				void 0; // ignore parse errors for this file
			}
		}
	}
	const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

function asNumber(v, def) {
	const n = parseFloat(v);
	return Number.isFinite(n) ? n : def;
}

function computeDrawdown(equitySeries) {
	let peak = -Infinity;
	let maxDd = 0;
	for (const v of equitySeries) {
		if (v > peak) peak = v;
		const dd = peak > 0 ? (peak - v) / peak : 0;
		if (dd > maxDd) maxDd = dd;
	}
	return maxDd;
}

function toFixed(x, d = 4) {
	return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

async function main() {
	const strategyId = process.env.BACKTEST_STRATEGY_ID;
	if (!strategyId) {
		console.error("BACKTEST_STRATEGY_ID no está definido. Ejemplo: BACKTEST_STRATEGY_ID=f1Balanced");
		process.exit(1);
	}

	const initialSol = asNumber(process.env.BACKTEST_INITIAL_SOL, 1.5);
	const allocSol = asNumber(process.env.BACKTEST_ALLOC_SOL, 0);
	const allocPct = allocSol > 0 ? 0 : asNumber(process.env.BACKTEST_ALLOC_PCT, 1.0); // por defecto 100% si no hay alloc SOL
	const tpPct = asNumber(process.env.BACKTEST_TP_PCT, 10);
	const slPct = Math.abs(asNumber(process.env.BACKTEST_SL_PCT, 5));
	const timeoutSec = asNumber(process.env.BACKTEST_TIMEOUT_SEC, 300);
	const feePct = asNumber(process.env.BACKTEST_FEE_PCT, 0);
	const slippagePct = asNumber(process.env.BACKTEST_SLIPPAGE_PCT, 0);
	const limit = parseInt(process.env.BACKTEST_LIMIT || "0", 10) || 0;
	const conc = parseInt(process.env.BACKTEST_PARSE_CONCURRENCY || "6", 10) || 6;

	const logDir = getStrategyLogDir(strategyId);
	const files = listTokenLogs(logDir);
	if (!files.length) {
		console.error(`No hay logs en ${logDir}. Asegúrate de tener tracking para la estrategia '${strategyId}'.`);
		process.exit(1);
	}

	const sessions = await parseAllSessions(files, { concurrency: conc, limit });
	if (!sessions.length) {
		console.error("No hay sesiones parseadas (todas podrían carecer de summary y se descartaron).");
		process.exit(1);
	}

	// Ordenar por startedAt ascendente; si falta, enviar al final
	sessions.sort((a, b) => {
		const ta = a.startedAt ? new Date(a.startedAt).getTime() : Number.POSITIVE_INFINITY;
		const tb = b.startedAt ? new Date(b.startedAt).getTime() : Number.POSITIVE_INFINITY;
		return ta - tb;
	});

	let wallet = initialSol;
	const trades = [];
	const equity = [wallet];
	let wins = 0,
		losses = 0;

	for (const s of sessions) {
		// Descarta sesiones sin puntos
		const pts = Array.isArray(s.points) ? s.points.slice().sort((x, y) => x.t - y.t) : [];
		if (!pts.length) continue;

		// Asignación
		const alloc = allocSol > 0 ? Math.min(allocSol, wallet) : Math.max(0, wallet * allocPct);
		if (alloc <= 0) break; // bancarrota efectiva

		let exitReason = "TIMEOUT";
		let exitPct = 0;
		let tExit = timeoutSec;

		for (const p of pts) {
			// Priorizar TP/SL en cada punto
			if (p.pct >= tpPct) {
				exitReason = "TP";
				exitPct = p.pct;
				tExit = p.t;
				break;
			}
			if (p.pct <= -slPct) {
				exitReason = "SL";
				exitPct = p.pct;
				tExit = p.t;
				break;
			}
			if (p.t >= timeoutSec) {
				exitReason = "TIMEOUT";
				exitPct = p.pct;
				tExit = p.t;
				break;
			}
		}

		if (exitPct === 0) {
			// Si no se alcanzó ningún evento ni timeout, usar el último punto
			const last = pts[pts.length - 1];
			exitPct = last.pct;
			tExit = last.t;
			exitReason = "END"; // fin de sesión
		}

		// Costes redondos ida+vuelta como porcentaje
		const roundTripCosts = (feePct + slippagePct) * 2;
		const netPct = exitPct - roundTripCosts;
		const pnl = alloc * (netPct / 100);
		const walletBefore = wallet;
		wallet = wallet + pnl;
		equity.push(wallet);
		if (netPct >= 0) wins++;
		else losses++;

		trades.push({
			strategyId,
			token: s.token || "",
			startedAt: s.startedAt || "",
			endedAt: s.endedAt || "",
			exitReason,
			exitPct,
			tExit,
			alloc,
			feePct,
			slippagePct,
			netPct,
			pnl,
			walletBefore,
			walletAfter: wallet,
		});

		if (wallet <= 0) {
			break; // bancarrota
		}
	}

	const maxDrawdown = computeDrawdown(equity);
	const summary = {
		strategyId,
		initialSol,
		finalSol: toFixed(wallet, 6),
		trades: trades.length,
		wins,
		losses,
		winRate: trades.length ? toFixed(wins / trades.length, 4) : 0,
		maxDrawdown: toFixed(maxDrawdown, 4),
		params: {
			allocSol,
			allocPct,
			tpPct,
			slPct,
			timeoutSec,
			feePct,
			slippagePct,
			limit,
		},
	};

	// Persist
	writeCsv(
		path.join(OUTPUT_DIR, "trades.csv"),
		trades.map((t) => ({
			...t,
			alloc: toFixed(t.alloc, 6),
			exitPct: toFixed(t.exitPct, 4),
			netPct: toFixed(t.netPct, 4),
			pnl: toFixed(t.pnl, 6),
			walletBefore: toFixed(t.walletBefore, 6),
			walletAfter: toFixed(t.walletAfter, 6),
		})),
		["strategyId", "token", "startedAt", "endedAt", "exitReason", "tExit", "exitPct", "netPct", "alloc", "feePct", "slippagePct", "pnl", "walletBefore", "walletAfter"]
	);

	fs.writeFileSync(path.join(OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));

	// Minimal HTML report
	const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Wallet Backtest</title><style>body{font-family:ui-monospace,Menlo,Consolas,monospace;padding:16px;background:#f7f7fb;color:#222} .kpi{display:inline-block;margin-right:16px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:6px 8px;text-align:right} th:first-child,td:first-child{text-align:left}</style></head>
  <body><h1>Wallet Backtest</h1>
  <div class="kpi"><b>Estrategia:</b> ${strategyId}</div>
  <div class="kpi"><b>Inicial:</b> ${initialSol} SOL</div>
  <div class="kpi"><b>Final:</b> ${summary.finalSol} SOL</div>
  <div class="kpi"><b>Trades:</b> ${summary.trades}</div>
  <div class="kpi"><b>WinRate:</b> ${(summary.winRate * 100).toFixed(2)}%</div>
  <div class="kpi"><b>MaxDD:</b> ${(summary.maxDrawdown * 100).toFixed(2)}%</div>
  <p>Parámetros: allocSol=${allocSol}, allocPct=${allocPct}, TP=${tpPct}%, SL=${slPct}%, Timeout=${timeoutSec}s, fee=${feePct}%, slippage=${slippagePct}%.</p>
  <p>Archivos: <a href="trades.csv">trades.csv</a> · <a href="summary.json">summary.json</a></p>
  </body></html>`;
	fs.writeFileSync(path.join(OUTPUT_DIR, "report.html"), html, "utf8");

	console.log("Wallet backtest completado.");
	console.log(`Salida: ${OUTPUT_DIR}/trades.csv, summary.json, report.html`);
}

main().catch((e) => {
	console.error("Error en wallet-backtest:", e);
	process.exit(1);
});
