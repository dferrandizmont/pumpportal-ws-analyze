import TokenMonitor from "./token-monitor.js";
import logger from "./logger.js";
import config from "./config.js";
import http from "http";
import priceService from "./price-service.js";

class PumpPortalAnalyzer {
	constructor() {
		this.tokenMonitor = new TokenMonitor();
		this.isRunning = false;
		this.statsInterval = null;
		this.httpServer = null;
	}

	async start() {
		if (this.isRunning) {
			logger.tokenMonitor("Application is already running");
			return;
		}

		logger.tokenMonitor("Starting PumpPortal Token Analyzer...");
		logger.tokenMonitor("Configuration loaded:", {
			wsUrl: config.pumpPortal.wsUrl,
			logLevel: config.logging.level,
			timezone: config.logging.timezone,
			monitorCreatorSells: config.app.monitorCreatorSells,
			creatorSellThreshold: config.thresholds.creatorSellThreshold,
			trackingFiltersEnabled: config.trackingFilters?.enabled || false,
			trackingFilters: config.trackingFilters,
		});

		this.isRunning = true;

		// Start the token monitor
		priceService.start();
		this.tokenMonitor.start();

		// Set up HTTP server for remote status queries
		this.setupHTTPServer();

		// Set up graceful shutdown
		this.setupGracefulShutdown();

		logger.tokenMonitor("PumpPortal Token Analyzer started successfully");
		logger.tokenMonitor("Monitoring for new tokens and creator sells...");
		logger.tokenMonitor(`Creator sell threshold: ${config.thresholds.creatorSellThreshold}%`);
	}

	async stop() {
		if (!this.isRunning) {
			return;
		}

		logger.tokenMonitor("Stopping PumpPortal Token Analyzer...");

		this.isRunning = false;

		// Close HTTP server
		if (this.httpServer) {
			this.httpServer.close(() => {
				logger.tokenMonitor("HTTP Server stopped");
			});
			this.httpServer = null;
		}

		// Stop the token monitor
		this.tokenMonitor.stop();
		priceService.stop();

		logger.tokenMonitor("PumpPortal Token Analyzer stopped");
	}

	logStats() {
		const stats = this.tokenMonitor.getStats();

		logger.tokenMonitor("Current Statistics:", {
			monitoredTokens: stats.totalTokens,
			totalCreators: stats.totalCreators,
			tokensOverThreshold: stats.tokensOverThreshold,
			totalTokensOwned: stats.totalTokensOwned ? stats.totalTokensOwned.toLocaleString() : "0",
			totalTokensSold: stats.totalTokensSold ? stats.totalTokensSold.toLocaleString() : "0",
			averageSellPercentage: `${stats.averageSellPercentage ? stats.averageSellPercentage.toFixed(2) : "0.00"}%`,
		});
	}

	setupHTTPServer() {
		this.httpServer = http.createServer((req, res) => {
			// Set CORS headers
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			res.setHeader("Content-Type", "application/json");

			// Handle preflight requests
			if (req.method === "OPTIONS") {
				res.writeHead(200);
				res.end();
				return;
			}

			// Only allow GET requests
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end(JSON.stringify({ error: "Method not allowed" }));
				return;
			}

			try {
				const url = new URL(req.url, `http://${req.headers.host}`);

				switch (url.pathname) {
					case "/status": {
						// Detailed status
						const tokens = this.tokenMonitor.getMonitoredTokens();
						const stats = this.tokenMonitor.getStats();
						const marketTemp = this.tokenMonitor.marketTemperature.getStats();
						
						// Build trade stats object for all monitored tokens
						const tradeStats = {};
						for (const [tokenAddress, aggStats] of this.tokenMonitor.tokenTradeStats.entries()) {
							tradeStats[tokenAddress] = {
								total: aggStats.total || 0,
								buys: aggStats.buys || 0,
								sells: aggStats.sells || 0,
								uniqueTraders: aggStats.traders ? aggStats.traders.size : 0,
								lastTradeAt: aggStats.lastTradeAt,
								minMcUsd: aggStats.minMcUsd,
								maxMcUsd: aggStats.maxMcUsd,
							};
						}

						const statusResponse = {
							timestamp: new Date().toISOString(),
							uptime: process.uptime(),
							marketTemperature: marketTemp,
							tradeStats,
							creatorSellThreshold: config.thresholds.creatorSellThreshold,
							trackingFilters: (() => {
								const tf = config.trackingFilters || {};
								return {
									enabled: !!tf.enabled,
									trackAllMints: !!tf.trackAllMints,
									minBuys: tf.minBuys,
									minTotalTrades: tf.minTotalTrades,
									minUniqueTraders: tf.minUniqueTraders,
									minBuyRatio: tf.minBuyRatio,
									minNetBuys: tf.minNetBuys,
									minMcUsd: tf.minMcUsd,
									maxMcUsd: Number.isFinite(tf.maxMcUsd) ? tf.maxMcUsd : null,
									minUniquePerTrade: tf.minUniquePerTrade,
									minBuysPerUnique: tf.minBuysPerUnique,
									maxAgeAtTriggerSec: Number.isFinite(tf.maxAgeAtTriggerSec) ? tf.maxAgeAtTriggerSec : null,
									maxMcVolatilityRatio: Number.isFinite(tf.maxMcVolatilityRatio) ? tf.maxMcVolatilityRatio : null,
								};
							})(),
							strategies: (config.strategies || []).map((s) => ({
								id: s.id,
								logDir: s?.tracking?.logDir,
								filters: {
									enabled: !!s?.trackingFilters?.enabled,
									trackAllMints: !!s?.trackingFilters?.trackAllMints,
									minBuys: s?.trackingFilters?.minBuys,
									minTotalTrades: s?.trackingFilters?.minTotalTrades,
									minUniqueTraders: s?.trackingFilters?.minUniqueTraders,
									minBuyRatio: s?.trackingFilters?.minBuyRatio,
									minNetBuys: s?.trackingFilters?.minNetBuys,
									minMcUsd: s?.trackingFilters?.minMcUsd,
									maxMcUsd: Number.isFinite(s?.trackingFilters?.maxMcUsd) ? s?.trackingFilters?.maxMcUsd : null,
									minUniquePerTrade: s?.trackingFilters?.minUniquePerTrade,
									minBuysPerUnique: s?.trackingFilters?.minBuysPerUnique,
									maxAgeAtTriggerSec: Number.isFinite(s?.trackingFilters?.maxAgeAtTriggerSec) ? s?.trackingFilters?.maxAgeAtTriggerSec : null,
									maxMcVolatilityRatio: Number.isFinite(s?.trackingFilters?.maxMcVolatilityRatio) ? s?.trackingFilters?.maxMcVolatilityRatio : null,
								},
							})),
							solUsdPrice: priceService.getSolUsd(),
							solUsdLastUpdated: priceService.getLastUpdated(),
							tokens: tokens
								.map((token) => {
									const tracking = this.tokenMonitor.tokenSellTracking.get(token.address);
									const info = this.tokenMonitor.monitoredTokens.get(token.address);

									if (!tracking || !info) return null;

									const percentage = tracking.initialTokensOwned > 0 ? (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
									return {
										address: token.address,
										name: info.name,
										symbol: info.symbol,
										creator: info.creator,
										initialTokensOwned: tracking.initialTokensOwned,
										totalTokensOwned: tracking.totalTokensOwned,
										tokensSold: tracking.tokensSold,
										sellPercentage: percentage,
										exitMarketCapSol: tracking.exitMarketCapSol,
										exitMarketCapUsd: tracking.exitMarketCapUsd,
										exitAt: tracking.exitAt,
										lastSellTime: tracking.lastSellTime,
										totalSells: tracking.sellHistory.length,
										createdAt: info.createdAt,
									};
								})
								.filter(Boolean),
							activeTracking: (() => {
								const result = [];
								for (const [tokenAddress, byToken] of this.tokenMonitor.activeTracking.entries()) {
									for (const [strategyId, session] of byToken) {
										result.push({
											tokenAddress,
											strategyId,
											entryRecorded: session.entryRecorded,
											tradeCount: session.tradeCount || 0,
											buyCount: session.buyCount || 0,
											sellCount: session.sellCount || 0,
										});
									}
								}
								return result;
							})(),
							summary: stats,
							subscriptions: {
								currentTokens: this.tokenMonitor.wsClient.subscribedTokens.size,
								currentAccounts: this.tokenMonitor.wsClient.subscribedAccounts.size,
								totalSubscribed: this.tokenMonitor.wsClient.subscribedTokens.size + this.tokenMonitor.wsClient.subscribedAccounts.size,
								wsConnected: this.tokenMonitor.wsClient.isConnected,
							},
							subscriptionStats: stats.subscriptionStats,
						};

						res.writeHead(200);
						res.end(JSON.stringify(statusResponse, null, 2));
						break;
					}

					case "/stats": {
						// Quick statistics
						const quickStats = this.tokenMonitor.getStats();
						const marketTemp = this.tokenMonitor.marketTemperature.getStats();
						res.writeHead(200);
						res.end(
							JSON.stringify(
								{
									timestamp: new Date().toISOString(),
									uptime: process.uptime(),
									marketTemperature: marketTemp,
									creatorSellThreshold: config.thresholds.creatorSellThreshold,
									trackingFilters: (() => {
										const tf = config.trackingFilters || {};
										return {
											enabled: !!tf.enabled,
											trackAllMints: !!tf.trackAllMints,
											minBuys: tf.minBuys,
											minTotalTrades: tf.minTotalTrades,
											minUniqueTraders: tf.minUniqueTraders,
											minBuyRatio: tf.minBuyRatio,
											minNetBuys: tf.minNetBuys,
											minMcUsd: tf.minMcUsd,
											maxMcUsd: Number.isFinite(tf.maxMcUsd) ? tf.maxMcUsd : null,
											minUniquePerTrade: tf.minUniquePerTrade,
											minBuysPerUnique: tf.minBuysPerUnique,
											maxAgeAtTriggerSec: Number.isFinite(tf.maxAgeAtTriggerSec) ? tf.maxAgeAtTriggerSec : null,
											maxMcVolatilityRatio: Number.isFinite(tf.maxMcVolatilityRatio) ? tf.maxMcVolatilityRatio : null,
										};
									})(),
									strategies: (config.strategies || []).map((s) => ({
										id: s.id,
										logDir: s?.tracking?.logDir,
										filters: {
											enabled: !!s?.trackingFilters?.enabled,
											trackAllMints: !!s?.trackingFilters?.trackAllMints,
											minBuys: s?.trackingFilters?.minBuys,
											minTotalTrades: s?.trackingFilters?.minTotalTrades,
											minUniqueTraders: s?.trackingFilters?.minUniqueTraders,
											minBuyRatio: s?.trackingFilters?.minBuyRatio,
											minNetBuys: s?.trackingFilters?.minNetBuys,
											minMcUsd: s?.trackingFilters?.minMcUsd,
											maxMcUsd: Number.isFinite(s?.trackingFilters?.maxMcUsd) ? s?.trackingFilters?.maxMcUsd : null,
											minUniquePerTrade: s?.trackingFilters?.minUniquePerTrade,
											minBuysPerUnique: s?.trackingFilters?.minBuysPerUnique,
											maxAgeAtTriggerSec: Number.isFinite(s?.trackingFilters?.maxAgeAtTriggerSec) ? s?.trackingFilters?.maxAgeAtTriggerSec : null,
											maxMcVolatilityRatio: Number.isFinite(s?.trackingFilters?.maxMcVolatilityRatio) ? s?.trackingFilters?.maxMcVolatilityRatio : null,
										},
									})),
									solUsdPrice: priceService.getSolUsd(),
									solUsdLastUpdated: priceService.getLastUpdated(),
									totalTokens: quickStats.totalTokens,
									totalCreators: quickStats.totalCreators,
									tokensOverThreshold: quickStats.tokensOverThreshold,
									totalTokensOwned: quickStats.totalTokensOwned,
									totalTokensSold: quickStats.totalTokensSold,
									averageSellPercentage: quickStats.averageSellPercentage,
									states: quickStats.states,
									alerts: quickStats.alerts,
									tracking: quickStats.tracking,
									subscriptions: {
										currentTokens: this.tokenMonitor.wsClient.subscribedTokens.size,
										currentAccounts: this.tokenMonitor.wsClient.subscribedAccounts.size,
										totalSubscribed: this.tokenMonitor.wsClient.subscribedTokens.size + this.tokenMonitor.wsClient.subscribedAccounts.size,
										wsConnected: this.tokenMonitor.wsClient.isConnected,
									},
									subscriptionStats: quickStats.subscriptionStats,
								},
								null,
								2
							)
						);
						break;
					}

					case "/health": {
						// Health check
						res.writeHead(200);
						res.end(
							JSON.stringify({
								status: "healthy",
								timestamp: new Date().toISOString(),
								uptime: process.uptime(),
								isRunning: this.isRunning,
							})
						);
						break;
					}

					default:
						res.writeHead(404);
						res.end(JSON.stringify({ error: "Endpoint not found" }));
						break;
				}
			} catch (error) {
				logger.errorMonitor("HTTP Server Error", { error: error.message });
				res.writeHead(500);
				res.end(JSON.stringify({ error: "Internal server error" }));
			}
		});

		// Start the server
		this.httpServer.listen(config.http.port, () => {
			logger.tokenMonitor(`HTTP Server started on port ${config.http.port}`);
			logger.tokenMonitor(`Available endpoints:`);
			logger.tokenMonitor(`   GET http://localhost:${config.http.port}/status - Detailed token status`);
			logger.tokenMonitor(`   GET http://localhost:${config.http.port}/stats - Quick statistics`);
			logger.tokenMonitor(`   GET http://localhost:${config.http.port}/health - Health check`);
		});

		// Handle server errors
		this.httpServer.on("error", (error) => {
			logger.errorMonitor("HTTP Server Error", { error: error.message });
		});
	}

	setupGracefulShutdown() {
		const shutdown = async (signal) => {
			logger.tokenMonitor(`Received ${signal}, initiating graceful shutdown...`);
			await this.stop();
			process.exit(0);
		};

		// Handle common termination signals
		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
		process.on("SIGUSR2", () => shutdown("SIGUSR2")); // nodemon restart

		// Handle uncaught exceptions
		process.on("uncaughtException", (error) => {
			logger.errorMonitor("Uncaught Exception", { error: error.message, stack: error.stack });
			this.stop().finally(() => process.exit(1));
		});

		// Handle unhandled promise rejections
		process.on("unhandledRejection", (reason, promise) => {
			logger.errorMonitor("Unhandled Rejection", { reason, promise });
			this.stop().finally(() => process.exit(1));
		});
	}

	getStatus() {
		return {
			isRunning: this.isRunning,
			stats: this.tokenMonitor.getStats(),
			uptime: process.uptime(),
		};
	}
}

export default PumpPortalAnalyzer;

// Main execution for ESM
const isMain = import.meta.url === (process?.argv?.[1] ? new URL(`file://${process.argv[1]}`).href : "");
if (isMain) {
	const analyzer = new PumpPortalAnalyzer();
	analyzer.start().catch((error) => {
		logger.errorMonitor("Failed to start application", { error: error.message });
		process.exit(1);
	});
}
