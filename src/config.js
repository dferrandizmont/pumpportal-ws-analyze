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
};

export default config;
