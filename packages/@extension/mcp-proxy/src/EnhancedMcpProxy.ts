import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer as createHttpServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'
import cors from 'cors'
import { EventEmitter } from 'events'
import { EnhancedMcpServerManager } from './core/EnhancedMcpServerManager.js'
import { SSETransport } from './transports/SSETransport.js'
import { WebSocketTransport } from './transports/WebSocketTransport.js'
import { StreamableHTTPTransport } from './transports/StreamableHTTPTransport.js'
import { ProxyConfig, McpServerConfig } from './types/index.js'
import { Logger } from './utils/logger.js'
import { ConfigValidator } from './utils/config-validator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export class EnhancedMcpProxy extends EventEmitter {
  private app: express.Application
  private server: any
  private wsServer?: WebSocketServer
  private serverManager: EnhancedMcpServerManager
  private sseTransport: SSETransport
  private wsTransport: WebSocketTransport
  private httpTransport: StreamableHTTPTransport
  private logger: Logger
  private config: ProxyConfig
  private isStarted = false

  constructor(config: ProxyConfig, logger?: Logger) {
    super()

    this.config = config
    this.logger = logger || new Logger(config.logging)
    this.app = express()
    this.server = createHttpServer(this.app)

    // Initialize core components
    this.serverManager = new EnhancedMcpServerManager(config, this.logger)
    this.sseTransport = new SSETransport(config, this.logger)
    this.wsTransport = new WebSocketTransport(config, this.logger)
    this.httpTransport = new StreamableHTTPTransport(config, this.logger)

    this.setupMiddleware()
    this.setupRoutes()
    this.setupEventHandlers()
  }

  private setupMiddleware(): void {
    // CORS middleware
    if (this.config.transports.sse.cors) {
      this.app.use(cors({
        origin: true,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      }))
    }

    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }))

    // Request logging middleware
    this.app.use((req, res, next) => {
      const requestId = req.headers['x-request-id'] || this.generateRequestId()
      req.headers['x-request-id'] = requestId

      this.logger.request(`${req.method} ${req.path}`, requestId, {
        method: req.method,
        path: req.path,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        contentLength: req.headers['content-length'],
      })

      // Track response
      const startTime = Date.now()
      res.on('finish', () => {
        const duration = Date.now() - startTime
        this.logger.request(`${req.method} ${req.path} - ${res.statusCode}`, requestId, {
          statusCode: res.statusCode,
          duration,
          contentLength: res.get('content-length'),
        })
      })

      next()
    })

    // Rate limiting middleware (basic implementation)
    const requestCounts = new Map<string, { count: number; resetTime: number }>()
    this.app.use((req, res, next) => {
      const clientId = req.ip || req.headers['x-forwarded-for'] || 'unknown'
      const now = Date.now()
      const windowMs = 60000 // 1 minute
      const maxRequests = 1000

      const client = requestCounts.get(clientId)
      if (!client || now > client.resetTime) {
        requestCounts.set(clientId, { count: 1, resetTime: now + windowMs })
        return next()
      }

      if (client.count >= maxRequests) {
        return res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: Math.ceil((client.resetTime - now) / 1000),
        })
      }

      client.count++
      next()
    })
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get(this.config.monitoring.healthEndpoint, (req, res) => {
      const servers = this.serverManager.getAllServers()
      const healthyServers = servers.filter(s => s.status === 'connected')

      const health = {
        status: healthyServers.length > 0 ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '0.6.0',
        servers: {
          total: servers.length,
          healthy: healthyServers.length,
          unhealthy: servers.length - healthyServers.length,
        },
        memory: process.memoryUsage(),
        metrics: this.serverManager.getServerMetrics(),
      }

      const statusCode = health.status === 'healthy' ? 200 : 503
      res.status(statusCode).json(health)
    })

    // Metrics endpoint
    if (this.config.monitoring.enabled) {
      this.app.get(this.config.monitoring.metricsEndpoint, (req, res) => {
        const format = req.query.format as string || 'json'
        const metrics = this.serverManager.getServerMetrics()

        if (format === 'prometheus') {
          const prometheusFormat = this.convertToPrometheusFormat(metrics)
          res.set('Content-Type', 'text/plain')
          res.send(prometheusFormat)
        } else {
          res.json({
            timestamp: new Date().toISOString(),
            servers: Object.fromEntries(metrics),
            system: {
              memory: process.memoryUsage(),
              uptime: process.uptime(),
              cpu: process.cpuUsage(),
            },
          })
        }
      })
    }

    // SSE endpoint
    this.app.get(this.config.transports.sse.path, (req, res) => {
      this.sseTransport.handleConnection(req, res, this.serverManager)
    })

    // Streamable HTTP endpoint
    this.app.all(this.config.transports.streamableHttp.path, (req, res) => {
      this.httpTransport.handleRequest(req, res, this.serverManager)
    })

    // Static file serving for documentation
    this.app.use('/docs', express.static(join(__dirname, '../docs')))

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Enhanced MCP SuperAssistant Proxy',
        version: '0.6.0',
        description: 'Multi-transport MCP proxy with dynamic server discovery',
        endpoints: {
          health: this.config.monitoring.healthEndpoint,
          metrics: this.config.monitoring.metricsEndpoint,
          sse: this.config.transports.sse.path,
          websocket: this.config.transports.websocket.path,
          http: this.config.transports.streamableHttp.path,
        },
        documentation: '/docs',
        servers: this.serverManager.getAllServers().map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          type: s.config.type,
        })),
      })
    })

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Not Found',
        path: req.originalUrl,
        availableEndpoints: [
          this.config.monitoring.healthEndpoint,
          this.config.monitoring.metricsEndpoint,
          this.config.transports.sse.path,
          this.config.transports.streamableHttp.path,
        ],
      })
    })

    // Error handler
    this.app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      this.logger.error('Unhandled error in express app', err, {
        method: req.method,
        path: req.path,
        requestId: req.headers['x-request-id'],
      })

      res.status(500).json({
        error: 'Internal Server Error',
        requestId: req.headers['x-request-id'],
      })
    })
  }

  private setupEventHandlers(): void {
    // Server manager events
    this.serverManager.on('server_added', (server) => {
      this.logger.info(`Server added: ${server.name}`, { serverId: server.id })
      this.emit('server_added', server)
    })

    this.serverManager.on('server_removed', (data) => {
      this.logger.info(`Server removed: ${data.name}`, { serverId: data.serverId })
      this.emit('server_removed', data)
    })

    this.serverManager.on('server_unhealthy', (server) => {
      this.logger.warn(`Server unhealthy: ${server.name}`, { serverId: server.id })
      this.emit('server_unhealthy', server)
    })

    this.serverManager.on('server_reconnected', (server) => {
      this.logger.info(`Server reconnected: ${server.name}`, { serverId: server.id })
      this.emit('server_reconnected', server)
    })

    // Process events
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', error)
      this.emit('error', error)
    })

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection', { reason, promise })
      this.emit('error', new Error(`Unhandled rejection: ${reason}`))
    })
  }

  async initialize(configPath: string): Promise<void> {
    this.logger.info(`Initializing Enhanced MCP Proxy from config: ${configPath}`)

    try {
      // Load and validate configuration
      const config = await this.loadConfig(configPath)
      ConfigValidator.validateProxyConfig(this.config)

      // Initialize server manager with loaded servers
      await this.serverManager.initialize(config)

      this.logger.info(`Enhanced MCP Proxy initialized with ${config.length} servers`)
      this.emit('initialized', { serverCount: config.length })

    } catch (error) {
      this.logger.error('Failed to initialize Enhanced MCP Proxy:', error)
      throw error
    }
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error('Proxy is already started')
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, (error?: Error) => {
        if (error) {
          this.logger.error('Failed to start HTTP server:', error)
          reject(error)
          return
        }

        // Setup WebSocket server
        if (this.config.transports.websocket.enabled) {
          this.wsServer = new WebSocketServer({
            server: this.server,
            path: this.config.transports.websocket.path,
          })

          this.wsServer.on('connection', (ws, req) => {
            this.wsTransport.handleConnection(ws, req, this.serverManager)
          })

          this.wsServer.on('error', (error) => {
            this.logger.error('WebSocket server error:', error)
            this.emit('error', error)
          })
        }

        this.isStarted = true
        this.logger.info(`🚀 Enhanced MCP Proxy started on ${this.config.host}:${this.config.port}`)
        this.emit('started', { host: this.config.host, port: this.config.port })
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    this.logger.info('Stopping Enhanced MCP Proxy...')

    // Close WebSocket server
    if (this.wsServer) {
      this.wsServer.close()
    }

    // Close HTTP server
    return new Promise((resolve) => {
      this.server.close(() => {
        this.isStarted = false
        this.logger.info('Enhanced MCP Proxy stopped')
        this.emit('stopped')
        resolve()
      })
    })
  }

  async cleanup(): Promise<void> {
    await this.stop()
    await this.serverManager.cleanup()
  }

  private async loadConfig(configPath: string): Promise<McpServerConfig[]> {
    try {
      const configContent = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(configContent)

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        throw new Error('Configuration must contain mcpServers object')
      }

      const serverConfigs: McpServerConfig[] = []

      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        if (typeof serverConfig !== 'object' || serverConfig === null) {
          throw new Error(`Invalid server configuration for ${name}`)
        }

        const validatedConfig = { ...serverConfig, name }
        ConfigValidator.validateServerConfig(validatedConfig)
        serverConfigs.push(validatedConfig)
      }

      return serverConfigs

    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in configuration file: ${configPath}`)
      }
      throw error
    }
  }

  private convertToPrometheusFormat(metrics: Map<string, any>): string {
    const lines: string[] = []

    for (const [serverId, serverMetrics] of metrics) {
      lines.push(`# Server ${serverId} metrics`)
      lines.push(`mcp_server_requests_total{server="${serverId}"} ${serverMetrics.totalRequests}`)
      lines.push(`mcp_server_requests_successful_total{server="${serverId}"} ${serverMetrics.successfulRequests}`)
      lines.push(`mcp_server_requests_failed_total{server="${serverId}"} ${serverMetrics.failedRequests}`)
      lines.push(`mcp_server_response_time_ms{server="${serverId}"} ${serverMetrics.averageResponseTime}`)
      lines.push(`mcp_server_uptime_seconds{server="${serverId}"} ${serverMetrics.uptime}`)
      lines.push('')
    }

    return lines.join('\n')
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  // Public API methods
  getStatus() {
    return {
      isStarted: this.isStarted,
      config: this.config,
      servers: this.serverManager.getAllServers(),
      metrics: this.serverManager.getServerMetrics(),
    }
  }

  getServerManager(): EnhancedMcpServerManager {
    return this.serverManager
  }
}