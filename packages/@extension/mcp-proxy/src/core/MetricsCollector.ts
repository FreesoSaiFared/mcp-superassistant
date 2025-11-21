import { EventEmitter } from 'events'
import { Logger } from '../utils/logger.js'

interface RequestMetrics {
  serverId: string
  method: string
  responseTime: number
  success: boolean
  timestamp: Date
  requestId: string
}

interface ServerMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageResponseTime: number
  requestsPerSecond: number
  lastRequestTime: Date
  errorRate: number
}

interface SystemMetrics {
  timestamp: Date
  memoryUsage: NodeJS.MemoryUsage
  cpuUsage: NodeJS.CpuUsage
  uptime: number
  activeConnections: number
}

export class MetricsCollector extends EventEmitter {
  private requestMetrics: RequestMetrics[] = []
  private serverMetrics: Map<string, ServerMetrics> = new Map()
  private systemMetrics: SystemMetrics[] = []
  private logger: Logger
  private collectionInterval?: NodeJS.Timeout
  private isActive = false

  constructor(monitoringConfig: any, logger?: Logger) {
    super()
    this.logger = logger || new Logger({ level: 'info', structured: true, includeTimestamps: true })
  }

  start(intervalMs: number = 60000): void {
    if (this.isActive) return

    this.isActive = true
    this.collectionInterval = setInterval(() => {
      this.collectSystemMetrics()
    }, intervalMs)

    this.logger.info('Metrics collector started', { interval: intervalMs })
  }

  stop(): void {
    if (!this.isActive) return

    this.isActive = false
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval)
      this.collectionInterval = undefined
    }

    this.logger.info('Metrics collector stopped')
  }

  recordRequest(serverId: string, method: string, responseTime: number, success: boolean, requestId?: string): void {
    const metric: RequestMetrics = {
      serverId,
      method,
      responseTime,
      success,
      timestamp: new Date(),
      requestId: requestId || this.generateRequestId(),
    }

    this.requestMetrics.push(metric)

    // Keep only last 10000 metrics to prevent memory leaks
    if (this.requestMetrics.length > 10000) {
      this.requestMetrics = this.requestMetrics.slice(-10000)
    }

    // Update server-specific metrics
    this.updateServerMetrics(serverId, responseTime, success)

    // Emit event for real-time monitoring
    this.emit('request_recorded', metric)

    // Log performance issues
    if (responseTime > 5000) {
      this.logger.warn('Slow request detected', {
        serverId,
        method,
        responseTime,
        requestId: metric.requestId,
      })
    }

    if (!success) {
      this.logger.error('Request failed', {
        serverId,
        method,
        responseTime,
        requestId: metric.requestId,
      })
    }
  }

  private updateServerMetrics(serverId: string, responseTime: number, success: boolean): void {
    const existing = this.serverMetrics.get(serverId) || {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      requestsPerSecond: 0,
      lastRequestTime: new Date(),
      errorRate: 0,
    }

    // Update counters
    existing.totalRequests++
    if (success) {
      existing.successfulRequests++
    } else {
      existing.failedRequests++
    }

    // Update average response time using exponential moving average
    const alpha = 0.1 // Smoothing factor
    existing.averageResponseTime =
      alpha * responseTime + (1 - alpha) * existing.averageResponseTime

    // Update error rate
    existing.errorRate = existing.failedRequests / existing.totalRequests

    // Calculate requests per second (last minute)
    const oneMinuteAgo = new Date(Date.now() - 60000)
    const recentRequests = this.requestMetrics.filter(m =>
      m.serverId === serverId && m.timestamp >= oneMinuteAgo
    )
    existing.requestsPerSecond = recentRequests.length / 60

    existing.lastRequestTime = new Date()

    this.serverMetrics.set(serverId, existing)
  }

  private collectSystemMetrics(): void {
    try {
      const metrics: SystemMetrics = {
        timestamp: new Date(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
        activeConnections: this.getActiveConnectionCount(),
      }

      this.systemMetrics.push(metrics)

      // Keep only last 1000 system metrics
      if (this.systemMetrics.length > 1000) {
        this.systemMetrics = this.systemMetrics.slice(-1000)
      }

      this.emit('system_metrics', metrics)

      // Check for performance warnings
      if (metrics.memoryUsage.heapUsed > 1024 * 1024 * 1024) { // > 1GB
        this.logger.warn('High memory usage detected', {
          heapUsed: Math.round(metrics.memoryUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(metrics.memoryUsage.heapTotal / 1024 / 1024),
        })
      }

    } catch (error) {
      this.logger.error('Failed to collect system metrics', { error: (error as Error).message })
    }
  }

  private getActiveConnectionCount(): number {
    // This would be implemented based on your connection tracking
    // For now, return a placeholder
    return 0
  }

  getServerMetrics(serverId: string): ServerMetrics | undefined {
    return this.serverMetrics.get(serverId)
  }

  getAllServerMetrics(): Map<string, ServerMetrics> {
    return new Map(this.serverMetrics)
  }

  getAggregatedMetrics(): {
    totalRequests: number
    totalErrors: number
    averageResponseTime: number
    requestsPerSecond: number
    errorRate: number
    uptime: number
    memoryUsage: NodeJS.MemoryUsage
    activeServers: number
  } {
    const totalRequests = this.requestMetrics.length
    const totalErrors = this.requestMetrics.filter(m => !m.success).length
    const averageResponseTime = this.requestMetrics.length > 0
      ? this.requestMetrics.reduce((sum, m) => sum + m.responseTime, 0) / this.requestMetrics.length
      : 0

    const oneMinuteAgo = new Date(Date.now() - 60000)
    const recentRequests = this.requestMetrics.filter(m => m.timestamp >= oneMinuteAgo)
    const requestsPerSecond = recentRequests.length / 60

    const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0

    const latestSystemMetrics = this.systemMetrics[this.systemMetrics.length - 1]
    const memoryUsage = latestSystemMetrics?.memoryUsage || process.memoryUsage()
    const uptime = latestSystemMetrics?.uptime || process.uptime()

    return {
      totalRequests,
      totalErrors,
      averageResponseTime: Math.round(averageResponseTime * 100) / 100,
      requestsPerSecond: Math.round(requestsPerSecond * 100) / 100,
      errorRate: Math.round(errorRate * 10000) / 10000, // As percentage
      uptime: Math.round(uptime),
      memoryUsage,
      activeServers: this.serverMetrics.size,
    }
  }

  getPerformanceReport(timeRangeMs: number = 3600000): {
    timeRange: { start: Date; end: Date }
    requestMetrics: {
      total: number
      successful: number
      failed: number
      averageResponseTime: number
      requestsPerSecond: number
    }
    serverBreakdown: Array<{
      serverId: string
      requests: number
      averageResponseTime: number
      errorRate: number
    }>
    systemMetrics: {
      peakMemoryUsage: number
      currentMemoryUsage: number
      uptime: number
    }
    recommendations: string[]
  } {
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - timeRangeMs)

    const timeRangeRequests = this.requestMetrics.filter(
      m => m.timestamp >= startTime && m.timestamp <= endTime
    )

    const total = timeRangeRequests.length
    const successful = timeRangeRequests.filter(m => m.success).length
    const failed = total - successful

    const averageResponseTime = total > 0
      ? timeRangeRequests.reduce((sum, m) => sum + m.responseTime, 0) / total
      : 0

    const requestsPerSecond = total / (timeRangeMs / 1000)

    // Server breakdown
    const serverBreakdown = new Map<string, { requests: number; totalTime: number; errors: number }>()
    timeRangeRequests.forEach(m => {
      const existing = serverBreakdown.get(m.serverId) || { requests: 0, totalTime: 0, errors: 0 }
      existing.requests++
      existing.totalTime += m.responseTime
      if (!m.success) existing.errors++
      serverBreakdown.set(m.serverId, existing)
    })

    const serverReport = Array.from(serverBreakdown.entries()).map(([serverId, stats]) => ({
      serverId,
      requests: stats.requests,
      averageResponseTime: stats.totalTime / stats.requests,
      errorRate: stats.errors / stats.requests,
    }))

    // System metrics
    const timeRangeSystemMetrics = this.systemMetrics.filter(
      m => m.timestamp >= startTime && m.timestamp <= endTime
    )

    const peakMemoryUsage = timeRangeSystemMetrics.length > 0
      ? Math.max(...timeRangeSystemMetrics.map(m => m.memoryUsage.heapUsed))
      : 0

    const currentMemoryUsage = process.memoryUsage().heapUsed

    // Generate recommendations
    const recommendations: string[] = []
    if (averageResponseTime > 2000) {
      recommendations.push('Consider optimizing slow requests (avg > 2s)')
    }
    if (failed / total > 0.05) {
      recommendations.push('High error rate detected (> 5%)')
    }
    if (peakMemoryUsage > 512 * 1024 * 1024) {
      recommendations.push('High memory usage detected (> 512MB)')
    }
    if (requestsPerSecond > 100) {
      recommendations.push('High request rate detected - consider scaling')
    }

    return {
      timeRange: { start: startTime, end: endTime },
      requestMetrics: {
        total,
        successful,
        failed,
        averageResponseTime: Math.round(averageResponseTime * 100) / 100,
        requestsPerSecond: Math.round(requestsPerSecond * 100) / 100,
      },
      serverBreakdown: serverReport,
      systemMetrics: {
        peakMemoryUsage: Math.round(peakMemoryUsage / 1024 / 1024),
        currentMemoryUsage: Math.round(currentMemoryUsage / 1024 / 1024),
        uptime: Math.round(process.uptime()),
      },
      recommendations,
    }
  }

  exportMetrics(format: 'json' | 'csv' = 'json'): string {
    const aggregated = this.getAggregatedMetrics()

    if (format === 'json') {
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        aggregated,
        serverMetrics: Object.fromEntries(this.serverMetrics),
        systemMetrics: this.systemMetrics.slice(-10), // Last 10 entries
      }, null, 2)
    }

    // CSV format
    const headers = ['timestamp', 'totalRequests', 'totalErrors', 'averageResponseTime', 'requestsPerSecond', 'errorRate', 'memoryUsageMB', 'uptime']
    const row = [
      new Date().toISOString(),
      aggregated.totalRequests,
      aggregated.totalErrors,
      aggregated.averageResponseTime,
      aggregated.requestsPerSecond,
      aggregated.errorRate,
      Math.round(aggregated.memoryUsage.heapUsed / 1024 / 1024),
      aggregated.uptime,
    ]

    return [headers.join(','), row.join(',')].join('\n')
  }

  reset(): void {
    this.requestMetrics = []
    this.serverMetrics.clear()
    this.systemMetrics = []
    this.logger.info('Metrics reset')
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}