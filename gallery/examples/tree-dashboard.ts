import { sferic, type HierarchyNodeData, type HierarchyNode } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Sunburst + TreeMap Dashboard',
  category: 'Hierarchy',
  order: 5,
  tags: ['sunburst', 'treemap', 'dashboard', 'linked'],
  description:
    'The same budget hierarchy shown as a sunburst and a treemap in one dashboard. Drill-down is linked: zooming into a department in either chart zooms the other one too.',
  run({ container, theme }) {
    const tree = (o: Record<string, number | object>): HierarchyNodeData[] =>
      Object.entries(o).map(([name, v]) => (typeof v === 'number' ? { name, value: v } : { name, children: tree(v as Record<string, number | object>) }))
    const data: HierarchyNodeData = {
      name: 'Budget',
      children: tree({
        Engineering: {
          Cloud: { Compute: 420, Storage: 180, Network: 90, Databases: 210 },
          Tooling: { CI: 60, Monitoring: 45, Licenses: 80 },
          Hardware: { Laptops: 120, Lab: 70 },
        },
        Sales: { CRM: 140, Travel: 220, Events: 160, Marketing: { Ads: 310, Content: 90, SEO: 40 } },
        Operations: {
          Facilities: { Rent: 520, Utilities: 80, Cleaning: 30 },
          HR: { Recruiting: 110, Training: 70, Benefits: 260 },
          Finance: { Audit: 60, Software: 40 },
        },
        Research: { Labs: { Equipment: 240, Materials: 130 }, Grants: 90, Compute: { GPU: 380, Storage: 60 } },
        Support: { Staff: 330, Tools: 50, Outsourcing: 120 },
      }),
    }
    const fmt = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(2)}M` : `$${Math.round(v)}k`)

    const dashboard = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 1 })
    dashboard.setColumnWidth(0, 1).setColumnWidth(1, 1.4)
    const sunburst = dashboard
      .createSunburstChart({ columnIndex: 0, rowIndex: 0 })
      .setTitle('Annual budget')
      .setValueFormatter(fmt)
      .setData(data)
    const treemap = dashboard
      .createTreeMapChart({ columnIndex: 1, rowIndex: 0 })
      .setTitle('Budget breakdown')
      .setInitialPathButtonText('Budget')
      .setValueFormatter(fmt)
      .setData(data)

    // Link drill-down both ways (guard against echo).
    let syncing = false
    const link = (src: typeof sunburst | typeof treemap, dst: typeof sunburst | typeof treemap) =>
      src.addEventListener('drilldown', (e: { node: HierarchyNode }) => {
        if (syncing) return
        syncing = true
        dst.setDrillDownNode(e.node.getPath().map((n) => n.name))
        syncing = false
      })
    link(sunburst, treemap)
    link(treemap, sunburst)
    return () => dashboard.dispose()
  },
} satisfies Example
