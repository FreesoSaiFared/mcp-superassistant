import { Request, Response } from 'express'
import { EnhancedMcpServerManager } from '../core/EnhancedMcpServerManager.js'
import { ProxyConfig } from '../types/index.js'
import { Logger } from '../utils/logger.js'

interface HttpSession {
  id: string
  createdAt: Date
  lastActivity: Date
  data: Map<string, any>
}

export class StreamableHTTPTransport {
  private sessions: Map<string, HttpSession> = new Map()
  private logger: Logger
  private config: ProxyConfig
  private cleanupInterval?: NodeJS.Timeout

  constructor(config: ProxyConfig, logger?: Logger) {
    this.config = config
    this.logger = logger || new Logger(config.logging)
    this.setupSessionCleanup()
  }

  async handleRequest(
    req: Request,
    res: Response,
    serverManager: EnhancedMcpServerManager
  ): Promise<void> {
    const startTime = Date.now()
    const sessionId = this.getSessionId(req)
    const requestId = this.generateRequestId()

    try {
      // Get or create session
      const session = this.getOrCreateSession(sessionId)

      this.logger.info('Streamable HTTP request', {
        method: req.method,
        path: req.path,
        sessionId,
        requestId,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      })

      // Set session cookie if stateful
      if (this.config.transports.streamableHttp.stateful) {
        res.setHeader('Set-Cookie', `mcp_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`)
      }

      // Parse request body
      let requestBody: any
      try {
        if (req.body && typeof req.body === 'object') {
          requestBody = req.body
        } else if (req.body) {
          requestBody = JSON.parse(req.body)
        } else {
          requestBody = {}
        }
      } catch (error) {
        res.status(400).json({
          error: 'Invalid JSON in request body',
          message: (error as Error).message,
          requestId,
        })
        return
      }

      // Add metadata to request
      const enrichedRequest = {
        ...requestBody,
        sessionId,
        requestId,
        timestamp: new Date().toISOString(),
        clientInfo: {
          type: 'streamable-http',
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          sessionId,
        },
      }

      // Handle different request types
      let response: any
      let statusCode = 200

      if (req.method === 'POST' && this.isMCPRequest(requestBody)) {
        // Handle MCP protocol requests
        response = await this.handleMCPRequest(enrichedRequest, serverManager, session)
      } else if (req.method === 'GET') {
        // Handle GET requests (session info, status, etc.)
        response = await this.handleGetRequest(req, session)
      } else if (req.method === 'DELETE') {
        // Handle session cleanup
        response = await this.handleDeleteRequest(req, session)
      } else {
        res.status(405).json({
          error: 'Method Not Allowed',
          message: `Only GET, POST, DELETE methods are supported`,
          requestId,
        })
        return
      }

      // Update session activity
      session.lastActivity = new Date()

      // Send response
      const processingTime = Date.now() - startTime

      res.status(statusCode).json({
        ...response,
        requestId,
        sessionId,
        processingTime,
        timestamp: new Date().toISOString(),
      })

      this.logger.info('Streamable HTTP request completed', {
        method: req.method,
        path: req.path,
        sessionId,
        requestId,
        processingTime,
        statusCode,
      })

    } catch (error) {
      const processingTime = Date.now() - startTime

      this.logger.error('Error handling Streamable HTTP request', error, {
        method: req.method,
        path: req.path,
        sessionId,
        requestId,
        processingTime,
      })

      res.status(500).json({
        error: 'Internal Server Error',
        message: (error as Error).message,
        requestId,
        sessionId,
        processingTime,
        timestamp: new Date().toISOString(),
      })
    }
  }

  private async handleMCPRequest(
    request: any,
    serverManager: EnhancedMcpServerManager,
    session: HttpSession
  ): Promise<any> {
    // Store request in session if stateful
    if (this.config.transports.streamableHttp.stateful) {
      session.data.set(`req_${request.requestId}`, {
        request,
        timestamp: new Date(),
      })
    }

    // Forward to server manager
    const response = await serverManager.handleRequest(request, {
      connection: { id: session.id, type: 'http' } as any,
      requestId: request.requestId,
    })

    // Store response in session if stateful
    if (this.config.transports.streamableHttp.stateful) {
      session.data.set(`res_${request.requestId}`, {
        response,
        timestamp: new Date(),
      })
    }

    return response
  }

  private async handleGetRequest(req: Request, session: HttpSession): Promise<any> {
    const { action, key } = req.query

    switch (action) {
      case 'session':
        return this.getSessionInfo(session)

      case 'get':
        if (key && typeof key === 'string') {
          return {
            value: session.data.get(key),
            exists: session.data.has(key),
          }
        }
        break

      case 'list':
        return {
          keys: Array.from(session.data.keys()),
          count: session.data.size,
        }

      case 'health':
        return {
          status: 'healthy',
          sessionId: session.id,
          sessionAge: Date.now() - session.createdAt.getTime(),
          lastActivity: session.lastActivity,
        }

      default:
        return {
          sessionId: session.id,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          dataCount: session.data.size,
          availableActions: ['session', 'get', 'list', 'health'],
        }
    }

    throw new Error('Invalid GET request parameters')
  }

  private async handleDeleteRequest(req: Request, session: HttpSession): Promise<any> {
    const { key, clear } = req.query

    if (clear === 'all') {
      const count = session.data.size
      session.data.clear()
      return {
        message: 'Session data cleared',
        deletedCount: count,
      }
    }

    if (key && typeof key === 'string') {
      const existed = session.data.delete(key)
      return {
        message: existed ? 'Key deleted' : 'Key not found',
        key,
        existed,
      }
    }

    throw new Error('Invalid DELETE request parameters')
  }

  private getSessionId(req: Request): string {
    // Check for session cookie first
    const cookies = this.parseCookies(req.headers.cookie || '')
    if (cookies.mcp_session) {
      return cookies.mcp_session
    }

    // Check for session header
    const sessionHeader = req.headers['x-session-id'] as string
    if (sessionHeader) {
      return sessionHeader
    }

    // Check for session query parameter
    const sessionQuery = req.query.session as string
    if (sessionQuery) {
      return sessionQuery
    }

    // Generate new session ID
    return this.generateSessionId()
  }

  private getOrCreateSession(sessionId: string): HttpSession {
    let session = this.sessions.get(sessionId)

    if (!session) {
      session = {
        id: sessionId,
        createdAt: new Date(),
        lastActivity: new Date(),
        data: new Map(),
      }

      this.sessions.set(sessionId, session)
      this.logger.debug('New session created', { sessionId })
    }

    return session
  }

  private getSessionInfo(session: HttpSession): any {
    return {
      sessionId: session.id,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      age: Date.now() - session.createdAt.getTime(),
      idleTime: Date.now() - session.lastActivity.getTime(),
      dataKeys: Array.from(session.data.keys()),
      dataCount: session.data.size,
      stateful: this.config.transports.streamableHttp.stateful,
    }
  }

  private isMCPRequest(body: any): boolean {
    // Check if this looks like an MCP protocol request
    return body && (
      body.method || // JSON-RPC method
      body.jsonrpc || // JSON-RPC version
      body.type === 'function_call_start' || // MCP function call format
      body.type === 'mcp_request'
    )
  }

  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {}

    if (!cookieHeader) return cookies

    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=')
      if (name && value) {
        cookies[name] = decodeURIComponent(value)
      }
    })

    return cookies
  }

  private setupSessionCleanup(): void {
    if (!this.config.transports.streamableHttp.stateful) {
      return
    }

    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      const timeout = this.config.transports.streamableHttp.sessionTimeout
      const expiredSessions: string[] = []

      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastActivity.getTime() > timeout) {
          expiredSessions.push(sessionId)
        }
      }

      expiredSessions.forEach(sessionId => {
        this.sessions.delete(sessionId)
        this.logger.debug('Session expired and cleaned up', { sessionId })
      })

      if (expiredSessions.length > 0) {
        this.logger.info('Cleaned up expired sessions', {
          count: expiredSessions.length,
          totalSessions: this.sessions.size,
        })
      }

    }, 60000) // Check every minute
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  getActiveSessions(): Array<{
    sessionId: string
    createdAt: Date
    lastActivity: Date
    age: number
    idleTime: number
    dataCount: number
  }> {
    const now = Date.now()

    return Array.from(this.sessions.values()).map(session => ({
      sessionId: session.id,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      age: now - session.createdAt.getTime(),
      idleTime: now - session.lastActivity.getTime(),
      dataCount: session.data.size,
    }))
  }

  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }

    this.sessions.clear()
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}