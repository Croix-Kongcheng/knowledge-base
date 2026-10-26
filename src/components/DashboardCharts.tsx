import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { seedNotes } from '../data'
import type { ImportedNote } from '../lib/importer'

echarts.use([
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  CanvasRenderer,
])

const fontFamily = 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
const colors = {
  purple: '#8b75ed',
  mint: '#63c9af',
  blue: '#81a8ee',
  peach: '#edb38e',
  muted: '#a0a1af',
  text: '#505164',
}

const tooltipStyle = {
  backgroundColor: '#fff',
  borderColor: '#eeedf5',
  borderWidth: 1,
  padding: [12, 15],
  textStyle: { color: colors.text, fontSize: 12, fontFamily },
  extraCssText: 'border-radius:12px;box-shadow:0 8px 32px rgba(38,34,76,.09);',
}

function ChartCanvas({
  option,
  height,
  label,
}: {
  option: EChartsOption
  height: number
  label: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const instance = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!element.current) return
    const chart = echarts.init(element.current, undefined, {
      renderer: 'canvas',
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    })
    instance.current = chart
    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => chart.resize())
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(element.current)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      chart.dispose()
      instance.current = null
    }
  }, [])

  useEffect(() => {
    instance.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={element} role="img" aria-label={label} style={{ minWidth: 0, height }} />
}

export function GrowthChart({ range = '本月', notes = seedNotes, theme = 'light' }: { range?: string; notes?: ImportedNote[]; theme?: string }) {
  const option = useMemo<EChartsOption>(() => {
    const weekly = range.includes('7') || range.includes('周')
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    const span = weekly ? 6 : 29
    const days = Array.from({length: 7}, (_, index) => {
      const date = new Date(end)
      date.setDate(end.getDate() - Math.round(span * (6 - index) / 6))
      return date
    })
    const dates = days.map(date => `${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getDate()).padStart(2,'0')}`)
    const counts = days.map(date => notes.filter(note => new Date(note.updatedAt).getTime() <= date.getTime()).length)
    const attachmentCounts = days.map(date => new Set(notes.filter(note => new Date(note.updatedAt).getTime() <= date.getTime()).flatMap(note => Object.values(note.attachments || {}))).size)
    const dark = theme === 'obsidian'
    const axisColor = dark ? '#929292' : '#95919d'
    const tooltip = {...tooltipStyle, backgroundColor:dark?'#2b2b2b':'#fff',borderColor:dark?'#3c3c3c':'#e5e5e9',textStyle:{...tooltipStyle.textStyle,color:dark?'#dadada':'#505164'},renderMode:'richText' as const}
    return {
      animationDuration: 650,
      color: [colors.purple, colors.mint],
      textStyle: { fontFamily },
      grid: { left: 38, right: 14, top: 51, bottom: 26 },
      legend: {
        top: 0,
        left: 25,
        icon: 'circle',
        itemWidth: 7,
        itemHeight: 7,
        itemGap: 22,
        textStyle: { fontSize: 12, color: axisColor, padding: [0, 0, 0, 3] },
        data: ['笔记数量', '附件数量'],
      },
      tooltip: {
        ...tooltip,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#dcd6f7', type: 'dashed' } },
        valueFormatter: (value) => Number(value).toLocaleString('zh-CN'),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: dates,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 12, margin: 14 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        minInterval: 1,
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 12, margin: 13 },
        splitLine: { lineStyle: { color: dark?'#343434':'#eeeef4', type: [3, 4] } },
      },
      series: [
        {
          name: '笔记数量',
          type: 'line',
          smooth: 0.45,
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 7,
          data: counts,
          lineStyle: { color: colors.purple, width: 3 },
          itemStyle: { color: colors.purple, borderColor: '#fff', borderWidth: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(139,117,237,0.17)' },
              { offset: 1, color: 'rgba(139,117,237,0.015)' },
            ]),
          },
          emphasis: { focus: 'series' },
        },
        {
          name: '附件数量',
          type: 'line',
          smooth: 0.45,
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 7,
          data: attachmentCounts,
          lineStyle: { color: colors.mint, width: 2.5, type: 'dashed' },
          itemStyle: { color: colors.mint, borderColor: '#fff', borderWidth: 2 },
          emphasis: { focus: 'series' },
        },
      ],
    }
  }, [range, notes, theme])

  return <ChartCanvas option={option} height={242} label="笔记与附件增长趋势，可悬停查看每天的数量" />
}

export function CategoryChart({data = [], theme = 'light'}: {data?: {name:string;value:number;color?:string}[]; theme?:string}) {
  const option = useMemo<EChartsOption>(() => {
    const dark = theme === 'obsidian'
    const total = data.reduce((sum,item)=>sum+item.value,0)
    return {
      animationDuration: 500,
      color: data.map((item,index)=>item.color||[colors.purple,colors.mint,colors.blue,colors.peach][index%4]),
      textStyle: {fontFamily},
      tooltip: {...tooltipStyle, backgroundColor:dark?'#2b2b2b':'#fff',borderColor:dark?'#3c3c3c':'#e5e5e9',textStyle:{...tooltipStyle.textStyle,color:dark?'#dadada':'#505164'},trigger:'item',renderMode:'richText',formatter:'{b}\n{c} 篇 · {d}%'},
      title: [
        {text:total.toLocaleString('en-US'),left:'center',top:'34%',textStyle:{fontFamily,fontSize:27,fontWeight:700,color:dark?'#dadada':'#393a4c'}},
        {text:'篇文档',left:'center',top:'54%',textStyle:{fontFamily,fontSize:12,fontWeight:400,color:dark?'#929292':'#a0a1af'}},
      ],
      series:[{type:'pie',radius:['66%','84%'],center:['50%','50%'],startAngle:90,padAngle:3,avoidLabelOverlap:true,itemStyle:{borderRadius:4},label:{show:false},labelLine:{show:false},emphasis:{scaleSize:3,label:{show:false}},data}],
    }
  },[data,theme])
  return <ChartCanvas option={option} height={190} label={`知识分类分布：${data.map(item=>`${item.name}${item.value}篇`).join('、')}`} />
}
