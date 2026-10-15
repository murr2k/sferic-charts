// Minimal float64 column-major 4x4 matrix helpers for the 3D chart.

export type Mat4 = Float64Array
export interface Point3D { x: number; y: number; z: number }

export const mat4 = (): Mat4 => identity(new Float64Array(16))

export function identity(o: Mat4): Mat4 {
  o.fill(0)
  o[0] = o[5] = o[10] = o[15] = 1
  return o
}

/** o = a * b (o may alias neither a nor b). */
export function multiply(o: Mat4, a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

export function perspective(o: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2)
  o.fill(0)
  o[0] = f / aspect
  o[5] = f
  o[10] = (far + near) / (near - far)
  o[11] = -1
  o[14] = (2 * far * near) / (near - far)
  return o
}

export function lookAt(o: Mat4, eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>): Mat4 {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2]
  let l = Math.hypot(zx, zy, zz) || 1
  zx /= l; zy /= l; zz /= l
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx
  l = Math.hypot(xx, xy, xz) || 1
  xx /= l; xy /= l; xz /= l
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0
  o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2])
  o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2])
  o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2])
  o[15] = 1
  return o
}

/** Rotation from Euler angles in degrees, applied X, then Y, then Z. Returns a column-major 3x3. */
export function eulerMat3(deg: Point3D): Float32Array {
  const a = (deg.x * Math.PI) / 180, b = (deg.y * Math.PI) / 180, c = (deg.z * Math.PI) / 180
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c)
  // R = Rz * Ry * Rx
  const m00 = cc * cb, m01 = cc * sb * sa - sc * ca, m02 = cc * sb * ca + sc * sa
  const m10 = sc * cb, m11 = sc * sb * sa + cc * ca, m12 = sc * sb * ca - cc * sa
  const m20 = -sb, m21 = cb * sa, m22 = cb * ca
  return new Float32Array([m00, m10, m20, m01, m11, m21, m02, m12, m22])
}

export const toF32 = (m: Mat4, o: Float32Array) => {
  for (let i = 0; i < 16; i++) o[i] = m[i]
  return o
}
