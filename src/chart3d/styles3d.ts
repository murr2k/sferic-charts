import { Color } from '../core/color'
import { Fill, Mutator, resolve } from '../core/style'

export type TriangulatedShape3D = 'sphere' | 'cube' | 'box' | 'cylinder' | 'cone' | 'pyramid' | 'diamond'
export type PixelatedShape3D = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'x' | 'star'

interface PointStyleOptions<S> {
  shape?: S
  /** Diameter in pixels (Triangulated: at the default camera distance, scales with perspective). */
  size?: number
  fillStyle?: Fill
}

/** Lit 3D geometry per point (spheres are ray-cast impostors, other shapes instanced meshes). */
export class TriangulatedPoints3D {
  readonly type = 'triangulated' as const
  readonly shape: TriangulatedShape3D
  readonly size: number
  readonly fillStyle: Fill | null
  constructor(o: PointStyleOptions<TriangulatedShape3D> = {}) {
    this.shape = o.shape ?? 'sphere'
    this.size = o.size ?? 8
    this.fillStyle = o.fillStyle ?? null
  }
  setShape(shape: TriangulatedShape3D) { return new TriangulatedPoints3D({ ...this.o(), shape }) }
  setSize(size: Mutator<number>) { return new TriangulatedPoints3D({ ...this.o(), size: resolve(this.size, size) }) }
  setFillStyle(f: Mutator<Fill>) { return new TriangulatedPoints3D({ ...this.o(), fillStyle: resolve(this.fillStyle as Fill, f) }) }
  getShape() { return this.shape }
  getSize() { return this.size }
  getFillStyle() { return this.fillStyle }
  private o() { return { shape: this.shape, size: this.size, fillStyle: this.fillStyle ?? undefined } }
}

/** Flat, constant pixel-size markers (fastest, unlit). */
export class PixelatedPoints3D {
  readonly type = 'pixelated' as const
  readonly shape: PixelatedShape3D
  readonly size: number
  readonly fillStyle: Fill | null
  constructor(o: PointStyleOptions<PixelatedShape3D | 'square' | 'circle'> = {}) {
    this.shape = (o.shape ?? 'square') as PixelatedShape3D
    this.size = o.size ?? 4
    this.fillStyle = o.fillStyle ?? null
  }
  setShape(shape: PixelatedShape3D) { return new PixelatedPoints3D({ ...this.o(), shape }) }
  setSize(size: Mutator<number>) { return new PixelatedPoints3D({ ...this.o(), size: resolve(this.size, size) }) }
  setFillStyle(f: Mutator<Fill>) { return new PixelatedPoints3D({ ...this.o(), fillStyle: resolve(this.fillStyle as Fill, f) }) }
  getShape() { return this.shape }
  getSize() { return this.size }
  getFillStyle() { return this.fillStyle }
  private o() { return { shape: this.shape, size: this.size, fillStyle: this.fillStyle ?? undefined } }
}

export type PointStyle3DType = TriangulatedPoints3D | PixelatedPoints3D

// Callable with or without `new`.
interface TriangulatedFactory {
  new (o?: PointStyleOptions<TriangulatedShape3D>): TriangulatedPoints3D
  (o?: PointStyleOptions<TriangulatedShape3D>): TriangulatedPoints3D
}
interface PixelatedFactory {
  new (o?: PointStyleOptions<PixelatedShape3D>): PixelatedPoints3D
  (o?: PointStyleOptions<PixelatedShape3D>): PixelatedPoints3D
}

export const PointStyle3D = {
  Triangulated: function (o?: PointStyleOptions<TriangulatedShape3D>) { return new TriangulatedPoints3D(o) } as unknown as TriangulatedFactory,
  Pixelated: function (o?: PointStyleOptions<PixelatedShape3D>) { return new PixelatedPoints3D(o) } as unknown as PixelatedFactory,
}

// ------------------------------------------------------------------ color shading

/** Unlit: colors are not affected by the light source. */
export class SimpleShading {
  readonly type = 'simple' as const
}

export interface PhongOptions {
  /** Ambient light level 0..1 (or a color whose brightness is used). */
  ambientColor?: Color | number
  /** Specular highlight strength 0..1. */
  specularReflection?: number
  specularColor?: Color
  shininess?: number
}

/** Phong lighting: ambient + directional diffuse + specular highlight. */
export class PhongShading {
  readonly type = 'phong' as const
  readonly ambient: number
  readonly specular: number
  readonly shininess: number
  constructor(o: PhongOptions = {}) {
    const a = o.ambientColor
    this.ambient = a === undefined ? 0.38 : typeof a === 'number' ? a : (a.r + a.g + a.b) / (3 * 255)
    this.specular = o.specularReflection ?? 0.35
    this.shininess = o.shininess ?? 28
  }
}

export type ColorShadingStyle = SimpleShading | PhongShading

export const ColorShadingStyles = { Simple: SimpleShading, Phong: PhongShading }

/** Shading uniform (ambient, diffuse, specular, shininess). */
export function shadeParams(s: ColorShadingStyle): [number, number, number, number] {
  if (s.type === 'simple') return [1, 0, 0, 1]
  return [s.ambient, 1 - s.ambient * 0.55, s.specular, s.shininess]
}
