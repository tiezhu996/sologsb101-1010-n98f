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
import { defaultBasis } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'
import { SUGGESTION_TEMPLATES } from '$lib/types/rectify'
import { suggestLimitOhm } from '$lib/utils/resistance'
import { assessPoint } from '$lib/utils/season'

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
    this.version(DB_VERSION)
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

    // v3：测点新增季节系数，判定记录季节修正口径（估算值 + 系数），历史判定按新口径重算
    this.version(DB_VERSION)
      .stores({
        buildings: 'id, name, usage, protectionClass, floors, heightM, updatedAt',
        devices: 'id, buildingId, type, material, spec, quantity, installDate, updatedAt',
        points: 'id, deviceId, code, measuredOhm, limitOhm, measureDate, updatedAt',
        verdicts: 'id, pointId, result, confirmed, verdictDate, updatedAt',
        rectifies: 'id, buildingId, pointId, state, deadline, updatedAt'
      })
      .upgrade(async (tx) => {
        // 历史测点没有现场系数，统一回落到月份表（measureDate 已在 v2 补齐）
        await tx
          .table('points')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.seasonFactor === undefined) row.seasonFactor = null
          })

        // 历史判定是按雨季实测值直接下的结论，必须按「最不利季节估算值」重算；
        // 缺月份 / 系数的记录改挂「待判定」并提示补录。保留检测人署名与确认时间。
        const points = await tx.table('points').toArray()
        const devices = await tx.table('devices').toArray()
        const buildings = await tx.table('buildings').toArray()
        const pointById = new Map(points.map((point: Record<string, unknown>) => [point.id as string, point]))
        const deviceById = new Map(devices.map((device: Record<string, unknown>) => [device.id as string, device]))
        const buildingById = new Map(
          buildings.map((building: Record<string, unknown>) => [building.id as string, building])
        )

        await tx
          .table('verdicts')
          .toCollection()
          .modify((verdict: Record<string, unknown>) => {
            const point = pointById.get(verdict.pointId as string) as
              | {
                  measuredOhm: number
                  limitOhm: number
                  measureDate: string
                  seasonFactor?: number | null
                  deviceId: string
                }
              | undefined
            if (!point) {
              verdict.result = '待判定'
              verdict.estimatedOhm = null
              verdict.seasonFactor = null
              return
            }
            const assessment = assessPoint({
              measuredOhm: point.measuredOhm,
              limitOhm: point.limitOhm,
              measureDate: point.measureDate,
              seasonFactor: point.seasonFactor ?? null
            })
            verdict.result = assessment.result
            verdict.estimatedOhm = assessment.estimatedOhm
            verdict.seasonFactor = assessment.seasonFactor
            const device = deviceById.get(point.deviceId) as { type?: string; buildingId?: string } | undefined
            const building = buildingById.get(device?.buildingId ?? '') as
              | { protectionClass?: string }
              | undefined
            verdict.basis = defaultBasis(building?.protectionClass ?? '三类', device?.type ?? '接地体', point.limitOhm, {
              factor: assessment.seasonFactor,
              source: assessment.factorSource,
              month: assessment.month
            })
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
  /** 现场实测季节系数；null 表示本次没量、按检测月份查表 */
  seasonFactor: number | null
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
          measureDate: '2026-07-15',
          seasonFactor: null
        },
        {
          id: 'pnt_oil_belt_2',
          deviceId: 'dev_oil_belt',
          code: 'JD-OIL-02',
          location: '屋面东南角接闪带引下点',
          measuredOhm: 4.1,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: '2026-07-15',
          seasonFactor: null
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
          measureDate: '2026-01-16',
          seasonFactor: null
        },
        {
          id: 'pnt_oil_down_2',
          deviceId: 'dev_oil_down',
          code: 'JD-OIL-04',
          location: '南侧 6 号引下线断接卡处',
          measuredOhm: 8.6,
          limitOhm: 10,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: '2026-06-18',
          seasonFactor: null
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
          measuredOhm: 3.9,
          limitOhm: 4,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: '2026-06-20',
          seasonFactor: null
        },
        {
          id: 'pnt_oil_grid_2',
          deviceId: 'dev_oil_grid',
          code: 'JD-OIL-06',
          location: '罐区环形接地体西侧测试井',
          measuredOhm: 5.4,
          limitOhm: 4,
          meter: 'ZC-8 接地电阻测试仪 / No.20230517',
          measureDate: '2026-06-20',
          seasonFactor: null
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
          measureDate: '2026-08-12',
          // 现场四极法实测量 ψ=1.5：以现场为准，估算 11.1 Ω 超限（月份表仅 1.05）
          seasonFactor: 1.5
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
          measureDate: '2026-12-09',
          seasonFactor: null
        },
        {
          id: 'pnt_hosp_down_2',
          deviceId: 'dev_hosp_down',
          code: 'JD-HOS-03',
          location: '主楼西侧引下线断接卡',
          measuredOhm: 15.2,
          limitOhm: 10,
          meter: 'DER2571 数字接地电阻表 / No.A221104',
          measureDate: '2026-12-09',
          seasonFactor: null
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
          // 手记漏填检测月份、现场也没量系数：不给合格结论，挂「待判定」提示补录
          measureDate: '',
          seasonFactor: null
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
          allPoints.push({ ...point, ...stamp(index * 100 + pointIndex) })
        })
      })
      await db.devices.bulkPut(allDevices)
      await db.points.bulkPut(allPoints)

      // 逐点自动初判：实测 × 季节系数 ψ 折算最不利季节估算值后再与限值比对；
      // 缺检测月份 / 系数的记录挂「待判定」。检测人确认后生效。
      const buildingOfDevice = new Map(allDevices.map((device) => [device.id, device.buildingId]))
      const deviceOfPoint = new Map(allDevices.map((device) => [device.id, device]))
      const verdicts: Verdict[] = allPoints.map((point, index) => {
        const device = deviceOfPoint.get(point.deviceId)
        const building = buildings.find((item) => item.id === buildingOfDevice.get(point.deviceId))
        const assessment = assessPoint(point)
        return {
          id: `vrd_${point.id}`,
          pointId: point.id,
          result: assessment.result,
          basis: defaultBasis(building?.protectionClass ?? '三类', device?.type ?? '接地体', point.limitOhm, {
            factor: assessment.seasonFactor,
            source: assessment.factorSource,
            month: assessment.month
          }),
          inspector: '陈立群',
          verdictDate: point.measureDate,
          confirmed: true,
          estimatedOhm: assessment.estimatedOhm,
          seasonFactor: assessment.seasonFactor,
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
            point && verdict.estimatedOhm !== null
              ? `${point.code} 原始实测 ${point.measuredOhm} Ω，季节修正估算 ${verdict.estimatedOhm} Ω，限值 ${point.limitOhm} Ω`
              : '测点数据缺失'
          return {
            id: `rct_${verdict.id}`,
            buildingId,
            pointId: verdict.pointId,
            problem: `${template.problem}：${estimateText}`,
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
