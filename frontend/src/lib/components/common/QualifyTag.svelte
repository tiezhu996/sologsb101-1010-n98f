<script lang="ts">
  /**
   * <QualifyTag> 按合格 / 不合格 / 待判定渲染底色与图标。
   * 被测点录入页（/points）与合格判定页（/verdicts）消费。
   *
   * 传入 point（含 measuredOhm / limitOhm / measureDate / seasonFactor）时，
   * 自动按季节修正估算值判定；也可直接传 result 显式指定结论。
   */
  import { limitRatio } from '$lib/utils/resistance.ts'
  import type { VerdictResult } from '$lib/types/verdict.ts'

  type ToneKey = VerdictResult

  let {
    /** 合格 / 不合格 / 待判定（显式指定时优先） */
    result = '待判定',
    /** 原始实测电阻（Ω），仅用于提示与报告留痕 */
    measuredOhm = null,
    /** 最不利季节估算电阻（Ω），判定与占限值按它走 */
    estimatedOhm = null,
    /** 限值（Ω） */
    limitOhm = null,
    /** 待判定提示（缺月份 / 缺系数），传入后无论结果都按待判定渲染 */
    pendingReason = null,
    /** 系数可读说明（如「6 月查表系数 ψ=1.05」），用于悬停提示 */
    factorText = '',
    /** 尺寸 */
    size = 'default',
    /** 是否以浅色描边风格展示 */
    plain = false
  }: {
    result?: VerdictResult
    measuredOhm?: number | null
    estimatedOhm?: number | null
    limitOhm?: number | null
    pendingReason?: string | null
    factorText?: string
    size?: 'default' | 'small' | 'large'
    plain?: boolean
  } = $props()

  const TONE: Record<ToneKey, { color: string; bg: string; icon: string }> = {
    合格: { color: '#1e8449', bg: '#eaf6ee', icon: '✔' },
    不合格: { color: '#c0392b', bg: '#fdecea', icon: '✕' },
    待判定: { color: '#8c8479', bg: '#f2f2f2', icon: '?' }
  }

  // 显式给了待判定原因就按待判定；否则以传入结论为准
  const resolvedResult = $derived<VerdictResult>(pendingReason ? '待判定' : result)
  const tone = $derived(TONE[resolvedResult] ?? TONE.待判定)
  const ratio = $derived(estimatedOhm !== null && limitOhm ? limitRatio(estimatedOhm, limitOhm) : 0)
  const valueText = $derived(estimatedOhm === null ? '' : `估算 ${estimatedOhm} Ω`)
  const tip = $derived(
    pendingReason
      ? `待判定：${pendingReason}`
      : estimatedOhm === null || limitOhm === null
        ? `${resolvedResult}`
        : `${resolvedResult}：原始实测 ${measuredOhm ?? '—'} Ω，${factorText || '季节修正'}后估算 ${estimatedOhm} Ω / 限值 ${limitOhm} Ω（${ratio > 1 ? `超限 ${((ratio - 1) * 100).toFixed(1)}%` : `余量 ${(limitOhm - estimatedOhm).toFixed(2)} Ω`}）`
  )
  const style = $derived(
    plain
      ? `color:${tone.color};background:${tone.bg};border-color:${tone.color};`
      : `color:#fff;background:${tone.color};border-color:${tone.color};`
  )
</script>

<span class="qualify-tag is-{size}" style={style} title={tip}>
  <i class="qualify-tag__icon" aria-hidden="true">{tone.icon}</i>
  <b class="qualify-tag__text">{resolvedResult}</b>
  {#if valueText}
    <em class="qualify-tag__value">· {valueText}</em>
  {/if}
</span>

<style>
  .qualify-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    line-height: 20px;
    white-space: nowrap;
  }

  .qualify-tag.is-small {
    padding: 0 8px;
    font-size: 12px;
    line-height: 18px;
  }

  .qualify-tag.is-large {
    padding: 4px 14px;
    font-size: 15px;
    line-height: 24px;
  }

  .qualify-tag__icon {
    font-style: normal;
    font-size: 12px;
  }

  .qualify-tag__value {
    font-style: normal;
    font-weight: 400;
    opacity: 0.9;
  }
</style>
