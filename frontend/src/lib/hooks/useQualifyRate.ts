/**
 * useQualifyRate：按建筑物或装置汇总合格率与不合格清单。
 * 被合格判定页（/verdicts）与检测结论导出页（/backup）消费。
 *
 * 判定口径：实测值先按季节系数折算为最不利季节估算值，再与限值比对；
 * 缺检测月份或季节系数的测点为「待判定」，不计入合格也不计入不合格。
 */
import { derived, get, type Readable } from 'svelte/store'
import { buildingList, deviceList } from '$lib/stores/buildingStore'
import { pointList } from '$lib/stores/pointStore'
import { rectifyList, verdictList } from '$lib/stores/rectifyStore'
import { limitRatio, judgeBuckets } from '$lib/utils/resistance'
import { evaluateSeasonPoint, type SeasonJudgeResult } from '$lib/utils/season'
import type { Point } from '$lib/types/point'

/** 评价测点（页面、清单与合格率共用同一口径） */
function resultOf(point: Point): SeasonJudgeResult {
  return evaluateSeasonPoint({
    measuredOhm: point.measuredOhm,
    limitOhm: point.limitOhm,
    measureDate: point.measureDate,
    siteSeasonFactor: point.siteSeasonFactor
  }).result
}

/** 不合格清单中的一行 */
export interface UnqualifiedRow {
  pointId: string
  code: string
  location: string
  buildingId: string
  buildingName: string
  deviceId: string
  deviceType: string
  /** 原始实测值（Ω），报告保留 */
  measuredOhm: number
  /** 最不利季节估算值（Ω） */
  estimatedOhm: number | null
  /** 采用的季节系数 */
  seasonFactor: number | null
  limitOhm: number
  /** 估算 / 限值，> 1 表示超限 */
  ratio: number
  /** 超限幅度（%） */
  exceedPct: number
  inspector: string
  verdictDate: string
  /** 对应整改单状态，无整改单时为 null */
  rectifyState: string | null
}

/** 按建筑物聚合的合格率 */
export interface BuildingQualifyStat {
  buildingId: string
  buildingName: string
  usage: string
  protectionClass: string
  deviceCount: number
  pointCount: number
  passed: number
  failed: number
  /** 待判定（缺月份 / 系数）测点 */
  pending: number
  /** 合格率（0-100，1 位小数，估算口径） */
  rate: number
  /** 未完成复检闭环的整改单数 */
  pendingRectify: number
}

export interface QualifyRateResult {
  /** 全部测点判定的合格率分档统计 */
  overall: Readable<{ total: number; passed: number; failed: number; pending: number; rate: number }>
  /** 按建筑物聚合 */
  byBuilding: Readable<BuildingQualifyStat[]>
  /** 按装置聚合的合格率（deviceId → 分档统计） */
  byDevice: Readable<Record<string, { total: number; passed: number; failed: number; pending: number; rate: number }>>
  /** 不合格清单（按超限幅度降序） */
  unqualified: Readable<UnqualifiedRow[]>
  /** 不合格清单里未闭环的数量 */
  pendingCount: Readable<number>
}

/** 判定某测点的三态结论：优先取判定表结论，缺失时按季节修正估算值现算 */
function resolveResult(point: Point): SeasonJudgeResult {
  const verdict = get(verdictList).find((item) => item.pointId === point.id)
  if (verdict) return verdict.result
  return resultOf(point)
}

/**
 * 组合式函数：基于 store 中的响应式列表派生合格率、不合格清单与整改闭环统计。
 */
export function useQualifyRate(): QualifyRateResult {
  const overall = derived([pointList, verdictList], ([$points]) => judgeBuckets($points.map(resolveResult)))

  const byBuilding = derived(
    [buildingList, deviceList, pointList, verdictList, rectifyList],
    ([$buildings, $devices, $points, $verdicts, $rectifies]) =>
      $buildings.map((building) => {
        const devices = $devices.filter((device) => device.buildingId === building.id)
        const deviceIds = new Set(devices.map((device) => device.id))
        const points = $points.filter((point) => deviceIds.has(point.deviceId))
        const buckets = judgeBuckets(points.map(resolveResult))
        const pendingRectify = $rectifies.filter(
          (rectify) => rectify.buildingId === building.id && rectify.state !== '已复检'
        ).length
        return {
          buildingId: building.id,
          buildingName: building.name,
          usage: building.usage,
          protectionClass: building.protectionClass,
          deviceCount: devices.length,
          pointCount: buckets.total,
          passed: buckets.passed,
          failed: buckets.failed,
          pending: buckets.pending,
          rate: buckets.rate,
          pendingRectify
        }
      })
  )

  const byDevice = derived([pointList, verdictList], ([$points]) => {
    const stats: Record<string, { total: number; passed: number; failed: number; pending: number; rate: number }> = {}
    $points.forEach((point) => {
      const result = resolveResult(point)
      const bucket = stats[point.deviceId] ?? { total: 0, passed: 0, failed: 0, pending: 0, rate: 0 }
      bucket.total += 1
      if (result === '合格') bucket.passed += 1
      else if (result === '不合格') bucket.failed += 1
      else bucket.pending += 1
      bucket.rate = bucket.total === 0 ? 0 : Number(((bucket.passed / bucket.total) * 100).toFixed(1))
      stats[point.deviceId] = bucket
    })
    return stats
  })

  const unqualified = derived(
    [buildingList, deviceList, pointList, verdictList, rectifyList],
    ([$buildings, $devices, $points, $verdicts, $rectifies]) => {
      const rows: UnqualifiedRow[] = []
      $points.forEach((point) => {
        if (resolveResult(point) !== '不合格') return
        const evaluation = evaluateSeasonPoint({
          measuredOhm: point.measuredOhm,
          limitOhm: point.limitOhm,
          measureDate: point.measureDate,
          siteSeasonFactor: point.siteSeasonFactor
        })
        const device = $devices.find((item) => item.id === point.deviceId)
        const building = device ? $buildings.find((item) => item.id === device.buildingId) : undefined
        const verdict = $verdicts.find((item) => item.pointId === point.id)
        const rectify = $rectifies.find((item) => item.pointId === point.id)
        const ratio =
          evaluation.estimatedOhm !== null ? limitRatio(evaluation.estimatedOhm, point.limitOhm) : 0
        rows.push({
          pointId: point.id,
          code: point.code,
          location: point.location,
          buildingId: building?.id ?? '',
          buildingName: building?.name ?? '未知建筑物',
          deviceId: point.deviceId,
          deviceType: device?.type ?? '未知装置',
          measuredOhm: point.measuredOhm,
          estimatedOhm: evaluation.estimatedOhm,
          seasonFactor: evaluation.factor,
          limitOhm: point.limitOhm,
          ratio,
          exceedPct: Number(((ratio - 1) * 100).toFixed(1)),
          inspector: verdict?.inspector ?? '未判定',
          verdictDate: verdict?.verdictDate ?? point.measureDate,
          rectifyState: rectify ? rectify.state : null
        })
      })
      return rows.sort((a, b) => b.ratio - a.ratio)
    }
  )

  const pendingCount = derived(unqualified, ($unqualified) =>
    $unqualified.filter((row) => row.rectifyState === null || row.rectifyState !== '已复检').length
  )

  return { overall, byBuilding, byDevice, unqualified, pendingCount }
}
