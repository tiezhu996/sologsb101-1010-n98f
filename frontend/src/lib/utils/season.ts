/**
 * 季节修正：接地电阻随土壤湿度季节变化，雨季（土壤湿润）实测值偏小，
 * 直接按实测值判定会出现「雨季合格、旱季复测超限」。因此须把实测值乘以
 * 季节系数，折算为最不利季节（旱季）估算值，再与限值比对。
 *
 * 系数取值优先级（现场优先）：
 *   1. 现场实测了当次季节系数（siteSeasonFactor）——以现场为准；
 *   2. 未现场测定——按检测月份查《月份季节系数参考表》；
 *   3. 月份也缺失——不给结论，测点标记为「待判定」，提示补录。
 *
 * 参考表为温带季风气候常见土壤（黏土 / 壤土）的经验值，仅在现场未测定时兜底；
 * 各地土壤与气象差异较大，正式报告应以现场实测系数或当地规范取值为准。
 */

/** 季节系数来源 */
export type SeasonFactorSource = '现场实测' | '月份表'

/** 三态判定结论（与 types/verdict 的 VerdictResult 同构，避免 utils → types 反向依赖） */
export type SeasonJudgeResult = '合格' | '不合格' | '待判定'

/**
 * 月份 → 季节系数参考表（1-12 月）。
 * 含义：该月实测接地电阻折算到最不利季节所需乘的系数，雨季大、旱季接近 1。
 */
export const MONTH_SEASON_FACTORS: Record<number, number> = {
  1: 1.0, // 隆冬土壤干燥，接近最不利季节
  2: 1.0,
  3: 1.1, // 开春返浆，湿度上升
  4: 1.2,
  5: 1.25,
  6: 1.3, // 梅雨季土壤湿润，实测值明显偏小
  7: 1.35,
  8: 1.3,
  9: 1.2,
  10: 1.1,
  11: 1.0, // 秋冬季回落，接近旱季
  12: 1.0
}

/** 季节系数解析结果（不含合格判定） */
export interface SeasonResolution {
  /** 检测月份（1-12），无法解析时为 null */
  month: number | null
  /** 实际采用的季节系数；缺失时为 null */
  factor: number | null
  /** 系数来源；待判定时为 null */
  factorSource: SeasonFactorSource | null
  /** 实测值 × 系数得到的最不利季节估算值（Ω）；无法折算时为 null */
  estimatedOhm: number | null
  /** 无法判定的原因；可判定时为 null */
  missingReason: string | null
  /** 一句话说明，写入判定依据与报告备注 */
  note: string
}

/** 测点季节评价：解析结果 + 以估算值与限值比对后的三态结论 */
export interface PointSeasonEvaluation extends SeasonResolution {
  result: SeasonJudgeResult
}

/** 季节系数是否有效（要求正数；实测系数一般 ≥ 1，此处不做上限约束） */
export function isValidSeasonFactor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 保留小数位（与 resistance.round 同口径，独立实现避免循环引用） */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 从 YYYY-MM-DD 检测日期中取月份（1-12），空值 / 非法值返回 null */
export function monthFromMeasureDate(measureDate: string | null | undefined): number | null {
  if (!measureDate || typeof measureDate !== 'string') return null
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(measureDate.trim())
  if (!match) return null
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? month : null
}

/** 按月份查季节系数参考表，查不到返回 null */
export function seasonFactorByMonth(month: number | null): number | null {
  if (month === null) return null
  const factor = MONTH_SEASON_FACTORS[month]
  return isValidSeasonFactor(factor) ? factor : null
}

/**
 * 解析测点的季节系数：现场实测优先，否则回退月份表，两者都缺则待判定。
 */
export function resolveSeason(input: {
  measuredOhm: number
  measureDate?: string | null
  /** 现场量取的当次季节系数；留空 / null 表示未现场测定 */
  siteSeasonFactor?: number | null
}): SeasonResolution {
  const month = monthFromMeasureDate(input.measureDate)

  if (isValidSeasonFactor(input.siteSeasonFactor)) {
    const factor = input.siteSeasonFactor
    const estimatedOhm = round3(input.measuredOhm * factor)
    return {
      month,
      factor,
      factorSource: '现场实测',
      estimatedOhm,
      missingReason: null,
      note: `季节修正：现场实测当次系数 ${factor.toFixed(2)}${
        month !== null ? `（${month} 月）` : ''
      }，原始实测 ${input.measuredOhm} Ω × ${factor.toFixed(2)} ＝ 最不利季节估算值 ${estimatedOhm} Ω`
    }
  }

  const tableFactor = seasonFactorByMonth(month)
  if (tableFactor !== null) {
    const estimatedOhm = round3(input.measuredOhm * tableFactor)
    return {
      month,
      factor: tableFactor,
      factorSource: '月份表',
      estimatedOhm,
      missingReason: null,
      note: `季节修正：按 ${month} 月月份表取系数 ${tableFactor.toFixed(2)}，原始实测 ${input.measuredOhm} Ω × ${tableFactor.toFixed(
        2
      )} ＝ 最不利季节估算值 ${estimatedOhm} Ω`
    }
  }

  return {
    month,
    factor: null,
    factorSource: null,
    estimatedOhm: null,
    missingReason: month === null ? '检测月份缺失' : `${month} 月季节系数缺失`,
    note:
      month === null
        ? '检测月份缺失，且未现场测定当次季节系数，无法折算最不利季节值，测点待判定，请补录检测日期或现场系数'
        : `${month} 月季节系数缺失，且未现场测定当次季节系数，无法折算最不利季节值，测点待判定，请补录`
  }
}

/**
 * 评价单个测点：解析季节系数 → 折算最不利季节估算值 → 与限值比对。
 * 判定与合格率一律以估算值为准；系数 / 月份缺失时结论为「待判定」。
 */
export function evaluateSeasonPoint(input: {
  measuredOhm: number
  limitOhm: number
  measureDate?: string | null
  siteSeasonFactor?: number | null
}): PointSeasonEvaluation {
  const resolution = resolveSeason(input)
  if (resolution.estimatedOhm === null || !Number.isFinite(input.limitOhm) || input.limitOhm <= 0) {
    return { ...resolution, result: '待判定' }
  }
  return { ...resolution, result: resolution.estimatedOhm <= input.limitOhm ? '合格' : '不合格' }
}

/** 报告 / 整改单用的折算摘要：「原始实测 X Ω × 1.30（7 月月份表）＝ 估算 Y Ω」 */
export function correctionText(evaluation: SeasonResolution): string {
  if (evaluation.estimatedOhm === null || evaluation.factor === null) return evaluation.note
  const source =
    evaluation.factorSource === '现场实测'
      ? '现场实测系数'
      : evaluation.month !== null
        ? `${evaluation.month} 月月份表系数`
        : '月份表系数'
  return `原始实测 × ${evaluation.factor.toFixed(2)}（${source}）＝ 最不利季节估算 ${evaluation.estimatedOhm} Ω`
}
