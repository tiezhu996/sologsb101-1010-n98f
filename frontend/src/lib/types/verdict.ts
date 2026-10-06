/** 判定结论 */
export type VerdictResult = '合格' | '不合格' | '待判定'

export const VERDICT_RESULTS: VerdictResult[] = ['合格', '不合格', '待判定']

/** 判定依据 */
export interface Verdict {
  id: string
  /** 被判定的测点 */
  pointId: string
  /** 判定结论 */
  result: VerdictResult
  /** 判定依据（规范条款 / 限值来源 / 季节修正口径） */
  basis: string
  /** 检测人 */
  inspector: string
  /** 判定日期 */
  verdictDate: string
  /** 是否已由检测人确认生效 */
  confirmed: boolean
  /** 出具该判定时使用的最不利季节估算电阻（Ω）；待判定时为 null */
  estimatedOhm: number | null
  /** 出具该判定时使用的季节系数 ψ；月份 / 系数缺失时为 null */
  seasonFactor: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 自动初判：以最不利季节估算值与限值比对。
 * 估算值或限值非法（月份 / 系数缺失导致估算值为 null）时判「待判定」。
 */
export function judgePoint(estimatedOhm: number | null, limitOhm: number): VerdictResult {
  if (estimatedOhm === null || !Number.isFinite(estimatedOhm) || !Number.isFinite(limitOhm) || limitOhm <= 0) {
    return '待判定'
  }
  return estimatedOhm <= limitOhm ? '合格' : '不合格'
}

/**
 * 判定依据模板：按防雷类别与装置类型给出常用条款说明，并注明季节修正口径。
 * correction 非空时追补「实测 × ψ → 估算值」一行，报告可同时留存原始实测值。
 */
export function defaultBasis(
  protectionClass: string,
  deviceType: string,
  limitOhm: number,
  correction?: { factor: number | null; source: string | null; month: number | null } | null
): string {
  const clause =
    protectionClass === '一类'
      ? 'GB 50057-2010 第 4.3 节'
      : protectionClass === '二类'
        ? 'GB 50057-2010 第 4.4 节'
        : 'GB 50057-2010 第 4.5 节'
  const base = `${clause}：${protectionClass}防雷建筑物${deviceType}接地电阻不大于 ${limitOhm} Ω`
  if (!correction) return base
  if (correction.factor === null) return base
  const source =
    correction.source === '现场实测量'
      ? '现场当次实测季节系数'
      : `${correction.month ?? '?'} 月季节系数表`
  return `${base}；按${source} ψ=${correction.factor} 将实测值折算为最不利季节估算值后判定`
}
