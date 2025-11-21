import { HealthCheckResult, ManagedServer } from '../types/index.js'
import { Logger } from '../utils/logger.js'

interface HealthCheckConfig {
  enabled: boolean
  interval: number
  timeout: number
  retries: number
  endpoints?: {
    tools: string
    resources: string
    prompts: string
  }
}

export class HealthChecker {
  private healthStatus: Map<string, HealthCheckResult> = new Map()
  private checkIntervals: Map<string, NodeJS.Timeout> = new Map()
  private logger: Logger
  private config: HealthCheckConfig

  constructor(monitoringConfig: any, logger?: Logger) {
    this.logger = logger || new Logger({ level: 'info', structured: true, includeTimestamps: true })
    this.config = {
      enabled: monitoringConfig?.enabled ?? true,
      interval: 30000, // 30 seconds
      timeout: 5000, // 5 seconds
      retries: 3,
    }
  }

  async checkServer(server: ManagedServer): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const result: HealthCheckResult = {
      serverId: server.id,
      status: 'healthy',
      responseTime: 0,
      timestamp: new Date(),
    }

    try {
      // Basic connectivity check
      if (server.status !== 'connected') {
        result.status = 'unhealthy'
        result.details = { reason: 'Server not connected' }
        return result
      }

      // Perform health checks based on server capabilities
      const checks = await Promise.allSettled([
        this.checkToolsCapability(server),
        this.checkResourcesCapability(server),
        this.checkPromptsCapability(server),
        this.checkResponseLatency(server),
      ])

      // Analyze results
      let degradedCount = 0
      const details: Record<string, any> = {}

      checks.forEach((check, index) => {
        const checkName = ['tools', 'resources', 'prompts', 'latency'][index]

        if (check.status === 'rejected') {
          details[checkName] = { error: check.reason?.message || 'Unknown error' }
          degradedCount++
        } else if (check.status === 'fulfilled') {
          details[checkName] = check.value
          if (check.value.status === 'degraded') {
            degradedCount++
          }
        }
      })

      // Determine overall health
      result.responseTime = Date.now() - startTime
      result.details = details

      if (degradedCount === 0) {
        result.status = 'healthy'
      } else if (degradedCount <= checks.length / 2) {
        result.status = 'degraded'
      } else {
        result.status = 'unhealthy'
      }

      this.healthStatus.set(server.id, result)
      this.logger.debug(`Health check completed for ${server.name}`, {
        serverId: server.id,
        status: result.status,
        responseTime: result.responseTime,
        details,
      })

      return result

    } catch (error) {
      result.status = 'unhealthy'
      result.responseTime = Date.now() - startTime
      result.details = {
        error: (error as Error).message,
        stack: (error as Error).stack,
      }

      this.healthStatus.set(server.id, result)
      this.logger.warn(`Health check failed for ${server.name}`, {
        serverId: server.id,
        error: (error as Error).message,
        responseTime: result.responseTime,
      })

      return result
    }
  }

  private async checkToolsCapability(server: ManagedServer): Promise<{ status: string; count: number }> {
    try {
      const response = await server.client!.request(
        { method: 'tools/list', params: {} },
        { tools: [] } as any
      )

      return {
        status: 'healthy',
        count: response.tools?.length || 0,
      }
    } catch (error) {
      return {
        status: 'degraded',
        count: 0,
        error: (error as Error).message,
      }
    }
  }

  private async checkResourcesCapability(server: ManagedServer): Promise<{ status: string; count: number }> {
    try {
      const response = await server.client!.request(
        { method: 'resources/list', params: {} },
        { resources: [] } as any
      )

      return {
        status: 'healthy',
        count: response.resources?.length || 0,
      }
    } catch (error) {
      // Resources might not be supported, so don't mark as degraded
      return {
        status: 'healthy',
        count: 0,
        unsupported: true,
      }
    }
  }

  private async checkPromptsCapability(server: ManagedServer): Promise<{ status: string; count: number }> {
    try {
      const response = await server.client!.request(
        { method: 'prompts/list', params: {} },
        { prompts: [] } as any
      )

      return {
        status: 'healthy',
        count: response.prompts?.length || 0,
      }
    } catch (error) {
      // Prompts might not be supported, so don't mark as degraded
      return {
        status: 'healthy',
        count: 0,
        unsupported: true,
      }
    }
  }

  private async checkResponseLatency(server: ManagedServer): Promise<{ status: string; latency: number }> {
    const startTime = Date.now()

    try {
      // Simple ping-like request
      await server.client!.request(
        { method: 'ping', params: {} },
        {} as any
      )

      const latency = Date.now() - startTime
      return {
        status: latency > 1000 ? 'degraded' : 'healthy',
        latency,
      }
    } catch (error) {
      // Ping might not be supported, try tools/list as fallback
      try {
        await server.client!.request(
          { method: 'tools/list', params: {} },
          { tools: [] } as any
        )

        const latency = Date.now() - startTime
        return {
          status: latency > 2000 ? 'degraded' : 'healthy',
          latency,
        }
      } catch (fallbackError) {
        return {
          status: 'unhealthy',
          latency: Date.now() - startTime,
          error: (fallbackError as Error).message,
        }
      }
    }
  }

  startPeriodicChecking(server: ManagedServer, interval?: number): void {
    if (!this.config.enabled) return

    // Stop existing checks for this server
    this.stopPeriodicChecking(server.id)

    const checkInterval = setInterval(async () => {
      try {
        const result = await this.checkServer(server)
        this.logger.debug(`Periodic health check for ${server.name}`, {
          serverId: server.id,
          status: result.status,
          responseTime: result.responseTime,
        })
      } catch (error) {
        this.logger.error(`Periodic health check failed for ${server.name}`, {
          serverId: server.id,
          error: (error as Error).message,
        })
      }
    }, interval || this.config.interval)

    this.checkIntervals.set(server.id, checkInterval)
    this.logger.info(`Started periodic health checking for ${server.name}`, {
      serverId: server.id,
      interval: interval || this.config.interval,
    })
  }

  stopPeriodicChecking(serverId: string): void {
    const interval = this.checkIntervals.get(serverId)
    if (interval) {
      clearInterval(interval)
      this.checkIntervals.delete(serverId)
      this.logger.info(`Stopped periodic health checking for server ${serverId}`)
    }
  }

  getHealthStatus(serverId: string): HealthCheckResult | undefined {
    return this.healthStatus.get(serverId)
  }

  getAllHealthStatus(): Map<string, HealthCheckResult> {
    return new Map(this.healthStatus)
  }

  getHealthyServers(): string[] {
    return Array.from(this.healthStatus.entries())
      .filter(([_, result]) => result.status === 'healthy')
      .map(([serverId]) => serverId)
  }

  getUnhealthyServers(): string[] {
    return Array.from(this.healthStatus.entries())
      .filter(([_, result]) => result.status === 'unhealthy')
      .map(([serverId]) => serverId)
  }

  getDegradedServers(): string[] {
    return Array.from(this.healthStatus.entries())
      .filter(([_, result]) => result.status === 'degraded')
      .map(([serverId]) => serverId)
  }

  generateHealthReport(): {
    timestamp: Date
    total: number
    healthy: number
    degraded: number
    unhealthy: number
    averageResponseTime: number
    servers: Array<{
      id: string
      status: string
      responseTime: number
      lastCheck: Date
    }>
  } {
    const results = Array.from(this.healthStatus.values())
    const healthy = results.filter(r => r.status === 'healthy').length
    const degraded = results.filter(r => r.status === 'degraded').length
    const unhealthy = results.filter(r => r.status === 'unhealthy').length

    const averageResponseTime = results.length > 0
      ? results.reduce((sum, r) => sum + r.responseTime, 0) / results.length
      : 0

    return {
      timestamp: new Date(),
      total: results.length,
      healthy,
      degraded,
      unhealthy,
      averageResponseTime: Math.round(averageResponseTime * 100) / 100,
      servers: results.map(result => ({
        id: result.serverId,
        status: result.status,
        responseTime: result.responseTime,
        lastCheck: result.timestamp,
      })),
    }
  }

  cleanup(): void {
    // Stop all periodic checks
    for (const [serverId, interval] of this.checkIntervals) {
      clearInterval(interval)
    }
    this.checkIntervals.clear()
    this.healthStatus.clear()
  }
}