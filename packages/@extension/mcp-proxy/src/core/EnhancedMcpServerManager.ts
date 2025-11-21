import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import { z } from 'zod'
import { EventEmitter } from 'events'
import chokidar from 'chokidar'
import cron from 'node-cron'
import {
  ManagedServer,
  McpServerConfig,
  ServerMetrics,
  HealthCheckResult,
  TransportType,
  ProxyEvent
} from '../types/index.js'
import { Logger } from '../utils/logger.js'
import { ConfigValidator } from '../utils/config-validator.js'
import { LoadBalancer } from './LoadBalancer.js'
import { HealthChecker } from './HealthChecker.js'
import { MetricsCollector } from './MetricsCollector.js'

export class EnhancedMcpServerManager extends EventEmitter {
  private servers: Map<string, ManagedServer> = new Map()
  private clients: Map<string, ClientConnection> = new Map()
  private configWatcher?: chokidar.FSWatcher
  private healthCheckJobs: Map<string, NodeJS.Timeout> = new Map()
  private loadBalancer: LoadBalancer
  private healthChecker: HealthChecker
  private metricsCollector: MetricsCollector
  private logger: Logger
  private isShuttingDown = false

  constructor(
    private config: ProxyConfig,
    logger?: Logger
  ) {
    super()
    this.logger = logger || new Logger(config.logging)
    this.loadBalancer = new LoadBalancer(config.loadBalancing)
    this.healthChecker = new HealthChecker(config.monitoring)
    this.metricsCollector = new MetricsCollector(config.monitoring)

    this.setupGracefulShutdown()
  }

  async initialize(configs: McpServerConfig[]): Promise<void> {
    this.logger.info('Initializing Enhanced MCP Server Manager')

    try {
      // Validate all configurations
      for (const config of configs) {
        ConfigValidator.validateServerConfig(config)
      }

      // Start all servers concurrently
      const initPromises = configs.map(config => this.addServer(config))
      await Promise.allSettled(initPromises)

      // Setup config file watching for hot reload
      this.setupConfigWatcher()

      // Setup health checking
      this.setupHealthChecking()

      // Start metrics collection
      this.metricsCollector.start()

      this.logger.info(`Initialized ${this.servers.size} MCP servers`)
      this.emit('initialized', { serverCount: this.servers.size })

    } catch (error) {
      this.logger.error('Failed to initialize server manager:', error)
      throw error
    }
  }

  async addServer(config: McpServerConfig): Promise<ManagedServer> {
    const serverId = this.generateServerId(config.name)

    if (this.servers.has(serverId)) {
      throw new Error(`Server ${config.name} already exists`)
    }

    this.logger.info(`Adding MCP server: ${config.name} (${config.type})`)

    try {
      const server = await this.createServer(config, serverId)
      this.servers.set(serverId, server)

      // Setup health checking for this server
      if (config.healthCheck?.enabled) {
        this.setupServerHealthCheck(serverId)
      }

      this.emit('server_added', server)
      return server

    } catch (error) {
      this.logger.error(`Failed to add server ${config.name}:`, error)
      throw error
    }
  }

  private async createServer(config: McpServerConfig, serverId: string): Promise<ManagedServer> {
    const transportType = ConfigValidator.detectTransportType(config)
    const client = new Client(
      {
        name: 'mcp-superassistant-enhanced-proxy',
        version: '0.6.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    )

    let transport: any
    let childProcess: ChildProcessWithoutNullStreams | undefined

    switch (transportType) {
      case 'stdio':
        transport = await this.createStdioTransport(config)
        break
      case 'sse':
        transport = await this.createSSETransport(config)
        break
      case 'websocket':
        transport = await this.createWebSocketTransport(config)
        break
      case 'streamable-http':
        transport = await this.createStreamableHTTPTransport(config)
        break
      default:
        throw new Error(`Unsupported transport type: ${transportType}`)
    }

    await client.connect(transport)

    const server: ManagedServer = {
      id: serverId,
      name: config.name,
      config,
      status: 'connected',
      connectionCount: 0,
      tools: [],
      resources: [],
      prompts: [],
      transport,
      client,
      child: childProcess,
      metrics: this.initializeMetrics(),
    }

    // Discover server capabilities
    await this.discoverCapabilities(server)

    return server
  }

  private async createStdioTransport(config: McpServerConfig): Promise<StdioClientTransport> {
    if (!config.command) {
      throw new Error('Stdio server missing command')
    }

    const args = config.args || []
    const env = { ...process.env, ...config.env }

    this.logger.debug(`Creating stdio transport: ${config.command} ${args.join(' ')}`)

    return new StdioClientTransport({
      command: config.command,
      args,
      env,
    } as any)
  }

  private async createSSETransport(config: McpServerConfig): Promise<SSEClientTransport> {
    if (!config.url) {
      throw new Error('SSE server missing URL')
    }

    const url = new URL(config.url)
    const headers = config.headers || {}

    this.logger.debug(`Creating SSE transport: ${config.url}`)

    return new SSEClientTransport(url, {
      eventSourceInit: {
        fetch: (...props: Parameters<typeof fetch>) => {
          const [url, init = {}] = props
          return fetch(url, {
            ...init,
            headers: { ...init.headers, ...headers }
          })
        },
      },
      requestInit: { headers },
    })
  }

  private async createWebSocketTransport(config: McpServerConfig): Promise<WebSocketClientTransport> {
    if (!config.url) {
      throw new Error('WebSocket server missing URL')
    }

    const url = new URL(config.url)
    const headers = config.headers || {}

    this.logger.debug(`Creating WebSocket transport: ${config.url}`)

    return new WebSocketClientTransport(url, { headers })
  }

  private async createStreamableHTTPTransport(config: McpServerConfig): Promise<StreamableHTTPClientTransport> {
    if (!config.url) {
      throw new Error('Streamable HTTP server missing URL')
    }

    const url = new URL(config.url)
    const headers = config.headers || {}

    this.logger.debug(`Creating Streamable HTTP transport: ${config.url}`)

    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    })
  }

  private async discoverCapabilities(server: ManagedServer): Promise<void> {
    try {
      // Discover tools
      const toolsResponse = await server.client.request(
        { method: 'tools/list', params: {} },
        z.object({ tools: z.array(z.any()) })
      ) as any
      server.tools = toolsResponse.tools || []

      // Discover resources
      try {
        const resourcesResponse = await server.client.request(
          { method: 'resources/list', params: {} },
          z.object({ resources: z.array(z.any()) })
        ) as any
        server.resources = resourcesResponse.resources || []
      } catch (err) {
        this.logger.debug(`Server ${server.name} does not support resources`)
      }

      // Discover prompts
      try {
        const promptsResponse = await server.client.request(
          { method: 'prompts/list', params: {} },
          z.object({ prompts: z.array(z.any()) })
        ) as any
        server.prompts = promptsResponse.prompts || []
      } catch (err) {
        this.logger.debug(`Server ${server.name} does not support prompts`)
      }

      this.logger.info(
        `Server ${server.name} capabilities: ${server.tools.length} tools, ` +
        `${server.resources.length} resources, ${server.prompts.length} prompts`
      )

    } catch (error) {
      this.logger.warn(`Failed to discover capabilities for ${server.name}:`, error)
    }
  }

  async removeServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId)
    if (!server) {
      throw new Error(`Server ${serverId} not found`)
    }

    this.logger.info(`Removing server: ${server.name}`)

    try {
      // Stop health checking
      const healthJob = this.healthCheckJobs.get(serverId)
      if (healthJob) {
        clearInterval(healthJob)
        this.healthCheckJobs.delete(serverId)
      }

      // Close client connection
      if (server.client) {
        await server.client.close()
      }

      // Kill child process if exists
      if (server.child) {
        server.child.kill()
      }

      this.servers.delete(serverId)
      this.emit('server_removed', { serverId, name: server.name })

    } catch (error) {
      this.logger.error(`Error removing server ${server.name}:`, error)
      throw error
    }
  }

  async handleRequest(request: any, context: any): Promise<any> {
    const startTime = Date.now()
    let serverId = request.serverId

    // Load balancing if no specific server requested
    if (!serverId) {
      serverId = this.loadBalancer.selectServer(request.method)
    }

    const server = this.servers.get(serverId)
    if (!server) {
      throw new Error(`Server ${serverId} not found`)
    }

    try {
      // Update metrics
      server.metrics.totalRequests++
      server.connectionCount++

      const response = await server.client.request(request, z.any())

      // Update success metrics
      server.metrics.successfulRequests++
      const processingTime = Date.now() - startTime
      server.metrics.averageResponseTime =
        (server.metrics.averageResponseTime + processingTime) / 2
      server.metrics.lastRequestTime = new Date()

      this.metricsCollector.recordRequest(serverId, request.method, processingTime, true)

      return response

    } catch (error) {
      server.metrics.failedRequests++
      this.metricsCollector.recordRequest(serverId, request.method, Date.now() - startTime, false)
      throw error
    } finally {
      server.connectionCount--
    }
  }

  getServer(serverId: string): ManagedServer | undefined {
    return this.servers.get(serverId)
  }

  getAllServers(): ManagedServer[] {
    return Array.from(this.servers.values())
  }

  getHealthyServers(): ManagedServer[] {
    return this.getAllServers().filter(server => server.status === 'connected')
  }

  getServerMetrics(): Map<string, ServerMetrics> {
    const metrics = new Map<string, ServerMetrics>()
    for (const [id, server] of this.servers) {
      metrics.set(id, { ...server.metrics })
    }
    return metrics
  }

  private generateServerId(name: string): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substr(2, 5)
    return `${name}-${timestamp}-${random}`
  }

  private initializeMetrics(): ServerMetrics {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      uptime: Date.now(),
    }
  }

  private setupConfigWatcher(): void {
    // Watch for config changes and hot reload servers
    // Implementation depends on your config storage strategy
  }

  private setupHealthChecking(): void {
    // Global health checking setup
    for (const [serverId, server] of this.servers) {
      if (server.config.healthCheck?.enabled) {
        this.setupServerHealthCheck(serverId)
      }
    }
  }

  private setupServerHealthCheck(serverId: string): void {
    const server = this.servers.get(serverId)
    if (!server?.config.healthCheck?.enabled) return

    const interval = setInterval(async () => {
      try {
        const healthResult = await this.healthChecker.checkServer(server)
        server.lastHealthCheck = new Date()

        if (healthResult.status === 'unhealthy' && server.status === 'connected') {
          server.status = 'error'
          server.lastError = 'Health check failed'
          this.emit('server_unhealthy', server)
        } else if (healthResult.status === 'healthy' && server.status !== 'connected') {
          // Attempt reconnection
          this.attemptReconnection(serverId)
        }

      } catch (error) {
        this.logger.warn(`Health check failed for ${server.name}:`, error)
      }
    }, server.config.healthCheck.interval)

    this.healthCheckJobs.set(serverId, interval)
  }

  private async attemptReconnection(serverId: string): Promise<void> {
    const server = this.servers.get(serverId)
    if (!server) return

    this.logger.info(`Attempting to reconnect to ${server.name}...`)

    try {
      // Create new connection
      const newServer = await this.createServer(server.config, serverId)

      // Clean up old connection
      if (server.child) {
        server.child.kill()
      }

      // Update server with new connection
      Object.assign(server, newServer)
      server.status = 'connected'
      server.lastError = undefined

      this.emit('server_reconnected', server)
      this.logger.info(`Successfully reconnected to ${server.name}`)

    } catch (error) {
      this.logger.error(`Failed to reconnect to ${server.name}:`, error)
      server.lastError = (error as Error).message
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async () => {
      if (this.isShuttingDown) return
      this.isShuttingDown = true

      this.logger.info('Shutting down Enhanced MCP Server Manager...')

      // Stop all health checks
      for (const interval of this.healthCheckJobs.values()) {
        clearInterval(interval)
      }

      // Close all server connections
      const shutdownPromises = Array.from(this.servers.values()).map(async (server) => {
        try {
          if (server.client) {
            await server.client.close()
          }
          if (server.child) {
            server.child.kill()
          }
        } catch (error) {
          this.logger.error(`Error shutting down ${server.name}:`, error)
        }
      })

      await Promise.allSettled(shutdownPromises)
      this.metricsCollector.stop()

      this.logger.info('Enhanced MCP Server Manager shutdown complete')
      process.exit(0)
    }

    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    process.once('SIGUSR2', shutdown) // For nodemon
  }

  async cleanup(): Promise<void> {
    this.isShuttingDown = true

    // Stop health checking
    for (const interval of this.healthCheckJobs.values()) {
      clearInterval(interval)
    }
    this.healthCheckJobs.clear()

    // Close all servers
    for (const [serverId, server] of this.servers) {
      try {
        if (server.client) {
          await server.client.close()
        }
        if (server.child) {
          server.child.kill()
        }
      } catch (error) {
        this.logger.error(`Error cleaning up server ${server.name}:`, error)
      }
    }

    this.servers.clear()
    this.metricsCollector.stop()

    if (this.configWatcher) {
      await this.configWatcher.close()
    }
  }
}