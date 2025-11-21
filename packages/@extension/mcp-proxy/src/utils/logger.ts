import winston from 'winston'
import { ProxyConfig } from '../types/index.js'

export interface LogEntry {
  timestamp: Date
  level: string
  message: string
  meta?: Record<string, any>
  requestId?: string
  serverId?: string
  clientId?: string
}

export class Logger {
  private logger: winston.Logger

  constructor(config: ProxyConfig['logging']) {
    const transports: winston.transport[] = []

    // Console transport
    if (config.level !== 'none') {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            config.includeTimestamps ? winston.format.timestamp() : winston.format.undef(),
            config.structured
              ? winston.format.json()
              : winston.format.combine(
                  winston.format.colorize(),
                  winston.format.simple()
                )
          ),
        })
      )
    }

    // File transport for production
    if (process.env.NODE_ENV === 'production') {
      transports.push(
        new winston.transports.File({
          filename: 'logs/mcp-proxy.log',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        }),
        new winston.transports.File({
          filename: 'logs/mcp-proxy-error.log',
          level: 'error',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      )
    }

    this.logger = winston.createLogger({
      level: config.level,
      transports,
      silent: config.level === 'none',
    })
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.logger.debug(message, meta)
  }

  info(message: string, meta?: Record<string, any>): void {
    this.logger.info(message, meta)
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.logger.warn(message, meta)
  }

  error(message: string, error?: Error | Record<string, any>): void {
    if (error instanceof Error) {
      this.logger.error(message, {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      })
    } else {
      this.logger.error(message, error)
    }
  }

  // Structured logging with context
  request(message: string, requestId: string, meta?: Record<string, any>): void {
    this.logger.info(message, { requestId, ...meta })
  }

  server(message: string, serverId: string, meta?: Record<string, any>): void {
    this.logger.info(message, { serverId, ...meta })
  }

  client(message: string, clientId: string, meta?: Record<string, any>): void {
    this.logger.info(message, { clientId, ...meta })
  }

  // Performance logging
  performance(operation: string, duration: number, meta?: Record<string, any>): void {
    this.logger.info(`Performance: ${operation}`, {
      operation,
      duration,
      ...meta,
    })
  }

  // Metrics logging
  metrics(metric: string, value: number, meta?: Record<string, any>): void {
    this.logger.info(`Metric: ${metric}`, {
      metric,
      value,
      timestamp: new Date().toISOString(),
      ...meta,
    })
  }

  // Create child logger with additional context
  child(context: Record<string, any>): Logger {
    const childLogger = new Logger({ level: 'debug', structured: true, includeTimestamps: true })
    childLogger.logger = this.logger.child(context)
    return childLogger
  }
}