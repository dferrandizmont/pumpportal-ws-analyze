const TokenMonitor = require('./token-monitor');
const logger = require('./logger');
const config = require('./config');
const http = require('http');

class PumpPortalAnalyzer {
  constructor() {
    this.tokenMonitor = new TokenMonitor();
    this.isRunning = false;
    this.statsInterval = null;
    this.httpServer = null;
  }

  async start() {
    if (this.isRunning) {
      logger.tokenMonitor('Application is already running');
      return;
    }

    logger.tokenMonitor('🚀 Starting PumpPortal Token Analyzer...');
    logger.tokenMonitor('Configuration loaded:', {
      wsUrl: config.pumpPortal.wsUrl,
      logLevel: config.logging.level,
      timezone: config.logging.timezone,
      monitorCreatorSells: config.app.monitorCreatorSells,
      creatorSellThreshold: config.thresholds.creatorSellThreshold
    });

    this.isRunning = true;

    // Start the token monitor
    this.tokenMonitor.start();

    // No mostrar estadísticas automáticamente - solo disponible via HTTP


    // Set up HTTP server for remote status queries
    this.setupHTTPServer();

    // Set up graceful shutdown
    this.setupGracefulShutdown();

    logger.tokenMonitor('✅ PumpPortal Token Analyzer started successfully');
    logger.tokenMonitor('📊 Monitoring for new tokens and creator sells...');
    logger.tokenMonitor(`🎯 Creator sell threshold: ${config.thresholds.creatorSellThreshold}%`);
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.tokenMonitor('🛑 Stopping PumpPortal Token Analyzer...');

    this.isRunning = false;

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close(() => {
        logger.tokenMonitor('🌐 HTTP Server stopped');
      });
      this.httpServer = null;
    }

    // Stop the token monitor
    this.tokenMonitor.stop();

    logger.tokenMonitor('✅ PumpPortal Token Analyzer stopped');
  }

  logStats() {
    const stats = this.tokenMonitor.getStats();

    logger.tokenMonitor('📊 Current Statistics:', {
      monitoredTokens: stats.totalTokens,
      totalCreators: stats.totalCreators,
      tokensOverThreshold: stats.tokensOverThreshold,
      totalTokensOwned: stats.totalTokensOwned ? stats.totalTokensOwned.toLocaleString() : '0',
      totalTokensSold: stats.totalTokensSold ? stats.totalTokensSold.toLocaleString() : '0',
      averageSellPercentage: `${stats.averageSellPercentage ? stats.averageSellPercentage.toFixed(2) : '0.00'}%`
    });
  }


  setupHTTPServer() {
    this.httpServer = http.createServer((req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Only allow GET requests
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      try {
        const url = new URL(req.url, `http://${req.headers.host}`);

        switch (url.pathname) {
          case '/status':
            // Detailed status
            const tokens = this.tokenMonitor.getMonitoredTokens();
            const stats = this.tokenMonitor.getStats();

            const statusResponse = {
              timestamp: new Date().toISOString(),
              uptime: process.uptime(),
              tokens: tokens.map(token => {
                const tracking = this.tokenMonitor.tokenSellTracking.get(token.address);
                const info = this.tokenMonitor.monitoredTokens.get(token.address);

                if (!tracking || !info) return null;

                const percentage = tracking.initialTokensOwned > 0 ?
                  (tracking.tokensSold / tracking.initialTokensOwned) * 100 : 0;
                return {
                  address: token.address,
                  name: info.name,
                  symbol: info.symbol,
                  creator: info.creator,
                  initialTokensOwned: tracking.initialTokensOwned,
                  totalTokensOwned: tracking.totalTokensOwned,
                  tokensSold: tracking.tokensSold,
                  sellPercentage: percentage,
                  lastSellTime: tracking.lastSellTime,
                  totalSells: tracking.sellHistory.length,
                  createdAt: info.createdAt
                };
              }).filter(Boolean),
              summary: stats
            };

            res.writeHead(200);
            res.end(JSON.stringify(statusResponse, null, 2));
            break;

          case '/stats':
            // Quick statistics
            const quickStats = this.tokenMonitor.getStats();
            res.writeHead(200);
            res.end(JSON.stringify({
              timestamp: new Date().toISOString(),
              uptime: process.uptime(),
              totalTokens: quickStats.totalTokens,
              totalCreators: quickStats.totalCreators,
              tokensOverThreshold: quickStats.tokensOverThreshold,
              totalTokensOwned: quickStats.totalTokensOwned,
              totalTokensSold: quickStats.totalTokensSold,
              averageSellPercentage: quickStats.averageSellPercentage
            }, null, 2));
            break;

          case '/health':
            // Health check
            res.writeHead(200);
            res.end(JSON.stringify({
              status: 'healthy',
              timestamp: new Date().toISOString(),
              uptime: process.uptime(),
              isRunning: this.isRunning
            }));
            break;

          default:
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Endpoint not found' }));
            break;
        }
      } catch (error) {
        logger.errorMonitor('HTTP Server Error', { error: error.message });
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    // Start the server
    this.httpServer.listen(config.http.port, () => {
      logger.tokenMonitor(`🌐 HTTP Server started on port ${config.http.port}`);
      logger.tokenMonitor(`📡 Available endpoints:`);
      logger.tokenMonitor(`   GET http://localhost:${config.http.port}/status - Detailed token status`);
      logger.tokenMonitor(`   GET http://localhost:${config.http.port}/stats - Quick statistics`);
      logger.tokenMonitor(`   GET http://localhost:${config.http.port}/health - Health check`);
    });

    // Handle server errors
    this.httpServer.on('error', (error) => {
      logger.errorMonitor('HTTP Server Error', { error: error.message });
    });
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      logger.tokenMonitor(`Received ${signal}, initiating graceful shutdown...`);
      await this.stop();
      process.exit(0);
    };

    // Handle common termination signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.errorMonitor('Uncaught Exception', { error: error.message, stack: error.stack });
      this.stop().finally(() => process.exit(1));
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.errorMonitor('Unhandled Rejection', { reason, promise });
      this.stop().finally(() => process.exit(1));
    });
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      stats: this.tokenMonitor.getStats(),
      uptime: process.uptime()
    };
  }
}

// Main execution
if (require.main === module) {
  const analyzer = new PumpPortalAnalyzer();

  // Start the application
  analyzer.start().catch((error) => {
    logger.errorMonitor('Failed to start application', { error: error.message });
    process.exit(1);
  });

  // Export for testing or external usage
  module.exports = PumpPortalAnalyzer;
} else {
  // Export for importing
  module.exports = PumpPortalAnalyzer;
}
