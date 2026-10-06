/** 判定结论 */
import type { PointSeasonEvaluation } from '$lib/utils/season'
import { evaluateSeasonPoint } from '$lib/utils/season'

export type VerdictResult = '合格' | '不合格' | '待判定'

export const VERDICT_RESULTS: VerdictResult[] = ['合格', '不合格', '待判定']

/** 判定：季节修正后的估算值与限值比对后的结论，检测人确认后生效 */
export interface Verdict {
  id: string
  /** 被判定的测点 */
  pointId: string
  /** 判定结论（以最不利季节估算值为准） */
  result: VerdictResult
  /** 判定依据（规范条款 / 限值来源 / 季节修正说明） */
  basis: string
  /** 检测人 */
  inspector: string
  /** 判定日期 */
  verdictDate: string
  /** 是否已由检测人确认生效 */
  confirmed: boolean
  /** 判定时采用的最不利季节估算值（Ω）；待判定时为 null */
  estimatedOhm: number | null
  /** 判定时采用的季节系数；待判定时为 null */
  seasonFactor: number | null
  /** 季节系数来源：现场实测 / 月份表；待判定时为 null */
  seasonFactorSource: '现场实测' | '月份表' | null
  createdAt: number
  updatedAt: number
}

/**
 * 自动初判：以季节修正后的最不利季节估算值与限值比对。
 * 现场量了系数用现场值，否则按月份查表；月份或系数缺失时给「待判定」。
 */
export function judgePoint(
  measuredOhm: number,
  limitOhm: number,
  measureDate?: string | null,
  siteSeasonFactor?: number | null
): PointSeasonEvaluation {
  return evaluateSeasonPoint({ measuredOhm, limitOhm, measureDate, siteSeasonFactor })
}

/** 判定依据模板：按防雷类别与装置类型给出常用条款说明 */
export function defaultBasis(protectionClass: string, deviceType: string, limitOhm: number): string {
  const clause =
    protectionClass === '一类'
      ? 'GB 50057-2010 第 4.3 节'
      : protectionClass === '二类'
        ? 'GB 50057-2010 第 4.4 节'
        : 'GB 50057-2010 第 4.5 节'
  return `${clause}：${protectionClass}防雷建筑物${deviceType}接地电阻不大于 ${limitOhm} Ω`
}

/**
 * 组装完整判定依据：规范条款 + 季节修正说明。
 * 待判定时返回补录提示，不出具合格 / 不合格结论。
 */
export function buildBasisWithSeason(
  protectionClass: string,
  deviceType: string,
  limitOhm: number,
  evaluation: PointSeasonEvaluation
): string {
  const clause = defaultBasis(protectionClass, deviceType, limitOhm)
  if (evaluation.result === '待判定') {
    return `${clause}；${evaluation.note}`
  }
  return `${clause}；${evaluation.note}；按最不利季节估算值 ${evaluation.estimatedOhm} Ω 与限值 ${limitOhm} Ω 比对，判定${evaluation.result}`
}

/** 判定记录中保存的季节修正快照（供报告另存原始实测值时溯源） */
export function seasonSnapshot(evaluation: PointSeasonEvaluation): Pick<
  Verdict,
  'estimatedOhm' | 'seasonFactor' | 'seasonFactorSource'
> {
  return {
    estimatedOhm: evaluation.estimatedOhm,
    seasonFactor: evaluation.factor,
    seasonFactorSource: evaluation.factorSource
  }
}
