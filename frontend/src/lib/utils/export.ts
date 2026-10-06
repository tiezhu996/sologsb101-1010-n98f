/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致；JSON 中不含任何非数据内容。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '$lib/utils/db'
import { assessPoint } from '$lib/utils/season'

/** 备份集合键名 */
export const BACKUP_KEYS = ['buildings', 'devices', 'points', 'verdicts', 'rectifies'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [buildings, devices, points, verdicts, rectifies] = await Promise.all([
    db.buildings.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.verdicts.toArray(),
    db.rectifies.toArray()
  ])
  return {
    app: 'gblightprot',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    buildings,
    devices,
    points,
    verdicts,
    rectifies
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gblightprot') {
    errors.push('app 字段应为 gblightprot，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gblightprot',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    buildings: obj.buildings ?? [],
    devices: obj.devices ?? [],
    points: obj.points ?? [],
    verdicts: obj.verdicts ?? [],
    rectifies: obj.rectifies ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    buildings: payload.buildings.length,
    devices: payload.devices.length,
    points: payload.points.length,
    verdicts: payload.verdicts.length,
    rectifies: payload.rectifies.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction('rw', [db.buildings, db.devices, db.points, db.verdicts, db.rectifies], async () => {
    await db.buildings.bulkPut(payload.buildings)
    await db.devices.bulkPut(payload.devices)
    await db.points.bulkPut(payload.points)
    await db.verdicts.bulkPut(payload.verdicts)
    await db.rectifies.bulkPut(payload.rectifies)
  })
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const buildingMap = new Map<string, string>()
  const deviceMap = new Map<string, string>()
  const pointMap = new Map<string, string>()

  const buildings = payload.buildings.map((building) => {
    const id = createId('bld')
    buildingMap.set(building.id, id)
    return { ...building, id }
  })
  const devices = payload.devices.map((device) => {
    const id = createId('dev')
    deviceMap.set(device.id, id)
    return { ...device, id, buildingId: buildingMap.get(device.buildingId) ?? device.buildingId }
  })
  const points = payload.points.map((point) => {
    const id = createId('pnt')
    pointMap.set(point.id, id)
    return { ...point, id, deviceId: deviceMap.get(point.deviceId) ?? point.deviceId }
  })
  const verdicts = payload.verdicts.map((verdict) => ({
    ...verdict,
    id: createId('vrd'),
    pointId: pointMap.get(verdict.pointId) ?? verdict.pointId
  }))
  const rectifies = payload.rectifies.map((rectify) => ({
    ...rectify,
    id: createId('rct'),
    buildingId: buildingMap.get(rectify.buildingId) ?? rectify.buildingId,
    pointId: rectify.pointId ? pointMap.get(rectify.pointId) ?? rectify.pointId : null
  }))
  return { ...payload, buildings, devices, points, verdicts, rectifies }
}

/** 检测结论行：按建筑物汇总测点数、待判定 / 不合格数与结论文字 */
export interface ConclusionLine {
  buildingId: string
  buildingName: string
  usage: string
  protectionClass: string
  deviceCount: number
  pointCount: number
  /** 季节修正估算后不合格数 */
  unqualifiedCount: number
  /** 缺检测月份 / 季节系数而无法判定的点数 */
  pendingCount: number
  qualifyRatePct: number
  /** 最不利点（估算 / 限值比最大的已判定测点）摘要 */
  worstPoint: string
  conclusion: string
  advice: string
}

/**
 * 生成按建筑物的检测结论与整改建议汇总。
 * 合格 / 不合格 / 合格率均以最不利季节估算值为准；原始实测值只进 worstPoint / 报告明细留存。
 */
export function buildConclusionLines(payload: BackupPayload): ConclusionLine[] {
  const deviceById = new Map(payload.devices.map((device) => [device.id, device]))
  const verdictByPoint = new Map(payload.verdicts.map((verdict) => [verdict.pointId, verdict]))

  return payload.buildings.map((building) => {
    const devices = payload.devices.filter((device) => device.buildingId === building.id)
    const deviceIds = new Set(devices.map((device) => device.id))
    const points = payload.points.filter((point) => deviceIds.has(point.deviceId))

    // 逐点确定生效结果：优先检测人确认 / 已写入的判定，缺失时按季节修正现算
    const assessed = points.map((point) => {
      const assessment = assessPoint(point)
      const verdict = verdictByPoint.get(point.id)
      const result = verdict && verdict.result !== '待判定' ? verdict.result : assessment.result
      const estimatedOhm = verdict?.estimatedOhm ?? assessment.estimatedOhm
      const seasonFactor = verdict?.seasonFactor ?? assessment.seasonFactor
      return { point, assessment, verdict, result, estimatedOhm, seasonFactor }
    })

    const unqualified = assessed.filter((item) => item.result === '不合格')
    const pending = assessed.filter((item) => item.result === '待判定')
    const passed = assessed.filter((item) => item.result === '合格').length

    let worstRatio = 0
    let worstPoint = '无测点数据'
    assessed
      .filter((item) => item.estimatedOhm !== null)
      .forEach((item) => {
        const ratio = item.point.limitOhm > 0 ? (item.estimatedOhm as number) / item.point.limitOhm : 0
        if (ratio > worstRatio) {
          worstRatio = ratio
          const device = deviceById.get(item.point.deviceId)
          worstPoint =
            `${item.point.code}（${device?.type ?? '装置'}）原始实测 ${item.point.measuredOhm} Ω × ψ=${item.seasonFactor ?? '?'} → ` +
            `最不利估算 ${item.estimatedOhm} Ω / 限值 ${item.point.limitOhm} Ω`
        }
      })

    const qualifyRatePct =
      assessed.length === 0 ? 0 : Number(((passed / assessed.length) * 100).toFixed(1))
    const rectifies = payload.rectifies.filter((rectify) => rectify.buildingId === building.id)
    const pendingRectify = rectifies.filter((rectify) => rectify.state !== '已复检').length
    const conclusion =
      points.length === 0
        ? '未录入测点，无法出具结论'
        : pending.length > 0
          ? `所检 ${points.length} 个测点中 ${pending.length} 个缺检测月份 / 季节系数，暂判待判定、需补录后复审；已判 ${passed} 合格 / ${unqualified.length} 不合格（按最不利季节估算值）`
          : unqualified.length === 0
            ? `所检 ${points.length} 个测点经季节修正折算最不利季节值后均不大于限值，判定合格（原始实测值见测点明细）`
            : `所检 ${points.length} 个测点经季节修正后 ${unqualified.length} 个估算值超限，判定不合格（雨季原始实测值见测点明细）`
    const advice =
      pending.length > 0
        ? `请先补录 ${pending.length} 个待判定测点的检测月份或现场季节系数${
            rectifies.length > 0 ? `；另有 ${pendingRectify} 条整改未完成复检闭环` : ''
          }`
        : rectifies.length === 0
          ? '无需整改，建议旱季按周期复测'
          : `已生成 ${rectifies.length} 条整改建议，其中 ${pendingRectify} 条未完成复检闭环`
    return {
      buildingId: building.id,
      buildingName: building.name,
      usage: building.usage,
      protectionClass: building.protectionClass,
      deviceCount: devices.length,
      pointCount: points.length,
      unqualifiedCount: unqualified.length,
      pendingCount: pending.length,
      qualifyRatePct,
      worstPoint,
      conclusion,
      advice
    }
  })
}
