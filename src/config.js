import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

const config = {
	// PumpPortal WebSocket Configuration
	pumpPortal: {
		wsUrl: process.env.PUMP_PORTAL_WS_URL || "wss://pumpportal.fun/api/data",
		apiKey: process.env.PUMP_PORTAL_API_KEY,
	},

	// Logging Configuration
	logging: {
		level: process.env.LOG_LEVEL || "info",
		timezone: process.env.LOG_TIMEZONE || "Europe/Madrid",
		trade: {
			// Reduce log volume for trades without losing visibility
			sampleEvery: parseInt(process.env.TRADE_LOG_SAMPLE_EVERY || "0"), // 0 or 1 disables sampling
			throttleMs: parseInt(process.env.TRADE_LOG_THROTTLE_MS || "0"), // 0 disables throttling
			suppressPumpWsTradeProcessingLog: process.env.SUPPRESS_PUMP_WS_TRADE_PROCESSING_LOG === "true",
		},
	},

	// Summaries formatting and classification
	summaries: {
		priceDecimals: parseInt(process.env.SUMMARIES_PRICE_DECIMALS || "12"),
		goodThresholdPct: parseFloat(process.env.SUMMARIES_GOOD_THRESHOLD_PCT || "20"),
		// Interpreted as absolute value; classification uses minPct <= -badThresholdPct
		badThresholdPct: parseFloat(process.env.SUMMARIES_BAD_THRESHOLD_PCT || "36"),
	},

	// Application Configuration
	app: {
		maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10,
		reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS) || 5000,
		monitorCreatorSells: process.env.MONITOR_CREATOR_SELLS === "true",
	},

	// Creator Sell Detection
	thresholds: {
		creatorSellThreshold: parseFloat(process.env.CREATOR_SELL_THRESHOLD) || 80.0,
	},

	// Tracking pre-conditions (to start tracking after creator sells)
	trackingFilters: {
		enabled: process.env.TRACK_FILTERS_ENABLED === "true",
		trackAllMints: process.env.TRACK_ALL_MINTS === "true",
		minBuys: parseFloat(process.env.TRACK_MIN_BUYS ?? "0"),
		minTotalTrades: parseFloat(process.env.TRACK_MIN_TOTAL_TRADES ?? "0"),
		minUniqueTraders: parseFloat(process.env.TRACK_MIN_UNIQUE_TRADERS ?? "0"),
		minBuyRatio: parseFloat(process.env.TRACK_MIN_BUY_RATIO ?? "0"),
		minNetBuys: parseFloat(process.env.TRACK_MIN_NET_BUYS ?? "0"),
		minMcUsd: parseFloat(process.env.TRACK_MIN_MC_USD ?? "0"),
		maxMcUsd: (() => {
			const v = process.env.TRACK_MAX_MC_USD;
			if (v === undefined || v === null || v === "") return Infinity;
			const n = parseFloat(v);
			return Number.isFinite(n) ? n : Infinity;
		})(),
		minUniquePerTrade: parseFloat(process.env.TRACK_MIN_UNIQUE_PER_TRADE ?? "0"),
		minBuysPerUnique: parseFloat(process.env.TRACK_MIN_BUYS_PER_UNIQUE ?? "0"),
		maxAgeAtTriggerSec: (() => {
			const v = process.env.TRACK_MAX_AGE_AT_TRIGGER_SEC;
			if (!v) return Infinity;
			const n = parseFloat(v);
			return Number.isFinite(n) ? n : Infinity;
		})(),
		maxMcVolatilityRatio: (() => {
			const v = process.env.TRACK_MAX_MC_VOLATILITY_RATIO;
			if (!v) return Infinity;
			const n = parseFloat(v);
			return Number.isFinite(n) ? n : Infinity;
		})(),
	},

	// HTTP Server Configuration
	http: {
		port: parseInt(process.env.HTTP_PORT) || 3000,
	},

	// Price Service Configuration
	prices: {
		// Full endpoint as requested by user
		coingeckoSolEndpoint: process.env.COINGECKO_SOL_ENDPOINT || "https://api.coingecko.com/api/v3/coins/solana",
		// Refresh every 10 minutes by default
		refreshIntervalMs: parseInt(process.env.PRICE_REFRESH_MS) || 10 * 60 * 1000,
	},

	// Tracking configuration
	tracking: {
		enabled: process.env.TRACKING_ENABLED !== "false", // default true
		// Interpret envs as seconds/minutes for convenience; keep ms internally
		// Env names use _SEC and _MIN; fallback to old *_MS for backward-compat
		entryDelayMs: (() => {
			const raw = process.env.TRACKING_ENTRY_DELAY_SEC;
			const defSec = 2; // default 2 seconds
			if (!raw) return defSec * 1000;
			const n = parseFloat(raw);
			return Number.isFinite(n) ? n * 1000 : defSec * 1000;
		})(),
		inactivityMs: (() => {
			const raw = process.env.TRACKING_INACTIVITY_MIN;
			const defMin = 10; // default 10 minutes
			if (!raw) return defMin * 60 * 1000;
			const n = parseFloat(raw);
			return Number.isFinite(n) ? n * 60 * 1000 : defMin * 60 * 1000;
		})(),
		maxWindowMs: (() => {
			const raw = process.env.TRACKING_MAX_WINDOW_MIN;
			const defMin = 20; // default 20 minutes
			if (!raw) return defMin * 60 * 1000;
			const n = parseFloat(raw);
			return Number.isFinite(n) ? n * 60 * 1000 : defMin * 60 * 1000;
		})(),
		logDir: process.env.TRACKING_LOG_DIR || "tracking",
		// optional TP for future use
		tpPct: parseFloat(process.env.TRACKING_TP_PCT || "20"),
	},
};

// Optional multi-strategy configuration (single instance)
// Two ways to configure strategies:
// 1) STRATEGIES_JSON env var containing a JSON array
// 2) strategies.json file in project root (or STRATEGIES_FILE path)
// If none provided, a default single strategy is inferred from the env-based config above.
try {
	let strategies = null;
	if (process.env.STRATEGIES_JSON) {
		try {
			strategies = JSON.parse(process.env.STRATEGIES_JSON);
		} catch (e) {
			console.warn("Invalid STRATEGIES_JSON; falling back to file/default:", e.message);
		}
	}

	if (!Array.isArray(strategies)) {
		const strategiesFile = process.env.STRATEGIES_FILE || path.join(process.cwd(), "strategies.json");
		if (fs.existsSync(strategiesFile)) {
			try {
				const raw = fs.readFileSync(strategiesFile, "utf8");
				strategies = JSON.parse(raw);
			} catch (e) {
				console.warn("Failed to read strategies.json; continuing with default:", e.message);
			}
		}
	}

	if (Array.isArray(strategies)) {
		// Normalize and inject defaults with light validation
		const normalize = (s, idx) => {
			const id = s.id || s.name || `strategy${idx + 1}`;
			if (typeof id !== "string" || id.trim() === "") {
				console.warn(`Invalid strategy id at index ${idx}; assigning default`);
			}
			const safeId = (id || `strategy${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-");
			const trackingFilters = {
				enabled: s?.trackingFilters?.enabled ?? process.env.TRACK_FILTERS_ENABLED === "true",
				trackAllMints: s?.trackingFilters?.trackAllMints ?? process.env.TRACK_ALL_MINTS === "true",
				minBuys: parseFloat(s?.trackingFilters?.minBuys ?? process.env.TRACK_MIN_BUYS ?? "0"),
				minTotalTrades: parseFloat(s?.trackingFilters?.minTotalTrades ?? process.env.TRACK_MIN_TOTAL_TRADES ?? "0"),
				minUniqueTraders: parseFloat(s?.trackingFilters?.minUniqueTraders ?? process.env.TRACK_MIN_UNIQUE_TRADERS ?? "0"),
				minBuyRatio: parseFloat(s?.trackingFilters?.minBuyRatio ?? process.env.TRACK_MIN_BUY_RATIO ?? "0"),
				minNetBuys: parseFloat(s?.trackingFilters?.minNetBuys ?? process.env.TRACK_MIN_NET_BUYS ?? "0"),
				minMcUsd: parseFloat(s?.trackingFilters?.minMcUsd ?? process.env.TRACK_MIN_MC_USD ?? "0"),
				maxMcUsd: (() => {
					const v = s?.trackingFilters?.maxMcUsd ?? process.env.TRACK_MAX_MC_USD;
					if (v === undefined || v === null || v === "") return Infinity;
					const n = parseFloat(v);
					return Number.isFinite(n) ? n : Infinity;
				})(),
				minUniquePerTrade: parseFloat(s?.trackingFilters?.minUniquePerTrade ?? process.env.TRACK_MIN_UNIQUE_PER_TRADE ?? "0"),
				minBuysPerUnique: parseFloat(s?.trackingFilters?.minBuysPerUnique ?? process.env.TRACK_MIN_BUYS_PER_UNIQUE ?? "0"),
				maxAgeAtTriggerSec: (() => {
					const v = s?.trackingFilters?.maxAgeAtTriggerSec ?? process.env.TRACK_MAX_AGE_AT_TRIGGER_SEC;
					if (!v) return Infinity;
					const n = parseFloat(v);
					return Number.isFinite(n) ? n : Infinity;
				})(),
				maxMcVolatilityRatio: (() => {
					const v = s?.trackingFilters?.maxMcVolatilityRatio ?? process.env.TRACK_MAX_MC_VOLATILITY_RATIO;
					if (!v) return Infinity;
					const n = parseFloat(v);
					return Number.isFinite(n) ? n : Infinity;
				})(),
			};

			// Per-strategy tracking output dir; fall back to global logDir/id
			const logDir = typeof s?.tracking?.logDir === "string" && s.tracking.logDir.trim() !== "" ? s.tracking.logDir : path.join(config.tracking.logDir || "tracking", safeId);

			return {
				id: safeId,
				trackingFilters,
				tracking: {
					...config.tracking,
					logDir,
				},
			};
		};

		const normalized = strategies.map(normalize);
		// Keep only unique strategy IDs
		const seen = new Set();
		config.strategies = normalized.filter((s) => {
			if (seen.has(s.id)) {
				console.warn(`Duplicate strategy id '${s.id}' ignored`);
				return false;
			}
			seen.add(s.id);
			return true;
		});
	} else {
		// Default single-strategy mode built from env
		config.strategies = [
			{
				id: "default",
				trackingFilters: config.trackingFilters,
				tracking: config.tracking,
			},
		];
	}
} catch (e) {
	console.warn("Failed to build strategies config; using default:", e.message);
	config.strategies = [{ id: "default", trackingFilters: config.trackingFilters, tracking: config.tracking }];
}

export default config;
