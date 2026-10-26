import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowRight, BookOpen, ChevronLeft, ChevronRight, Clock3, FileText, List, LoaderCircle, RefreshCw, Search, Users, X } from 'lucide-react';
import { formatReadingClock, formatReadingDuration, getReadingAnalytics, type ReadingAnalyticsData } from '../lib/readingAnalytics';
import UserAvatar from './UserAvatar';
import './reading-analytics.css';

type Tab = 'users' | 'notes' | 'records';
type Props = { onOpenNote?: (id: string) => void };
const tabs: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: 'users', label: '用户统计', icon: Users },
  { id: 'notes', label: '笔记统计', icon: BookOpen },
  { id: 'records', label: '阅读明细', icon: List },
];
const listPageSize = 20;
const detailPageSize = 50;
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const count = (value: number) => value.toLocaleString('zh-CN');

function LastRead({ value }: { value: string | null }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span className="ra-muted">尚未阅读</span>;
  return <time dateTime={value}>{dateFormatter.format(new Date(value))}</time>;
}

function Empty({ title, description }: { title: string; description?: string }) {
  return <div className="ra-empty"><BookOpen size={28} aria-hidden="true"/><strong>{title}</strong>{description && <p>{description}</p>}</div>;
}

function Pagination({ page, pageSize, total, onChange, disabled, label }: { page: number; pageSize: number; total: number; onChange: (page: number) => void; disabled?: boolean; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="ra-pagination" aria-label={label}>
    <span>共 {count(total)} 条{total > 0 && <span className="ra-pagination-range"> · {count((page - 1) * pageSize + 1)}–{count(Math.min(page * pageSize, total))}</span>}</span>
    <div><button type="button" className="ra-page-button" aria-label="上一页" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={16}/></button><span>{count(page)} / {count(pages)}</span><button type="button" className="ra-page-button" aria-label="下一页" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={16}/></button></div>
  </nav>;
}

export default function ReadingAnalytics({ onOpenNote }: Props) {
  const [tab, setTab] = useState<Tab>('users');
  const [data, setData] = useState<ReadingAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [userId, setUserId] = useState('');
  const [noteId, setNoteId] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [recordPage, setRecordPage] = useState(1);
  const [listSearch, setListSearch] = useState('');
  const [listPage, setListPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search.trim());setRecordPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);setError('');
    void getReadingAnalytics({ userId, noteId, q: debouncedSearch, page: recordPage, pageSize: detailPageSize }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setData(result);
      const lastPage = Math.max(1, Math.ceil(result.pagination.total / detailPageSize));
      if (recordPage > lastPage) setRecordPage(lastPage);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '阅读统计加载失败，请稍后重试。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [userId, noteId, debouncedSearch, recordPage, refresh]);

  const changeTab = (next: Tab) => { setTab(next);setListSearch('');setListPage(1); };
  const tabKeyboard = (event: KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    const index = tabs.findIndex(item => item.id === current);
    const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();changeTab(next.id);document.getElementById(`ra-tab-${next.id}`)?.focus();
  };
  const viewUser = (id: string) => { setUserId(id);setNoteId('');setSearch('');setDebouncedSearch('');setRecordPage(1);changeTab('records'); };
  const viewNote = (id: string) => { setNoteId(id);setUserId('');setSearch('');setDebouncedSearch('');setRecordPage(1);changeTab('records'); };
  const clearFilters = () => { setUserId('');setNoteId('');setSearch('');setDebouncedSearch('');setRecordPage(1); };
  const hasFilters = Boolean(userId || noteId || search);
  const filteredUsers = useMemo(() => {
    const query = listSearch.trim().toLocaleLowerCase();
    return (data?.users ?? []).filter(item => !query || `${item.name} ${item.email}`.toLocaleLowerCase().includes(query));
  }, [data?.users, listSearch]);
  const filteredNotes = useMemo(() => {
    const query = listSearch.trim().toLocaleLowerCase();
    return (data?.notes ?? []).filter(item => !query || `${item.title} ${item.path}`.toLocaleLowerCase().includes(query));
  }, [data?.notes, listSearch]);
  const listTotal = tab === 'users' ? filteredUsers.length : filteredNotes.length;
  const effectiveListPage = Math.min(listPage, Math.max(1, Math.ceil(listTotal / listPageSize)));
  const listStart = (effectiveListPage - 1) * listPageSize;
  const noteTitle = (id: string, title: string): ReactNode => onOpenNote ? <button type="button" className="ra-note-link" title={`打开笔记：${title}`} onClick={() => onOpenNote(id)}>{title}</button> : <strong>{title}</strong>;
  const busyDetails = loading || search.trim() !== debouncedSearch;

  return <section className="ra-dashboard" aria-label="阅读时间统计">
    <div className="ra-intro"><p><Clock3 size={15} aria-hidden="true"/><span>当前笔记停留超过 10 秒后开始计时，前 10 秒、后台页面和未显示的笔记不计入。</span></p><button type="button" className="button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} className={loading ? 'ra-spin' : ''}/>刷新统计</button></div>
    <div className="ra-metrics">
      <article className="ra-metric"><div><h2>累计阅读时间</h2><span className="ra-metric-icon ra-purple"><Clock3 size={19}/></span></div><strong className="ra-metric-number" aria-label={data ? `累计阅读时间 ${formatReadingDuration(data.summary.totalMs)}` : '累计阅读时间加载中'}>{data ? formatReadingClock(data.summary.totalMs) : '—'}</strong><p>小时 : 分钟 : 秒</p></article>
      <article className="ra-metric"><div><h2>阅读成员</h2><span className="ra-metric-icon ra-mint"><Users size={19}/></span></div><strong className="ra-metric-number">{data ? count(data.summary.readerCount) : '—'}</strong><p>已产生有效阅读时间的成员</p></article>
      <article className="ra-metric"><div><h2>已读笔记</h2><span className="ra-metric-icon ra-blue"><BookOpen size={19}/></span></div><strong className="ra-metric-number">{data ? count(data.summary.noteCount) : '—'}</strong><p>已产生有效阅读时间的笔记</p></article>
      <article className="ra-metric"><div><h2>阅读记录</h2><span className="ra-metric-icon ra-peach"><FileText size={19}/></span></div><strong className="ra-metric-number">{data ? count(data.summary.pairCount) : '—'}</strong><p>按成员与笔记分别累计</p></article>
    </div>

    {error && <div className="ra-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>重新加载</button></div>}
    <div className="ra-panel">
      <div className="ra-panel-top"><div className="ra-tabs" role="tablist" aria-label="阅读统计类型">{tabs.map(({ id, label, icon: Icon }) => <button key={id} id={`ra-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`ra-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={event => tabKeyboard(event, id)} onClick={() => changeTab(id)}><Icon size={16} aria-hidden="true"/>{label}</button>)}</div><span className="ra-admin-label">仅管理员可见</span></div>
      {tab !== 'records' && <div className="ra-list-toolbar"><p>{tab === 'users' ? '查看每位成员的累计阅读时间，点击明细查看读过的笔记。' : '查看每篇笔记的阅读时间，点击明细查看各成员的阅读情况。'}</p><label className="ra-search"><Search size={15} aria-hidden="true"/><input aria-label={tab === 'users' ? '搜索统计用户' : '搜索统计笔记'} placeholder={tab === 'users' ? '搜索姓名或邮箱' : '搜索标题或路径'} value={listSearch} onChange={event => { setListSearch(event.target.value);setListPage(1); }}/>{listSearch && <button type="button" aria-label="清空列表搜索" onClick={() => { setListSearch('');setListPage(1); }}><X size={14}/></button>}</label></div>}

      {tab === 'users' && <div id="ra-panel-users" role="tabpanel" aria-labelledby="ra-tab-users" aria-busy={loading}>
        {!data ? <div className="ra-loading" role="status">{loading ? <><LoaderCircle size={19} className="ra-spin"/>正在加载阅读统计…</> : '暂无可显示的数据'}</div> : !filteredUsers.length ? <Empty title={listSearch ? '没有匹配的成员' : '暂无成员'} description={listSearch ? '试试其他姓名或邮箱。' : undefined}/> : <div className="ra-table-scroll"><table className="ra-table ra-users-table"><thead><tr><th scope="col">成员</th><th scope="col">累计阅读时间</th><th scope="col">已读笔记</th><th scope="col">最近阅读</th><th scope="col"><span className="ra-sr-only">操作</span></th></tr></thead><tbody>{filteredUsers.slice(listStart, listStart + listPageSize).map(item => <tr key={item.userId}><td><div className="ra-person"><UserAvatar src={item.avatarUrl} name={item.name}/><span><strong>{item.name}</strong><small>{item.email}</small></span></div></td><td className="ra-duration">{formatReadingDuration(item.totalMs)}</td><td className="ra-number">{count(item.noteCount)}</td><td className="ra-date"><LastRead value={item.lastReadAt}/></td><td><button type="button" className="ra-detail-button" aria-label={`查看${item.name}的阅读明细`} disabled={!item.noteCount} onClick={() => viewUser(item.userId)}>明细<ArrowRight size={13}/></button></td></tr>)}</tbody></table></div>}
        {data && <Pagination label="用户统计分页" page={effectiveListPage} pageSize={listPageSize} total={filteredUsers.length} onChange={setListPage}/>}
      </div>}

      {tab === 'notes' && <div id="ra-panel-notes" role="tabpanel" aria-labelledby="ra-tab-notes" aria-busy={loading}>
        {!data ? <div className="ra-loading" role="status">{loading ? <><LoaderCircle size={19} className="ra-spin"/>正在加载阅读统计…</> : '暂无可显示的数据'}</div> : !filteredNotes.length ? <Empty title={listSearch ? '没有匹配的笔记' : '暂无笔记'} description={listSearch ? '试试其他标题或路径。' : '创建或导入笔记后，可在这里查看阅读情况。'}/> : <div className="ra-table-scroll"><table className="ra-table ra-notes-table"><thead><tr><th scope="col">笔记</th><th scope="col">累计阅读时间</th><th scope="col">阅读人数</th><th scope="col">最近阅读</th><th scope="col"><span className="ra-sr-only">操作</span></th></tr></thead><tbody>{filteredNotes.slice(listStart, listStart + listPageSize).map(item => <tr key={item.noteId}><td><div className="ra-note"><span className="ra-file-icon"><FileText size={17}/></span><span>{noteTitle(item.noteId, item.title)}<small title={item.path}>{item.path || '根目录'}</small></span></div></td><td className="ra-duration">{formatReadingDuration(item.totalMs)}</td><td className="ra-number">{count(item.readerCount)}</td><td className="ra-date"><LastRead value={item.lastReadAt}/></td><td><button type="button" className="ra-detail-button" aria-label={`查看${item.title}的阅读明细`} disabled={!item.readerCount} onClick={() => viewNote(item.noteId)}>明细<ArrowRight size={13}/></button></td></tr>)}</tbody></table></div>}
        {data && <Pagination label="笔记统计分页" page={effectiveListPage} pageSize={listPageSize} total={filteredNotes.length} onChange={setListPage}/>}
      </div>}

      {tab === 'records' && <div id="ra-panel-records" role="tabpanel" aria-labelledby="ra-tab-records" aria-busy={busyDetails}>
        <div className="ra-filters"><label><span>成员</span><select aria-label="筛选阅读成员" value={userId} onChange={event => { setUserId(event.target.value);setRecordPage(1); }}><option value="">全部成员</option>{data?.users.map(item => <option key={item.userId} value={item.userId}>{item.name}（{item.email}）</option>)}</select></label><label><span>笔记</span><select aria-label="筛选阅读笔记" value={noteId} onChange={event => { setNoteId(event.target.value);setRecordPage(1); }}><option value="">全部笔记</option>{data?.notes.map(item => <option key={item.noteId} value={item.noteId}>{item.path || item.title}</option>)}</select></label><label className="ra-filter-search"><span>搜索</span><span className="ra-search"><Search size={15} aria-hidden="true"/><input aria-label="搜索阅读明细" placeholder="姓名、邮箱、笔记标题或路径" value={search} onChange={event => setSearch(event.target.value)}/></span></label><button type="button" className="ra-clear-button" disabled={!hasFilters} onClick={clearFilters}>清除筛选</button></div>
        {busyDetails ? <div className="ra-loading" role="status"><LoaderCircle size={19} className="ra-spin"/>正在加载阅读明细…</div> : error ? <Empty title="阅读明细加载失败" description="请点击上方的重新加载，获取当前筛选条件下的数据。"/> : !data?.records.length ? <Empty title={hasFilters ? '没有匹配的阅读记录' : '暂无阅读记录'} description={hasFilters ? '调整筛选条件后再试试。' : '成员在当前笔记停留超过 10 秒后，阅读时间会累计在这里。'}/> : <div className="ra-table-scroll"><table className="ra-table ra-records-table"><thead><tr><th scope="col">成员</th><th scope="col">阅读笔记</th><th scope="col">累计阅读时间</th><th scope="col">最近阅读</th></tr></thead><tbody>{data.records.map(item => <tr key={`${item.userId}:${item.noteId}`}><td><div className="ra-person"><UserAvatar src={item.avatarUrl} name={item.userName}/><span><strong>{item.userName}</strong><small>{item.userEmail}</small></span></div></td><td><div className="ra-record-note">{noteTitle(item.noteId, item.noteTitle)}<small title={item.notePath}>{item.notePath || '根目录'}</small></div></td><td className="ra-duration">{formatReadingDuration(item.totalMs)}</td><td className="ra-date"><LastRead value={item.lastReadAt}/></td></tr>)}</tbody></table></div>}
        {data && !error && <Pagination label="阅读明细分页" page={recordPage} pageSize={detailPageSize} total={data.pagination.total} onChange={setRecordPage} disabled={busyDetails}/>}
      </div>}
    </div>
  </section>;
}
