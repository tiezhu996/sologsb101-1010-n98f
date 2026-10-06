/**
 * 接地电阻工具：限值比对、合格率计算、Ω 与 kΩ 单位换算。
 * 页面、store 与数据库播种共用同一套算法，保证展示值与存储判定一致。
 */
import type { ProtectionClass } from '$lib/types/building'
import type { DeviceType } from '$lib/types/device'

/** 保留小数位 */
export function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Ω → kΩ */
export function ohmToKohm(ohm: number): number {
  return round(ohm / 1000, 6)
}

/** kΩ → Ω */
export function kohmToOhm(kohm: number): number {
  return round(kohm * 1000, 3)
}

/** 按量级自动选择可读单位 */
export function formatOhm(ohm: number): string {
  if (!Number.isFinite(ohm)) return '—'
  if (Math.abs(ohm) >= 1000) return `${ohmToKohm(ohm).toFixed(3)} kΩ`
  return `${round(ohm, 2)} Ω`
}

/**
 * 限值比对：返回某电阻值是否不大于限值。
 * 注意：合格判定必须传入季节修正后的「最不利季节估算值」（见 utils/season.ts），
 * 不能直接传雨季原始实测值；本函数只做纯数值比对，不感知季节口径。
 */
export function isQualified(resistanceOhm: number, limitOhm: number): boolean {
  if (!Number.isFinite(resistanceOhm) || !Number.isFinite(limitOhm) || limitOhm <= 0) return false
  return resistanceOhm <= limitOhm
}

/** 合格余量：限值 - 估算值（正数为余量，负数为超限幅度） */
export function marginOhm(estimatedOhm: number, limitOhm: number): number {
  return round(limitOhm - estimatedOhm, 3)
}

/** 超限比例：估算 / 限值（> 1 表示超限） */
export function limitRatio(resistanceOhm: number, limitOhm: number): number {
  if (!Number.isFinite(limitOhm) || limitOhm <= 0) return 0
  return round(resistanceOhm / limitOhm, 3)
}

/** 合格率（0-100，保留 1 位）：传入逐点是否合格的布尔数组 */
export function qualifyRate(flags: boolean[]): number {
  if (flags.length === 0) return 0
  const passed = flags.filter((flag) => flag).length
  return round((passed / flags.length) * 100, 1)
}

/**
 * 按分档统计合格率：布尔口径只区分合格 / 不合格，无法表达「待判定」。
 * 含待判定的季节修正场景请改用 utils/season.ts 的 judgeBuckets（直接收判定结果）。
 */
export function qualifyBuckets(flags: boolean[]): { total: number; passed: number; failed: number; pending: number; rate: number } {
  const total = flags.length
  const passed = flags.filter((flag) => flag).length
  return { total, passed, failed: total - passed, pending: 0, rate: qualifyRate(flags) }
}

/**
 * 建议限值：按防雷类别与装置类型给出初始限值（Ω）。
 * 一类建筑独立接地装置取 10 Ω、共用接地取 4 Ω；仅为录入初值，最终以设计文件为准。
 */
export function suggestLimitOhm(protectionClass: ProtectionClass, deviceType: DeviceType): number {
  if (protectionClass === '一类') return deviceType === '接地体' ? 4 : 10
  if (protectionClass === '二类') return deviceType === '接地体' ? 4 : 10
  return 10
}

/**
 * 季节修正后的最不利季节估算电阻：实测 × 季节系数 ψ。
 * 完整口径（月份查表 / 现场系数优先 / 缺月份或系数转待判定）见 utils/season.ts。
 */
export function seasonCorrected(measuredOhm: number, seasonFactor = 1.2): number {
  return round(measuredOhm * seasonFactor, 3)
}
