import { SlicedChartOptions, SlicedChartTypes, SlicedShapeChart, SliceModes } from './SlicedShapeChart'
import { SliceLabelSide } from './slices'

export const FunnelChartTypes = SlicedChartTypes
export const FunnelSliceModes = SliceModes
export const FunnelLabelSide = SliceLabelSide

export interface FunnelChartOptions extends SlicedChartOptions {
  [k: string]: unknown
}

/** Funnel chart: slices stacked top-down, narrowing from the head to the neck. */
export class FunnelChart extends SlicedShapeChart {
  protected readonly upward = false
  constructor(o: FunnelChartOptions = {}) {
    super(o, 30)
  }
  /** Width of the top edge, % of the chart width. */
  setHeadWidth(percent: number) { this.head = Math.max(1, Math.min(100, percent)); this.requestRender(); return this }
  getHeadWidth() { return this.head }
}
