#!/usr/bin/env node

const http = require('http');

/**
 * Client script to query PumpPortal Token Analyzer status from another terminal
 * Usage: node status-client.js [command] [options]
 *
 * Commands:
 *   status  - Get detailed token tracking status
 *   stats   - Get quick statistics
 *   health  - Health check
 *   watch   - Continuously monitor stats
 */

const PORT = process.env.HTTP_PORT || 3000;
const HOST = 'localhost';

function makeRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: `/${endpoint}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const jsonData = JSON.parse(data);
            resolve(jsonData);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

function formatStatus(data) {
  console.log('\n📊 === TOKEN TRACKING STATUS === 📊');
  console.log(`⏰ Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
  console.log(`⏱️  Uptime: ${Math.floor(data.uptime / 60)}m ${Math.floor(data.uptime % 60)}s`);
  console.log(`📈 Total tokens monitored: ${data.tokens.length}\n`);

  data.tokens.forEach((token, index) => {
    const statusEmoji = token.sellPercentage >= 80 ? '🚨' : '✅';
    console.log(`${index + 1}. ${statusEmoji} ${token.name} (${token.symbol})`);
    console.log(`   📍 Address: ${token.address}`);
    console.log(`   👤 Creator: ${token.creator}`);
    console.log(`   💰 Creator owns: ${token.totalTokensOwned.toLocaleString()} tokens`);
    console.log(`   📈 Creator sold: ${token.tokensSold.toLocaleString()} tokens`);
    console.log(`   📊 Sold percentage: ${token.sellPercentage.toFixed(2)}%`);
    console.log(`   🕒 Last sell: ${token.lastSellTime ? new Date(token.lastSellTime).toLocaleTimeString() : 'Never'}`);
    console.log(`   📝 Total sells: ${token.totalSells}`);
    console.log(`   📅 Created: ${new Date(token.createdAt).toLocaleString()}`);
    console.log('');
  });

  console.log('=====================================\n');
}

function formatStats(data) {
  console.log('\n📈 === CURRENT STATISTICS === 📈');
  console.log(`⏰ Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
  console.log(`⏱️  Uptime: ${Math.floor(data.uptime / 60)}m ${Math.floor(data.uptime % 60)}s`);
  console.log(`📊 Tokens monitored: ${data.totalTokens}`);
  console.log(`👥 Total creators: ${data.totalCreators}`);
  console.log(`🚨 Tokens over threshold: ${data.tokensOverThreshold}`);
  console.log(`💰 Total tokens owned: ${data.totalTokensOwned ? data.totalTokensOwned.toLocaleString() : '0'}`);
  console.log(`📈 Total tokens sold: ${data.totalTokensSold ? data.totalTokensSold.toLocaleString() : '0'}`);
  console.log(`📊 Average sell %: ${data.averageSellPercentage ? data.averageSellPercentage.toFixed(2) : '0.00'}%`);
  console.log('=====================================\n');
}

function formatHealth(data) {
  console.log('\n💚 === HEALTH CHECK === 💚');
  console.log(`📊 Status: ${data.status}`);
  console.log(`⏰ Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
  console.log(`⏱️  Uptime: ${Math.floor(data.uptime / 60)}m ${Math.floor(data.uptime % 60)}s`);
  console.log(`▶️  Is running: ${data.isRunning ? '✅ Yes' : '❌ No'}`);
  console.log('========================\n');
}

async function watchMode(interval = 5000) {
  console.log(`👀 Entering watch mode (updates every ${interval/1000}s). Press Ctrl+C to exit.\n`);

  const watchInterval = setInterval(async () => {
    try {
      const data = await makeRequest('stats');
      console.clear();
      formatStats(data);
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
    }
  }, interval);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n👋 Exiting watch mode...');
    clearInterval(watchInterval);
    process.exit(0);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  try {
    switch (command) {
      case 'status':
        const statusData = await makeRequest('status');
        formatStatus(statusData);
        break;

      case 'stats':
        const statsData = await makeRequest('stats');
        formatStats(statsData);
        break;

      case 'health':
        const healthData = await makeRequest('health');
        formatHealth(healthData);
        break;

      case 'watch':
        const interval = args[1] ? parseInt(args[1]) * 1000 : 5000;
        await watchMode(interval);
        break;

      case 'help':
      default:
        console.log('\n📊 PumpPortal Token Analyzer - Status Client');
        console.log('==============================================');
        console.log('');
        console.log('Usage: node status-client.js <command> [options]');
        console.log('');
        console.log('Commands:');
        console.log('  status              Show detailed token tracking status');
        console.log('  stats               Show quick statistics');
        console.log('  health              Health check');
        console.log('  watch [seconds]     Continuously monitor stats (default: 5s)');
        console.log('  help                Show this help message');
        console.log('');
        console.log('Examples:');
        console.log('  node status-client.js status');
        console.log('  node status-client.js stats');
        console.log('  node status-client.js watch 10');
        console.log('');
        console.log('Environment Variables:');
        console.log('  HTTP_PORT           Port where the main app is running (default: 3000)');
        console.log('');
        break;
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    console.log('\n💡 Make sure the main PumpPortal application is running on port', PORT);
    console.log('   Start it with: yarn start');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { makeRequest, formatStatus, formatStats, formatHealth };
