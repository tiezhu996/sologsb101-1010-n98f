/**
 * 季节修正：雨季土壤湿润，接地电阻实测值偏小，若直接按当次实测值判合格，
 * 旱季复测就可能超限。因此按测量月份查季节系数 ψ，把实测值折算成最不利季节
 * （旱季）估算值；判定结论与合格率一律以估算值为准，原始实测值只作留存与展示。
 *
 * 系数优先级：现场当次实测了季节系数（如四极法土壤电阻率比对）就以现场为准，
 * 没量才按测量月份查经验表。月份或系数缺失的记录不给合格结论，一律标成「待判定」
 * 并提示补录。
 */
import { round } from './resistance'
import type { VerdictResult } from '$lib/types/verdict'

/**
 * 月份季节系数 ψ（按测量月份查表，1-12 月）。
 * 雨季（6-8 月）土壤最湿润系数最小，旱季（冬季）最干燥系数最大；
 * 为常用经验取值，工程上应以规范规定值或现场实测比对结果为准。
 */
export const SEASON_FACTOR_BY_MONTH: readonly number[] = [
  1.3, // 1 月（旱季）
  1.3, // 2 月
  1.2, // 3 月
  1.2, // 4 月
  1.1, // 5 月（梅雨前）
  1.05, // 6 月（雨季）
  1.0, // 7 月（最湿润，基准月）
  1.05, // 8 月（雨季）
  1.15, // 9 月
  1.25, // 10 月
  1.3, // 11 月（旱季）
  1.35 // 12 月（最干）
]

/** 季节系数来源：现场实测优先于月份查表 */
export type SeasonFactorSource = '现场实测量' | '月份查表'

/** 测点季节修正评估结果，供录入页、判定页与结论导出共用同一套口径 */
export interface PointAssessment {
  /** 参与折算的季节系数 ψ；月份 / 系数缺失时为 null */
  seasonFactor: number | null
  /** 系数来源；缺失时为 null */
  factorSource: SeasonFactorSource | null
  /** 测量月份（1-12）；检测日期缺失或非法时为 null */
  month: number | null
  /** 最不利季节估算电阻（Ω）= 实测 × ψ；系数缺失时为 null */
  estimatedOhm: number | null
  /** 判定结果：以估算值与限值比对，缺月份 / 系数一律待判定 */
  result: VerdictResult
  /** 待判定提示（缺月份 / 缺系数 / 限值非法等），可直接展示给检测人 */
  pendingReason: string | null
}

/** 从检测日期（YYYY-MM-DD）解析测量月份 1-12；缺失或非法返回 null */
export function monthOfMeasureDate(measureDate: string | null | undefined): number | null {
  if (!measureDate || typeof measureDate !== 'string') return null
  const match = /^\s*(\d{4})-(\d{1,2})(?:-\d{1,2})?/.exec(measureDate.trim())
  if (!match) return null
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? month : null
}

/** 按月份查季节系数；月份缺失返回 null（表示月份表缺该月，需补录） */
export function monthSeasonFactor(month: number | null): number | null {
  if (month === null || month < 1 || month > 12) return null
  return SEASON_FACTOR_BY_MONTH[month - 1]
}

/** 季节系数合法性：必须为大于 0 的有限数 */
export function isValidSeasonFactor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 解析某测点应使用的季节系数。
 * 现场实测系数（point.seasonFactor）优先；未量时才按测量月份查月份表。
 * 月份或系数缺失时 factor 为 null，并给出待判定提示。
 */
export function resolveSeasonFactor(input: {
  measureDate?: string | null
  seasonFactor?: number | null
}): { factor: number | null; source: SeasonFactorSource | null; month: number | null; pendingReason: string | null } {
  const month = monthOfMeasureDate(input.measureDate)

  // 现场当次量了季节系数，就以现场为准（无论月份表取值）
  if (isValidSeasonFactor(input.seasonFactor)) {
    return { factor: round(input.seasonFactor, 3), source: '现场实测量', month, pendingReason: null }
  }

  const rawDate = typeof input.measureDate === 'string' ? input.measureDate.trim() : ''
  if (rawDate.length === 0) {
    return { factor: null, source: null, month, pendingReason: '检测月份缺失：请补录检测日期（或现场实测季节系数）后再出判定' }
  }
  if (month === null) {
    return { factor: null, source: null, month, pendingReason: '检测日期无法识别测量月份：请按 YYYY-MM-DD 补录检测日期后再出判定' }
  }
  const factor = monthSeasonFactor(month)
  if (factor === null) {
    return { factor: null, source: null, month, pendingReason: `${month} 月季节系数表缺失：请补录月份系数或现场实测季节系数` }
  }
  return { factor, source: '月份查表', month, pendingReason: null }
}

/**
 * 评估单个测点：解析季节系数 → 折算最不利季节估算值 → 与限值比对。
 * 实测 / 限值非法或缺月份 / 系数时，结果一律为「待判定」并附带补录提示。
 */
export function assessPoint(point: {
  measuredOhm: number
  limitOhm: number
  measureDate?: string | null
  seasonFactor?: number | null
}): PointAssessment {
  const { factor, source, month, pendingReason } = resolveSeasonFactor({
    measureDate: point.measureDate ?? '',
    seasonFactor: point.seasonFactor ?? null
  })

  if (pendingReason) {
    return { seasonFactor: factor, factorSource: source, month, estimatedOhm: null, result: '待判定', pendingReason }
  }
  if (!Number.isFinite(point.measuredOhm) || point.measuredOhm < 0 || !Number.isFinite(point.limitOhm) || point.limitOhm <= 0) {
    return {
      seasonFactor: factor,
      factorSource: source,
      month,
      estimatedOhm: null,
      result: '待判定',
      pendingReason: '实测电阻或限值缺失 / 非法：请补录实测值与限值后再出判定'
    }
  }

  const estimatedOhm = round(point.measuredOhm * (factor as number), 3)
  return {
    seasonFactor: factor,
    factorSource: source,
    month,
    estimatedOhm,
    result: estimatedOhm <= point.limitOhm ? '合格' : '不合格',
    pendingReason: null
  }
}

/** 系数来源与取值的可读说明，如「现场实测系数 ψ=1.5」「6 月查表系数 ψ=1.05」 */
export function factorLabel(assessment: PointAssessment): string {
  if (assessment.seasonFactor === null) return '季节系数缺失'
  const source = assessment.factorSource === '现场实测量' ? '现场实测系数' : `${assessment.month ?? '?'} 月查表系数`
  return `${source} ψ=${assessment.seasonFactor}`
}

/** 判定结果分档统计（合格 / 不合格 / 待判定；合格率 = 合格数 / 全部测点数） */
export interface JudgeBucket {
  total: number
  passed: number
  failed: number
  pending: number
  /** 合格率（0-100，保留 1 位；待判定不计入合格数） */
  rate: number
}

/** 汇总逐点判定结果 */
export function judgeBuckets(results: VerdictResult[]): JudgeBucket {
  const total = results.length
  const passed = results.filter((result) => result === '合格').length
  const failed = results.filter((result) => result === '不合格').length
  const pending = total - passed - failed
  const rate = total === 0 ? 0 : Number(((passed / total) * 100).toFixed(1))
  return { total, passed, failed, pending, rate }
}
