import { Color, ColorHEX, ColorRGBA } from './color'
import { Fill, LineStyle, RadialGradientFill, SolidFill, SolidLine, LinearGradientFill, emptyFill } from './style'

export interface GlowSettings {
  /** Master switch for the bloom post-process. */
  enabled: boolean
  /** Additive strength of the blurred halo. */
  intensity: number
  /** Blur radius in CSS px (approximate). */
  radius: number
}

export interface Theme {
  name: string
  isDark: boolean
  fontFamily: string
  fontSize: number
  titleFontSize: number
  /** Whole-chart background. */
  chartBackgroundFill: Fill
  /** Plot area background. */
  seriesBackgroundFill: Fill
  seriesBackgroundStroke: LineStyle
  titleColor: Color
  axisTitleColor: Color
  axisLineColor: Color
  tickLabelColor: Color
  minorTickLabelColor: Color
  tickColor: Color
  gridMajorColor: Color
  gridMinorColor: Color
  seriesColors: Color[]
  /** Default fill for area series (alpha applied to series color). */
  areaFillAlpha: number
  lineThickness: number
  pointSize: number
  cursor: {
    lineColor: Color
    tableFill: Color
    tableStroke: Color
    textColor: Color
    tickFill: Color
    tickText: Color
  }
  legend: {
    textColor: Color
    titleColor: Color
    panelFill: Color
    panelStroke: Color
    disabledColor: Color
  }
  zoomRectFill: Color
  zoomRectStroke: Color
  bandFill: Color
  constantLineColor: Color
  dashboardSplitterColor: Color
  uiFill: Color
  uiStroke: Color
  uiText: Color
  glow: GlowSettings
  /** 3D charts. */
  chart3D: {
    boundingBoxColor: Color
    wallFill: Color
  }
  /** Named palettes for heatmaps, intensity and status coloring. */
  examples: {
    spectrogramColorPalette: Color[]
    intensityColorPalette: Color[]
    coldHotColorPalette: Color[]
    badGoodColorPalette: Color[]
    positiveNegativeColorPalette: Color[]
    highlightColor: Color
    mainTextColor: Color
  }
}

const hex = (s: string) => ColorHEX(s)
const hexes = (...s: string[]) => s.map(hex)

// Default theme: deep blue-slate surfaces, electric-blue accents, bloom glow.
// Series palette: OKLCH L 0.665 / C 0.17, hue order chosen so adjacent slots stay
// separable under protan/deutan simulation (worst adjacent OKLab dE 13.4).
const storm: Theme = {
  name: 'storm',
  isDark: true,
  fontFamily: '"Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
  fontSize: 13,
  titleFontSize: 18,
  chartBackgroundFill: new RadialGradientFill({
    position: { x: 0.5, y: 0.4 },
    stops: [
      { offset: 0, color: hex('#1c2333') },
      { offset: 1, color: hex('#07090f') },
    ],
  }),
  seriesBackgroundFill: new RadialGradientFill({
    position: { x: 0.5, y: 0.45 },
    stops: [
      { offset: 0, color: hex('#121827') },
      { offset: 1, color: hex('#05070c') },
    ],
  }),
  seriesBackgroundStroke: new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: hex('#28324a') }) }),
  titleColor: hex('#eef2fb'),
  axisTitleColor: hex('#8fb4ff'),
  axisLineColor: hex('#6f7b93'),
  tickLabelColor: hex('#d3d9e6'),
  minorTickLabelColor: hex('#8f99ad'),
  tickColor: hex('#66728a'),
  gridMajorColor: ColorRGBA(150, 175, 255, 26),
  gridMinorColor: ColorRGBA(150, 175, 255, 11),
  seriesColors: hexes('#03a1d5', '#c58501', '#608dfb', '#e06099', '#a19705', '#c66acc', '#40ae4b', '#9d7aef', '#e86545', '#07aaa3'),
  areaFillAlpha: 80,
  lineThickness: 2,
  pointSize: 6,
  cursor: {
    lineColor: ColorRGBA(200, 215, 255, 120),
    tableFill: ColorRGBA(12, 15, 24, 235),
    tableStroke: ColorRGBA(150, 175, 255, 90),
    textColor: hex('#eef2fb'),
    tickFill: hex('#8fb4ff'),
    tickText: hex('#0a0d14'),
  },
  legend: {
    textColor: hex('#e3e8f2'),
    titleColor: hex('#ffffff'),
    panelFill: ColorRGBA(10, 13, 20, 220),
    panelStroke: ColorRGBA(150, 175, 255, 90),
    disabledColor: hex('#4c5568'),
  },
  zoomRectFill: ColorRGBA(143, 180, 255, 36),
  zoomRectStroke: ColorRGBA(143, 180, 255, 180),
  bandFill: ColorRGBA(143, 180, 255, 34),
  constantLineColor: hex('#f0b44c'),
  dashboardSplitterColor: hex('#1a2131'),
  uiFill: ColorRGBA(16, 20, 30, 230),
  uiStroke: ColorRGBA(150, 175, 255, 80),
  uiText: hex('#e3e8f2'),
  glow: { enabled: true, intensity: 0.9, radius: 6 },
  chart3D: { boundingBoxColor: ColorRGBA(170, 190, 255, 70), wallFill: ColorRGBA(150, 175, 255, 8) },
  examples: {
    spectrogramColorPalette: hexes('#04060b', '#0c1840', '#173a8a', '#2a70d0', '#4fb0ff', '#b7e3ff', '#ffffff'),
    intensityColorPalette: hexes('#04060b', '#1d2b6b', '#2f8fd8', '#4fe0a0', '#f0e040', '#ff5030'),
    coldHotColorPalette: hexes('#3060ff', '#30c0ff', '#40ff90', '#ffff40', '#ff8020', '#ff2020'),
    badGoodColorPalette: hexes('#ff4d4d', '#ffb030', '#40d070'),
    positiveNegativeColorPalette: hexes('#ff4d4d', '#1a2030', '#40b4ff'),
    highlightColor: hex('#8fb4ff'),
    mainTextColor: hex('#e3e8f2'),
  },
}

const daylight: Theme = {
  ...storm,
  name: 'daylight',
  isDark: false,
  chartBackgroundFill: new SolidFill({ color: hex('#ffffff') }),
  seriesBackgroundFill: new SolidFill({ color: hex('#ffffff') }),
  seriesBackgroundStroke: new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: hex('#c8ccd2') }) }),
  titleColor: hex('#1b1f24'),
  axisTitleColor: hex('#343a42'),
  axisLineColor: hex('#8a9099'),
  tickLabelColor: hex('#353b43'),
  minorTickLabelColor: hex('#6b727c'),
  tickColor: hex('#8a9099'),
  gridMajorColor: ColorRGBA(0, 0, 0, 26),
  gridMinorColor: ColorRGBA(0, 0, 0, 10),
  // OKLCH L 0.58 / C 0.17, ordered for CVD separation (worst adjacent OKLab dE 11.6).
  seriesColors: hexes('#2279dc', '#9f7100', '#0389a0', '#678806', '#606cdd', '#c94363', '#925ac9', '#079343', '#b84999', '#c55205'),
  areaFillAlpha: 60,
  cursor: {
    lineColor: ColorRGBA(0, 0, 0, 110),
    tableFill: ColorRGBA(255, 255, 255, 240),
    tableStroke: ColorRGBA(0, 0, 0, 60),
    textColor: hex('#1b1f24'),
    tickFill: hex('#2f3640'),
    tickText: hex('#ffffff'),
  },
  legend: {
    textColor: hex('#2a2f36'),
    titleColor: hex('#111111'),
    panelFill: ColorRGBA(255, 255, 255, 235),
    panelStroke: ColorRGBA(0, 0, 0, 50),
    disabledColor: hex('#b8bcc2'),
  },
  zoomRectFill: ColorRGBA(47, 111, 222, 40),
  zoomRectStroke: ColorRGBA(47, 111, 222, 180),
  bandFill: ColorRGBA(47, 111, 222, 36),
  constantLineColor: hex('#e0335f'),
  dashboardSplitterColor: hex('#dcdfe4'),
  uiFill: ColorRGBA(255, 255, 255, 235),
  uiStroke: ColorRGBA(0, 0, 0, 60),
  uiText: hex('#1b1f24'),
  glow: { enabled: false, intensity: 0, radius: 0 },
  chart3D: { boundingBoxColor: ColorRGBA(0, 0, 0, 70), wallFill: ColorRGBA(0, 0, 0, 6) },
  examples: {
    spectrogramColorPalette: hexes('#ffffff', '#c6dbef', '#6baed6', '#2171b5', '#6a1b9a', '#d81b60', '#ff6f00'),
    intensityColorPalette: hexes('#f7fbff', '#9ecae1', '#3182bd', '#31a354', '#fdae6b', '#e6550d'),
    coldHotColorPalette: hexes('#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'),
    badGoodColorPalette: hexes('#d7191c', '#fdae61', '#1a9641'),
    positiveNegativeColorPalette: hexes('#d7191c', '#f7f7f7', '#2c7bb6'),
    highlightColor: hex('#e0335f'),
    mainTextColor: hex('#1b1f24'),
  },
}

const aurora: Theme = {
  ...storm,
  name: 'aurora',
  chartBackgroundFill: new LinearGradientFill({
    angle: 90,
    stops: [
      { offset: 0, color: hex('#05040f') },
      { offset: 1, color: hex('#141036') },
    ],
  }),
  seriesBackgroundFill: new RadialGradientFill({
    stops: [
      { offset: 0, color: hex('#0e0b2a') },
      { offset: 1, color: hex('#030210') },
    ],
  }),
  seriesBackgroundStroke: new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: hex('#2a2466') }) }),
  titleColor: hex('#e8e6ff'),
  axisTitleColor: hex('#7fe8ff'),
  axisLineColor: hex('#5a54a8'),
  tickLabelColor: hex('#cfcbff'),
  minorTickLabelColor: hex('#8f8acb'),
  tickColor: hex('#5a54a8'),
  gridMajorColor: ColorRGBA(120, 110, 255, 40),
  gridMinorColor: ColorRGBA(120, 110, 255, 16),
  seriesColors: hexes('#00e5ff', '#ff3df5', '#7dff6a', '#ffe14a', '#8a7bff', '#ff7a45', '#3dffc5', '#ff5d8f', '#b8ff3d', '#5aa0ff'),
  cursor: { ...storm.cursor, tickFill: hex('#00e5ff'), lineColor: ColorRGBA(0, 229, 255, 120), tableFill: ColorRGBA(8, 6, 30, 235) },
  legend: { ...storm.legend, panelFill: ColorRGBA(8, 6, 30, 220), panelStroke: ColorRGBA(0, 229, 255, 110) },
  zoomRectFill: ColorRGBA(0, 229, 255, 36),
  zoomRectStroke: ColorRGBA(0, 229, 255, 180),
  bandFill: ColorRGBA(255, 61, 245, 36),
  constantLineColor: hex('#ff3df5'),
  dashboardSplitterColor: hex('#1d1848'),
  glow: { enabled: true, intensity: 1.1, radius: 8 },
  examples: {
    ...storm.examples,
    spectrogramColorPalette: hexes('#000010', '#1a0b5e', '#5b10c8', '#d81bd8', '#ff5db8', '#ffd0f0'),
    intensityColorPalette: hexes('#000010', '#0d2c8c', '#00a6ff', '#00ffd5', '#d6ff3d', '#ffffff'),
    highlightColor: hex('#00e5ff'),
  },
}

const lagoon: Theme = {
  ...storm,
  name: 'lagoon',
  chartBackgroundFill: new RadialGradientFill({
    stops: [
      { offset: 0, color: hex('#12333a') },
      { offset: 1, color: hex('#03100f') },
    ],
  }),
  seriesBackgroundFill: new RadialGradientFill({
    stops: [
      { offset: 0, color: hex('#0b2226') },
      { offset: 1, color: hex('#020807') },
    ],
  }),
  seriesBackgroundStroke: new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: hex('#1e4a4c') }) }),
  titleColor: hex('#e6fffb'),
  axisTitleColor: hex('#5ff0d8'),
  axisLineColor: hex('#4c8a88'),
  tickLabelColor: hex('#cdeeea'),
  minorTickLabelColor: hex('#8fb8b4'),
  tickColor: hex('#4c8a88'),
  gridMajorColor: ColorRGBA(95, 240, 216, 32),
  gridMinorColor: ColorRGBA(95, 240, 216, 12),
  seriesColors: hexes('#3df2d2', '#f2c14e', '#f76f8e', '#7ab8ff', '#b4f27a', '#c792ea', '#ff9e5e', '#5ee0ff', '#f2f27a', '#9ef2b9'),
  cursor: { ...storm.cursor, tickFill: hex('#3df2d2'), lineColor: ColorRGBA(61, 242, 210, 120), tableFill: ColorRGBA(3, 20, 20, 235) },
  legend: { ...storm.legend, panelFill: ColorRGBA(3, 20, 20, 220), panelStroke: ColorRGBA(61, 242, 210, 110) },
  zoomRectFill: ColorRGBA(61, 242, 210, 36),
  zoomRectStroke: ColorRGBA(61, 242, 210, 180),
  bandFill: ColorRGBA(61, 242, 210, 34),
  constantLineColor: hex('#f2c14e'),
  dashboardSplitterColor: hex('#123234'),
  glow: { enabled: true, intensity: 0.9, radius: 6 },
  examples: {
    ...storm.examples,
    spectrogramColorPalette: hexes('#000808', '#06353a', '#0b7c7a', '#3df2d2', '#f2f27a', '#ffffff'),
    highlightColor: hex('#3df2d2'),
  },
}

const graphite: Theme = {
  ...storm,
  name: 'graphite',
  chartBackgroundFill: new SolidFill({ color: hex('#16181c') }),
  seriesBackgroundFill: new SolidFill({ color: hex('#0f1114') }),
  seriesBackgroundStroke: new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: hex('#2c3038') }) }),
  titleColor: hex('#f0f2f5'),
  axisTitleColor: hex('#a9b3c1'),
  seriesColors: hexes('#4c9aff', '#ff8b4c', '#36c78b', '#b07cff', '#ff5c7a', '#2ccbe0', '#ffc933', '#93a3b8', '#ec6ac8', '#9ccf3c'),
  cursor: { ...storm.cursor, tickFill: hex('#4c9aff'), tickText: hex('#ffffff') },
  zoomRectFill: ColorRGBA(76, 154, 255, 40),
  zoomRectStroke: ColorRGBA(76, 154, 255, 180),
  bandFill: ColorRGBA(76, 154, 255, 34),
  constantLineColor: hex('#ff5c7a'),
  glow: { enabled: false, intensity: 0, radius: 0 },
}

export const Themes = { storm, daylight, aurora, lagoon, graphite } satisfies Record<string, Theme>
export type ThemeName = keyof typeof Themes

/** Scale all font sizes and default stroke/point sizes. */
export function scaleTheme(t: Theme, k: number): Theme {
  return {
    ...t,
    fontSize: t.fontSize * k,
    titleFontSize: t.titleFontSize * k,
    lineThickness: Math.max(1, t.lineThickness * k),
    pointSize: t.pointSize * k,
  }
}

export const font = (t: Theme, size: number = t.fontSize, weight: string | number = 'normal') =>
  `${weight} ${size}px ${t.fontFamily}`

export const seriesColor = (t: Theme, i: number) => t.seriesColors[((i % t.seriesColors.length) + t.seriesColors.length) % t.seriesColors.length]

export { emptyFill }
