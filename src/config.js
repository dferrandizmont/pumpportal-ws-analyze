require('dotenv').config();

const config = {
  // PumpPortal WebSocket Configuration
  pumpPortal: {
    wsUrl: process.env.PUMP_PORTAL_WS_URL || 'wss://pumpportal.fun/api/data',
    apiKey: process.env.PUMP_PORTAL_API_KEY,
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    timezone: process.env.LOG_TIMEZONE || 'Europe/Madrid',
  },

  // Application Configuration
  app: {
    maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10,
    reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS) || 5000,
    monitorCreatorSells: process.env.MONITOR_CREATOR_SELLS === 'true',
  },

           // Creator Sell Detection
         thresholds: {
           creatorSellThreshold: parseFloat(process.env.CREATOR_SELL_THRESHOLD) || 80.0,
         },

         // HTTP Server Configuration
         http: {
           port: parseInt(process.env.HTTP_PORT) || 3000,
         },
};

module.exports = config;
