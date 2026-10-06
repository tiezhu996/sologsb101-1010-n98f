/**
 * 装置维度的测点统计（跨 store 的派生值），独立为叶子 store 模块。
 *
 * 为什么要单独一个文件：buildingStore 与 pointStore 互相 import 会形成
 * ES 模块循环依赖，浏览器里表现为 `Cannot access 'X' before initialization` 的白屏。
 * 把「同时依赖两个 store 的派生值」下沉到这里，即可让 buildingStore → pointStore
 * 变成单向依赖（buildingStore 不再 import pointStore），彻底断环。
 *
 * 统计口径：合格 / 不合格一律以季节修正后的最不利季节估算值为准；
 * 月份或季节系数缺失的测点为「待判定」，单独计数，不并入不合格。
 */
import { derived } from 'svelte/store'
import { deviceList } from '$lib/stores/buildingStore'
import { pointList } from '$lib/stores/pointStore'
import { evaluateSeasonPoint } from '$lib/utils/season'

/** 某装置的测点统计 */
export interface DevicePointStats {
  count: number
  unqualified: number
  /** 待判定（月份 / 季节系数缺失，需补录）测点数 */
  pending: number
  /** 原始实测极值（Ω） */
  minOhm: number
  maxOhm: number
}

/** 装置 id → 测点数 / 不合格数 / 待判定数 / 原始实测极值 */
export const pointStatsByDevice = derived([pointList, deviceList], ([$points, $devices]) => {
  const stats: Record<string, DevicePointStats> = {}
  $devices.forEach((device) => {
    const list = $points.filter((point) => point.deviceId === device.id)
    const values = list.map((point) => point.measuredOhm)
    let unqualified = 0
    let pending = 0
    list.forEach((point) => {
      const result = evaluateSeasonPoint({
        measuredOhm: point.measuredOhm,
        limitOhm: point.limitOhm,
        measureDate: point.measureDate,
        siteSeasonFactor: point.siteSeasonFactor
      }).result
      if (result === '不合格') unqualified += 1
      else if (result === '待判定') pending += 1
    })
    stats[device.id] = {
      count: list.length,
      unqualified,
      pending,
      minOhm: values.length > 0 ? Math.min(...values) : 0,
      maxOhm: values.length > 0 ? Math.max(...values) : 0
    }
  })
  return stats
})
