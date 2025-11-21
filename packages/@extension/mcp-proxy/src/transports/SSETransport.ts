import { Request, Response } from 'express'
import { EventEmitter } from 'events'
import { EnhancedMcpServerManager } from '../core/EnhancedMcpServerManager.js'
import { ProxyConfig, ClientConnection } from '../types/index.js'
import { Logger } from '../utils/logger.js'

interface SSEConnection extends ClientConnection {
  response: Response
  clientId: string
  lastPing: number
  isAlive: boolean
}

export class SSETransport extends EventEmitter {
  private connections: Map<string, SSEConnection> = new Map()
  private pingInterval?: NodeJS.Timeout
  private logger: Logger
  private config: ProxyConfig

  constructor(config: ProxyConfig, logger?: Logger) {
    super()
    this.config = config
    this.logger = logger || new Logger(config.logging)
    this.setupPingInterval()
  }

  handleConnection(req: Request, res: Response, serverManager: EnhancedMcpServerManager): void {
    const clientId = this.generateClientId()
    const connectionId = this.generateConnectionId()

    this.logger.info('New SSE connection established', {
      clientId,
      connectionId,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    })

    // Setup SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
      'Access-Control-Allow-Credentials': 'true',
    })

    // Create connection object
    const connection: SSEConnection = {
      id: connectionId,
      type: 'sse',
      transport: res,
      lastActivity: new Date(),
      sessionId: req.headers['x-session-id'] as string || this.generateSessionId(),
      metadata: {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        headers: req.headers,
      },
      response: res,
      clientId,
      lastPing: Date.now(),
      isAlive: true,
    }

    this.connections.set(connectionId, connection)

    // Send initial connection message
    this.sendEvent(connectionId, 'connected', {
      connectionId,
      clientId,
      sessionId: connection.sessionId,
      timestamp: new Date().toISOString(),
      server: {
        name: 'Enhanced MCP SuperAssistant Proxy',
        version: '0.6.0',
      },
    })

    // Setup request handling
    this.handleSSERequests(req, res, connection, serverManager)

    // Handle connection close
    req.on('close', () => {
      this.handleConnectionClose(connectionId)
    })

    req.on('error', (error) => {
      this.logger.error('SSE connection error', error, { connectionId })
      this.handleConnectionClose(connectionId)
    })

    // Emit connection event
    this.emit('client_connected', connection)
  }

  private handleSSERequests(
    req: Request,
    res: Response,
    connection: SSEConnection,
    serverManager: EnhancedMcpServerManager
  ): void {
    // SSE is typically one-way (server to client), but we can handle POST requests
    // for bidirectional communication
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })

      req.on('end', async () => {
        try {
          const request = JSON.parse(body)
          await this.handleRequest(request, connection, serverManager)
        } catch (error) {
          this.logger.error('Invalid JSON in SSE POST request', error, {
            connectionId: connection.id,
            body: body.substring(0, 200),
          })

          this.sendEvent(connection.id, 'error', {
            error: 'Invalid JSON',
            message: (error as Error).message,
          })
        }
      })
    }
  }

  private async handleRequest(
    request: any,
    connection: SSEConnection,
    serverManager: EnhancedMcpServerManager
  ): Promise<void> {
    try {
      connection.lastActivity = new Date()

      // Add request metadata
      const enrichedRequest = {
        ...request,
        requestId: request.id || this.generateRequestId(),
        timestamp: new Date().toISOString(),
        clientId: connection.clientId,
        sessionId: connection.sessionId,
      }

      this.logger.debug('Processing SSE request', {
        requestId: enrichedRequest.requestId,
        method: request.method,
        connectionId: connection.id,
      })

      // Forward to server manager
      const response = await serverManager.handleRequest(enrichedRequest, {
        connection,
        requestId: enrichedRequest.requestId,
      })

      // Send response
      this.sendEvent(connection.id, 'response', {
        requestId: enrichedRequest.requestId,
        response,
        timestamp: new Date().toISOString(),
      })

    } catch (error) {
      this.logger.error('Error handling SSE request', error, {
        connectionId: connection.id,
        request: request.id || 'unknown',
      })

      this.sendEvent(connection.id, 'error', {
        error: (error as Error).message,
        requestId: request.id || this.generateRequestId(),
        timestamp: new Date().toISOString(),
      })
    }
  }

  sendEvent(connectionId: string, event: string, data: any): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection || !connection.isAlive) {
      return false
    }

    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      connection.response.write(payload)

      this.logger.debug('SSE event sent', {
        connectionId,
        event,
        dataSize: JSON.stringify(data).length,
      })

      return true

    } catch (error) {
      this.logger.error('Failed to send SSE event', error, { connectionId, event })
      connection.isAlive = false
      return false
    }
  }

  broadcast(event: string, data: any): number {
    let sentCount = 0

    for (const [connectionId, connection] of this.connections) {
      if (connection.isAlive && this.sendEvent(connectionId, event, data)) {
        sentCount++
      }
    }

    this.logger.debug('SSE broadcast sent', {
      event,
      totalConnections: this.connections.size,
      sentCount,
    })

    return sentCount
  }

  private setupPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now()
      const deadConnections: string[] = []

      for (const [connectionId, connection] of this.connections) {
        if (!connection.isAlive) {
          deadConnections.push(connectionId)
          continue
        }

        // Check if connection is stale (no ping response for 2 minutes)
        if (now - connection.lastPing > 120000) {
          this.logger.warn('SSE connection stale', {
            connectionId,
            lastPing: connection.lastPing,
          })
          deadConnections.push(connectionId)
          continue
        }

        // Send ping
        try {
          connection.response.write(': ping\n\n')
          connection.lastPing = now
        } catch (error) {
          this.logger.debug('SSE connection died during ping', {
            connectionId,
            error: (error as Error).message,
          })
          connection.isAlive = false
          deadConnections.push(connectionId)
        }
      }

      // Clean up dead connections
      deadConnections.forEach(connectionId => {
        this.handleConnectionClose(connectionId)
      })

    }, 30000) // Every 30 seconds
  }

  private handleConnectionClose(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return

    this.logger.info('SSE connection closed', {
      connectionId,
      clientId: connection.clientId,
      duration: Date.now() - connection.lastPing,
    })

    try {
      connection.response.end()
    } catch (error) {
      // Ignore errors during cleanup
    }

    this.connections.delete(connectionId)
    this.emit('client_disconnected', connection)
  }

  getConnectionCount(): number {
    return this.connections.size
  }

  getActiveConnections(): Array<{
    connectionId: string
    clientId: string
    sessionId: string
    lastActivity: Date
    duration: number
  }> {
    const now = Date.now()

    return Array.from(this.connections.values()).map(connection => ({
      connectionId: connection.id,
      clientId: connection.clientId,
      sessionId: connection.sessionId,
      lastActivity: connection.lastActivity,
      duration: now - connection.lastPing,
    }))
  }

  closeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) return false

    try {
      connection.response.end()
      this.connections.delete(connectionId)
      this.emit('client_disconnected', connection)
      return true
    } catch (error) {
      this.logger.error('Error closing SSE connection', error, { connectionId })
      return false
    }
  }

  closeAllConnections(): void {
    this.logger.info(`Closing all SSE connections (${this.connections.size})`)

    for (const [connectionId, connection] of this.connections) {
      try {
        connection.response.end()
      } catch (error) {
        // Ignore errors during cleanup
      }
    }

    this.connections.clear()
  }

  cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = undefined
    }

    this.closeAllConnections()
    this.removeAllListeners()
  }

  private generateClientId(): string {
    return `sse_client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateConnectionId(): string {
    return `sse_conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}