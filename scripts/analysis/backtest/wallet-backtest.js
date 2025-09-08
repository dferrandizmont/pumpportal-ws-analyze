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

	// Log de inicio con parámetros básicos
	console.log("Iniciando wallet backtest");
	console.log(
		[
			`Estrategia: ${strategyId}`,
			`Inicial SOL: ${initialSol}`,
			`Asignación SOL: ${allocSol}`,
			`Asignación %: ${allocPct}`,
			`TP %: ${tpPct}`,
			`SL %: ${slPct}`,
			`Timeout (s): ${timeoutSec}`,
			`Fee %: ${feePct}`,
			`Slippage %: ${slippagePct}`,
			`Límite sesiones: ${limit}`,
			`Parse concurrency: ${conc}`,
		].join(" | ")
	);

	const logDir = getStrategyLogDir(strategyId);
	console.log(`Directorio de tracking: ${logDir}`);
	const files = listTokenLogs(logDir);
	console.log(`Archivos de log encontrados: ${files.length}`);
	if (!files.length) {
		console.error(`No hay logs en ${logDir}. Asegúrate de tener tracking para la estrategia '${strategyId}'.`);
		process.exit(1);
	}

	const sessions = await parseAllSessions(files, { concurrency: conc, limit });
	if (!sessions.length) {
		console.error("No hay sesiones parseadas (todas podrían carecer de summary y se descartaron).");
		process.exit(1);
	}
	console.log(`[Wallet] Sesiones parseadas: ${sessions.length} (desde ${files.length} archivos)`);

	// Ordenar por startedAt ascendente; si falta, enviar al final
	sessions.sort((a, b) => {
		const ta = a.startedAt ? new Date(a.startedAt).getTime() : Number.POSITIVE_INFINITY;
		const tb = b.startedAt ? new Date(b.startedAt).getTime() : Number.POSITIVE_INFINITY;
		return ta - tb;
	});

	// Barra de progreso
	const startTs = Date.now();
	const totalSessions = sessions.length;
	let processed = 0;
	let lastDraw = 0;
	function drawProgress(force = false) {
		const now = Date.now();
		if (!force && now - lastDraw < 200) return; // limitar refresco
		lastDraw = now;
		const ratio = totalSessions ? Math.min(1, processed / totalSessions) : 0;
		const width = 40;
		const filled = Math.round(ratio * width);
		const bar = "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
		const pct = (ratio * 100).toFixed(1).padStart(5);
		const elapsed = (now - startTs) / 1000;
		const rate = processed && elapsed > 0 ? processed / elapsed : 0; // sesiones/s
		const remaining = Math.max(0, totalSessions - processed);
		const etaSec = rate > 0 ? remaining / rate : 0;
		const fmt = (s) => {
			if (!Number.isFinite(s)) return "?";
			if (s >= 3600) return `${Math.round(s / 3600)}h`;
			if (s >= 60) return `${Math.round(s / 60)}m`;
			return `${Math.round(s)}s`;
		};
		const line = `[${bar}] ${pct}%  ${processed.toLocaleString('es-ES')}/${totalSessions.toLocaleString('es-ES')}  ~${rate.toFixed(1)} ses/s  ETA ${fmt(etaSec)}`;
		process.stdout.write("\r" + line);
	}

	let wallet = initialSol;
	const trades = [];
	const equity = [wallet];
	let wins = 0,
		losses = 0;

	for (const s of sessions) {
		processed++;
		drawProgress();
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

	// Finalizar y avanzar línea de la barra
	drawProgress(true);
	process.stdout.write("\n");

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

	// HTML con resumen (cabecera + KPIs + parámetros) y SOLO tabla de detalle por trade
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
	const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Wallet Backtest · ${esc(strategyId)}</title>
  <style>
    :root{ --bg:#0e1117; --panel:#161b22; --muted:#8b949e; --text:#e6edf3; --pos:#2ea043; --neg:#f85149; --accent:#7ee787; --border:#30363d; --hover:#0f141b; }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
    .wrap{max-width:1100px;margin:24px auto;padding:0 16px 48px}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
    h1{font-size:20px;margin:0}
    .pill{display:inline-block;padding:4px 8px;border:1px solid var(--border);border-radius:999px;color:var(--muted)}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0 8px}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px}
    .card b{display:block;color:var(--muted);font-weight:600;margin-bottom:2px}
    .val{font-size:18px}
    .val .pos{color:var(--pos)} .val .neg{color:var(--neg)}
    section{margin-top:18px}
    h2{font-size:16px;margin:8px 0;color:var(--accent)}
    table{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
    thead th{position:sticky;top:0;background:#101827;color:#cfd6df;text-transform:uppercase;font-size:12px;letter-spacing:.04em}
    th,td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap}
    th:first-child,td:first-child{text-align:left}
    tbody tr:hover{background:var(--hover)}
    tbody tr:last-child td{border-bottom:none}
    .tag{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);background:#0d1420}
    .pct.pos{color:var(--pos);font-weight:600}
    .pct.neg{color:var(--neg);font-weight:600}
    .links{margin-top:10px;color:var(--muted)}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
  </style></head>
  <body><div class="wrap">
    <header>
      <h1>Wallet Backtest</h1>
      <span class="pill">Estrategia: ${esc(strategyId)}</span>
    </header>
    <div class="cards">
      <div class="card"><b>Inicial</b><div class="val">${initialSol} SOL</div></div>
      <div class="card"><b>Final</b><div class="val">${summary.finalSol} SOL</div></div>
      <div class="card"><b>Trades</b><div class="val">${summary.trades}</div></div>
      <div class="card"><b>WinRate</b><div class="val">${(summary.winRate * 100).toFixed(2)}%</div></div>
      <div class="card"><b>Max Drawdown</b><div class="val">${(summary.maxDrawdown * 100).toFixed(2)}%</div></div>
    </div>

    <section>
      <h2>Parámetros</h2>
      <div class="cards">
        <div class="card"><b>Alloc SOL</b><div class="val">${allocSol}</div></div>
        <div class="card"><b>Alloc %</b><div class="val">${(allocPct*100).toFixed(0)}%</div></div>
        <div class="card"><b>TP</b><div class="val">${tpPct}%</div></div>
        <div class="card"><b>SL</b><div class="val">${slPct}%</div></div>
        <div class="card"><b>Timeout</b><div class="val">${timeoutSec}s</div></div>
        <div class="card"><b>Fee</b><div class="val">${feePct}%</div></div>
        <div class="card"><b>Slippage</b><div class="val">${slippagePct}%</div></div>
      </div>
      <div class="links">Archivos: <a href="trades.csv">trades.csv</a> · <a href="summary.json">summary.json</a></div>
    </section>

    <section>
      <h2>Detalle de Trades</h2>
      <table>
        <thead><tr>
          <th>Token</th>
          <th>Razón salida</th>
          <th>tExit (s)</th>
          <th>Exit %</th>
          <th>Net %</th>
          <th>Alloc (SOL)</th>
          <th>PnL (SOL)</th>
          <th>Inicio</th>
          <th>Fin</th>
        </tr></thead>
        <tbody>
          ${trades.map((t)=>{
            const exitPctC = t.exitPct >= 0 ? 'pct pos' : 'pct neg';
            const netPctC = t.netPct >= 0 ? 'pct pos' : 'pct neg';
            return `<tr>
              <td><span class=\"tag\">${esc(t.token)}</span></td>
              <td>${esc(t.exitReason)}</td>
              <td>${t.tExit}</td>
              <td class=\"${exitPctC}\">${toFixed(t.exitPct,2)}%</td>
              <td class=\"${netPctC}\">${toFixed(t.netPct,2)}%</td>
              <td>${toFixed(t.alloc,6)}</td>
              <td>${toFixed(t.pnl,6)}</td>
              <td>${esc(t.startedAt)}</td>
              <td>${esc(t.endedAt)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </section>

  </div></body></html>`;
	fs.writeFileSync(path.join(OUTPUT_DIR, "report.html"), html, "utf8");

	const totalSec = ((Date.now() - startTs) / 1000).toFixed(1);
	console.log("Wallet backtest completado.");
	if (trades.length > 0) {
		const winRatePct = ((wins / trades.length) * 100).toFixed(2);
		console.log(
			`Resumen: trades=${trades.length}, wins=${wins}, losses=${losses}, winRate=${winRatePct}%, final=${toFixed(wallet, 6)} SOL, maxDD=${(maxDrawdown * 100).toFixed(2)}%, duración=${totalSec}s`
		);
	}
	console.log(`Salida: ${OUTPUT_DIR}/trades.csv, summary.json, report.html`);
}

main().catch((e) => {
	console.error("Error en wallet-backtest:", e);
	process.exit(1);
});
