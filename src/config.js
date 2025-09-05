import dotenv from "dotenv";
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
			const raw = process.env.TRACKING_ENTRY_DELAY_SEC ?? process.env.TRACKING_ENTRY_DELAY_MS;
			const defSec = 2; // default 2 seconds
			if (!raw) return defSec * 1000;
			const n = parseFloat(raw);
			if (!Number.isFinite(n)) return defSec * 1000;
			// if someone still sets ms (legacy), accept it
			return n > 10000 ? n : n * 1000;
		})(),
		inactivityMs: (() => {
			const raw = process.env.TRACKING_INACTIVITY_MIN ?? process.env.TRACKING_INACTIVITY_MS;
			const defMin = 10; // default 10 minutes
			if (!raw) return defMin * 60 * 1000;
			const n = parseFloat(raw);
			if (!Number.isFinite(n)) return defMin * 60 * 1000;
			// if looks like ms (legacy), accept it
			return n > 600000 ? n : n * 60 * 1000;
		})(),
		maxWindowMs: (() => {
			const raw = process.env.TRACKING_MAX_WINDOW_MIN ?? process.env.TRACKING_MAX_WINDOW_MS;
			const defMin = 20; // default 20 minutes
			if (!raw) return defMin * 60 * 1000;
			const n = parseFloat(raw);
			if (!Number.isFinite(n)) return defMin * 60 * 1000;
			return n > 600000 ? n : n * 60 * 1000;
		})(),
		logDir: process.env.TRACKING_LOG_DIR || "tracking",
		// optional TP for future use
		tpPct: parseFloat(process.env.TRACKING_TP_PCT || "20"),
	},
};

export default config;
