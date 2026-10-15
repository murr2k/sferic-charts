import { SlicedChartOptions, SlicedChartTypes, SlicedShapeChart, SliceModes } from './SlicedShapeChart'
import { SliceLabelSide } from './slices'

export const PyramidChartTypes = SlicedChartTypes
export const PyramidSliceModes = SliceModes
export const PyramidLabelSide = SliceLabelSide

export interface PyramidChartOptions extends SlicedChartOptions {
  [k: string]: unknown
}

/** Pyramid chart: slices stacked bottom-up, narrowing towards the apex (neck). */
export class PyramidChart extends SlicedShapeChart {
  protected readonly upward = true
  constructor(o: PyramidChartOptions = {}) {
    super(o, 0)
  }
}
