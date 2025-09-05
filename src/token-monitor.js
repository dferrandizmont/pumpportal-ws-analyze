const PumpPortalWSClient = require('./pumpportal-ws-client');
const logger = require('./logger');
const config = require('./config');

class TokenMonitor {
  constructor() {
    this.wsClient = new PumpPortalWSClient();
    this.monitoredTokens = new Map(); // tokenAddress -> tokenInfo
    this.creatorPositions = new Map(); // creatorAddress -> Set of tokenAddresses
    this.tokenSellTracking = new Map(); // tokenAddress -> sellInfo (por token individual)

    this.setupMessageHandlers();
  }

  start() {
    logger.tokenMonitor('Starting Token Monitor...');
    this.wsClient.connect();

    // Subscribe to new token events
    this.wsClient.subscribeNewTokens();

    // No mostrar estado automáticamente - solo disponible via HTTP

    // Limpiar trades procesados cada hora para evitar memory leaks
    setInterval(() => {
      if (this.processedTrades && this.processedTrades.size > 10000) {
        logger.debugTokenMonitor(`Cleaning up processed trades cache (${this.processedTrades.size} entries)`);
        this.processedTrades.clear();
      }
    }, 60 * 60 * 1000); // Cada hora
  }

  stop() {
    logger.tokenMonitor('Stopping Token Monitor...');
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
    const tokensOverThreshold = tokens.filter(token => {
      const tracking = this.tokenSellTracking.get(token.address);
      if (!tracking) return false;
      const percentage = tracking.initialTokensOwned > 0 ?
        (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
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
        const percentage = tracking.initialTokensOwned > 0 ?
          (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
        return sum + percentage;
      }, 0);
      averageSellPercentage = totalPercentage / tokens.length;
    }

    const stats = {
      totalTokens: tokens.length,
      totalCreators: creators.length,
      tokensOverThreshold: tokensOverThreshold,
      totalTokensOwned: totalTokensOwned,
      totalTokensSold: totalTokensSold,
      averageSellPercentage: averageSellPercentage
    };

    return stats;
  }

  // Limpiar tokens inactivos (sin ventas en las últimas 24 horas)
  cleanupInactiveTokens() {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let cleanedCount = 0;

    for (const [tokenAddress, tracking] of this.tokenSellTracking) {
      if (!tracking.lastSellTime || new Date(tracking.lastSellTime) < oneDayAgo) {
        // Solo limpiar si no hay ventas recientes
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
    this.wsClient.onMessage('newToken', (message) => {
      this.handleNewToken(message);
    });

    // Handle trade events
    this.wsClient.onMessage('trade', (message) => {
      this.handleTrade(message);
    });
  }

  handleNewToken(tokenData) {
    try {
      logger.debugTokenMonitor('Processing new token data', {
        hasMint: !!tokenData.mint,
        hasTrader: !!tokenData.traderPublicKey,
        hasName: !!tokenData.name,
        hasSymbol: !!tokenData.symbol,
        txType: tokenData.txType
      });

      const tokenAddress = tokenData.mint;
      const creatorAddress = tokenData.traderPublicKey; // PumpPortal uses traderPublicKey for creator
      const tokenName = tokenData.name;
      const tokenSymbol = tokenData.symbol;

      if (!tokenAddress || !creatorAddress) {
        logger.debugTokenMonitor('Invalid token data - missing required fields', {
          tokenAddress,
          creatorAddress,
          tokenName,
          tokenSymbol,
          allKeys: Object.keys(tokenData)
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
        currentSupply: tokenData.currentSupply || 0
      });

      logger.debugTokenMonitor(`Token stored: ${tokenName} (${tokenSymbol})`, {
        tokenAddress,
        creatorAddress,
        name: tokenName,
        symbol: tokenSymbol
      });

      // Track creator's tokens
      if (!this.creatorPositions.has(creatorAddress)) {
        this.creatorPositions.set(creatorAddress, new Set());
      }
      this.creatorPositions.get(creatorAddress).add(tokenAddress);

      // Initialize token sell tracking (por token individual)
      const initialTokensOwned = tokenData.initialBuy || tokenData.tokenAmount || 0;
      this.tokenSellTracking.set(tokenAddress, {
        creatorAddress: creatorAddress,
        totalTokensOwned: initialTokensOwned,  // Tokens que el creador compró para este token
        initialTokensOwned: initialTokensOwned,  // Guardamos el balance inicial para cálculos de %
        tokensSold: 0,
        lastSellTime: null,
        sellHistory: []
      });

      logger.debugTokenMonitor(`New token detected: ${tokenName} (${tokenSymbol})`, {
        tokenAddress,
        creatorAddress,
        creatorInitialBuy: tokenData.initialBuy,
        totalSupply: tokenData.initialSupply
      });

      // Subscribe to trades for this token
      this.wsClient.subscribeTokenTrades([tokenAddress]);
      logger.debugTokenMonitor(`Subscribed to trades for new token: ${tokenName} (${tokenSymbol})`, {
        tokenAddress,
        creatorAddress
      });

      // Note: Account trades subscription removed - we'll detect creator sells from token trades instead
      // This is more reliable as it doesn't depend on PumpPortal's account trade format
      if (config.app.monitorCreatorSells) {
        logger.tokenMonitor(`Creator monitoring enabled for: ${creatorAddress}`, {
          tokenAddress,
          tokenName,
          tokenSymbol,
          creatorAddress
        });
      }

    } catch (error) {
      logger.errorMonitor('Error handling new token', { error: error.message, tokenData });
    }
  }

  handleTrade(tradeData) {
    try {
      const {
        mint: tokenAddress,
        traderPublicKey: traderAddress,
        txType,
        tokenAmount,
        solAmount,
        marketCapSol,
        price
      } = tradeData;

      if (!tokenAddress || !traderAddress || !txType) {
        logger.tokenMonitor('Invalid trade data received', { tradeData });
        return;
      }

      // Check if this is a sell trade by a creator FIRST
      if (txType === 'sell' && this.isCreatorOfToken(traderAddress, tokenAddress)) {
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
      if (txType === 'buy' && this.isCreatorOfToken(traderAddress, tokenAddress)) {
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

      // Log trade information (debug level to reduce noise)
      logger.debugTokenMonitor(`Trade detected: ${txType.toUpperCase()}`, {
        tokenAddress,
        traderAddress,
        tokenAmount,
        solAmount,
        marketCapSol,
        price
      });

    } catch (error) {
      logger.errorMonitor('Error handling trade', { error: error.message, tradeData });
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
      logger.tokenMonitor(`🎯 CREATOR TRADE DETECTED: ${traderAddress} for token ${tokenAddress}`);
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
      price
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

    const { tokenAmount, solAmount, price } = tradeData;

    // Calcular porcentaje basado en el balance ANTES de la venta
    const balanceBeforeSell = tokenTracking.totalTokensOwned;
    const sellPercentage = balanceBeforeSell > 0 ?
      (tokenAmount / balanceBeforeSell) * 100 : 0;

    // Validar que no vendamos más tokens de los que tenemos
    if (tokenAmount > balanceBeforeSell) {
      logger.warnMonitor(`Creator trying to sell more tokens than owned!`, {
        creatorAddress,
        tokenAddress,
        tokenAmount,
        balanceBeforeSell,
        tokenName: tokenInfo.name
      });
      return; // No procesar esta venta inválida
    }

    // Update tracking - restar tokens del balance del creador
    tokenTracking.totalTokensOwned -= tokenAmount;  // ✅ RESTAR del balance del creador
    tokenTracking.tokensSold += tokenAmount;        // ✅ ACUMULAR total vendido
    tokenTracking.lastSellTime = new Date();
    tokenTracking.sellHistory.push({
      tokenAddress,
      tokenAmount,
      solAmount,
      price,
      timestamp: new Date(),
      percentage: sellPercentage
    });

    logger.debugTokenMonitor(`Updated tracking for ${tokenAddress}:`, {
      creatorAddress,
      balanceBeforeSell: balanceBeforeSell,
      tokensSoldInThisTrade: tokenAmount,
      balanceAfterSell: tokenTracking.totalTokensOwned,
      totalTokensSold: tokenTracking.tokensSold,
      sellPercentage: sellPercentage.toFixed(2)
    });

    // Check if creator has sold a significant portion of THIS token
    const totalSoldPercentage = tokenTracking.initialTokensOwned > 0 ?
      (tokenTracking.tokensSold / tokenTracking.initialTokensOwned) * 100 : 0;

    logger.creatorSell(`Creator sell detected`, {
      creatorAddress,
      tokenAddress: tokenAddress,
      tokenName: tokenInfo.name,
      tokenSymbol: tokenInfo.symbol,
      sellAmount: tokenAmount,
      sellPercentage: sellPercentage.toFixed(2),
      totalSoldPercentage: totalSoldPercentage.toFixed(2),
      solReceived: solAmount,
      price: price
    });

    // Log current state after update
    logger.tokenMonitor(`STATE UPDATED for ${tokenInfo.name}:`, {
      currentTokensOwned: tokenTracking.totalTokensOwned,
      totalTokensSold: tokenTracking.tokensSold,
      totalSellPercentage: totalSoldPercentage.toFixed(2),
      totalSells: tokenTracking.sellHistory.length
    });

    // Alert if creator has sold more than threshold of THIS token
    if (totalSoldPercentage >= config.thresholds.creatorSellThreshold) {
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
        totalSellsInHistory: tokenTracking.sellHistory.length
      });

      console.log(`🚨 ALERT: Creator ${creatorAddress} has sold ${totalSoldPercentage.toFixed(2)}% of tokens in ${tokenInfo.name} (${tokenInfo.symbol})!`);
    }
  }

  getMonitoredTokens() {
    return Array.from(this.monitoredTokens.entries()).map(([address, info]) => ({
      address,
      ...info
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
          tokens: []
        });
      }

      const creatorData = creatorMap.get(creator);
      creatorData.totalTokensOwned += tracking.initialTokensOwned;  // Usar balance inicial
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
      logger.tokenMonitor('No tokens being tracked currently');
      return;
    }

    console.log('\n📊 === TOKENS TRACKED STATUS === 📊');
    console.log(`Total tokens monitored: ${monitoredTokens.length}\n`);

    monitoredTokens.forEach((token) => {
      const tokenTracking = this.tokenSellTracking.get(token.address);
      const tokenInfo = this.monitoredTokens.get(token.address);

      if (!tokenTracking || !tokenInfo) {
        return;
      }

      const totalSoldPercentage = tokenTracking.initialTokensOwned > 0 ?
        (tokenTracking.tokensSold / tokenTracking.initialTokensOwned) * 100 : 0;
      const statusEmoji = totalSoldPercentage >= config.thresholds.creatorSellThreshold ? '🚨' : '✅';
      const lastSellTime = tokenTracking.lastSellTime ?
        new Date(tokenTracking.lastSellTime).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }) : 'Never';

      console.log(`${statusEmoji} ${tokenInfo.name} (${tokenInfo.symbol})`);
      console.log(`   📍 Address: ${token.address}`);
      console.log(`   👤 Creator: ${tokenInfo.creator}`);
      console.log(`   💰 Creator owns: ${tokenTracking.totalTokensOwned.toLocaleString()} tokens`);
      console.log(`   📈 Creator sold: ${tokenTracking.tokensSold.toLocaleString()} tokens`);
      console.log(`   📊 Sold percentage: ${totalSoldPercentage.toFixed(2)}%`);
      console.log(`   🕒 Last sell: ${lastSellTime}`);
      console.log(`   📝 Total sells: ${tokenTracking.sellHistory.length}`);
      console.log(`   📅 Created: ${new Date(tokenInfo.createdAt).toLocaleString('es-ES')}`);
      console.log('');
    });

    console.log('=====================================\n');

    // Log resumido para archivos
    logger.tokenMonitor(`Tracking status update: ${monitoredTokens.length} tokens monitored`, {
      totalTokens: monitoredTokens.length,
      tokensOverThreshold: monitoredTokens.filter(token => {
        const tracking = this.tokenSellTracking.get(token.address);
        if (!tracking) return false;
        const percentage = tracking.initialTokensOwned > 0 ?
          (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
        return percentage >= config.thresholds.creatorSellThreshold;
      }).length
    });
  }

  // Mostrar resumen compacto (útil para logs)
  showCompactStatus() {
    const monitoredTokens = this.getMonitoredTokens();

    if (monitoredTokens.length === 0) {
      return;
    }

    const statusSummary = monitoredTokens.map(token => {
      const tracking = this.tokenSellTracking.get(token.address);
      const info = this.monitoredTokens.get(token.address);

      if (!tracking || !info) return null;

      const percentage = tracking.initialTokensOwned > 0 ?
        (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
      const status = percentage >= config.thresholds.creatorSellThreshold ? '🚨' : '✅';

      return `${status} ${info.name}(${info.symbol}): ${percentage.toFixed(1)}%`;
    }).filter(Boolean).join(' | ');

    console.log(`📊 Status: ${statusSummary}`);
  }

}

module.exports = TokenMonitor;
