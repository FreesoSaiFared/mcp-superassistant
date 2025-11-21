import { WebSocket, IncomingMessage } from 'ws'
import { EventEmitter } from 'events'
import { EnhancedMcpServerManager } from '../core/EnhancedMcpServerManager.js'
import { ProxyConfig, ClientConnection } from '../types/index.js'
import { Logger } from '../utils/logger.js'

interface WebSocketConnection extends ClientConnection {
  ws: WebSocket
  clientId: string
  lastPing: number
  isAlive: boolean
  requests: Map<string, { resolve: Function; reject: Function; timestamp: number }>
}

export class WebSocketTransport extends EventEmitter {
  private connections: Map<string, WebSocketConnection> = new Map()
  private pingInterval?: NodeJS.Timeout
  private logger: Logger
  private config: ProxyConfig

  constructor(config: ProxyConfig, logger?: Logger) {
    super()
    this.config = config
    this.logger = logger || new Logger(config.logging)
    this.setupPingInterval()
  }

  handleConnection(
    ws: WebSocket,
    req: IncomingMessage,
    serverManager: EnhancedMcpServerManager
  ): void {
    const connectionId = this.generateConnectionId()
    const clientId = this.generateClientId()

    this.logger.info('New WebSocket connection established', {
      connectionId,
      clientId,
      userAgent: req.headers['user-agent'],
      ip: req.socket.remoteAddress,
    })

    // Create connection object
    const connection: WebSocketConnection = {
      id: connectionId,
      type: 'websocket',
      transport: ws,
      lastActivity: new Date(),
      sessionId: req.headers['x-session-id'] as string || this.generateSessionId(),
      metadata: {
        userAgent: req.headers['user-agent'],
        ip: req.socket.remoteAddress,
        headers: req.headers,
      },
      ws,
      clientId,
      lastPing: Date.now(),
      isAlive: true,
      requests: new Map(),
    }

    this.connections.set(connectionId, connection)

    // Setup WebSocket event handlers
    this.setupWebSocketHandlers(connection, serverManager)

    // Send initial connection message
    this.sendMessage(connectionId, 'connected', {
      connectionId,
      clientId,
      sessionId: connection.sessionId,
      timestamp: new Date().toISOString(),
      server: {
        name: 'Enhanced MCP SuperAssistant Proxy',
        version: '0.6.0',
      },
    })

    // Emit connection event
    this.emit('client_connected', connection)
  }

  private setupWebSocketHandlers(
    connection: WebSocketConnection,
    serverManager: EnhancedMcpServerManager
  ): void {
    const ws = connection.ws

    // Handle incoming messages
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString())
        await this.handleMessage(message, connection, serverManager)
      } catch (error) {
        this.logger.error('Invalid JSON in WebSocket message', error, {
          connectionId: connection.id,
          message: data.toString().substring(0, 200),
        })

        this.sendMessage(connection.id, 'error', {
          error: 'Invalid JSON',
          message: (error as Error).message,
        })
      }
    })

    // Handle connection close
    ws.on('close', (code: number, reason: Buffer) => {
      this.logger.info('WebSocket connection closed', {
        connectionId: connection.id,
        code,
        reason: reason.toString(),
      })

      // Reject any pending requests
      for (const [requestId, requestHandler] of connection.requests) {
        requestHandler.reject(new Error('Connection closed'))
      }
      connection.requests.clear()

      this.handleConnectionClose(connection.id)
    })

    // Handle connection errors
    ws.on('error', (error: Error) => {
      this.logger.error('WebSocket connection error', error, {
        connectionId: connection.id,
      })

      connection.isAlive = false
      this.handleConnectionClose(connection.id)
    })

    // Handle ping/pong for connection health
    ws.on('ping', () => {
      connection.lastPing = Date.now()
      ws.pong()
    })

    ws.on('pong', () => {
      connection.lastPing = Date.now()
    })
  }

  private async handleMessage(
    message: any,
    connection: WebSocketConnection,
    serverManager: EnhancedMcpServerManager
  ): Promise<void> {
    try {
      connection.lastActivity = new Date()

      // Add request metadata
      const enrichedMessage = {
        ...message,
        requestId: message.id || this.generateRequestId(),
        timestamp: new Date().toISOString(),
        clientId: connection.clientId,
        sessionId: connection.sessionId,
      }

      this.logger.debug('Processing WebSocket message', {
        requestId: enrichedMessage.requestId,
        type: message.type || 'unknown',
        method: message.method,
        connectionId: connection.id,
      })

      let response

      // Handle different message types
      switch (message.type) {
        case 'request':
        case 'mcp_request':
          response = await this.handleRequest(enrichedMessage, connection, serverManager)
          break

        case 'ping':
          response = { type: 'pong', timestamp: new Date().toISOString() }
          break

        case 'subscribe':
          response = await this.handleSubscription(message, connection)
          break

        case 'unsubscribe':
          response = await this.handleUnsubscription(message, connection)
          break

        default:
          // Treat as standard MCP request
          response = await this.handleRequest(enrichedMessage, connection, serverManager)
      }

      // Send response
      this.sendMessage(connection.id, 'response', {
        requestId: enrichedMessage.requestId,
        response,
        timestamp: new Date().toISOString(),
      })

    } catch (error) {
      this.logger.error('Error handling WebSocket message', error, {
        connectionId: connection.id,
        message: message.id || 'unknown',
      })

      this.sendMessage(connection.id, 'error', {
        error: (error as Error).message,
        requestId: message.id || this.generateRequestId(),
        timestamp: new Date().toISOString(),
      })
    }
  }

  private async handleRequest(
    request: any,
    connection: WebSocketConnection,
    serverManager: EnhancedMcpServerManager
  ): Promise<any> {
    // Store request promise for potential timeout/cancellation
    if (request.requestId) {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), 30000)
      })

      try {
        const response = await Promise.race([
          serverManager.handleRequest(request, {
            connection,
            requestId: request.requestId,
          }),
          timeoutPromise,
        ])

        return response
      } catch (error) {
        connection.requests.delete(request.requestId)
        throw error
      }
    } else {
      return serverManager.handleRequest(request, {
        connection,
        requestId: this.generateRequestId(),
      })
    }
  }

  private async handleSubscription(message: any, connection: WebSocketConnection): Promise<any> {
    // Handle subscription to specific events or topics
    const { topic, filters } = message

    this.logger.debug('WebSocket subscription', {
      connectionId: connection.id,
      topic,
      filters,
    })

    // Store subscription metadata
    connection.metadata.subscriptions = connection.metadata.subscriptions || []
    connection.metadata.subscriptions.push({ topic, filters })

    return {
      type: 'subscription_confirmed',
      topic,
      timestamp: new Date().toISOString(),
    }
  }

  private async handleUnsubscription(message: any, connection: WebSocketConnection): Promise<any> {
    // Handle unsubscription from topics
    const { topic } = message

    this.logger.debug('WebSocket unsubscription', {
      connectionId: connection.id,
      topic,
    })

    if (connection.metadata.subscriptions) {
      connection.metadata.subscriptions = connection.metadata.subscriptions.filter(
        (sub: any) => sub.topic !== topic
      )
    }

    return {
      type: 'unsubscription_confirmed',
      topic,
      timestamp: new Date().toISOString(),
    }
  }

  sendMessage(connectionId: string, type: string, data: any): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection || !connection.isAlive) {
      return false
    }

    try {
      const message = {
        type,
        ...data,
        timestamp: data.timestamp || new Date().toISOString(),
      }

      connection.ws.send(JSON.stringify(message))

      this.logger.debug('WebSocket message sent', {
        connectionId,
        type,
        dataSize: JSON.stringify(message).length,
      })

      return true

    } catch (error) {
      this.logger.error('Failed to send WebSocket message', error, { connectionId, type })
      connection.isAlive = false
      return false
    }
  }

  broadcast(type: string, data: any, filter?: (conn: WebSocketConnection) => boolean): number {
    let sentCount = 0

    for (const [connectionId, connection] of this.connections) {
      if (!connection.isAlive) continue

      // Apply filter if provided
      if (filter && !filter(connection)) continue

      // Check if connection is subscribed to relevant topics
      if (connection.metadata.subscriptions) {
        const hasRelevantSubscription = connection.metadata.subscriptions.some(
          (sub: any) => this.isRelevantSubscription(sub, type, data)
        )
        if (!hasRelevantSubscription) continue
      }

      if (this.sendMessage(connectionId, type, data)) {
        sentCount++
      }
    }

    this.logger.debug('WebSocket broadcast sent', {
      type,
      totalConnections: this.connections.size,
      sentCount,
    })

    return sentCount
  }

  private isRelevantSubscription(subscription: any, type: string, data: any): boolean {
    // Implement subscription filtering logic
    // For now, send to all subscribed connections
    return true
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

        // Check if connection is stale (no pong for 2 minutes)
        if (now - connection.lastPing > 120000) {
          this.logger.warn('WebSocket connection stale', {
            connectionId,
            lastPing: connection.lastPing,
          })
          deadConnections.push(connectionId)
          continue
        }

        // Send ping
        try {
          connection.ws.ping()
        } catch (error) {
          this.logger.debug('WebSocket connection died during ping', {
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

    this.logger.info('WebSocket connection closed', {
      connectionId,
      clientId: connection.clientId,
      duration: Date.now() - connection.lastPing,
    })

    try {
      connection.ws.terminate()
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
    subscriptions: any[]
  }> {
    const now = Date.now()

    return Array.from(this.connections.values()).map(connection => ({
      connectionId: connection.id,
      clientId: connection.clientId,
      sessionId: connection.sessionId,
      lastActivity: connection.lastActivity,
      duration: now - connection.lastPing,
      subscriptions: connection.metadata.subscriptions || [],
    }))
  }

  closeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) return false

    try {
      connection.ws.close()
      this.connections.delete(connectionId)
      this.emit('client_disconnected', connection)
      return true
    } catch (error) {
      this.logger.error('Error closing WebSocket connection', error, { connectionId })
      return false
    }
  }

  closeAllConnections(): void {
    this.logger.info(`Closing all WebSocket connections (${this.connections.size})`)

    for (const [connectionId, connection] of this.connections) {
      try {
        connection.ws.close()
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
    return `ws_client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateConnectionId(): string {
    return `ws_conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}