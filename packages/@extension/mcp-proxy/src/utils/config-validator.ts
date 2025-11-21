import { z } from 'zod'
import { McpServerConfig, TransportType } from '../types/index.js'

const ServerConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['stdio', 'sse', 'websocket', 'streamable-http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().positive().optional(),
  retryAttempts: z.number().min(0).optional(),
  healthCheck: z.object({
    enabled: z.boolean(),
    interval: z.number().positive(),
    endpoint: z.string().optional(),
  }).optional(),
  loadBalancing: z.object({
    strategy: z.enum(['round-robin', 'least-connections', 'random']),
    servers: z.array(z.object({
      url: z.string().url(),
      weight: z.number().positive(),
    })),
  }).optional(),
}).refine((config) => {
  // Validate that either command (for stdio) or url (for remote) is provided
  if (config.type === 'stdio' && !config.command) {
    return false
  }
  if (['sse', 'websocket', 'streamable-http'].includes(config.type || '') && !config.url) {
    return false
  }
  return true
}, {
  message: 'Invalid server configuration: missing required command or url',
})

const ProxyConfigSchema = z.object({
  port: z.number().positive().max(65535),
  host: z.string(),
  transports: z.object({
    sse: z.object({
      enabled: z.boolean(),
      path: z.string(),
      cors: z.boolean(),
      headers: z.record(z.string()).optional(),
    }),
    websocket: z.object({
      enabled: z.boolean(),
      path: z.string(),
      compression: z.boolean(),
    }),
    streamableHttp: z.object({
      enabled: z.boolean(),
      path: z.string(),
      stateful: z.boolean(),
      sessionTimeout: z.number().positive(),
    }),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'none']),
    structured: z.boolean(),
    includeTimestamps: z.boolean(),
  }),
  monitoring: z.object({
    enabled: z.boolean(),
    metricsEndpoint: z.string(),
    healthEndpoint: z.string(),
    collectMetrics: z.boolean(),
  }),
  performance: z.object({
    requestTimeout: z.number().positive(),
    maxConnections: z.number().positive(),
    enableCaching: z.boolean(),
    cacheTtl: z.number().positive(),
  }),
})

export class ConfigValidator {
  static validateServerConfig(config: McpServerConfig): void {
    try {
      ServerConfigSchema.parse(config)
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err =>
          `${err.path.join('.')}: ${err.message}`
        ).join(', ')
        throw new Error(`Invalid server configuration: ${details}`)
      }
      throw error
    }
  }

  static validateProxyConfig(config: any): void {
    try {
      ProxyConfigSchema.parse(config)
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err =>
          `${err.path.join('.')}: ${err.message}`
        ).join(', ')
        throw new Error(`Invalid proxy configuration: ${details}`)
      }
      throw error
    }
  }

  static detectTransportType(config: McpServerConfig): TransportType {
    // Explicit type takes precedence
    if (config.type) {
      return config.type
    }

    // Auto-detect based on configuration
    if (config.url) {
      const url = new URL(config.url)
      if (url.pathname.endsWith('/sse') || url.pathname.includes('/sse')) {
        return 'sse'
      }
      if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        return 'websocket'
      }
      if (url.pathname.endsWith('/mcp') || url.pathname.includes('/mcp')) {
        return 'streamable-http'
      }
      // Default to SSE for HTTP URLs
      return 'sse'
    }

    if (config.command) {
      return 'stdio'
    }

    throw new Error('Unable to detect transport type: provide either type, command, or url')
  }

  static validateServerName(name: string, existingNames: Set<string>): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Server name is required')
    }

    if (existingNames.has(name)) {
      throw new Error(`Server name '${name}' already exists`)
    }

    // Validate name format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Server name can only contain letters, numbers, hyphens, and underscores')
    }
  }

  static validateUrl(url: string): boolean {
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  }

  static validateTimeout(timeout?: number): number {
    if (!timeout) return 30000 // Default 30 seconds
    if (timeout < 1000) return 1000 // Minimum 1 second
    if (timeout > 300000) return 300000 // Maximum 5 minutes
    return timeout
  }

  static sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
    if (!headers) return {}

    const sanitized: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      // Remove potentially dangerous headers
      if (!['host', 'connection', 'upgrade', 'content-length'].includes(key.toLowerCase())) {
        sanitized[key] = value
      }
    }

    return sanitized
  }

  static validateHealthCheck(config: McpServerConfig['healthCheck']): McpServerConfig['healthCheck'] {
    if (!config) return { enabled: false, interval: 30000 }

    return {
      enabled: config.enabled ?? false,
      interval: Math.max(config.interval || 30000, 5000), // Minimum 5 seconds
      endpoint: config.endpoint,
    }
  }

  static validateLoadBalancing(config: McpServerConfig['loadBalancing']): McpServerConfig['loadBalancing'] {
    if (!config) return undefined

    const totalWeight = config.servers.reduce((sum, server) => sum + server.weight, 0)
    if (totalWeight === 0) {
      throw new Error('Total weight in load balancing configuration must be greater than 0')
    }

    return {
      strategy: config.strategy || 'round-robin',
      servers: config.servers.map(server => ({
        url: server.url,
        weight: Math.max(server.weight, 1), // Minimum weight of 1
      })),
    }
  }
}