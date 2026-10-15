// Ear-clipping polygon triangulation with holes, following the earcut algorithm
// (Mapbox, ISC license): holes are bridged into the outer ring, then ears are
// clipped with fallbacks for self-touching / degenerate input. No z-order hash.

class Node {
  prev!: Node
  next!: Node
  steiner = false
  constructor(readonly i: number, readonly x: number, readonly y: number) {}
}

/**
 * Triangulate a polygon given as flat `[x0, y0, x1, y1, ...]` with hole start
 * indices (in vertices). Returns vertex indices, three per triangle.
 */
export function triangulate(data: ArrayLike<number>, holeIndices: number[] = []): number[] {
  const hasHoles = holeIndices.length > 0
  const outerLen = hasHoles ? holeIndices[0] * 2 : data.length
  let outer = linkedList(data, 0, outerLen, true)
  const tris: number[] = []
  if (!outer || outer.next === outer.prev) return tris
  if (hasHoles) outer = eliminateHoles(data, holeIndices, outer)
  earcutLinked(outer, tris, 0)
  return tris
}

/** Twice the signed area; positive for counter-clockwise rings in a y-up frame. */
function signedArea(data: ArrayLike<number>, start: number, end: number): number {
  let sum = 0
  for (let i = start, j = end - 2; i < end; i += 2) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1])
    j = i
  }
  return sum
}

function linkedList(data: ArrayLike<number>, start: number, end: number, outer: boolean): Node | null {
  let last: Node | null = null
  if (outer === signedArea(data, start, end) > 0) {
    for (let i = start; i < end; i += 2) last = insertNode(i / 2, data[i], data[i + 1], last)
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, data[i], data[i + 1], last)
  }
  if (last && equals(last, last.next)) {
    removeNode(last)
    last = last.next
  }
  return last
}

function filterPoints(start: Node | null, end?: Node | null): Node | null {
  if (!start) return start
  if (!end) end = start
  let p = start
  let again: boolean
  do {
    again = false
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p)
      p = end = p.prev
      if (p === p.next) break
      again = true
    } else {
      p = p.next
    }
  } while (again || p !== end)
  return end
}

function earcutLinked(ear: Node | null, tris: number[], pass: number) {
  if (!ear) return
  let stop = ear
  let guard = 0
  while (ear.prev !== ear.next) {
    if (++guard > 1e7) return
    const prev: Node = ear.prev
    const next: Node = ear.next
    if (isEar(ear)) {
      tris.push(prev.i, ear.i, next.i)
      removeNode(ear)
      ear = next.next
      stop = next.next
      continue
    }
    ear = next
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), tris, 1)
      else if (pass === 1) {
        const f = filterPoints(ear)
        if (f) earcutLinked(cureLocalIntersections(f, tris), tris, 2)
      }
      else if (pass === 2) splitEarcut(ear, tris)
      break
    }
  }
}

function isEar(ear: Node): boolean {
  const a = ear.prev, b = ear, c = ear.next
  if (area(a, b, c) >= 0) return false
  const x0 = Math.min(a.x, b.x, c.x), y0 = Math.min(a.y, b.y, c.y)
  const x1 = Math.max(a.x, b.x, c.x), y1 = Math.max(a.y, b.y, c.y)
  let p = c.next
  while (p !== a) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false
    p = p.next
  }
  return true
}

function cureLocalIntersections(start: Node, tris: number[]): Node | null {
  let p = start
  do {
    const a = p.prev, b = p.next.next
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      tris.push(a.i, p.i, b.i)
      removeNode(p)
      removeNode(p.next)
      p = start = b
    }
    p = p.next
  } while (p !== start)
  return filterPoints(p)
}

function splitEarcut(start: Node, tris: number[]) {
  let a = start
  do {
    let b = a.next.next
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c: Node | null = splitPolygon(a, b)
        const aa = filterPoints(a, a.next)
        c = filterPoints(c, c.next)
        earcutLinked(aa, tris, 0)
        earcutLinked(c, tris, 0)
        return
      }
      b = b.next
    }
    a = a.next
  } while (a !== start)
}

function eliminateHoles(data: ArrayLike<number>, holeIndices: number[], outer: Node): Node {
  const queue: Node[] = []
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * 2
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * 2 : data.length
    const list = linkedList(data, start, end, false)
    if (!list) continue
    if (list === list.next) list.steiner = true
    queue.push(getLeftmost(list))
  }
  queue.sort((a, b) => a.x - b.x)
  for (const h of queue) outer = eliminateHole(h, outer)
  return outer
}

function eliminateHole(hole: Node, outer: Node): Node {
  const bridge = findHoleBridge(hole, outer)
  if (!bridge) return outer
  const rev = splitPolygon(bridge, hole)
  filterPoints(rev, rev.next)
  return filterPoints(bridge, bridge.next) ?? outer
}

function findHoleBridge(hole: Node, outer: Node): Node | null {
  let p = outer
  let qx = -Infinity
  let m: Node | null = null
  const hx = hole.x, hy = hole.y
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y)
      if (x <= hx && x > qx) {
        qx = x
        m = p.x < p.next.x ? p : p.next
        if (x === hx) return m
      }
    }
    p = p.next
  } while (p !== outer)
  if (!m) return null
  const stop = m, mx = m.x, my = m.y
  let tanMin = Infinity
  p = m
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x)
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p
        tanMin = tan
      }
    }
    p = p.next
  } while (p !== stop)
  return m
}

const sectorContainsSector = (m: Node, p: Node) => area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0

function getLeftmost(start: Node): Node {
  let p = start, left = start
  do {
    if (p.x < left.x || (p.x === left.x && p.y < left.y)) left = p
    p = p.next
  } while (p !== start)
  return left
}

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py)
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
      (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
  )
}

const area = (p: Node, q: Node, r: Node) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
const equals = (a: Node, b: Node) => a.x === b.x && a.y === b.y
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0)
const onSegment = (p: Node, q: Node, r: Node) =>
  q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2))
  const o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1))
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p2, q1)) return true
  if (o2 === 0 && onSegment(p1, q2, q1)) return true
  if (o3 === 0 && onSegment(p2, p1, q2)) return true
  if (o4 === 0 && onSegment(p2, q1, q2)) return true
  return false
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true
    p = p.next
  } while (p !== a)
  return false
}

function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0
}

function middleInside(a: Node, b: Node): boolean {
  let p = a
  let inside = false
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2
  do {
    if (p.y > py !== p.next.y > py && p.next.y !== p.y && px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x) inside = !inside
    p = p.next
  } while (p !== a)
  return inside
}

function splitPolygon(a: Node, b: Node): Node {
  const a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y)
  const an = a.next, bp = b.prev
  a.next = b
  b.prev = a
  a2.next = an
  an.prev = a2
  b2.next = a2
  a2.prev = b2
  bp.next = b2
  b2.prev = bp
  return b2
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
  const p = new Node(i, x, y)
  if (!last) {
    p.prev = p
    p.next = p
  } else {
    p.next = last.next
    p.prev = last
    last.next.prev = p
    last.next = p
  }
  return p
}

function removeNode(p: Node) {
  p.next.prev = p.prev
  p.prev.next = p.next
}
