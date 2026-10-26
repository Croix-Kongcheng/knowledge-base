import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { Maximize, Minus, Plus, RotateCcw, Search, Settings2, X } from 'lucide-react'
import type { ImportedNote } from '../lib/importer'
import { buildNoteGraph } from '../lib/graph'

echarts.use([GraphChart, TooltipComponent, CanvasRenderer])

const MAX_VISIBLE_NOTES = 800
const number = (value: number) => value.toLocaleString('zh-CN')
const groupColors = ['#a88bdd', '#6cae9c', '#8ba9cf', '#c7a47c', '#bd87a2', '#87afb7']
const defaultPalette = { background: '#1e1e1e', node: '#a8a8ae', edge: '#4a4a50', text: '#88888f', accent: '#b69be9', surface: '#262626', border: '#393939' }
type GraphPalette = typeof defaultPalette

export default function ObsidianGraph({ notes, onOpenNote, theme }: {
  notes: ImportedNote[]
  onOpenNote: (id: string) => void
  theme?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const openNote = useRef(onOpenNote)
  openNote.current = onOpenNote
  const [palette, setPalette] = useState<GraphPalette>(defaultPalette)
  const [controlsOpen, setControlsOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [showOrphans, setShowOrphans] = useState(true)
  const [colorGroups, setColorGroups] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [nodeSize, setNodeSize] = useState(1)
  const [lineOpacity, setLineOpacity] = useState(0.45)
  const [repulsion, setRepulsion] = useState(170)
  const [linkLength, setLinkLength] = useState(85)
  const graph = useMemo(() => buildNoteGraph(notes), [notes])
  const categories = useMemo(() => [...new Set(notes.map((note) => note.category))].sort(), [notes])
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return graph.nodes.filter((note) => {
      if (!showOrphans && !graph.degree.get(note.id)) return false
      const text = `${note.title} ${note.path || ''} ${note.tags.join(' ')}`.toLocaleLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [graph, query, showOrphans])
  const visible = useMemo(() => {
    // A bounded graph keeps the force simulation usable on the Orange Pi.
    const nodes = filtered.length > MAX_VISIBLE_NOTES
      ? [...filtered].sort((a, b) => (graph.degree.get(b.id) || 0) - (graph.degree.get(a.id) || 0)).slice(0, MAX_VISIBLE_NOTES)
      : filtered
    const ids = new Set(nodes.map((note) => note.id))
    return { nodes, links: graph.links.filter((link) => ids.has(link.source) && ids.has(link.target)) }
  }, [filtered, graph])

  useEffect(() => {
    if (!host.current) return
    let frame = 0
    const readPalette = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!host.current) return
        const styles = getComputedStyle(host.current)
        const value = (key: string, fallback: string) => styles.getPropertyValue(key).trim() || fallback
        const next = {
          background: value('--graph-bg', defaultPalette.background),
          node: value('--graph-node', defaultPalette.node),
          edge: value('--graph-edge', defaultPalette.edge),
          text: value('--text-muted', defaultPalette.text),
          accent: value('--accent', defaultPalette.accent),
          surface: value('--surface', defaultPalette.surface),
          border: value('--border', defaultPalette.border),
        }
        setPalette((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      })
    }
    readPalette()
    const observer = new MutationObserver(readPalette)
    let parent: HTMLElement | null = host.current
    while (parent) {
      observer.observe(parent, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
      parent = parent.parentElement
    }
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [theme])

  useEffect(() => {
    if (!canvas.current) return
    const instance = echarts.init(canvas.current, undefined, { renderer: 'canvas', devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2) })
    chart.current = instance
    instance.on('click', (event) => {
      if (event.dataType === 'node') {
        const node = event.data as { id?: string }
        if (node.id) openNote.current(node.id)
      }
    })
    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => instance.resize())
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas.current)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      instance.dispose()
      chart.current = null
    }
  }, [])

  const option = useMemo<EChartsOption>(() => ({
    backgroundColor: palette.background,
    animationDurationUpdate: 250,
    textStyle: { fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: 12 },
    tooltip: {
      trigger: 'item',
      backgroundColor: palette.surface,
      borderColor: palette.border,
      borderWidth: 1,
      textStyle: { color: palette.node, fontSize: 12 },
      confine: true,
      extraCssText: 'border-radius:6px;box-shadow:none;max-width:320px;white-space:normal;word-break:break-word;',
      formatter: (event: unknown) => {
        const entry = event as { dataType?: string; data?: { name?: string; path?: string; value?: number } }
        if (entry.dataType !== 'node') return ''
        const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
        return `${escape(entry.data?.name || '')}<br/><span style="opacity:.65">${escape(entry.data?.path || '')}</span><br/>${number(entry.data?.value || 0)} 条关联 · 点击打开`
      },
    },
    series: [{
      id: 'notes-network',
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      left: 20,
      right: 20,
      top: 20,
      bottom: 20,
      scaleLimit: { min: 0.15, max: 6 },
      force: {
        repulsion,
        edgeLength: [linkLength * 0.75, linkLength * 1.3],
        gravity: 0.045,
        friction: 0.6,
        layoutAnimation: true,
      },
      data: visible.nodes.map((note) => {
        const degree = graph.degree.get(note.id) || 0
        return {
          id: note.id,
          name: note.title,
          path: note.path || note.category,
          value: degree,
          symbolSize: (4.5 + Math.min(7.5, Math.sqrt(degree) * 1.6)) * nodeSize,
          itemStyle: { color: colorGroups ? groupColors[categories.indexOf(note.category) % groupColors.length] : palette.node },
        }
      }),
      links: visible.links,
      symbol: 'circle',
      edgeSymbol: ['none', 'none'],
      label: {
        show: showLabels,
        position: 'bottom',
        distance: 5,
        color: palette.text,
        opacity: 0.7,
        fontSize: 12,
        fontWeight: 400,
        formatter: ({ name }: { name: string }) => name.length > 23 ? `${name.slice(0, 23)}…` : name,
      },
      labelLayout: { hideOverlap: true },
      itemStyle: { borderWidth: 0 },
      lineStyle: { color: palette.edge, width: 0.7, opacity: lineOpacity, curveness: 0 },
      emphasis: {
        focus: 'adjacency',
        scale: 1.4,
        itemStyle: { color: palette.accent },
        label: { show: true, color: palette.accent, opacity: 1 },
        lineStyle: { color: palette.accent, opacity: 0.7, width: 1 },
      },
      blur: { itemStyle: { opacity: 0.16 }, lineStyle: { opacity: 0.035 }, label: { opacity: 0.08 } },
    }],
  }), [palette, repulsion, linkLength, visible, graph, nodeSize, colorGroups, categories, showLabels, lineOpacity])

  useEffect(() => {
    chart.current?.setOption(option, { replaceMerge: ['series'] })
  }, [option])

  const zoom = (amount: number) => {
    const instance = chart.current
    if (!instance) return
    instance.dispatchAction({ type: 'graphRoam', seriesIndex: 0, zoom: amount, originX: instance.getWidth() / 2, originY: instance.getHeight() / 2 })
  }
  const resetView = () => chart.current?.setOption({ series: [{ id: 'notes-network', zoom: 1, center: ['50%', '50%'] }] })
  const resetSettings = () => {
    setQuery(''); setShowOrphans(true); setColorGroups(false); setShowLabels(true)
    setNodeSize(1); setLineOpacity(0.45); setRepulsion(170); setLinkLength(85)
    resetView()
  }

  return <section ref={host} className="obsidian-graph" aria-label="知识库关系图谱">
    <style>{graphStyles}</style>
    <div ref={canvas} className="obsidian-graph-canvas" role="img" aria-label={`知识图谱，${number(visible.nodes.length)} 篇笔记、${number(visible.links.length)} 条关联。拖动节点，滚轮缩放，点击节点打开知识库文档。`} />
    <div className="obsidian-graph-caption"><span className="obsidian-graph-dot" />关系图谱<span>仅显示文档中的真实链接</span></div>
    <button className="obsidian-graph-settings-toggle" type="button" aria-label={controlsOpen ? '收起图谱设置' : '展开图谱设置'} aria-expanded={controlsOpen} onClick={() => setControlsOpen(!controlsOpen)}><Settings2 size={16} /></button>
    {controlsOpen && <aside className="obsidian-graph-controls" aria-label="图谱设置">
      <details open>
        <summary>筛选</summary>
        <div className="obsidian-graph-control-content">
          <label className="obsidian-graph-search"><Search size={14} /><input aria-label="筛选图谱中的文档" placeholder="搜索文档、路径或标签…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清空图谱搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
          <label className="obsidian-graph-check">显示孤立文档<input type="checkbox" checked={showOrphans} onChange={(event) => setShowOrphans(event.target.checked)} /></label>
          {query && visible.nodes.length > 0 && visible.nodes.length <= 5 && <div className="obsidian-graph-results">{visible.nodes.map((note) => <button key={note.id} type="button" title={note.path || note.title} onClick={() => onOpenNote(note.id)}>{note.title}</button>)}</div>}
        </div>
      </details>
      <details>
        <summary>分组</summary>
        <div className="obsidian-graph-control-content">
          <label className="obsidian-graph-check">按知识库目录着色<input type="checkbox" checked={colorGroups} onChange={(event) => setColorGroups(event.target.checked)} /></label>
          {colorGroups && <div className="obsidian-graph-groups">{categories.map((category, index) => <span key={category}><i style={{ background: groupColors[index % groupColors.length] }} />{category}</span>)}</div>}
        </div>
      </details>
      <details>
        <summary>显示</summary>
        <div className="obsidian-graph-control-content">
          <label className="obsidian-graph-check">文档标题<input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /></label>
          <label className="obsidian-graph-slider">节点大小<input aria-label="图谱节点大小" type="range" min="0.6" max="2" step="0.1" value={nodeSize} onChange={(event) => setNodeSize(Number(event.target.value))} /></label>
          <label className="obsidian-graph-slider">连线透明度<input aria-label="图谱连线透明度" type="range" min="0.1" max="1" step="0.05" value={lineOpacity} onChange={(event) => setLineOpacity(Number(event.target.value))} /></label>
        </div>
      </details>
      <details>
        <summary>引力</summary>
        <div className="obsidian-graph-control-content">
          <label className="obsidian-graph-slider">节点排斥力<input aria-label="图谱节点排斥力" type="range" min="40" max="400" step="10" value={repulsion} onChange={(event) => setRepulsion(Number(event.target.value))} /></label>
          <label className="obsidian-graph-slider">连线长度<input aria-label="图谱连线长度" type="range" min="35" max="180" step="5" value={linkLength} onChange={(event) => setLinkLength(Number(event.target.value))} /></label>
        </div>
      </details>
      <button className="obsidian-graph-reset-settings" type="button" onClick={resetSettings}><RotateCcw size={12} />恢复默认设置</button>
    </aside>}
    {visible.nodes.length === 0 && <div className="obsidian-graph-empty"><span>{notes.length ? '没有符合筛选条件的文档' : '知识从第一篇文档开始连接'}</span><p>{notes.length ? '尝试其他关键词，或打开“显示孤立文档”。' : '导入 Obsidian 知识库后，文档间的双向链接会出现在这里。'}</p></div>}
    <div className="obsidian-graph-bottom"><div className="obsidian-graph-counts"><span>{number(visible.nodes.length)} 篇文档</span><span>{number(visible.links.length)} 条关联</span>{filtered.length > MAX_VISIBLE_NOTES && <span title="优先显示关联最多的文档；使用搜索可以筛选全部知识库">共 {number(filtered.length)} 篇，当前显示前 {number(MAX_VISIBLE_NOTES)} 篇</span>}</div><span className="obsidian-graph-hint">拖动平移 · 滚轮缩放 · 点击打开</span></div>
    <div className="obsidian-graph-zoom"><button type="button" aria-label="放大图谱" title="放大" onClick={() => zoom(1.25)}><Plus size={16} /></button><button type="button" aria-label="缩小图谱" title="缩小" onClick={() => zoom(0.8)}><Minus size={16} /></button><button type="button" aria-label="图谱复位" title="复位视图" onClick={resetView}><Maximize size={15} /></button></div>
  </section>
}

const graphStyles = `
.obsidian-graph{position:relative;isolation:isolate;width:100%;height:calc(100dvh - 64px);min-height:520px;overflow:hidden;background:var(--graph-bg,#1e1e1e);border:0;border-radius:0;color:var(--text-muted,#88888f);font-size:12px}
.obsidian-graph-canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.obsidian-graph-caption{position:absolute;left:20px;top:18px;display:flex;align-items:center;gap:9px;pointer-events:none;font-size:12px;color:var(--text-primary,#d2d2d5);font-weight:500}
.obsidian-graph-caption>span:last-child{margin-left:8px;color:var(--text-muted,#88888f);font-weight:400}
.obsidian-graph-dot{height:5px;width:5px;border-radius:50%;background:var(--graph-node,#a8a8ae)}
.obsidian-graph button{display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font:inherit;color:inherit;box-shadow:none;transition:background .15s,color .15s}
.obsidian-graph button:hover{color:var(--text-primary,#ddd);background:color-mix(in srgb,var(--text-muted,#88888f) 13%,transparent)}
.obsidian-graph button:focus-visible,.obsidian-graph input:focus-visible,.obsidian-graph summary:focus-visible{outline:2px solid var(--accent,#b69be9);outline-offset:3px}
.obsidian-graph-settings-toggle{position:absolute;right:15px;top:12px;width:30px;height:30px;border:0;border-radius:5px;background:var(--surface,#262626)}
.obsidian-graph-controls{position:absolute;right:15px;top:50px;width:228px;max-height:calc(100% - 145px);overflow-y:auto;border:1px solid var(--border,#393939);border-radius:7px;background:var(--surface,#262626);color:var(--text-muted,#999);font-size:12px;box-shadow:0 3px 12px #00000009}
.obsidian-graph-controls details+details{border-top:1px solid var(--border,#393939)}
.obsidian-graph-controls summary{padding:11px 12px;font-weight:600;cursor:pointer;color:var(--text-primary,#d2d2d5);user-select:none}
.obsidian-graph-controls summary::marker{color:var(--text-muted,#88888f)}
.obsidian-graph-control-content{display:flex;flex-direction:column;gap:14px;padding:2px 13px 14px}
.obsidian-graph-search{height:32px;display:flex;align-items:center;gap:7px;border:1px solid var(--border,#393939);border-radius:5px;padding:0 8px;background:var(--graph-bg,#1e1e1e)}
.obsidian-graph-search input{padding:0;min-width:0;width:100%;height:100%;border:0;outline:none;background:transparent;color:var(--text-primary,#ddd);font-size:12px}
.obsidian-graph-search input::placeholder{color:var(--text-muted,#88888f)}
.obsidian-graph-search button{height:22px;width:18px;padding:0;border:0;border-radius:3px;background:transparent;flex-shrink:0}
.obsidian-graph-check{display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer}
.obsidian-graph-check input{width:14px;height:14px;margin:0;accent-color:var(--accent,#b69be9)}
.obsidian-graph-slider{display:flex;flex-direction:column;gap:10px}
.obsidian-graph-slider input{width:100%;height:3px;margin:0;accent-color:var(--accent,#b69be9);cursor:pointer}
.obsidian-graph-results{display:flex;flex-direction:column;gap:3px}
.obsidian-graph-results button{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:6px 4px;border:0;background:transparent;border-radius:3px;color:var(--accent,#b69be9)}
.obsidian-graph-groups{display:flex;flex-direction:column;gap:9px;max-height:140px;overflow-y:auto}
.obsidian-graph-groups span{display:flex;align-items:center;gap:7px;overflow-wrap:anywhere}
.obsidian-graph-groups i{width:6px;height:6px;flex-shrink:0;border-radius:50%}
.obsidian-graph-reset-settings{width:100%;gap:7px;border:0;border-top:1px solid var(--border,#393939);background:transparent;padding:11px}
.obsidian-graph-bottom{position:absolute;left:18px;right:70px;bottom:17px;display:flex;align-items:center;justify-content:space-between;gap:10px;pointer-events:none;font-size:12px}
.obsidian-graph-counts{display:flex;flex-wrap:wrap;gap:13px}
.obsidian-graph-hint{opacity:.7;white-space:nowrap}
.obsidian-graph-zoom{position:absolute;right:14px;bottom:14px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border,#393939);border-radius:6px;background:var(--surface,#262626)}
.obsidian-graph-zoom button{width:30px;height:30px;padding:0;border:0;background:transparent}
.obsidian-graph-zoom button+button{border-top:1px solid var(--border,#393939)}
.obsidian-graph-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:30px;pointer-events:none;text-align:center}
.obsidian-graph-empty>span{font-size:15.5px;font-weight:600;color:var(--text-primary,#ddd)}
.obsidian-graph-empty p{max-width:33em;line-height:1.9;margin:0;font-size:12px}
@media(max-width:850px){.obsidian-graph-hint{display:none}.obsidian-graph-caption>span:last-child{display:none}}
@media(max-width:570px){.obsidian-graph{height:calc(100dvh - 60px)}}
@media(prefers-reduced-motion:reduce){.obsidian-graph button{transition:none}}
`
