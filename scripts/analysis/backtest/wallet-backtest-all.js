import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import dotenv from "dotenv";

dotenv.config();

function readStrategies() {
	try {
		const strategiesFile = process.env.STRATEGIES_FILE || path.join(process.cwd(), "strategies.json");
		if (fs.existsSync(strategiesFile)) {
			const raw = fs.readFileSync(strategiesFile, "utf8");
			const arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		}
	} catch {
		// ignore
	}
	return [];
}

function ensureDirSync(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

async function runOne(strategyId, outDir) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env, BACKTEST_STRATEGY_ID: strategyId, BACKTEST_OUTPUT_DIR: outDir };
		const child = spawn(process.execPath, [path.join("scripts", "analysis", "backtest", "wallet-backtest.js")], {
			stdio: "inherit",
			env,
		});
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`wallet-backtest failed for ${strategyId} (code ${code})`));
		});
		child.on("error", reject);
	});
}

function buildIndexHtml(entries) {
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
	const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "-");
	const pct100 = (x) => (Number.isFinite(x) ? x.toFixed(2) + "%" : "-");
	const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Wallet Backtests</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
    
    :root {
      /* Ayu Mirage Theme Palette */
      --bg-primary: #1f2430;        /* Ayu Mirage Primary Background */
      --bg-secondary: #1c212b;      /* Ayu Mirage Secondary Background */
      --bg-tertiary: #242936;       /* Ayu Mirage Tertiary Background */
      --bg-surface: #171b24;        /* Ayu Mirage Surface */
      --text-primary: #cccac2;      /* Ayu Mirage Primary Text */
      --text-secondary: #707a8c;    /* Ayu Mirage Secondary Text */
      --text-muted: #eceff4;        /* Ayu Mirage Muted Text - More visible */
      --accent-primary: #ffcc66;    /* Ayu Mirage Yellow (Principal) */
      --accent-secondary: #ebcb8b;  /* Ayu Mirage Blue */
      --success: #a3be8c;           /* Ayu Mirage Green */
      --danger: #bf616a;            /* Ayu Mirage Red */
      --warning: #d08770;           /* Ayu Mirage Orange */
      --info: #5ccfe6;              /* Ayu Mirage Cyan */
      --border: #63759926;          /* Ayu Mirage Border */
      --border-solid: #434c5e;      /* Ayu Mirage Solid Border */
      --shadow: 0 4px 6px -1px rgba(18, 21, 28, 0.6), 0 2px 4px -1px rgba(18, 21, 28, 0.4);
    }
    
    * { box-sizing: border-box; }
    
    body {
      margin: 0;
      background: var(--bg-primary);
      color: var(--text-primary);
      font: 14px/1.45 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    }
    
    .wrap {
      max-width: 1200px;
      margin: 24px auto;
      padding: 0 16px 48px;
    }
    
    h1 {
      font-size: 28px;
      margin: 0 0 8px;
      color: var(--text-primary);
      font-weight: 700;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
    
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-solid);
      border-radius: 12px;
      padding: 20px;
      transition: all 0.3s ease;
      box-shadow: var(--shadow);
      min-height: 200px;
      display: flex;
      flex-direction: column;
    }
    
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px -5px rgba(18, 21, 28, 0.8);
    }
    
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 16px;
      flex-grow: 1;
    }
    
    .id {
      font-weight: 700;
      font-size: 16px;
      color: var(--text-primary);
    }
    
    .name {
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .desc { color: var(--text-secondary); font-size: 12px; margin-top: 6px; line-height: 1.4; }
    
    a {
      color: var(--accent-secondary);
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
      padding: 8px 16px;
      background: rgba(115, 208, 255, 0.1);
      border-radius: 8px;
      border: 1px solid rgba(115, 208, 255, 0.3);
      transition: all 0.2s ease;
      white-space: nowrap;
      align-self: flex-start;
      flex-shrink: 0;
    }
    
    a:hover {
      background: rgba(115, 208, 255, 0.2);
      color: var(--accent-primary);
      text-decoration: none;
    }
    
    .muted {
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    
    .kpis {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-top: auto;
      padding-top: 12px;
    }
    
    .kpi {
      background: var(--bg-surface);
      border: 1px solid var(--border-solid);
      border-radius: 8px;
      padding: 10px;
      transition: background 0.2s ease;
    }
    
    .kpi:hover {
      background: var(--bg-secondary);
    }
    
    .kpi b {
      display: block;
      color: var(--text-muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    
    .val {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    
    .pos { color: var(--success); }
    .neg { color: var(--danger); }
    
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .card {
        min-height: auto;
      }
      .top {
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
      }
      a {
        align-self: center;
        padding: 10px 20px;
      }
    }
  </style></head>
  <body><div class="wrap">
    <h1>Wallet Backtests by Strategy</h1>
    <div class="muted">A report was generated for each strategy. Click to open.</div>
    <div class="grid">
      ${entries
			.map((e) => {
				const s = e.summary || {};
				const wr = pct(s.winRate);
				const tr = Number.isFinite(s.trades) ? String(s.trades) : "-";
				const fin = Number.isFinite(s.finalSol) ? num(s.finalSol, 3) + " SOL" : "-";
				const ret = Number.isFinite(s.totalReturn) ? pct100(s.totalReturn) : "-";
				const dd = pct(s.maxDrawdown);
				const retClass = Number.isFinite(s.totalReturn) && s.totalReturn >= 0 ? "pos" : "neg";
				return (
					`<div class="card">\n` +
					`<div class="top">\n` +
					`<div>\n<div class="id">${esc(e.id)}</div>\n<div class="name">${esc(e.name || "")}</div>\n<div class="desc">${esc(e.description || "")}</div>\n</div>\n` +
					`<div><a href="${encodeURIComponent(e.id)}/report.html">Open Report</a></div>\n` +
					`</div>\n` +
					`<div class="kpis">\n` +
					`<div class="kpi"><b>Final</b><div class="val">${fin}</div></div>\n` +
					`<div class="kpi"><b>Trades</b><div class="val">${tr}</div></div>\n` +
					`<div class="kpi"><b>WinRate</b><div class="val">${wr}</div></div>\n` +
					`<div class="kpi"><b>Return</b><div class="val ${retClass}">${ret}</div></div>\n` +
					`<div class="kpi"><b>MaxDD</b><div class="val">${dd}</div></div>\n` +
					`</div>\n` +
					`</div>`
				);
			})
			.join("")}
    </div>
  </div></body></html>`;
}

async function main() {
	const strategies = readStrategies();
	if (!strategies.length) {
		console.error("No strategies found in strategies.json");
		process.exit(1);
	}
	const baseOut = path.join("backtest-output", "wallet");
	ensureDirSync(baseOut);
	const conc = parseInt(process.env.BACKTEST_ALL_CONCURRENCY || process.argv[2] || "0", 10) || Math.max(1, (os.cpus()?.length || 2) - 1);
	console.log(`Running wallet-backtest for ${strategies.length} strategies with concurrency=${conc}...`);

	let idx = 0;
	async function worker(wid) {
		while (idx < strategies.length) {
			const myIdx = idx++;
			const s = strategies[myIdx];
			const sid = s?.id;
			if (!sid) continue;
			const outDir = path.join(baseOut, sid);
			// Limpieza opcional del directorio de salida por estrategia
			if (process.env.BACKTEST_ALL_CLEAN === "1" && fs.existsSync(outDir)) {
				try {
					for (const f of fs.readdirSync(outDir)) {
						fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
					}
				} catch {
					// ignore
				}
			}
			ensureDirSync(outDir);
			console.log(`[w${wid}] [${myIdx + 1}/${strategies.length}] Strategy: ${sid} -> ${outDir}`);
			try {
				await runOne(sid, outDir);
			} catch (e) {
				console.error(`[w${wid}] Failed strategy ${sid}:`, e?.message || e);
				// continuar
			}
		}
	}

	const workers = Array.from({ length: Math.min(conc, strategies.length) }, (_, i) => worker(i + 1));
	await Promise.all(workers);

	// Generar índice con KPIs por estrategia
	const entries = strategies
		.filter((s) => s?.id)
		.map((s) => {
			const p = path.join(baseOut, s.id, "summary.json");
			let summary = null;
			try {
				if (fs.existsSync(p)) summary = JSON.parse(fs.readFileSync(p, "utf8"));
			} catch {
				// ignore
			}
			return { id: s.id, name: s.name || "", description: s.description || "", summary };
		});
	const indexHtml = buildIndexHtml(entries);
	fs.writeFileSync(path.join(baseOut, "index.html"), indexHtml, "utf8");
	console.log(`Index created at ${path.join(baseOut, "index.html")}`);
}

main().catch((e) => {
	console.error("Error in wallet-backtest-all:", e);
	process.exit(1);
});
