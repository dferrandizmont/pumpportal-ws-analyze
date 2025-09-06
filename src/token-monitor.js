import PumpPortalWSClient from "./pumpportal-ws-client.js";
import logger from "./logger.js";
import config from "./config.js";
import priceService from "./price-service.js";
import { formatCurrencyEs, formatPercentage } from "./utils.js";
import fs from "fs";
import path from "path";
import moment from "moment-timezone";

class TokenMonitor {
	constructor() {
		this.wsClient = new PumpPortalWSClient();
		this.monitoredTokens = new Map(); // tokenAddress -> tokenInfo
		this.creatorPositions = new Map(); // creatorAddress -> Set of tokenAddresses
		this.tokenSellTracking = new Map(); // tokenAddress -> sellInfo (por token individual)
		this.activeTracking = new Map(); // tokenAddress -> tracking session
		this.tokenTradeStats = new Map(); // tokenAddress -> { total, buys, sells, traders:Set, lastTradeAt }

		this.setupMessageHandlers();
	}

	start() {
		logger.tokenMonitor("Starting Token Monitor...");
		this.wsClient.connect();

		// Subscribe to new token events
		this.wsClient.subscribeNewTokens();

		// No mostrar estado automáticamente - solo disponible via HTTP

		// Limpiar trades procesados cada hora para evitar memory leaks
		setInterval(
			() => {
				if (this.processedTrades && this.processedTrades.size > 10_000) {
					logger.debugTokenMonitor(`Cleaning up processed trades cache (${this.processedTrades.size} entries)`);
					this.processedTrades.clear();
				}
			},
			60 * 60 * 1000
		); // Cada hora
	}

	stop() {
		logger.tokenMonitor("Stopping Token Monitor...");
		this.wsClient.disconnect();
	}

	// Método público para mostrar estado manualmente
	printStatus() {
		this.showTrackingStatus();
	}

	// Obtener estadísticas generales
	getStats() {
		const tokens = this.getMonitoredTokens();
		const creators = this.getCreatorTracking();

		// Calcular tokens sobre el threshold correctamente
		const tokensOverThreshold = tokens.filter((token) => {
			const tracking = this.tokenSellTracking.get(token.address);
			if (!tracking) return false;
			const percentage = tracking.initialTokensOwned > 0 ? (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
			return percentage >= config.thresholds.creatorSellThreshold;
		}).length;

		// Calcular totales
		const totalTokensOwned = creators.reduce((sum, creator) => sum + creator.totalTokensOwned, 0);
		const totalTokensSold = creators.reduce((sum, creator) => sum + creator.tokensSold, 0);

		// Calcular porcentaje promedio
		let averageSellPercentage = 0;
		if (tokens.length > 0) {
			const totalPercentage = tokens.reduce((sum, token) => {
				const tracking = this.tokenSellTracking.get(token.address);
				if (!tracking) return sum;
				const percentage = tracking.initialTokensOwned > 0 ? (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
				return sum + percentage;
			}, 0);
			averageSellPercentage = totalPercentage / tokens.length;
		}

		return {
			totalTokens: tokens.length,
			totalCreators: creators.length,
			tokensOverThreshold,
			totalTokensOwned,
			totalTokensSold,
			averageSellPercentage,
		};
	}

	// Limpiar tokens inactivos (sin ventas en las últimas 24 horas)
	cleanupInactiveTokens() {
		const now = new Date();
		const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		let cleanedCount = 0;

		for (const [tokenAddress, tracking] of this.tokenSellTracking) {
			if (!tracking.lastSellTime || new Date(tracking.lastSellTime) < oneDayAgo) {
				// Solo limpiar si no hay ventas recientes
				// Asegurar desuscripción del token en el WS antes de limpiar estructuras locales
				try {
					this.wsClient.unsubscribeTokenTrades([tokenAddress]);
				} catch {
					// Continuar limpieza aunque falle el WS
				}
				this.tokenSellTracking.delete(tokenAddress);
				this.monitoredTokens.delete(tokenAddress);

				// Remover de creator positions
				for (const [creator, tokens] of this.creatorPositions) {
					tokens.delete(tokenAddress);
					if (tokens.size === 0) {
						this.creatorPositions.delete(creator);
					}
				}

				cleanedCount++;
			}
		}

		if (cleanedCount > 0) {
			logger.tokenMonitor(`Cleaned up ${cleanedCount} inactive tokens (no sells in 24h)`);
		}

		return cleanedCount;
	}

	setupMessageHandlers() {
		// Handle new token creation events
		this.wsClient.onMessage("newToken", (message) => {
			this.handleNewToken(message);
		});

		// Handle trade events
		this.wsClient.onMessage("trade", (message) => {
			this.handleTrade(message);
		});
	}

	// ===== Tracking subsystem =====

	startTracking(tokenAddress, triggerCtx = {}) {
		if (!config.tracking.enabled) return;
		if (this.activeTracking.has(tokenAddress)) return;

		const now = Date.now();
		const logDir = config.tracking.logDir;
		try {
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}
		} catch (e) {
			logger.errorMonitor("Failed to ensure tracking log directory", { error: e.message, dir: logDir });
			return;
		}

		const filePath = path.join(logDir, `${tokenAddress}-websocket.log`);
		const stream = fs.createWriteStream(filePath, { flags: "a" });

		const session = {
			filePath,
			stream,
			startedAt: now,
			lastActivityAt: now,
			entryAfterTs: now + config.tracking.entryDelayMs,
			entryRecorded: false,
			entryPrice: null,
			entryMcUsd: null,
			entryMcSol: null,
			preEntryTotalTrades: null,
			preEntryBuys: null,
			preEntrySells: null,
			preEntryUniqueTraders: null,
			preEntryMinMcUsd: null,
			preEntryMaxMcUsd: null,
			minPct: 0,
			maxPct: 0,
			buyCount: 0,
			sellCount: 0,
			tradeCount: 0,
			inactivityTimer: null,
			hardStopTimer: null,
			entryTimer: null,
			// pre-trigger snapshot
			triggerAt: triggerCtx.triggerAt || new Date(now).toISOString(),
			ageAtTriggerSec: triggerCtx.ageAtTriggerSec || null,
			preTotalTrades: triggerCtx.preTotalTrades || 0,
			preBuys: triggerCtx.preBuys || 0,
			preSells: triggerCtx.preSells || 0,
			preUniqueTraders: triggerCtx.preUniqueTraders || 0,
			thresholdMcSol: triggerCtx.thresholdMcSol || null,
			thresholdMcUsd: triggerCtx.thresholdMcUsd || null,
			thresholdPrice: triggerCtx.thresholdPrice || null,
		};

		// timers
		session.inactivityTimer = setTimeout(() => this.stopTracking(tokenAddress, "inactivity"), config.tracking.inactivityMs);
		session.hardStopTimer = setTimeout(() => this.stopTracking(tokenAddress, "max_window"), config.tracking.maxWindowMs);
		// entry fallback timer (record entry from threshold data if no trade arrived yet)
		session.entryTimer = setTimeout(() => {
			try {
				const sess = this.activeTracking.get(tokenAddress);
				if (!sess || sess.entryRecorded) return;
				const solUsd = priceService.getSolUsd();
				const mcSol = typeof sess.thresholdMcSol === "number" ? sess.thresholdMcSol : 0;
				const mcUsd = typeof solUsd === "number" ? mcSol * solUsd : 0;
				const entryPrice = typeof sess.thresholdPrice === "number" ? sess.thresholdPrice : 0;

				// snapshot pre-entry stats at this moment
				const agg = this.tokenTradeStats.get(tokenAddress) || { total: 0, buys: 0, sells: 0, traders: new Set(), minMcUsd: null, maxMcUsd: null };
				sess.preEntryTotalTrades = agg.total || 0;
				sess.preEntryBuys = agg.buys || 0;
				sess.preEntrySells = agg.sells || 0;
				sess.preEntryUniqueTraders = agg.traders ? agg.traders.size : 0;
				sess.preEntryMinMcUsd = agg.minMcUsd;
				sess.preEntryMaxMcUsd = agg.maxMcUsd;

				sess.entryRecorded = true;
				sess.entryPrice = entryPrice;
				sess.entryMcSol = mcSol;
				sess.entryMcUsd = mcUsd;

				const ts = moment().tz(config.logging.timezone).format("DD-MM-YYYY HH:mm:ss.SSS");
				const buys = sess.preEntryBuys || 0;
				const sells = sess.preEntrySells || 0;
				let ratio = "0:0";
				if (buys > 0) ratio = `1:${(sells / buys).toFixed(2)}`;
				else if (sells > 0) ratio = "0:1";
				const minCap = sess.preEntryMinMcUsd != null ? Math.round(sess.preEntryMinMcUsd) : 0;
				const maxCap = sess.preEntryMaxMcUsd != null ? Math.round(sess.preEntryMaxMcUsd) : 0;
				sess.stream.write(
					`${ts} INFO Entry price: ${entryPrice.toFixed(18)} - Entry market cap: ${Math.round(mcUsd)} - Buys ${buys} - Sells ${sells} - Ratio: ${ratio} - Min MarketCap: ${minCap} - Max MarketCap: ${maxCap}\n`
				);
				// also write a first current line (0%) for visual continuity
				const elapsedMs = Date.now() - sess.startedAt;
				const h = String(Math.floor(elapsedMs / 3600000)).padStart(2, "0");
				const m = String(Math.floor((elapsedMs % 3600000) / 60000)).padStart(2, "0");
				const s = String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, "0");
				sess.stream.write(
					`${ts} INFO Current price: ${entryPrice.toFixed(12)} - Current percentage: 0.00% - Max: 0.00% - Min: 0.00% - Market Cap ${Math.round(mcUsd)} - Trading time: ${h}:${m}:${s}\n`
				);
			} catch (e) {
				logger.errorMonitor("Error recording fallback entry", { error: e.message, tokenAddress });
			}
		}, config.tracking.entryDelayMs);

		this.activeTracking.set(tokenAddress, session);
		logger.tokenMonitor("Tracking started for token", { tokenAddress, filePath });
	}

	stopTracking(tokenAddress, reason) {
		const session = this.activeTracking.get(tokenAddress);
		if (!session) return;
		try {
			if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
			if (session.hardStopTimer) clearTimeout(session.hardStopTimer);
			if (session.entryTimer) clearTimeout(session.entryTimer);
			const durationSec = Math.floor((Date.now() - session.startedAt) / 1000);
			const summary = {
				type: "summary",
				reason,
				startedAt: new Date(session.startedAt).toISOString(),
				endedAt: new Date().toISOString(),
				durationSec,
				entryPrice: session.entryPrice,
				entryMarketCapSol: session.entryMcSol,
				entryMarketCapUsd: session.entryMcUsd,
				minPct: session.minPct,
				maxPct: session.maxPct,
				buyCount: session.buyCount,
				sellCount: session.sellCount,
				tradeCount: session.tradeCount,
				entryRecorded: session.entryRecorded,
				noPostThresholdTrades: session.tradeCount === 0,
				// pre-trigger snapshot
				triggerAt: session.triggerAt,
				ageAtTriggerSec: session.ageAtTriggerSec,
				preTotalTrades: session.preTotalTrades,
				preBuys: session.preBuys,
				preSells: session.preSells,
				preUniqueTraders: session.preUniqueTraders,
				preEntryTotalTrades: session.preEntryTotalTrades,
				preEntryBuys: session.preEntryBuys,
				preEntrySells: session.preEntrySells,
				preEntryUniqueTraders: session.preEntryUniqueTraders,
				preEntryMinMcUsd: session.preEntryMinMcUsd,
				preEntryMaxMcUsd: session.preEntryMaxMcUsd,
				thresholdMcSol: session.thresholdMcSol,
				thresholdMcUsd: session.thresholdMcUsd,
				thresholdPrice: session.thresholdPrice,
			};
			const ts = moment().tz(config.logging.timezone).format("DD-MM-YYYY HH:mm:ss.SSS");
			// clear separation before summary (for readability)
			session.stream.write(`\n\n\n\n\n\n`);
			session.stream.write(`${ts} INFO ${JSON.stringify(summary)}\n`);

			// Also append a consolidated summary line to a global summaries log
			try {
				const tokenInfo = this.monitoredTokens.get(tokenAddress) || {};
				// Classification outcome based on configured thresholds
				const goodT = config.summaries.goodThresholdPct;
				const badT = config.summaries.badThresholdPct;
				let outcome = "neutral";
				let outcomeReason = "no thresholds met";
				if (typeof summary.maxPct === "number" && isFinite(summary.maxPct) && summary.maxPct >= goodT) {
					outcome = "good";
					outcomeReason = `maxPct ${summary.maxPct.toFixed(2)}% >= ${goodT}%`;
				} else if (typeof summary.minPct === "number" && isFinite(summary.minPct) && summary.minPct <= -badT) {
					outcome = "bad";
					outcomeReason = `minPct ${summary.minPct.toFixed(2)}% <= -${badT}%`;
				}

				const priceDecimals = Math.max(0, parseInt(config.summaries.priceDecimals || 12));
				const summaryForGlobal = {
					...summary,
					tokenAddress,
					tokenName: tokenInfo.name || null,
					tokenSymbol: tokenInfo.symbol || null,
					outcome,
					outcomeReason,
					goodThresholdPct: goodT,
					badThresholdPct: badT,
					// Formatted helpers for quick visual scanning
					entryPriceStr: typeof summary.entryPrice === "number" && isFinite(summary.entryPrice) ? summary.entryPrice.toFixed(priceDecimals) : null,
					entryMarketCapSolStr:
						typeof summary.entryMarketCapSol === "number" && isFinite(summary.entryMarketCapSol)
							? `${summary.entryMarketCapSol.toLocaleString("es-ES", { maximumFractionDigits: 6 })} SOL`
							: null,
					entryMarketCapUsdStr:
						typeof summary.entryMarketCapUsd === "number" && isFinite(summary.entryMarketCapUsd) ? formatCurrencyEs(summary.entryMarketCapUsd, "$") : null,
					minPctStr: typeof summary.minPct === "number" && isFinite(summary.minPct) ? formatPercentage(summary.minPct) : null,
					maxPctStr: typeof summary.maxPct === "number" && isFinite(summary.maxPct) ? formatPercentage(summary.maxPct) : null,
					thresholdPriceStr: typeof summary.thresholdPrice === "number" && isFinite(summary.thresholdPrice) ? summary.thresholdPrice.toFixed(priceDecimals) : null,
					thresholdMcSolStr:
						typeof summary.thresholdMcSol === "number" && isFinite(summary.thresholdMcSol)
							? `${summary.thresholdMcSol.toLocaleString("es-ES", { maximumFractionDigits: 6 })} SOL`
							: null,
					thresholdMcUsdStr: typeof summary.thresholdMcUsd === "number" && isFinite(summary.thresholdMcUsd) ? formatCurrencyEs(summary.thresholdMcUsd, "$") : null,
				};
				const summariesLogPath = path.join("logs", "tracking-summaries.log");
				if (!fs.existsSync("logs")) {
					fs.mkdirSync("logs", { recursive: true });
				}
				fs.appendFileSync(summariesLogPath, `${ts} INFO ${JSON.stringify(summaryForGlobal)}\n`);
			} catch (e) {
				logger.errorMonitor("Failed to write global summary log", { error: e.message, tokenAddress });
			}
			session.stream.end();
			this.wsClient.unsubscribeTokenTrades([tokenAddress]);
			logger.tokenMonitor("Tracking stopped for token", { tokenAddress, reason, filePath: session.filePath });
		} catch (e) {
			logger.errorMonitor("Error stopping tracking", { error: e.message, tokenAddress });
		} finally {
			this.activeTracking.delete(tokenAddress);
		}
	}

	_resetTrackingInactivity(tokenAddress) {
		const session = this.activeTracking.get(tokenAddress);
		if (!session) return;
		if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
		session.inactivityTimer = setTimeout(() => this.stopTracking(tokenAddress, "inactivity"), config.tracking.inactivityMs);
	}

	handleNewToken(tokenData) {
		try {
			logger.debugTokenMonitor("Processing new token data", {
				hasMint: !!tokenData.mint,
				hasTrader: !!tokenData.traderPublicKey,
				hasName: !!tokenData.name,
				hasSymbol: !!tokenData.symbol,
				txType: tokenData.txType,
			});

			const tokenAddress = tokenData.mint;
			const creatorAddress = tokenData.traderPublicKey; // PumpPortal uses traderPublicKey for creator
			const tokenName = tokenData.name;
			const tokenSymbol = tokenData.symbol;

			if (!tokenAddress || !creatorAddress) {
				logger.debugTokenMonitor("Invalid token data - missing required fields", {
					tokenAddress,
					creatorAddress,
					tokenName,
					tokenSymbol,
					allKeys: Object.keys(tokenData),
				});
				return;
			}

			// Store token information
			this.monitoredTokens.set(tokenAddress, {
				name: tokenName,
				symbol: tokenSymbol,
				creator: creatorAddress,
				createdAt: new Date(),
				initialSupply: tokenData.initialSupply || 0,
				currentSupply: tokenData.currentSupply || 0,
			});

			logger.debugTokenMonitor(`Token stored: ${tokenName} (${tokenSymbol})`, {
				tokenAddress,
				creatorAddress,
				name: tokenName,
				symbol: tokenSymbol,
			});

			// Track creator's tokens
			if (!this.creatorPositions.has(creatorAddress)) {
				this.creatorPositions.set(creatorAddress, new Set());
			}
			this.creatorPositions.get(creatorAddress).add(tokenAddress);

			// Initialize token sell tracking (por token individual)
			const initialTokensOwned = tokenData.initialBuy || tokenData.tokenAmount || 0;
			this.tokenSellTracking.set(tokenAddress, {
				creatorAddress,
				totalTokensOwned: initialTokensOwned, // Tokens que el creador compró para este token
				initialTokensOwned, // Guardamos el balance inicial para cálculos de %
				tokensSold: 0,
				lastSellTime: null,
				sellHistory: [],
				exitMarketCapSol: null,
				exitMarketCapUsd: null,
				exitAt: null,
				exitLogged: false,
				thresholdAlerted: false,
			});

			logger.debugTokenMonitor(`New token detected: ${tokenName} (${tokenSymbol})`, {
				tokenAddress,
				creatorAddress,
				creatorInitialBuy: tokenData.initialBuy,
				totalSupply: tokenData.initialSupply,
			});

			// Subscribe to trades for this token
			this.wsClient.subscribeTokenTrades([tokenAddress]);
			logger.debugTokenMonitor(`Subscribed to trades for new token: ${tokenName} (${tokenSymbol})`, {
				tokenAddress,
				creatorAddress,
			});

			// Note: Account trades subscription removed - we'll detect creator sells from token trades instead
			// This is more reliable as it doesn't depend on PumpPortal's account trade format
			if (config.app.monitorCreatorSells) {
				logger.tokenMonitor(`Creator monitoring enabled for: ${creatorAddress}`, {
					tokenAddress,
					tokenName,
					tokenSymbol,
					creatorAddress,
				});
			}
		} catch (error) {
			logger.errorMonitor("Error handling new token", { error: error.message, tokenData });
		}
	}

	handleTrade(tradeData) {
		try {
			const { mint: tokenAddress, traderPublicKey: traderAddress, txType, tokenAmount, solAmount, marketCapSol, price } = tradeData;

			if (!tokenAddress || !traderAddress || !txType) {
				logger.tokenMonitor("Invalid trade data received", { tradeData });
				return;
			}

			// Check if this is a sell trade by a creator FIRST
			if (txType === "sell" && this.isCreatorOfToken(traderAddress, tokenAddress)) {
				// Para creator trades, usamos un ID diferente para evitar falsos positivos de duplicados
				const creatorTradeId = `creator-${tradeData.signature}-${tokenAddress}-${traderAddress}`;
				if (!this.processedTrades) {
					this.processedTrades = new Set();
				}

				if (this.processedTrades.has(creatorTradeId)) {
					logger.debugTokenMonitor(`Skipping duplicate creator trade: ${creatorTradeId}`);
					return;
				}

				this.processedTrades.add(creatorTradeId);
				this.handleCreatorSell(traderAddress, tokenAddress, tradeData);
				return; // Salimos aquí para no procesar como trade normal
			}

			// Handle creator BUY to keep balances accurate
			if (txType === "buy" && this.isCreatorOfToken(traderAddress, tokenAddress)) {
				const creatorTradeId = `creator-buy-${tradeData.signature}-${tokenAddress}-${traderAddress}`;
				if (!this.processedTrades) {
					this.processedTrades = new Set();
				}
				if (this.processedTrades.has(creatorTradeId)) {
					logger.debugTokenMonitor(`Skipping duplicate creator buy trade: ${creatorTradeId}`);
					return;
				}
				this.processedTrades.add(creatorTradeId);
				this.handleCreatorBuy(traderAddress, tokenAddress, tradeData);
				return;
			}

			// Para trades normales (no creator), verificar duplicados normalmente
			const tradeId = `${tradeData.signature}-${tokenAddress}-${traderAddress}`;
			if (!this.processedTrades) {
				this.processedTrades = new Set();
			}

			if (this.processedTrades.has(tradeId)) {
				logger.debugTokenMonitor(`Skipping duplicate trade: ${tradeId}`);
				return;
			}

			this.processedTrades.add(tradeId);

			// Trade logging sampling/throttling to reduce log volume
			const tradeLogCfg = (config.logging && config.logging.trade) || {};
			let shouldLog = true;
			const tokenKey = tokenAddress || "unknown";
			// Initialize internal state maps lazily
			if (!this._tradeLogCounters) this._tradeLogCounters = new Map();
			if (!this._tradeLogLastTs) this._tradeLogLastTs = new Map();

			// Throttle by time per token
			if (tradeLogCfg.throttleMs && tradeLogCfg.throttleMs > 0) {
				const now = Date.now();
				const last = this._tradeLogLastTs.get(tokenKey) || 0;
				if (now - last < tradeLogCfg.throttleMs) {
					shouldLog = false;
				} else {
					this._tradeLogLastTs.set(tokenKey, now);
				}
			}

			// Sample every N trades per token
			if (shouldLog && tradeLogCfg.sampleEvery && tradeLogCfg.sampleEvery > 1) {
				const cnt = (this._tradeLogCounters.get(tokenKey) || 0) + 1;
				this._tradeLogCounters.set(tokenKey, cnt);
				if (cnt % tradeLogCfg.sampleEvery !== 0) {
					shouldLog = false;
				}
			}

			if (shouldLog) {
				logger.debugTokenMonitor(`Trade detected: ${txType.toUpperCase()}`, { tokenAddress, traderAddress, tokenAmount, solAmount, marketCapSol, price });
			}

			// Update aggregated per-token trade stats (lifetime)
			let agg = this.tokenTradeStats.get(tokenAddress);
			if (!agg) {
				agg = { total: 0, buys: 0, sells: 0, traders: new Set(), lastTradeAt: null, minMcUsd: null, maxMcUsd: null };
				this.tokenTradeStats.set(tokenAddress, agg);
			}
			agg.total += 1;
			if (txType === "buy") agg.buys += 1;
			if (txType === "sell") agg.sells += 1;
			agg.traders.add(traderAddress);
			agg.lastTradeAt = new Date();
			// Update lifetime min/max MarketCap USD if available
			const _solUsd = priceService.getSolUsd();
			if (typeof marketCapSol === "number" && typeof _solUsd === "number") {
				const _mcUsd = marketCapSol * _solUsd;
				agg.minMcUsd = agg.minMcUsd === null ? _mcUsd : Math.min(agg.minMcUsd, _mcUsd);
				agg.maxMcUsd = agg.maxMcUsd === null ? _mcUsd : Math.max(agg.maxMcUsd, _mcUsd);
			}

			// Tracking: update per-trade if active
			const session = this.activeTracking.get(tokenAddress);
			if (session) {
				session.tradeCount += 1;
				if (txType === "buy") session.buyCount += 1;
				if (txType === "sell") session.sellCount += 1;
				session.lastActivityAt = Date.now();
				this._resetTrackingInactivity(tokenAddress);

				let currentPrice = typeof price === "number" && isFinite(price) ? price : undefined;
				if (currentPrice === undefined) {
					if (typeof solAmount === "number" && typeof tokenAmount === "number" && tokenAmount > 0) {
						currentPrice = solAmount / tokenAmount;
					} else {
						currentPrice = 0;
					}
				}

				const solUsd = priceService.getSolUsd();
				const mcSol = typeof marketCapSol === "number" ? marketCapSol : 0;
				const mcUsd = typeof solUsd === "number" ? mcSol * solUsd : 0;

				// Record entry after delay using the first trade at/after entryAfterTs
				if (!session.entryRecorded && Date.now() >= session.entryAfterTs) {
					// snapshot pre-entry stats at this moment
					const agg = this.tokenTradeStats.get(tokenAddress) || { total: 0, buys: 0, sells: 0, traders: new Set(), minMcUsd: null, maxMcUsd: null };
					session.preEntryTotalTrades = agg.total || 0;
					session.preEntryBuys = agg.buys || 0;
					session.preEntrySells = agg.sells || 0;
					session.preEntryUniqueTraders = agg.traders ? agg.traders.size : 0;
					session.preEntryMinMcUsd = agg.minMcUsd;
					session.preEntryMaxMcUsd = agg.maxMcUsd;

					session.entryRecorded = true;
					session.entryPrice = currentPrice;
					session.entryMcSol = mcSol;
					session.entryMcUsd = mcUsd;
					const ts = moment().tz(config.logging.timezone).format("DD-MM-YYYY HH:mm:ss.SSS");
					const entryPriceStr = (session.entryPrice || 0).toFixed(18);
					const entryMcStr = Math.round(session.entryMcUsd || 0);
					const buys0 = session.preEntryBuys || 0;
					const sells0 = session.preEntrySells || 0;
					let ratio0 = "0:0";
					if (buys0 > 0) ratio0 = `1:${(sells0 / buys0).toFixed(2)}`;
					else if (sells0 > 0) ratio0 = "0:1";
					const minCap0 = session.preEntryMinMcUsd != null ? Math.round(session.preEntryMinMcUsd) : 0;
					const maxCap0 = session.preEntryMaxMcUsd != null ? Math.round(session.preEntryMaxMcUsd) : 0;
					session.stream.write(
						`${ts} INFO Entry price: ${entryPriceStr} - Entry market cap: ${entryMcStr} - Buys ${buys0} - Sells ${sells0} - Ratio: ${ratio0} - Min MarketCap: ${minCap0} - Max MarketCap: ${maxCap0}\n`
					);
					// Current line for this same trade (will also be printed below, but ensure immediate feedback)
					const elapsedMs0 = Date.now() - session.startedAt;
					const h0 = String(Math.floor(elapsedMs0 / 3600000)).padStart(2, "0");
					const m0 = String(Math.floor((elapsedMs0 % 3600000) / 60000)).padStart(2, "0");
					const s0 = String(Math.floor((elapsedMs0 % 60000) / 1000)).padStart(2, "0");
					session.stream.write(
						`${ts} INFO Current price: ${(currentPrice || 0).toFixed(12)} - Current percentage: 0.00% - Max: 0.00% - Min: 0.00% - Market Cap ${entryMcStr} - Trading time: ${h0}:${m0}:${s0}\n`
					);
				}

				// If entry recorded, write current status
				if (session.entryRecorded) {
					const pct = session.entryMcUsd > 0 ? ((mcUsd - session.entryMcUsd) / session.entryMcUsd) * 100 : 0;
					session.minPct = Math.min(session.minPct, pct);
					session.maxPct = Math.max(session.maxPct, pct);
					const elapsedMs = Date.now() - session.startedAt;
					const h = String(Math.floor(elapsedMs / 3600000)).padStart(2, "0");
					const m = String(Math.floor((elapsedMs % 3600000) / 60000)).padStart(2, "0");
					const s = String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, "0");
					const ts = moment().tz(config.logging.timezone).format("DD-MM-YYYY HH:mm:ss.SSS");
					const currentPriceStr = (currentPrice || 0).toFixed(12);
					const pctStr = `${pct.toFixed(2)}%`;
					const maxStr = `${session.maxPct.toFixed(2)}%`;
					const minStr = `${session.minPct.toFixed(2)}%`;
					const mcStr = Math.round(mcUsd || 0);
					session.stream.write(
						`${ts} INFO Current price: ${currentPriceStr} - Current percentage: ${pctStr} - Max: ${maxStr} - Min: ${minStr} - Market Cap ${mcStr} - Trading time: ${h}:${m}:${s}\n`
					);
				}
			}
		} catch (error) {
			logger.errorMonitor("Error handling trade", { error: error.message, tradeData });
		}
	}

	isCreatorOfToken(traderAddress, tokenAddress) {
		const tokenInfo = this.monitoredTokens.get(tokenAddress);
		if (!tokenInfo) {
			logger.debugTokenMonitor(`Token ${tokenAddress} not found in monitored tokens`);
			return false;
		}

		const isCreator = tokenInfo.creator === traderAddress;
		if (isCreator) {
			logger.tokenMonitor(`CREATOR TRADE DETECTED: ${traderAddress} for token ${tokenAddress}`);
		}

		return isCreator;
	}

	handleCreatorBuy(creatorAddress, tokenAddress, tradeData) {
		const tokenInfo = this.monitoredTokens.get(tokenAddress);
		const tokenTracking = this.tokenSellTracking.get(tokenAddress);

		if (!tokenInfo || !tokenTracking) {
			return;
		}

		// Verificar que el trader sea el creador de este token específico
		if (tokenTracking.creatorAddress !== creatorAddress) {
			return;
		}

		const { tokenAmount, solAmount, price } = tradeData;

		// Sumar tokens al balance del creador
		tokenTracking.totalTokensOwned += tokenAmount;

		// Sumar también al denominador usado para el porcentaje de venta total
		// (representa el total de tokens adquiridos por el creador en la vida del token)
		tokenTracking.initialTokensOwned += tokenAmount;

		logger.debugTokenMonitor(`Creator BUY recorded for ${tokenAddress}:`, {
			creatorAddress,
			tokenBought: tokenAmount,
			newBalance: tokenTracking.totalTokensOwned,
			newDenominator: tokenTracking.initialTokensOwned,
			solSpent: solAmount,
			price,
		});
	}

	handleCreatorSell(creatorAddress, tokenAddress, tradeData) {
		const tokenInfo = this.monitoredTokens.get(tokenAddress);
		const tokenTracking = this.tokenSellTracking.get(tokenAddress);

		if (!tokenInfo || !tokenTracking) {
			return;
		}

		// Verificar que el trader sea el creador de este token específico
		if (tokenTracking.creatorAddress !== creatorAddress) {
			return;
		}

		// Los duplicados ya se verificaron en handleTrade, aquí procesamos directamente

		const { tokenAmount, solAmount, price, marketCapSol } = tradeData;

		// Calcular porcentaje basado en el balance ANTES de la venta
		const balanceBeforeSell = tokenTracking.totalTokensOwned;
		const sellPercentage = balanceBeforeSell > 0 ? (tokenAmount / balanceBeforeSell) * 100 : 0;

		// Validar que no vendamos más tokens de los que tenemos
		if (tokenAmount > balanceBeforeSell) {
			logger.warnMonitor(`Creator trying to sell more tokens than owned!`, {
				creatorAddress,
				tokenAddress,
				tokenAmount,
				balanceBeforeSell,
				tokenName: tokenInfo.name,
			});
			return; // No procesar esta venta inválida
		}

		// Update tracking - restar tokens del balance del creador
		tokenTracking.totalTokensOwned -= tokenAmount; // Restar del balance del creador
		tokenTracking.tokensSold += tokenAmount; // Acumular total vendido
		tokenTracking.lastSellTime = new Date();
		tokenTracking.sellHistory.push({
			tokenAddress,
			tokenAmount,
			solAmount,
			price,
			timestamp: new Date(),
			percentage: sellPercentage,
		});

		logger.debugTokenMonitor(`Updated tracking for ${tokenAddress}:`, {
			creatorAddress,
			balanceBeforeSell,
			tokensSoldInThisTrade: tokenAmount,
			balanceAfterSell: tokenTracking.totalTokensOwned,
			totalTokensSold: tokenTracking.tokensSold,
			sellPercentage: sellPercentage.toFixed(2),
		});

		// Check if creator has sold a significant portion of THIS token
		const totalSoldPercentage = tokenTracking.initialTokensOwned > 0 ? (tokenTracking.tokensSold / tokenTracking.initialTokensOwned) * 100 : 0;

		logger.creatorSell(`Creator sell detected`, {
			creatorAddress,
			tokenAddress,
			tokenName: tokenInfo.name,
			tokenSymbol: tokenInfo.symbol,
			sellAmount: tokenAmount,
			sellPercentage: sellPercentage.toFixed(2),
			totalSoldPercentage: totalSoldPercentage.toFixed(2),
			solReceived: solAmount,
			price,
			marketCapSol,
		});

		// Log current state after update
		logger.tokenMonitor(`STATE UPDATED for ${tokenInfo.name}:`, {
			currentTokensOwned: tokenTracking.totalTokensOwned,
			totalTokensSold: tokenTracking.tokensSold,
			totalSellPercentage: totalSoldPercentage.toFixed(2),
			totalSells: tokenTracking.sellHistory.length,
		});

		// Alert once if creator has sold more than threshold of THIS token
		if (totalSoldPercentage >= config.thresholds.creatorSellThreshold && !tokenTracking.thresholdAlerted) {
			const alertMessage = `Creator sold ${totalSoldPercentage.toFixed(2)}% of tokens in ${tokenInfo.name} (${tokenInfo.symbol})`;

			logger.creatorAlert(alertMessage, {
				creatorAddress,
				tokenAddress,
				tokenName: tokenInfo.name,
				tokenSymbol: tokenInfo.symbol,
				sellPercentage: totalSoldPercentage.toFixed(2),
				threshold: config.thresholds.creatorSellThreshold,
				totalSold: tokenTracking.tokensSold,
				totalOwned: tokenTracking.totalTokensOwned,
				lastSellTime: tokenTracking.lastSellTime,
				totalSellsInHistory: tokenTracking.sellHistory.length,
			});

			console.info(`[ALERT] Creator ${creatorAddress} has sold ${totalSoldPercentage.toFixed(2)}% of tokens in ${tokenInfo.name} (${tokenInfo.symbol})!`);
			tokenTracking.thresholdAlerted = true;

			// Snapshot pre-trigger stats and pass to tracker
			const stats = this.tokenTradeStats.get(tokenAddress) || { total: 0, buys: 0, sells: 0, traders: new Set(), minMcUsd: null, maxMcUsd: null };
			const solUsd = priceService.getSolUsd();
			const thresholdMcSol = typeof marketCapSol === "number" ? marketCapSol : null;
			const thresholdMcUsd = thresholdMcSol !== null && typeof solUsd === "number" ? thresholdMcSol * solUsd : null;
			const triggerAt = new Date();
			const tokenCreatedAt = this.monitoredTokens.get(tokenAddress)?.createdAt;
			const ageAtTriggerSec = tokenCreatedAt ? Math.floor((triggerAt - tokenCreatedAt) / 1000) : null;
			const thresholdPrice =
				typeof price === "number" && isFinite(price)
					? price
					: typeof solAmount === "number" && typeof tokenAmount === "number" && tokenAmount > 0
						? solAmount / tokenAmount
						: null;

			// Optional pre-conditions to start tracking (from ENV)
			let passesFilters = true;
			const f = config.trackingFilters || { enabled: false };
			if (f.enabled) {
				const total = stats.total || 0;
				const buys = stats.buys || 0;
				const sells = stats.sells || 0;
				const uniq = stats.traders ? stats.traders.size : 0;
				const denom = buys + sells;
				const buyRatio = denom > 0 ? buys / denom : 0;
				const netBuys = buys - sells;
				const uniquePerTrade = total > 0 ? uniq / total : 0;
				const buysPerUnique = uniq > 0 ? buys / uniq : 0;
				const mcUsd = typeof thresholdMcUsd === "number" ? thresholdMcUsd : 0;
				const volRatio = stats.minMcUsd && stats.minMcUsd > 0 && stats.maxMcUsd ? stats.maxMcUsd / stats.minMcUsd : null;

				passesFilters =
					buys >= (f.minBuys || 0) &&
					total >= (f.minTotalTrades || 0) &&
					uniq >= (f.minUniqueTraders || 0) &&
					buyRatio >= (f.minBuyRatio || 0) &&
					netBuys >= (f.minNetBuys || 0) &&
					mcUsd >= (Number.isFinite(f.minMcUsd) ? f.minMcUsd : 0) &&
					mcUsd <= (Number.isFinite(f.maxMcUsd) ? f.maxMcUsd : Infinity) &&
					uniquePerTrade >= (f.minUniquePerTrade || 0) &&
					buysPerUnique >= (f.minBuysPerUnique || 0) &&
					(ageAtTriggerSec === null || ageAtTriggerSec <= (Number.isFinite(f.maxAgeAtTriggerSec) ? f.maxAgeAtTriggerSec : Infinity)) &&
					(volRatio === null || volRatio <= (Number.isFinite(f.maxMcVolatilityRatio) ? f.maxMcVolatilityRatio : Infinity));

				if (!passesFilters) {
					logger.tokenMonitor("Tracking filters not met; skipping tracking start", {
						tokenAddress,
						buys,
						sells,
						total,
						uniq,
						buyRatio: buyRatio.toFixed(3),
						netBuys,
						mcUsd: Math.round(mcUsd),
						uniquePerTrade: uniquePerTrade.toFixed(3),
						buysPerUnique: buysPerUnique.toFixed(3),
						ageAtTriggerSec,
						volatilityRatio: volRatio,
						filters: f,
					});
				}
			}
			// Only start tracking if filters pass or filters are disabled
			if (f.enabled && !passesFilters) {
				logger.tokenMonitor("Tracking not started due to filters", { tokenAddress });
				return;
			}
			this.startTracking(tokenAddress, {
				triggerAt: triggerAt.toISOString(),
				ageAtTriggerSec,
				preTotalTrades: stats.total || 0,
				preBuys: stats.buys || 0,
				preSells: stats.sells || 0,
				preUniqueTraders: stats.traders ? stats.traders.size : 0,
				thresholdMcSol,
				thresholdMcUsd,
				thresholdPrice,
			});
		}

		// If creator fully exited position, record market caps
		const fullyExited = tokenTracking.totalTokensOwned === 0 || tokenTracking.tokensSold >= tokenTracking.initialTokensOwned;
		if (fullyExited && !tokenTracking.exitLogged) {
			const solUsd = priceService.getSolUsd();
			const mcSol = typeof marketCapSol === "number" ? marketCapSol : null;
			const mcUsd = mcSol !== null && typeof solUsd === "number" ? mcSol * solUsd : null;

			tokenTracking.exitMarketCapSol = mcSol;
			tokenTracking.exitMarketCapUsd = mcUsd;
			tokenTracking.exitAt = new Date();
			tokenTracking.exitLogged = true;

			logger.creatorAlert("Creator fully exited token", {
				creatorAddress,
				tokenAddress,
				tokenName: tokenInfo.name,
				tokenSymbol: tokenInfo.symbol,
				exitAt: tokenTracking.exitAt,
				exitMarketCapSol: mcSol,
				exitMarketCapUsd: mcUsd,
				solUsdPrice: solUsd,
			});

			const mcUsdStr = mcUsd !== null ? formatCurrencyEs(mcUsd, "$") : "N/D";
			const mcSolStr = typeof mcSol === "number" ? `${mcSol.toLocaleString("es-ES", { maximumFractionDigits: 6 })} SOL` : "N/D";
			console.info(`[CREATOR_SELL] Creator fully exited ${tokenInfo.name} (${tokenInfo.symbol}) at MC: ${mcSolStr} (${mcUsdStr})`);
		}
	}

	getMonitoredTokens() {
		return Array.from(this.monitoredTokens.entries()).map(([address, info]) => ({
			address,
			...info,
		}));
	}

	getCreatorTracking() {
		// Agrupar tracking por token en tracking por creador
		const creatorMap = new Map();

		this.tokenSellTracking.forEach((tracking, tokenAddress) => {
			const creator = tracking.creatorAddress;
			if (!creatorMap.has(creator)) {
				creatorMap.set(creator, {
					creator,
					totalTokensOwned: 0,
					tokensSold: 0,
					sellHistory: [],
					tokens: [],
				});
			}

			const creatorData = creatorMap.get(creator);
			creatorData.totalTokensOwned += tracking.initialTokensOwned; // Usar balance inicial
			creatorData.tokensSold += tracking.tokensSold;
			creatorData.sellHistory.push(...tracking.sellHistory);
			creatorData.tokens.push(tokenAddress);
		});

		return Array.from(creatorMap.values());
	}

	// Mostrar estado de todos los tokens trackeados
	showTrackingStatus() {
		const monitoredTokens = this.getMonitoredTokens();

		if (monitoredTokens.length === 0) {
			logger.tokenMonitor("No tokens being tracked currently");
			return;
		}

		console.info("\n=== TOKENS TRACKED STATUS ===");
		console.info(`Total tokens monitored: ${monitoredTokens.length}\n`);

		monitoredTokens.forEach((token) => {
			const tokenTracking = this.tokenSellTracking.get(token.address);
			const tokenInfo = this.monitoredTokens.get(token.address);

			if (!tokenTracking || !tokenInfo) {
				return;
			}

			const totalSoldPercentage = tokenTracking.initialTokensOwned > 0 ? (tokenTracking.tokensSold / tokenTracking.initialTokensOwned) * 100 : 0;
			// Indicator removed (no emojis in logs/console)
			const lastSellTime = tokenTracking.lastSellTime
				? new Date(tokenTracking.lastSellTime).toLocaleTimeString("es-ES", {
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
					})
				: "Never";

			console.info(`${tokenInfo.name} (${tokenInfo.symbol})`);
			console.info(`   Address: ${token.address}`);
			console.info(`   Creator: ${tokenInfo.creator}`);
			console.info(`   Creator owns: ${tokenTracking.totalTokensOwned.toLocaleString()} tokens`);
			console.info(`   Creator sold: ${tokenTracking.tokensSold.toLocaleString()} tokens`);
			console.info(`   Sold percentage: ${totalSoldPercentage.toFixed(2)}%`);
			console.info(`   Last sell: ${lastSellTime}`);
			console.info(`   Total sells: ${tokenTracking.sellHistory.length}`);
			console.info(`   Created: ${new Date(tokenInfo.createdAt).toLocaleString("es-ES")}`);
			if (tokenTracking.exitLogged) {
				const mcUsdStr = tokenTracking.exitMarketCapUsd !== null ? formatCurrencyEs(tokenTracking.exitMarketCapUsd, "$") : "N/D";
				const mcSolStr = tokenTracking.exitMarketCapSol !== null ? `${tokenTracking.exitMarketCapSol.toLocaleString("es-ES", { maximumFractionDigits: 6 })} SOL` : "N/D";
				const exitTime = tokenTracking.exitAt ? new Date(tokenTracking.exitAt).toLocaleString("es-ES") : "N/D";
				console.info(`   Exit MC: ${mcSolStr} (${mcUsdStr}) at ${exitTime}`);
			}
			console.info("");
		});

		console.info("=====================================\n");

		// Log resumido para archivos
		logger.tokenMonitor(`Tracking status update: ${monitoredTokens.length} tokens monitored`, {
			totalTokens: monitoredTokens.length,
			tokensOverThreshold: monitoredTokens.filter((token) => {
				const tracking = this.tokenSellTracking.get(token.address);
				if (!tracking) return false;
				const percentage = tracking.initialTokensOwned > 0 ? (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
				return percentage >= config.thresholds.creatorSellThreshold;
			}).length,
		});
	}

	// Mostrar resumen compacto (útil para logs)
	showCompactStatus() {
		const monitoredTokens = this.getMonitoredTokens();

		if (monitoredTokens.length === 0) {
			return;
		}

		const statusSummary = monitoredTokens
			.map((token) => {
				const tracking = this.tokenSellTracking.get(token.address);
				const info = this.monitoredTokens.get(token.address);

				if (!tracking || !info) return null;

				const percentage = tracking.initialTokensOwned > 0 ? (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
				const status = percentage >= config.thresholds.creatorSellThreshold ? "ALERT" : "OK";

				return `${status} ${info.name}(${info.symbol}): ${percentage.toFixed(1)}%`;
			})
			.filter(Boolean)
			.join(" | ");

		console.info(`Status: ${statusSummary}`);
	}
}

export default TokenMonitor;
