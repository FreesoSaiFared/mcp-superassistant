import {
  JSONRPCRequest,
  JSONRPCResponse,
  Tool,
  Resource,
  Prompt,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult
} from '@modelcontextprotocol/sdk/types.js'

export interface McpServerConfig {
  name: string
  type?: 'stdio' | 'sse' | 'websocket' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeout?: number
  retryAttempts?: number
  healthCheck?: {
    enabled: boolean
    interval: number
    endpoint?: string
  }
  loadBalancing?: {
    strategy: 'round-robin' | 'least-connections' | 'random'
    servers: Array<{
      url: string
      weight: number
    }>
  }
}

export interface ManagedServer {
  id: string
  name: string
  config: McpServerConfig
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  lastError?: string
  lastHealthCheck?: Date
  connectionCount: number
  tools: Tool[]
  resources: Resource[]
  prompts: Prompt[]
  transport: any
  client?: any
  child?: any
  metrics: ServerMetrics
}

export interface ServerMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageResponseTime: number
  lastRequestTime?: Date
  uptime: number
  memoryUsage?: NodeJS.MemoryUsage
}

export interface ProxyConfig {
  port: number
  host: string
  transports: {
    sse: {
      enabled: boolean
      path: string
      cors: boolean
      headers?: Record<string, string>
    }
    websocket: {
      enabled: boolean
      path: string
      compression: boolean
    }
    streamableHttp: {
      enabled: boolean
      path: string
      stateful: boolean
      sessionTimeout: number
    }
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'none'
    structured: boolean
    includeTimestamps: boolean
  }
  monitoring: {
    enabled: boolean
    metricsEndpoint: string
    healthEndpoint: string
    collectMetrics: boolean
  }
  performance: {
    requestTimeout: number
    maxConnections: number
    enableCaching: boolean
    cacheTtl: number
  }
}

export interface ClientConnection {
  id: string
  type: 'sse' | 'websocket' | 'http'
  transport: any
  lastActivity: Date
  sessionId: string
  metadata: Record<string, any>
}

export interface RequestContext {
  requestId: string
  client: ClientConnection
  timestamp: Date
  method: string
  params?: any
  serverId?: string
}

export interface HealthCheckResult {
  serverId: string
  status: 'healthy' | 'unhealthy' | 'degraded'
  responseTime: number
  timestamp: Date
  details?: Record<string, any>
}

export interface LoadBalancerConfig {
  strategy: 'round-robin' | 'least-connections' | 'weighted-round-robin' | 'random'
  healthCheck: {
    enabled: boolean
    interval: number
    timeout: number
    retries: number
  }
  servers: Array<{
    id: string
    url: string
    weight: number
    maxConnections: number
    currentConnections: number
  }>
}

export type TransportType = 'stdio' | 'sse' | 'websocket' | 'streamable-http'

export interface UnifiedRequest extends JSONRPCRequest {
  requestId: string
  clientInfo: {
    id: string
    type: TransportType
    userAgent?: string
  }
  timestamp: Date
}

export interface UnifiedResponse extends JSONRPCResponse {
  requestId: string
  serverId: string
  processingTime: number
  timestamp: Date
}

export interface ProxyEvent {
  type: 'server_connected' | 'server_disconnected' | 'client_connected' | 'client_disconnected' | 'error' | 'metrics_updated'
  timestamp: Date
  data: Record<string, any>
}

export interface CacheEntry<T = any> {
  key: string
  value: T
  timestamp: Date
  ttl: number
  hits: number
}