/**
 * metrics-calculator.js
 * Calcula métricas avanzadas para detectar tokens prometedores en tiempo real
 */

/**
 * Calcula la mediana de un array de números
 */
function calculateMedian(values) {
	if (!values || values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Calcula el promedio de un array
 */
function calculateAverage(values) {
	if (!values || values.length === 0) return 0;
	return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Calcula la desviación estándar
 */
function calculateStdDev(values) {
	if (!values || values.length < 2) return 0;
	const avg = calculateAverage(values);
	const squareDiffs = values.map((val) => Math.pow(val - avg, 2));
	const avgSquareDiff = calculateAverage(squareDiffs);
	return Math.sqrt(avgSquareDiff);
}

/**
 * Clase para calcular métricas en tiempo real de un token
 */
class MetricsCalculator {
	constructor() {
		// Estructuras de datos para tracking
		this.holders = new Map(); // address -> { boughtAt, soldAt, amount, stillHolding, buyAmount }
		this.tradeTimestamps = []; // [timestamp, ...]
		this.buyTimestamps = []; // [timestamp, ...]
		this.buyAmounts = []; // [solAmount, ...]
		this.priceHistory = []; // [{ price, timestamp, mcUsd }, ...]
		this.buyerWallets = new Set(); // Set of buyer addresses
		this.sellerWallets = new Set(); // Set of seller addresses
		this.tokenCreatedAt = null; // Timestamp de creación del token
		this.volumeHistory = []; // [{ volume, timestamp }, ...] para VSR
		this.largeBuys = []; // [{solAmount, timestamp}, ...] para Whale Presence
	}

	/**
	 * Registra un trade (compra o venta)
	 */
	recordTrade(tradeData) {
		const { traderAddress, txType, tokenAmount, solAmount, price, marketCapSol, timestamp } = tradeData;
		const now = timestamp || Date.now();

		// Set token creation time on first trade
		if (!this.tokenCreatedAt) {
			this.tokenCreatedAt = now;
		}

		this.tradeTimestamps.push(now);

		// Registrar precio
		if (typeof price === "number" && isFinite(price)) {
			this.priceHistory.push({
				price,
				timestamp: now,
				mcUsd: marketCapSol || null,
			});
		}

		if (txType === "buy") {
			this.buyTimestamps.push(now);
			this.buyerWallets.add(traderAddress);

			// Registrar compra
			if (typeof solAmount === "number" && isFinite(solAmount)) {
				this.buyAmounts.push(solAmount);
				
				// Track large buys for Whale Presence Score
				if (solAmount >= 0.5) {
					this.largeBuys.push({ solAmount, timestamp: now });
				}
			}

			// Track volume for VSR
			if (typeof solAmount === "number" && isFinite(solAmount)) {
				this.volumeHistory.push({ volume: solAmount, timestamp: now });
			}

			// Actualizar holder
			if (!this.holders.has(traderAddress)) {
				this.holders.set(traderAddress, {
					boughtAt: now,
					soldAt: null,
					amount: tokenAmount || 0,
					stillHolding: true,
					buyAmount: solAmount || 0,
				});
			} else {
				const holder = this.holders.get(traderAddress);
				holder.amount += tokenAmount || 0;
				holder.buyAmount += solAmount || 0;
				holder.stillHolding = true;
			}
		} else if (txType === "sell") {
			this.sellerWallets.add(traderAddress);

			// Actualizar holder
			const holder = this.holders.get(traderAddress);
			if (holder) {
				holder.soldAt = now;
				holder.stillHolding = false;
				holder.amount -= tokenAmount || 0;
				if (holder.amount <= 0) {
					holder.stillHolding = false;
				}
			}
		}
	}

	/**
	 * 1. Buy Acceleration - Crítica para detectar momentum
	 * Compara compras en los últimos 60s vs los 60s anteriores
	 */
	getBuyAcceleration() {
		const now = Date.now();
		const last60s = now - 60000;
		const previous60s = now - 120000;

		const buysLast60s = this.buyTimestamps.filter((ts) => ts >= last60s && ts < now).length;
		const buysPrevious60s = this.buyTimestamps.filter((ts) => ts >= previous60s && ts < last60s).length;

		return buysLast60s - buysPrevious60s;
	}

	/**
	 * Velocidad de compras (buys por minuto) en diferentes ventanas
	 */
	getBuyVelocity(windowSec = 120) {
		const now = Date.now();
		const windowMs = windowSec * 1000;
		const windowStart = now - windowMs;

		const buysInWindow = this.buyTimestamps.filter((ts) => ts >= windowStart).length;
		return (buysInWindow / windowSec) * 60; // buys por minuto
	}

	/**
	 * 2. Median Buy Size - Detecta "smart money" vs retail pequeño
	 */
	getMedianBuySize() {
		return calculateMedian(this.buyAmounts);
	}

	/**
	 * Promedio y distribución de tamaños de compra
	 */
	getBuySizeStats() {
		if (this.buyAmounts.length === 0) {
			return {
				median: 0,
				average: 0,
				min: 0,
				max: 0,
				stdDev: 0,
			};
		}

		return {
			median: calculateMedian(this.buyAmounts),
			average: calculateAverage(this.buyAmounts),
			min: Math.min(...this.buyAmounts),
			max: Math.max(...this.buyAmounts),
			stdDev: calculateStdDev(this.buyAmounts),
		};
	}

	/**
	 * 3. Active Holders Ratio - % de compradores que NO han vendido
	 */
	getActiveHoldersRatio() {
		if (this.holders.size === 0) return 0;

		const stillHoldingCount = Array.from(this.holders.values()).filter((h) => h.stillHolding).length;

		return stillHoldingCount / this.holders.size;
	}

	/**
	 * Estadísticas de holders
	 */
	getHolderStats() {
		const holdersArray = Array.from(this.holders.values());
		const stillHolding = holdersArray.filter((h) => h.stillHolding);
		const sold = holdersArray.filter((h) => !h.stillHolding);

		return {
			total: this.holders.size,
			stillHolding: stillHolding.length,
			sold: sold.length,
			retentionRate: this.holders.size > 0 ? stillHolding.length / this.holders.size : 0,
		};
	}

	/**
	 * 4. Price Acceleration - Cambio de velocidad del precio
	 * Compara cambio en último minuto vs minuto anterior
	 */
	getPriceAcceleration() {
		if (this.priceHistory.length < 3) return 0;

		const now = Date.now();
		const last60s = now - 60000;
		const previous60s = now - 120000;

		const pricesLast60s = this.priceHistory.filter((p) => p.timestamp >= last60s && p.timestamp < now);
		const pricesPrevious60s = this.priceHistory.filter((p) => p.timestamp >= previous60s && p.timestamp < last60s);

		if (pricesLast60s.length === 0 || pricesPrevious60s.length === 0) return 0;

		const avgLast = calculateAverage(pricesLast60s.map((p) => p.price));
		const avgPrevious = calculateAverage(pricesPrevious60s.map((p) => p.price));

		if (avgPrevious === 0) return 0;

		return (avgLast - avgPrevious) / avgPrevious;
	}

	/**
	 * Cambio de precio en diferentes ventanas temporales
	 */
	getPriceChange(windowSec = 60) {
		if (this.priceHistory.length < 2) return 0;

		const now = Date.now();
		const windowMs = windowSec * 1000;
		const windowStart = now - windowMs;

		const pricesInWindow = this.priceHistory.filter((p) => p.timestamp >= windowStart);

		if (pricesInWindow.length < 2) return 0;

		const firstPrice = pricesInWindow[0].price;
		const lastPrice = pricesInWindow[pricesInWindow.length - 1].price;

		if (firstPrice === 0) return 0;

		return (lastPrice - firstPrice) / firstPrice;
	}

	/**
	 * 5. Trade Density - Detecta actividad orgánica vs bots
	 * Ratio de traders únicos vs trades totales
	 * Cercano a 1 = muy orgánico, <0.5 = posibles bots
	 */
	getTradeDensity() {
		if (this.tradeTimestamps.length === 0) return 0;

		const uniqueTraders = this.buyerWallets.size + this.sellerWallets.size;
		return uniqueTraders / this.tradeTimestamps.length;
	}

	/**
	 * Calcula la varianza de intervalos entre trades
	 * Alta varianza = orgánico, baja varianza = bot-like
	 */
	getTradeIntervalVariance() {
		if (this.tradeTimestamps.length < 3) return 0;

		const intervals = [];
		for (let i = 1; i < this.tradeTimestamps.length; i++) {
			intervals.push(this.tradeTimestamps[i] - this.tradeTimestamps[i - 1]);
		}

		return calculateStdDev(intervals);
	}

	/**
	 * Nuevos holders por minuto (señal de interés creciente)
	 */
	getNewHoldersPerMinute(windowSec = 60) {
		const now = Date.now();
		const windowMs = windowSec * 1000;
		const windowStart = now - windowMs;

		const newHolders = Array.from(this.holders.values()).filter((h) => h.boughtAt >= windowStart).length;

		return (newHolders / windowSec) * 60;
	}

	/**
	 * Ratio de compradores que volvieron a comprar (señal de confianza)
	 */
	getRepeatBuyerRatio() {
		if (this.buyerWallets.size === 0) return 0;

		let repeatBuyers = 0;
		for (const address of this.buyerWallets) {
			const holder = this.holders.get(address);
			if (holder && holder.buyAmount > 0) {
				// Simplificado: si el holder existe, contamos
				repeatBuyers++;
			}
		}

		return repeatBuyers / this.buyerWallets.size;
	}

	/**
	 * 🆕 NUEVAS MÉTRICAS PARA MEMECOINS RÁPIDOS
	 */

	/**
	 * 1. Volume Spike Ratio (VSR) ⚡
	 * Detecta picos súbitos de volumen
	 * VSR = Volumen últimos 30s / Volumen previos 30s
	 */
	getVolumeSpikeRatio() {
		const now = Date.now();
		const last30s = now - 30000;
		const previous30s = now - 60000;

		const volumeLast30s = this.volumeHistory
			.filter((v) => v.timestamp >= last30s && v.timestamp < now)
			.reduce((sum, v) => sum + v.volume, 0);

		const volumePrevious30s = this.volumeHistory
			.filter((v) => v.timestamp >= previous30s && v.timestamp < last30s)
			.reduce((sum, v) => sum + v.volume, 0);

		if (volumePrevious30s === 0) return volumeLast30s > 0 ? 10 : 0; // No hay volumen previo pero hay actual = spike fuerte
		return volumeLast30s / volumePrevious30s;
	}

	/**
	 * 2. First Minute Momentum (FMM) 🚀
	 * Detecta tokens que explotan en el primer minuto
	 * FMM = Buys en primer minuto / Total Unique Buyers
	 */
	getFirstMinuteMomentum() {
		if (!this.tokenCreatedAt || this.buyerWallets.size === 0) return 0;

		const firstMinuteEnd = this.tokenCreatedAt + 60000;
		const buysInFirstMinute = this.buyTimestamps.filter((ts) => ts <= firstMinuteEnd).length;

		return buysInFirstMinute / this.buyerWallets.size;
	}

	/**
	 * 3. Whale Presence Score (WPS) 🐋
	 * Número de compras grandes (> 0.5 SOL) en los primeros 2 minutos
	 */
	getWhalePresenceScore() {
		if (!this.tokenCreatedAt) return 0;

		const twoMinutesEnd = this.tokenCreatedAt + 120000;
		const largeEarlyBuys = this.largeBuys.filter(
			(buy) => buy.timestamp <= twoMinutesEnd && buy.solAmount >= 0.5
		).length;

		return largeEarlyBuys;
	}

	/**
	 * 4. Sell Pressure Resistance (SPR) 🛡️
	 * Retention rate cuando el precio ha bajado > 5%
	 */
	getSellPressureResistance() {
		if (this.priceHistory.length < 2) return this.getActiveHoldersRatio();

		// Encontrar el máximo precio en los últimos 2 minutos
		const now = Date.now();
		const twoMinutesAgo = now - 120000;
		const recentPrices = this.priceHistory.filter((p) => p.timestamp >= twoMinutesAgo);

		if (recentPrices.length < 2) return this.getActiveHoldersRatio();

		const maxPrice = Math.max(...recentPrices.map((p) => p.price));
		const currentPrice = recentPrices[recentPrices.length - 1].price;

		// Si el precio ha caído más del 5%
		if (currentPrice < maxPrice * 0.95) {
			return this.getActiveHoldersRatio();
		}

		// Si no ha habido caída, retornar la retention normal
		return this.getActiveHoldersRatio();
	}

	/**
	 * 5. Early Bird Ratio (EBR) 🐦
	 * % de compradores que entraron en los primeros 90 segundos
	 */
	getEarlyBirdRatio() {
		if (!this.tokenCreatedAt || this.buyerWallets.size === 0) return 0;

		const first90sEnd = this.tokenCreatedAt + 90000;
		let earlyBuyers = 0;

		for (const address of this.buyerWallets) {
			const holder = this.holders.get(address);
			if (holder && holder.boughtAt <= first90sEnd) {
				earlyBuyers++;
			}
		}

		return earlyBuyers / this.buyerWallets.size;
	}

	/**
	 * 6. Trade Density Score (TDS) 📊
	 * Trades por segundo desde creación
	 */
	getTradeDensityScore() {
		if (!this.tokenCreatedAt || this.tradeTimestamps.length === 0) return 0;

		const now = Date.now();
		const ageSeconds = (now - this.tokenCreatedAt) / 1000;

		if (ageSeconds === 0) return 0;

		return this.tradeTimestamps.length / ageSeconds;
	}

	/**
	 * 7. Market Cap Growth Rate (MCGR) 📈
	 * Crecimiento del Market Cap en los últimos 60 segundos
	 */
	getMarketCapGrowthRate() {
		if (this.priceHistory.length < 2) return 0;

		const now = Date.now();
		const sixtySecondsAgo = now - 60000;

		const recentPrices = this.priceHistory.filter((p) => p.timestamp >= sixtySecondsAgo);

		if (recentPrices.length < 2) return 0;

		const oldestPrice = recentPrices[0].price;
		const latestPrice = recentPrices[recentPrices.length - 1].price;

		if (oldestPrice === 0) return 0;

		return (latestPrice - oldestPrice) / oldestPrice;
	}

	/**
	 * 8. Creator Activity Score (CAS) 👤
	 * Nota: Esta métrica requiere datos del creador que se pasan externamente
	 * Se calculará en token-monitor.js
	 */
	getCreatorActivityScore(creatorSellPercentage) {
		if (creatorSellPercentage === undefined || creatorSellPercentage === null) return 50; // Default neutral

		if (creatorSellPercentage === 0) return 100; // Creador NO ha vendido
		if (creatorSellPercentage < 20) return 75; // Vendió menos del 20%
		if (creatorSellPercentage < 50) return 50; // Vendió menos del 50%
		if (creatorSellPercentage < 80) return 25; // Vendió menos del 80%
		return 0; // Vendió 80%+
	}

	/**
	 * Calcula todas las métricas críticas de una vez
	 */
	getAllMetrics(creatorSellPercentage = null) {
		const buySizeStats = this.getBuySizeStats();
		const holderStats = this.getHolderStats();

		return {
			// Momentum metrics
			buyAcceleration: this.getBuyAcceleration(),
			buyVelocityLast2Min: this.getBuyVelocity(120),
			priceAcceleration: this.getPriceAcceleration(),
			priceChangeLast1Min: this.getPriceChange(60),
			priceChangeLast2Min: this.getPriceChange(120),

			// Size metrics
			medianBuySize: buySizeStats.median,
			avgBuySize: buySizeStats.average,
			maxBuySize: buySizeStats.max,
			minBuySize: buySizeStats.min,
			buyAmountStdDev: buySizeStats.stdDev,

			// Holder metrics
			activeHoldersRatio: this.getActiveHoldersRatio(),
			totalHolders: holderStats.total,
			holdersStillHolding: holderStats.stillHolding,
			holdersSold: holderStats.sold,
			holderRetentionRate: holderStats.retentionRate,
			newHoldersPerMinute: this.getNewHoldersPerMinute(),
			repeatBuyerRatio: this.getRepeatBuyerRatio(),

			// Activity metrics
			tradeDensity: this.getTradeDensity(),
			tradeIntervalVariance: this.getTradeIntervalVariance(),
			uniqueBuyers: this.buyerWallets.size,
			uniqueSellers: this.sellerWallets.size,
			totalTrades: this.tradeTimestamps.length,
			totalBuys: this.buyTimestamps.length,

			// 🆕 NEW Fast Memecoin Metrics
			volumeSpikeRatio: this.getVolumeSpikeRatio(),
			firstMinuteMomentum: this.getFirstMinuteMomentum(),
			whalePresenceScore: this.getWhalePresenceScore(),
			sellPressureResistance: this.getSellPressureResistance(),
			earlyBirdRatio: this.getEarlyBirdRatio(),
			tradeDensityScore: this.getTradeDensityScore(),
			marketCapGrowthRate: this.getMarketCapGrowthRate(),
			creatorActivityScore: this.getCreatorActivityScore(creatorSellPercentage),

			// Data points
			pricePoints: this.priceHistory.length,
			buyAmountSamples: this.buyAmounts.length,
			tokenAge: this.tokenCreatedAt ? (Date.now() - this.tokenCreatedAt) / 1000 : 0, // age in seconds
		};
	}

	/**
	 * Calcula un "Sweet Spot Score" combinado (0-100)
	 * Optimizado para trades rápidos de memecoins (10-15% ganancia)
	 */
	getSweetSpotScore(creatorSellPercentage = null) {
		let score = 0;

		// 1. Retention (15 puntos): Holders reteniendo
		const retentionRate = this.getActiveHoldersRatio();
		if (retentionRate >= 0.75) score += 15;
		else if (retentionRate >= 0.65) score += 12;
		else if (retentionRate >= 0.55) score += 9;
		else if (retentionRate >= 0.45) score += 5;

		// 2. Buy Acceleration (15 puntos): Compras acelerando
		const buyAccel = this.getBuyAcceleration();
		if (buyAccel >= 5) score += 15;
		else if (buyAccel >= 3) score += 12;
		else if (buyAccel >= 1) score += 9;
		else if (buyAccel >= 0) score += 5;

		// 3. Buy Size (10 puntos): Tamaño mediano de compras
		const medianBuy = this.getMedianBuySize();
		if (medianBuy >= 0.1) score += 10;
		else if (medianBuy >= 0.05) score += 8;
		else if (medianBuy >= 0.03) score += 5;
		else if (medianBuy >= 0.01) score += 2;

		// 4. Organic Activity (10 puntos): Actividad orgánica
		const density = this.getTradeDensity();
		if (density >= 0.75) score += 10;
		else if (density >= 0.65) score += 8;
		else if (density >= 0.55) score += 5;
		else if (density >= 0.45) score += 2;

		// 🆕 5. Volume Spike Ratio (10 puntos): Pico de volumen
		const vsr = this.getVolumeSpikeRatio();
		if (vsr >= 3) score += 10;
		else if (vsr >= 2) score += 8;
		else if (vsr >= 1.5) score += 5;
		else if (vsr >= 1) score += 2;

		// 🆕 6. Whale Presence (10 puntos): Ballenas comprando
		const wps = this.getWhalePresenceScore();
		if (wps >= 3) score += 10;
		else if (wps >= 2) score += 8;
		else if (wps >= 1) score += 5;

		// 🆕 7. Early Bird Ratio (10 puntos): Compradores tempranos
		const ebr = this.getEarlyBirdRatio();
		if (ebr >= 0.6) score += 10;
		else if (ebr >= 0.5) score += 8;
		else if (ebr >= 0.4) score += 5;
		else if (ebr >= 0.3) score += 2;

		// 🆕 8. Market Cap Growth (10 puntos): Crecimiento de MC
		const mcgr = this.getMarketCapGrowthRate();
		if (mcgr >= 0.2) score += 10; // +20%
		else if (mcgr >= 0.15) score += 8; // +15%
		else if (mcgr >= 0.1) score += 5; // +10%
		else if (mcgr >= 0.05) score += 2; // +5%

		// 🆕 9. Creator Activity Score (10 puntos): Actividad del creador
		const cas = this.getCreatorActivityScore(creatorSellPercentage);
		score += Math.round(cas / 10); // CAS es 0-100, lo normalizamos a 0-10

		return Math.min(score, 100);
	}

	/**
	 * Determina si es un buen momento para entrar
	 */
	isOptimalEntry() {
		const score = this.getSweetSpotScore();
		const buyAccel = this.getBuyAcceleration();
		const retentionRate = this.getActiveHoldersRatio();
		const priceChange = this.getPriceChange(120);

		// Condiciones para entrada óptima:
		// 1. Score >= 60
		// 2. Buy acceleration positiva
		// 3. Retention rate >= 60%
		// 4. Precio no cayendo fuertemente

		return score >= 60 && buyAccel >= 0 && retentionRate >= 0.6 && priceChange >= -0.1;
	}

	/**
	 * Resetea todas las métricas
	 */
	reset() {
		this.holders.clear();
		this.tradeTimestamps = [];
		this.buyTimestamps = [];
		this.buyAmounts = [];
		this.priceHistory = [];
		this.buyerWallets.clear();
		this.sellerWallets.clear();
		this.tokenCreatedAt = null;
		this.volumeHistory = [];
		this.largeBuys = [];
	}
}

export default MetricsCalculator;
export { calculateMedian, calculateAverage, calculateStdDev };
