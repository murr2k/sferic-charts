import { Theme } from './core/theme'
import { Dashboard, DashboardOptions } from './dashboard/Dashboard'
import { ChartXY, ChartXYOptions } from './xy/ChartXY'
import { Chart3D, Chart3DOptions } from './chart3d/Chart3D'
import { PolarChart, PolarChartOptions } from './polar/PolarChart'
import { SpiderChart, SpiderChartOptions } from './polar/SpiderChart'
import { PieChart, PieChartOptions } from './pie/PieChart'
import { GaugeChart, GaugeChartOptions } from './pie/GaugeChart'
import { FunnelChart, FunnelChartOptions } from './pie/FunnelChart'
import { PyramidChart, PyramidChartOptions } from './pie/PyramidChart'
import { BarChart, BarChartOptions } from './bar/BarChart'
import { ZoomBandChart, ZoomBandChartOptions } from './zoomband/ZoomBandChart'
import { ParallelCoordinateChart, ParallelCoordinateChartOptions } from './parallel/ParallelCoordinateChart'
import { TreeMapChart, TreeMapChartOptions } from './hierarchy/TreeMapChart'
import { SunburstChart, SunburstChartOptions } from './hierarchy/SunburstChart'
import { DataGrid, DataGridOptions } from './datagrid/DataGrid'
import { MapChart, MapChartOptions } from './map/MapChart'

export interface SfericOptions {
  /** Accepted and ignored; Sferic needs no license key. */
  license?: string
  licenseInformation?: unknown
  resourcesBaseUrl?: string
  /** Default theme for charts created through this instance. */
  theme?: Theme
  [k: string]: unknown
}

/** Chart factory. */
export class Sferic {
  constructor(readonly options: SfericOptions = {}) {}
  private withTheme<T extends { theme?: Theme }>(o: T): T {
    return { ...o, theme: o.theme ?? this.options.theme }
  }
  ChartXY(o: ChartXYOptions = {}) { return new ChartXY(this.withTheme(o)) }
  Dashboard(o: DashboardOptions) { return new Dashboard(this.withTheme(o)) }
  Chart3D(o: Chart3DOptions = {}) { return new Chart3D(this.withTheme(o)) }
  Polar(o: PolarChartOptions = {}) { return new PolarChart(this.withTheme(o)) }
  Spider(o: SpiderChartOptions = {}) { return new SpiderChart(this.withTheme(o)) }
  Pie(o: PieChartOptions = {}) { return new PieChart(this.withTheme(o)) }
  Gauge(o: GaugeChartOptions = {}) { return new GaugeChart(this.withTheme(o)) }
  Funnel(o: FunnelChartOptions = {}) { return new FunnelChart(this.withTheme(o)) }
  Pyramid(o: PyramidChartOptions = {}) { return new PyramidChart(this.withTheme(o)) }
  BarChart(o: BarChartOptions = {}) { return new BarChart(this.withTheme(o)) }
  ZoomBandChart(o: ZoomBandChartOptions = {}) { return new ZoomBandChart(this.withTheme(o)) }
  ParallelCoordinateChart(o: ParallelCoordinateChartOptions = {}) { return new ParallelCoordinateChart(this.withTheme(o)) }
  TreeMapChart(o: TreeMapChartOptions = {}) { return new TreeMapChart(this.withTheme(o)) }
  SunburstChart(o: SunburstChartOptions = {}) { return new SunburstChart(this.withTheme(o)) }
  DataGrid(o: DataGridOptions = {}) { return new DataGrid(this.withTheme(o)) }
  Map(o: MapChartOptions = {}) { return new MapChart(this.withTheme(o)) }
}

export function sferic(o: SfericOptions = {}) { return new Sferic(o) }
