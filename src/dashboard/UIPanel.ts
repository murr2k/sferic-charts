import { Panel, PanelOptions } from '../core/Panel'
import type { Surface } from '../render/Surface'

export interface UIPanelOptions extends PanelOptions {
  surface?: Surface
  [k: string]: unknown
}

/** A panel holding only a title and UI elements. */
export class UIPanel extends Panel {
  constructor(o: UIPanelOptions = {}) {
    super(o)
    this.padding = { left: 6, right: 6, top: 4, bottom: 4 }
  }
}
