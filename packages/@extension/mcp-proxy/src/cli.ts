#!/usr/bin/env node

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import dotenv from 'dotenv'
import { EnhancedMcpProxy } from './EnhancedMcpProxy.js'
import { Logger } from './utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load environment variables
dotenv.config()

const argv = await yargs(hideBin(process.argv))
  .option('config', {
    alias: 'c',
    type: 'string',
    description: 'Path to configuration file',
    demandOption: true,
  })
  .option('port', {
    alias: 'p',
    type: 'number',
    default: 3006,
    description: 'Port to run the proxy server on',
  })
  .option('host', {
    alias: 'h',
    type: 'string',
    default: 'localhost',
    description: 'Host to bind the proxy server to',
  })
  .option('logLevel', {
    alias: 'l',
    type: 'string',
    choices: ['debug', 'info', 'warn', 'error', 'none'],
    default: 'info',
    description: 'Set logging level',
  })
  .option('cors', {
    type: 'boolean',
    default: true,
    description: 'Enable CORS',
  })
  .option('ssePath', {
    type: 'string',
    default: '/sse',
    description: 'Path for SSE endpoint',
  })
  .option('websocketPath', {
    type: 'string',
    default: '/ws',
    description: 'Path for WebSocket endpoint',
  })
  .option('httpPath', {
    type: 'string',
    default: '/mcp',
    description: 'Path for Streamable HTTP endpoint',
  })
  .option('healthPath', {
    type: 'string',
    default: '/health',
    description: 'Path for health check endpoint',
  })
  .option('metricsPath', {
    type: 'string',
    default: '/metrics',
    description: 'Path for metrics endpoint',
  })
  .option('timeout', {
    type: 'number',
    default: 30000,
    description: 'Request timeout in milliseconds',
  })
  .option('maxConnections', {
    type: 'number',
    default: 1000,
    description: 'Maximum concurrent connections',
  })
  .option('enableCaching', {
    type: 'boolean',
    default: false,
    description: 'Enable response caching',
  })
  .option('cacheTtl', {
    type: 'number',
    default: 300000,
    description: 'Cache TTL in milliseconds',
  })
  .option('monitoring', {
    type: 'boolean',
    default: true,
    description: 'Enable monitoring and metrics collection',
  })
  .option('structuredLogs', {
    type: 'boolean',
    default: false,
    description: 'Enable structured JSON logging',
  })
  .option('healthCheckInterval', {
    type: 'number',
    default: 30000,
    description: 'Health check interval in milliseconds',
  })
  .option('gracefulShutdownTimeout', {
    type: 'number',
    default: 10000,
    description: 'Graceful shutdown timeout in milliseconds',
  })
  .help()
  .alias('help', 'h')
  .version()
  .alias('version', 'v')
  .strict()
  .argv

// Validate configuration file
if (!existsSync(argv.config)) {
  console.error(`❌ Configuration file not found: ${argv.config}`)
  process.exit(1)
}

async function main() {
  const logger = new Logger({
    level: argv.logLevel,
    structured: argv.structuredLogs,
    includeTimestamps: true,
  })

  logger.info('🚀 Starting Enhanced MCP SuperAssistant Proxy', {
    version: '0.6.0',
    config: argv.config,
    port: argv.port,
    host: argv.host,
  })

  let proxy: EnhancedMcpProxy

  // Setup graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info(`📴 Received ${signal}, starting graceful shutdown...`)

    if (proxy) {
      try {
        await Promise.race([
          proxy.cleanup(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Graceful shutdown timeout')), argv.gracefulShutdownTimeout)
          ),
        ])
        logger.info('✅ Graceful shutdown completed')
      } catch (error) {
        logger.error('❌ Graceful shutdown failed:', error)
        process.exit(1)
      }
    }

    process.exit(0)
  }

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.once('SIGINT', () => gracefulShutdown('SIGINT'))
  process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2')) // For nodemon

  try {
    // Create and start the enhanced proxy
    proxy = new EnhancedMcpProxy({
      port: argv.port,
      host: argv.host,
      transports: {
        sse: {
          enabled: true,
          path: argv.ssePath,
          cors: argv.cors,
        },
        websocket: {
          enabled: true,
          path: argv.websocketPath,
          compression: true,
        },
        streamableHttp: {
          enabled: true,
          path: argv.httpPath,
          stateful: true,
          sessionTimeout: 300000, // 5 minutes
        },
      },
      logging: {
        level: argv.logLevel,
        structured: argv.structuredLogs,
        includeTimestamps: true,
      },
      monitoring: {
        enabled: argv.monitoring,
        metricsEndpoint: argv.metricsPath,
        healthEndpoint: argv.healthPath,
        collectMetrics: true,
      },
      performance: {
        requestTimeout: argv.timeout,
        maxConnections: argv.maxConnections,
        enableCaching: argv.enableCaching,
        cacheTtl: argv.cacheTtl,
      },
    }, logger)

    await proxy.initialize(argv.config)
    await proxy.start()

    logger.info('🎉 Enhanced MCP SuperAssistant Proxy is running!', {
      url: `http://${argv.host}:${argv.port}`,
      sseEndpoint: `http://${argv.host}:${argv.port}${argv.ssePath}`,
      websocketEndpoint: `ws://${argv.host}:${argv.port}${argv.websocketPath}`,
      httpEndpoint: `http://${argv.host}:${argv.port}${argv.httpPath}`,
      healthEndpoint: `http://${argv.host}:${argv.port}${argv.healthPath}`,
      metricsEndpoint: `http://${argv.host}:${argv.port}${argv.metricsPath}`,
    })

  } catch (error) {
    logger.error('❌ Failed to start Enhanced MCP SuperAssistant Proxy:', error)
    process.exit(1)
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
  process.exit(1)
})

// Start the application
main().catch((error) => {
  console.error('❌ Application failed to start:', error)
  process.exit(1)
})