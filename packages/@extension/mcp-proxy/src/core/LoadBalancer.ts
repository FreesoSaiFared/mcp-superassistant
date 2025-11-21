import { LoadBalancerConfig } from '../types/index.js'
import { Logger } from '../utils/logger.js'

interface ServerNode {
  id: string
  url: string
  weight: number
  currentConnections: number
  maxConnections: number
  totalRequests: number
  averageResponseTime: number
  lastHealthCheck?: Date
  status: 'healthy' | 'unhealthy' | 'degraded'
}

export class LoadBalancer {
  private nodes: Map<string, ServerNode> = new Map()
  private roundRobinIndex = 0
  private logger: Logger

  constructor(config?: LoadBalancerConfig, logger?: Logger) {
    this.logger = logger || new Logger({ level: 'info', structured: true, includeTimestamps: true })

    if (config) {
      this.initializeFromConfig(config)
    }
  }

  private initializeFromConfig(config: LoadBalancerConfig): void {
    for (const server of config.servers) {
      this.nodes.set(server.id, {
        id: server.id,
        url: server.url,
        weight: server.weight,
        currentConnections: 0,
        maxConnections: server.maxConnections,
        totalRequests: 0,
        averageResponseTime: 0,
        status: 'healthy',
      })
    }
  }

  addServer(id: string, url: string, weight: number = 1, maxConnections: number = 100): void {
    this.nodes.set(id, {
      id,
      url,
      weight,
      currentConnections: 0,
      maxConnections,
      totalRequests: 0,
      averageResponseTime: 0,
      status: 'healthy',
    })

    this.logger.info(`Added server to load balancer: ${id} (${url})`)
  }

  removeServer(id: string): void {
    this.nodes.delete(id)
    this.logger.info(`Removed server from load balancer: ${id}`)
  }

  selectServer(strategy: 'round-robin' | 'least-connections' | 'weighted-round-robin' | 'random' = 'round-robin'): string | null {
    const healthyNodes = Array.from(this.nodes.values()).filter(node =>
      node.status === 'healthy' && node.currentConnections < node.maxConnections
    )

    if (healthyNodes.length === 0) {
      this.logger.warn('No healthy servers available for load balancing')
      return null
    }

    let selectedNode: ServerNode

    switch (strategy) {
      case 'round-robin':
        selectedNode = this.selectRoundRobin(healthyNodes)
        break
      case 'least-connections':
        selectedNode = this.selectLeastConnections(healthyNodes)
        break
      case 'weighted-round-robin':
        selectedNode = this.selectWeightedRoundRobin(healthyNodes)
        break
      case 'random':
        selectedNode = this.selectRandom(healthyNodes)
        break
      default:
        selectedNode = healthyNodes[0]
    }

    selectedNode.currentConnections++
    selectedNode.totalRequests++

    this.logger.debug(`Selected server ${selectedNode.id} using ${strategy} strategy`, {
      strategy,
      connections: selectedNode.currentConnections,
      totalRequests: selectedNode.totalRequests,
    })

    return selectedNode.id
  }

  private selectRoundRobin(nodes: ServerNode[]): ServerNode {
    const node = nodes[this.roundRobinIndex % nodes.length]
    this.roundRobinIndex++
    return node
  }

  private selectLeastConnections(nodes: ServerNode[]): ServerNode {
    return nodes.reduce((least, current) =>
      current.currentConnections < least.currentConnections ? current : least
    )
  }

  private selectWeightedRoundRobin(nodes: ServerNode[]): ServerNode {
    const totalWeight = nodes.reduce((sum, node) => sum + node.weight, 0)
    let random = Math.random() * totalWeight

    for (const node of nodes) {
      random -= node.weight
      if (random <= 0) {
        return node
      }
    }

    return nodes[0] // Fallback
  }

  private selectRandom(nodes: ServerNode[]): ServerNode {
    return nodes[Math.floor(Math.random() * nodes.length)]
  }

  releaseConnection(serverId: string): void {
    const node = this.nodes.get(serverId)
    if (node) {
      node.currentConnections = Math.max(0, node.currentConnections - 1)
    }
  }

  updateMetrics(serverId: string, responseTime: number): void {
    const node = this.nodes.get(serverId)
    if (node) {
      // Update average response time using exponential moving average
      const alpha = 0.1 // Smoothing factor
      node.averageResponseTime =
        alpha * responseTime + (1 - alpha) * node.averageResponseTime
    }
  }

  updateHealthStatus(serverId: string, status: ServerNode['status']): void {
    const node = this.nodes.get(serverId)
    if (node) {
      node.status = status
      node.lastHealthCheck = new Date()

      this.logger.info(`Updated health status for ${serverId}: ${status}`)
    }
  }

  getServerStats(): Array<{
    id: string
    url: string
    status: string
    connections: number
    maxConnections: number
    totalRequests: number
    averageResponseTime: number
    weight: number
  }> {
    return Array.from(this.nodes.values()).map(node => ({
      id: node.id,
      url: node.url,
      status: node.status,
      connections: node.currentConnections,
      maxConnections: node.maxConnections,
      totalRequests: node.totalRequests,
      averageResponseTime: Math.round(node.averageResponseTime * 100) / 100,
      weight: node.weight,
    }))
  }

  getHealthyServers(): ServerNode[] {
    return Array.from(this.nodes.values()).filter(node => node.status === 'healthy')
  }

  getTotalConnections(): number {
    return Array.from(this.nodes.values()).reduce((sum, node) => sum + node.currentConnections, 0)
  }

  getTotalRequests(): number {
    return Array.from(this.nodes.values()).reduce((sum, node) => sum + node.totalRequests, 0)
  }

  getAverageResponseTime(): number {
    const healthyNodes = this.getHealthyServers()
    if (healthyNodes.length === 0) return 0

    const totalTime = healthyNodes.reduce((sum, node) => sum + node.averageResponseTime, 0)
    return totalTime / healthyNodes.length
  }

  // Advanced load balancing strategies

  selectServerWithLatency(latencyThreshold: number): string | null {
    const healthyNodes = Array.from(this.nodes.values()).filter(node =>
      node.status === 'healthy' &&
      node.currentConnections < node.maxConnections &&
      node.averageResponseTime <= latencyThreshold
    )

    if (healthyNodes.length === 0) {
      // Fallback to any healthy server
      return this.selectServer()
    }

    // Select the fastest server within threshold
    const fastest = healthyNodes.reduce((fastest, current) =>
      current.averageResponseTime < fastest.averageResponseTime ? current : fastest
    )

    fastest.currentConnections++
    fastest.totalRequests++

    return fastest.id
  }

  selectServerWithFailover(preferredServerId?: string): string | null {
    // Try preferred server first
    if (preferredServerId) {
      const preferred = this.nodes.get(preferredServerId)
      if (preferred && preferred.status === 'healthy' && preferred.currentConnections < preferred.maxConnections) {
        preferred.currentConnections++
        preferred.totalRequests++
        return preferredServerId
      }
    }

    // Fallback to load balancing
    return this.selectServer()
  }

  getRecommendations(): {
    addMoreServers: boolean
    increaseWeights: string[]
    optimizeResponseTime: boolean
  } {
    const healthyNodes = this.getHealthyServers()
    const totalConnections = this.getTotalConnections()
    const avgResponseTime = this.getAverageResponseTime()
    const maxCapacity = Array.from(this.nodes.values()).reduce((sum, node) => sum + node.maxConnections, 0)

    return {
      addMoreServers: totalConnections > maxCapacity * 0.8,
      increaseWeights: healthyNodes
        .filter(node => node.averageResponseTime < avgResponseTime * 0.8)
        .map(node => node.id),
      optimizeResponseTime: avgResponseTime > 1000, // > 1 second
    }
  }

  reset(): void {
    this.roundRobinIndex = 0
    for (const node of this.nodes.values()) {
      node.currentConnections = 0
      node.totalRequests = 0
      node.averageResponseTime = 0
    }
  }
}