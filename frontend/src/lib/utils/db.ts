/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gblightprot，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（建筑物 → 防雷装置 → 测点 → 判定 → 整改建议）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import { DEVICE_TYPES } from '$lib/types/device'
import type { Point } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { buildBasisWithSeason } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'
import { SUGGESTION_TEMPLATES } from '$lib/types/rectify'
import { suggestLimitOhm } from '$lib/utils/resistance'
import { evaluateSeasonPoint } from '$lib/utils/season'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gblightprot'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gblightprot:db-version',
  lastBackupAt: 'gblightprot:last-backup-at',
  lastBuildingId: 'gblightprot:last-building-id'
} as const

/** 备份文件结构，供 utils/export.ts 与备份页使用 */
export interface BackupPayload {
  app: 'gblightprot'
  dbVersion: number
  exportedAt: string
  buildings: Building[]
  devices: Device[]
  points: Point[]
  verdicts: Verdict[]
  rectifies: Rectify[]
}

export class LightProtDatabase extends Dexie {
  buildings!: Table<Building, string>
  devices!: Table<Device, string>
  points!: Table<Point, string>
  verdicts!: Table<Verdict, string>
  rectifies!: Table<Rectify, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      buildings: 'id, name, usage, protectionClass',
      devices: 'id, buildingId, type, material',
      points: 'id, deviceId, code, measuredOhm',
      verdicts: 'id, pointId, result',
      rectifies: 'id, buildingId, state'
    })

    // v2：补齐筛选与统计需要的索引（用途/类别/层数、装置类型、限值、判定与状态）
    this.version(2)
      .stores({
        buildings: 'id, name, usage, protectionClass, floors, heightM, updatedAt',
        devices: 'id, buildingId, type, material, spec, quantity, installDate, updatedAt',
        points: 'id, deviceId, code, measuredOhm, limitOhm, measureDate, updatedAt',
        verdicts: 'id, pointId, result, confirmed, verdictDate, updatedAt',
        rectifies: 'id, buildingId, pointId, state, deadline, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定确认标记，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['buildings', () => ({ floors: 1, heightM: 4 })],
          ['devices', () => ({ quantity: 1, installDate: new Date().toISOString().slice(0, 10) })],
          ['points', () => ({ limitOhm: 10, meter: '', measureDate: new Date().toISOString().slice(0, 10) })],
          ['verdicts', () => ({ result: '待判定', confirmed: false, inspector: '', basis: '' })],
          ['rectifies', () => ({ state: '待整改', owner: '', pointId: null })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：接地电阻测点增加季节修正——现场季节系数字段；判定改按最不利季节估算值
    this.version(DB_VERSION)
      .stores({
        buildings: 'id, name, usage, protectionClass, floors, heightM, updatedAt',
        devices: 'id, buildingId, type, material, spec, quantity, installDate, updatedAt',
        points: 'id, deviceId, code, measuredOhm, limitOhm, measureDate, updatedAt',
        verdicts: 'id, pointId, result, confirmed, verdictDate, updatedAt',
        rectifies: 'id, buildingId, pointId, state, deadline, updatedAt'
      })
      .upgrade(async (tx) => {
        // 历史测点补「现场季节系数」字段：缺省 null，表示未现场测定、回退月份表
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (!('siteSeasonFactor' in point)) point.siteSeasonFactor = null
          })

        // 历史判定全部按季节修正重算：结论、估算值与系数来源一次性回填，
        // 保留既有检测人 / 时间戳 / 确认状态，并在依据后补季节修正说明。
        // 注意：Dexie 的 modify 回调内不能再嵌套写其他表，因此先算好再逐条更新。
        const devices = (await tx.table('devices').toArray()) as Array<{
          id: string
          buildingId: string
          type?: string
        }>
        const buildings = (await tx.table('buildings').toArray()) as Array<{
          id: string
          protectionClass?: string
        }>
        const points = (await tx.table('points').toArray()) as Array<Record<string, unknown>>
        const buildingOfDevice = new Map(devices.map((device) => [device.id, device.buildingId]))
        const buildingById = new Map(buildings.map((building) => [building.id, building]))
        const deviceById = new Map(devices.map((device) => [device.id, device]))

        for (const point of points) {
          const deviceId = String(point.deviceId ?? '')
          const device = deviceById.get(deviceId)
          const building = buildingById.get(buildingOfDevice.get(deviceId) ?? '')
          const evaluation = evaluateSeasonPoint({
            measuredOhm: Number(point.measuredOhm),
            limitOhm: Number(point.limitOhm),
            measureDate: typeof point.measureDate === 'string' ? point.measureDate : '',
            siteSeasonFactor: typeof point.siteSeasonFactor === 'number' ? (point.siteSeasonFactor as number) : null
          })
          const protectionClass = building?.protectionClass ?? '三类'
          const clause =
            protectionClass === '一类'
              ? 'GB 50057-2010 第 4.3 节'
              : protectionClass === '二类'
                ? 'GB 50057-2010 第 4.4 节'
                : 'GB 50057-2010 第 4.5 节'
          const limitText = `${clause}：${protectionClass}防雷建筑物${device?.type ?? '接地体'}接地电阻不大于 ${point.limitOhm} Ω`
          await tx
            .table('verdicts')
            .where('pointId')
            .equals(String(point.id))
            .modify((verdict: Record<string, unknown>) => {
              verdict.result = evaluation.result
              verdict.estimatedOhm = evaluation.estimatedOhm
              verdict.seasonFactor = evaluation.factor
              verdict.seasonFactorSource = evaluation.factorSource
              const existingBasis =
                typeof verdict.basis === 'string' && verdict.basis.length > 0 ? verdict.basis : limitText
              verdict.basis = `${existingBasis}；${evaluation.note}`
            })
        }

        // 历史判定记录补齐季节快照字段（无对应测点的孤立项）
        await tx
          .table('verdicts')
          .toCollection()
          .modify((verdict: Record<string, unknown>) => {
            if (!('estimatedOhm' in verdict)) verdict.estimatedOhm = null
            if (!('seasonFactor' in verdict)) verdict.seasonFactor = null
            if (!('seasonFactorSource' in verdict)) verdict.seasonFactorSource = null
          })
      })
  }
}

export const db = new LightProtDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * 订阅单表变化（Dexie liveQuery），返回取消订阅函数。
 * 供 Svelte store 在模块加载时启动响应式数据流。
 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedPoint {
  id: string
  deviceId: string
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
  meter: string
  measureDate: string
  /** 现场实测的当次季节系数；null 表示未现场测定（回退月份表） */
  siteSeasonFactor?: number | null
}

interface SeedDevice {
  id: string
  buildingId: string
  type: (typeof DEVICE_TYPES)[number]
  material: string
  spec: string
  quantity: number
  installDate: string
  points: SeedPoint[]
}

/**
 * 播种演示数据：2 栋建筑物 → 6 个防雷装置 → 9 个测点 → 逐点自动初判 → 2 条整改建议，
 * 保证父 → 子 → 孙三层链路可点开，且既有合格也有不合格样本。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  // 演示不同季节工况：7 月雨季实测偏小需按系数放大、1 月旱季系数为 1、
  // 个别测点现场测定当次系数、一条测点漏录检测日期（待判定、提示补录）。
  const rainyDate = '2026-07-15'
  const dryDate = '2026-01-20'
  const juneDate = '2026-06-10'

  const buildings: Array<Omit<Building, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'bld_oil01',
      name: '临港油库综合楼',
      usage: '油库',
      protectionClass: '一类',
      floors: 4,
      heightM: 18.6,
      address: '临港工业园区纬三路 18 号'
    },
    {
      id: 'bld_hosp02',
      name: '市第一医院住院部',
      usage: '医院',
      protectionClass: '二类',
      floors: 12,
      heightM: 46.2,
      address: '解放东路 220 号'
    },
    {
      id: 'bld_school03',
      name: '第三中学教学楼',
      usage: '学校',
      protectionClass: '三类',
      floors: 5,
      heightM: 19.8,
      address: '文化路 77 号'
    }
  ]

  const devices: SeedDevice[] = [
    {
      id: 'dev_oil_belt',
      buildingId: 'bld_oil01',
      type: '接闪带',
      material: '热镀锌圆钢',
      spec: 'Φ12',
      quantity: 186,
      installDate: '2019-06-12',
      points: [
        {
          id: 'pnt_oil_belt_1',
          deviceId: 'dev_oil_belt',
          code: 'JD-OIL-01',
          location: '屋面西北角接闪带引下点',
          measuredOhm: 3.2,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: rainyDate,
          siteSeasonFactor: null
        },
        {
          id: 'pnt_oil_belt_2',
          deviceId: 'dev_oil_belt',
          code: 'JD-OIL-02',
          location: '屋面东南角接闪带引下点',
          measuredOhm: 4.1,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: rainyDate,
          // 现场量了当次季节系数，以现场为准（覆盖 7 月月份表的 1.35）
          siteSeasonFactor: 1.2
        }
      ]
    },
    {
      id: 'dev_oil_down',
      buildingId: 'bld_oil01',
      type: '引下线',
      material: '热镀锌扁钢',
      spec: '-40×4',
      quantity: 8,
      installDate: '2019-06-12',
      points: [
        {
          id: 'pnt_oil_down_1',
          deviceId: 'dev_oil_down',
          code: 'JD-OIL-03',
          location: '北侧 3 号引下线断接卡处',
          measuredOhm: 12.6,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: dryDate,
          siteSeasonFactor: null
        },
        {
          id: 'pnt_oil_down_2',
          deviceId: 'dev_oil_down',
          code: 'JD-OIL-04',
          location: '南侧 6 号引下线断接卡处',
          measuredOhm: 8.2,
          limitOhm: 10,
          // 6 月雨季实测 8.2 Ω 看似合格，× 1.30 折算最不利季节 10.66 Ω → 不合格
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: juneDate,
          siteSeasonFactor: null
        }
      ]
    },
    {
      id: 'dev_oil_grid',
      buildingId: 'bld_oil01',
      type: '接地体',
      material: '石墨接地模块',
      spec: '500×400×60',
      quantity: 24,
      installDate: '2019-06-20',
      points: [
        {
          id: 'pnt_oil_grid_1',
          deviceId: 'dev_oil_grid',
          code: 'JD-OIL-05',
          location: '罐区环形接地体东侧测试井',
          // 7 月实测 3.9 Ω，× 1.35 ＝ 5.265 Ω，超过 4 Ω 限值 → 不合格
          measuredOhm: 3.9,
          limitOhm: 4,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: rainyDate,
          siteSeasonFactor: null
        },
        {
          id: 'pnt_oil_grid_2',
          deviceId: 'dev_oil_grid',
          code: 'JD-OIL-06',
          location: '罐区环形接地体西侧测试井',
          // 旱季实测 3.6 Ω，系数 1.00，仍合格
          measuredOhm: 3.6,
          limitOhm: 4,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: dryDate,
          siteSeasonFactor: null
        }
      ]
    },
    {
      id: 'dev_hosp_rod',
      buildingId: 'bld_hosp02',
      type: '接闪杆',
      material: '不锈钢',
      spec: 'Φ25 × 1.5 m',
      quantity: 4,
      installDate: '2021-03-08',
      points: [
        {
          id: 'pnt_hosp_rod_1',
          deviceId: 'dev_hosp_rod',
          code: 'JD-HOS-01',
          location: '裙房屋面接闪杆杆基',
          measuredOhm: 7.4,
          limitOhm: 10,
          meter: 'DER2571 数字接地电阻表 / No.A221104',
          measureDate: dryDate,
          siteSeasonFactor: null
        }
      ]
    },
    {
      id: 'dev_hosp_down',
      buildingId: 'bld_hosp02',
      type: '引下线',
      material: '铜包钢',
      spec: 'Φ16',
      quantity: 12,
      installDate: '2021-03-08',
      points: [
        {
          id: 'pnt_hosp_down_1',
          deviceId: 'dev_hosp_down',
          code: 'JD-HOS-02',
          location: '主楼东侧引下线断接卡',
          measuredOhm: 8.9,
          limitOhm: 10,
          meter: 'DER2571 数字接地电阻表 / No.A221104',
          measureDate: dryDate,
          siteSeasonFactor: null
        },
        {
          id: 'pnt_hosp_down_2',
          deviceId: 'dev_hosp_down',
          code: 'JD-HOS-03',
          location: '主楼西侧引下线断接卡',
          measuredOhm: 15.2,
          limitOhm: 10,
          meter: 'DER2571 数字接地电阻表 / No.A221104',
          measureDate: dryDate,
          siteSeasonFactor: null
        }
      ]
    },
    {
      id: 'dev_school_belt',
      buildingId: 'bld_school03',
      type: '接闪带',
      material: '热镀锌圆钢',
      spec: 'Φ10',
      quantity: 142,
      installDate: '2016-08-30',
      points: [
        {
          id: 'pnt_school_belt_1',
          deviceId: 'dev_school_belt',
          code: 'JD-SCH-01',
          location: '教学楼屋面接闪带东北角',
          measuredOhm: 9.4,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20201122',
          measureDate: dryDate,
          siteSeasonFactor: null
        },
        {
          id: 'pnt_school_belt_2',
          deviceId: 'dev_school_belt',
          code: 'JD-SCH-02',
          location: '教学楼屋面接闪带西南角',
          // 漏录检测日期、也没现场测系数：不给结论，待判定并提示补录
          measuredOhm: 4.8,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20201122',
          measureDate: '',
          siteSeasonFactor: null
        }
      ]
    }
  ]

  await db.transaction(
    'rw',
    [db.buildings, db.devices, db.points, db.verdicts, db.rectifies],
    async () => {
      const stamp = (index: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + index,
        updatedAt: now + index
      })

      await db.buildings.bulkPut(buildings.map((building, index) => ({ ...building, ...stamp(index) })))

      const allDevices: Device[] = []
      const allPoints: Point[] = []
      devices.forEach((device, index) => {
        const { points, ...rest } = device
        allDevices.push({ ...rest, ...stamp(index) })
        points.forEach((point, pointIndex) => {
          allPoints.push({
            ...point,
            siteSeasonFactor: point.siteSeasonFactor ?? null,
            ...stamp(index * 100 + pointIndex)
          })
        })
      })
      await db.devices.bulkPut(allDevices)
      await db.points.bulkPut(allPoints)

      // 逐点自动初判：实测值先做季节修正折算最不利季节估算值，再与限值比对；
      // 月份或季节系数缺失的测点判「待判定」，检测人确认后生效。
      const buildingOfDevice = new Map(allDevices.map((device) => [device.id, device.buildingId]))
      const deviceOfPoint = new Map(allDevices.map((device) => [device.id, device]))
      const verdicts: Verdict[] = allPoints.map((point, index) => {
        const device = deviceOfPoint.get(point.deviceId)
        const building = buildings.find((item) => item.id === buildingOfDevice.get(point.deviceId))
        const evaluation = evaluateSeasonPoint({
          measuredOhm: point.measuredOhm,
          limitOhm: point.limitOhm,
          measureDate: point.measureDate,
          siteSeasonFactor: point.siteSeasonFactor
        })
        return {
          id: `vrd_${point.id}`,
          pointId: point.id,
          result: evaluation.result,
          basis: buildBasisWithSeason(
            building?.protectionClass ?? '三类',
            device?.type ?? '接地体',
            point.limitOhm,
            evaluation
          ),
          inspector: '陈立群',
          verdictDate: point.measureDate,
          confirmed: evaluation.result !== '待判定',
          estimatedOhm: evaluation.estimatedOhm,
          seasonFactor: evaluation.factor,
          seasonFactorSource: evaluation.factorSource,
          ...stamp(1000 + index)
        }
      })
      await db.verdicts.bulkPut(verdicts)

      // 由不合格判定批量生成整改建议（跟踪到复检闭环）
      const rectifies: Rectify[] = verdicts
        .filter((verdict) => verdict.result === '不合格')
        .map((verdict, index) => {
          const point = allPoints.find((item) => item.id === verdict.pointId)
          const buildingId = point ? buildingOfDevice.get(point.deviceId) ?? '' : ''
          const template =
            index % 2 === 0
              ? SUGGESTION_TEMPLATES[0]
              : SUGGESTION_TEMPLATES[1]
          const deadline = new Date(now + template.days * 86400000).toISOString().slice(0, 10)
          const estimateText =
            verdict.estimatedOhm !== null
              ? `季节修正后估算 ${verdict.estimatedOhm} Ω（原始实测 ${point?.measuredOhm ?? '—'} Ω × ${
                  verdict.seasonFactor !== null ? verdict.seasonFactor.toFixed(2) : '—'
                }），限值 ${point?.limitOhm ?? '—'} Ω`
              : `实测 ${point?.measuredOhm ?? '—'} Ω，限值 ${point?.limitOhm ?? '—'} Ω`
          return {
            id: `rct_${verdict.id}`,
            buildingId,
            pointId: verdict.pointId,
            problem: `${template.problem}：${point ? `${point.code} ` : ''}${estimateText}`,
            suggestion: template.suggestion,
            deadline,
            state: index === 0 ? '待整改' : '已整改',
            owner: index === 0 ? '王振海' : '刘敏',
            ...stamp(2000 + index)
          }
        })
      if (rectifies.length > 0) {
        await db.rectifies.bulkPut(rectifies)
      } else {
        // 兜底：即使没有不合格点也生成一条演示整改单，保证整改页有内容
        await db.rectifies.put({
          id: 'rct_fallback',
          buildingId: buildings[0].id,
          pointId: allPoints[0]?.id ?? null,
          problem: '接地装置锈蚀巡检记录待补充',
          suggestion: SUGGESTION_TEMPLATES[1].suggestion,
          deadline: new Date(now + 30 * 86400000).toISOString().slice(0, 10),
          state: '待整改',
          owner: '王振海',
          ...stamp(3000)
        })
      }
    }
  )
}

/** 打开数据库并幂等播种：仅当建筑物表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.buildings.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.buildings, db.devices, db.points, db.verdicts, db.rectifies], async () => {
    await Promise.all([
      db.buildings.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.verdicts.clear(),
      db.rectifies.clear()
    ])
  })
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与备份页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [buildings, devices, points, verdicts, rectifies] = await Promise.all([
    db.buildings.count(),
    db.devices.count(),
    db.points.count(),
    db.verdicts.count(),
    db.rectifies.count()
  ])
  return { buildings, devices, points, verdicts, rectifies }
}

/** 写入结构版本号到 localStorage，便于备份页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastBuildingId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBuildingId)
  } catch {
    return null
  }
}

export function writeLastBuildingId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastBuildingId)
    else localStorage.setItem(LS_KEYS.lastBuildingId, id)
  } catch {
    // 忽略
  }
}

/** 建议限值透出（供表单默认值使用） */
export { suggestLimitOhm }
