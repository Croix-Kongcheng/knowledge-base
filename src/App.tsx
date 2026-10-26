import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Command, FileText, Folder, FolderOpen, Grid2X2, HardDrive, Hash, Layers, LayoutDashboard, List, LogIn, MoreHorizontal, Network, PanelLeftClose, PanelLeftOpen, Plus, Search, ShieldCheck, Sparkles, Star, Tag, Upload, UserRoundPen, Users, X } from 'lucide-react';
import type { ImportedNote, ImportReport } from './lib/importer';
import { categories as categoryPalette } from './data';
import { getPendingLegacyNotes, loadLegacyNotes, migrateLocalWorkspace, sanitizeWorkspaceNotes } from './lib/storage';
import type { WorkspaceMember } from './lib/workspace';
import { apiRequest, authApi, notesApi, foldersApi, canEditNote, canDeleteNote, canManageSharing, type SessionUser } from './lib/api';
import type { NoteDraft } from './components/NoteEditor';
import DeleteNoteDialog from './components/DeleteNoteDialog';
import DeleteFolderDialog from './components/DeleteFolderDialog';
import { getCategories, getFolderPaths, getFolderPath, getNotePath } from './lib/library';
import { useWorkspaceLayout } from './lib/useWorkspaceLayout';
import { isExcludedPath } from './lib/privacy';
import FolderTree from './components/FolderTree';
import ThemePicker, { useTheme } from './components/ThemePicker';
import ReadingSettingsButton from './components/ReadingSettingsButton';
import { useReadingPreferences } from './lib/useReadingPreferences';
import NoteTabs from './components/NoteTabs';
import UserAvatar from './components/UserAvatar';
import './components/avatar-viewer.css';
import { EMPTY_NOTE_TABS, openTab, pinTab, closeTab, reconcileTabs, type NoteTabsState } from './lib/noteTabs';
import { SPACE_NAME, SPACE_AFFILIATION, SPACE_FULL_AFFILIATION } from './lib/space';
import { cacheDocument, cacheIndex, cacheSessionDisplay, fetchDocument, forgetDocument, indexNote, materializeIndex, peekDocument, readCachedIndex, readSessionDisplay, type LibraryIndex, type LibraryTotals, type WorkspaceFolder } from './lib/libraryCache';
import { useNoteDocument } from './lib/useNoteDocument';
import { useReadingTracker } from './lib/useReadingTracker';

const importReader = () => import('./components/KnowledgeReader');
let readerModule: ReturnType<typeof importReader> | undefined;
const loadReader = () => readerModule ??= importReader().catch(error => { readerModule = undefined; throw error; });
const warmReader = () => { void loadReader().catch(() => {}); };
const KnowledgeReader = lazy(loadReader);
const ObsidianGraph = lazy(() => import('./components/ObsidianGraph'));
const GrowthChart = lazy(() => import('./components/DashboardCharts').then(module => ({ default: module.GrowthChart })));
const CategoryChart = lazy(() => import('./components/DashboardCharts').then(module => ({ default: module.CategoryChart })));
const MemoFolderTree = memo(FolderTree);
const ignoreFolderSelection = () => {};

const ImportModal = lazy(() => import('./components/ImportModal'));
const AccountModal = lazy(() => import('./components/AccountModal'));
const NoteEditor = lazy(() => import('./components/NoteEditor'));
const ProfileSettings = lazy(() => import('./components/ProfileSettings'));
const AvatarViewer = lazy(() => import('./components/AvatarViewer'));
const ReadingAnalytics = lazy(() => import('./components/ReadingAnalytics'));

const NOTE_TABS_KEY = 'zhiyu-note-tabs-v1';
function restoreNoteTabs(): NoteTabsState {
  try {
    const saved = JSON.parse(sessionStorage.getItem(NOTE_TABS_KEY) || 'null');
    if (!saved || !Array.isArray(saved.ids)) return EMPTY_NOTE_TABS;
    const ids = [...new Set<string>(saved.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 300))];
    return { ids, previewId: typeof saved.previewId === 'string' && ids.includes(saved.previewId) ? saved.previewId : null };
  } catch { return EMPTY_NOTE_TABS; }
}

type Page = 'overview' | 'notes' | 'recent' | 'favorites' | 'tags' | 'graph' | 'members' | 'reading-stats';
const titles: Record<Page, string> = {overview:'知识概览',notes:'全部文档',recent:'最近更新',favorites:'我的收藏',tags:'标签管理',graph:'知识图谱',members:'空间成员','reading-stats':'阅读统计'};
const descriptions: Record<Page,string> = {overview:'每一次记录，都在为下一次灵感积蓄力量。',notes:'从左侧目录打开文档，或在这里搜索全部内容。',recent:'看看最近有哪些新想法，正在悄悄发生。',favorites:'那些值得反复阅读的内容，都在这里。',tags:'让分散的记录，通过共同的主题连接。',graph:'循着一个想法，发现知识之间的联系。',members:'与志同道合的人，一起让知识生长。','reading-stats':'查看成员的阅读积累，以及每篇笔记的阅读情况。'};
const number = (n:number) => new Intl.NumberFormat('en-US').format(n);
const dateLabel = (date:string) => {const value=new Date(date);return Number.isNaN(value.getTime())?'刚刚':`${String(value.getMonth()+1).padStart(2,'0')}.${String(value.getDate()).padStart(2,'0')} ${String(value.getHours()).padStart(2,'0')}:${String(value.getMinutes()).padStart(2,'0')}`;};
const folderContains=(folder:string,value:string)=>{
  const root=folder.normalize('NFC').toLocaleLowerCase();
  const candidate=value.normalize('NFC').toLocaleLowerCase();
  return candidate===root||candidate.startsWith(`${root}/`);
};

export default function App() {
  const [initialWorkspace]=useState(()=>{
    let favorites:string[]=[];
    try{const saved=JSON.parse(localStorage.getItem('zhiyu-stars-v1')||'[]');if(Array.isArray(saved))favorites=saved.filter((id:unknown):id is string=>typeof id==='string');}catch{/* Optional local preferences. */}
    return {notes:null as ImportedNote[]|null,favorites};
  });
  const [notes,setNotes]=useState<ImportedNote[]>([]);
  const [workspaceFolders,setWorkspaceFolders]=useState<WorkspaceFolder[]>([]);
  const [libraryTotals,setLibraryTotals]=useState<LibraryTotals>();
  const [indexVerified,setIndexVerified]=useState(false);
  const liveIndexReceived=useRef(false);
  const sidebar = useWorkspaceLayout();
  useReadingPreferences();
  const { preference: themePreference, setPreference: setThemePreference, resolved: resolvedTheme } = useTheme();
  const [storageReady,setStorageReady]=useState(false);
  const [favorites,setFavorites]=useState<string[]>(initialWorkspace.favorites);
  const [user,setUser]=useState<SessionUser|null>(null);
  const [sessionReady,setSessionReady]=useState(false);
  const [sessionDisplay,setSessionDisplay]=useState(readSessionDisplay);
  const sessionGeneration=useRef(0);
  const [workspaceMembers,setWorkspaceMembers]=useState<WorkspaceMember[]>([]);
  const [loadError,setLoadError]=useState('');
  const [legacyNotes,setLegacyNotes]=useState<ImportedNote[]>([]);
  const [migrationBusy,setMigrationBusy]=useState(false);
  const [migrationStatus,setMigrationStatus]=useState('');
  const [editingNote,setEditingNote]=useState<ImportedNote|null>(null);
  const [deleteTarget,setDeleteTarget]=useState<ImportedNote|null>(null);
  const [deleteFolderTarget,setDeleteFolderTarget]=useState<string|null>(null);
  const [setupToken,setSetupToken]=useState(()=>new URLSearchParams(location.search).get('setup')||'');
  const [page,setPage]=useState<Page>(()=>location.hash.startsWith('#note/')?'notes':'overview');
  const [query,setQuery]=useState('');
  const [searchResult,setSearchResult]=useState<{query:string;ids:Set<string>}>();
  const [searchBusy,setSearchBusy]=useState(false);
  const [graphNotes,setGraphNotes]=useState<ImportedNote[]>([]);
  const [graphError,setGraphError]=useState('');
  const [category,setCategory]=useState('全部分类');
  const [range,setRange]=useState('近 30 天');
  const [importOpen,setImportOpen]=useState(false);
  const [editorOpen,setEditorOpen]=useState(false);
  const [accountOpen,setAccountOpen]=useState(()=>Boolean(new URLSearchParams(location.search).get('setup')));
  const [selectedId,setSelectedId]=useState<string|null>(()=>{try{return location.hash.startsWith('#note/')?decodeURIComponent(location.hash.slice(6)):null;}catch{return null;}});
  useEffect(()=>{if(selectedId)warmReader();},[selectedId]);
  const [noteTabs,setNoteTabs]=useState<NoteTabsState>(restoreNoteTabs);
  const noteTabsRef=useRef(noteTabs);
  noteTabsRef.current=noteTabs;
  const updateNoteTabs=useCallback((change:(previous:NoteTabsState)=>NoteTabsState)=>{
    const previous=noteTabsRef.current;
    const next=change(previous);
    if(next!==previous){noteTabsRef.current=next;setNoteTabs(next);}
    return next;
  },[]);
  const [profileSettingsOpen,setProfileSettingsOpen]=useState(false);
  const [avatarMember,setAvatarMember]=useState<WorkspaceMember|null>(null);
  const [renderedReaderId,setRenderedReaderId]=useState<string|null>(null);
  const [notificationsOpen,setNotificationsOpen]=useState(false);
  const [notificationsRead,setNotificationsRead]=useState(false);
  const [profileOpen,setProfileOpen]=useState(false);
  const [toast,setToast]=useState('');
  const [tableTab,setTableTab]=useState('最近更新');
  const [layout,setLayout]=useState<'list'|'grid'>('list');
  const searchRef=useRef<HTMLInputElement>(null);
  const sidebarRef=useRef<HTMLElement>(null);
  const sidebarToggleRef=useRef<HTMLButtonElement>(null);
  const editorDirty=useRef(false);
  const editorBusy=useRef(false);
  const selectedIdRef=useRef(selectedId);
  selectedIdRef.current=selectedId;
  const navigationGuard=useRef<()=>boolean>(()=>true);
  const setEditorDirty=useCallback((dirty:boolean)=>{editorDirty.current=dirty;},[]);
  const setEditorBusy=useCallback((busy:boolean)=>{editorBusy.current=busy;},[]);
  const pendingAction=useRef<'import'|'create'|null>(null);
  const refreshGeneration=useRef(0);
  const toastTimer=useRef<ReturnType<typeof setTimeout>>();
  const notify=(message:string)=>{setToast(message);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),4000);};
  const leaveEditor=()=>{
    if(editorBusy.current){notify('正在保存，请稍候。');return false;}
    if(editorDirty.current&&!window.confirm('有尚未保存的修改，确定放弃并离开吗？'))return false;
    editorDirty.current=false;setEditorOpen(false);setEditingNote(null);return true;
  };
  navigationGuard.current=leaveEditor;
  const navigate=(next:Page)=>{if(!leaveEditor())return false;setPage(next);setSelectedId(null);selectedIdRef.current=null;setQuery('');setCategory('全部分类');sidebar.closeDrawer();history.replaceState(null,'',location.pathname+location.search);return true;};
  const activateNote=(id:string,replace=false)=>{
    setSelectedId(id);selectedIdRef.current=id;setPage('notes');sidebar.closeDrawer();
    const hash=`#note/${encodeURIComponent(id)}`;
    if(location.hash!==hash)history[replace?'replaceState':'pushState'](null,'',location.pathname+location.search+hash);
    window.scrollTo({top:0});
  };
  const showNote=(id:string,pinned=false)=>{updateNoteTabs(previous=>openTab(previous,id,pinned));activateNote(id);};
  const openNote=(id:string)=>{if(leaveEditor())showNote(id);};
  const openPinnedNote=(id:string)=>{if(leaveEditor())showNote(id,true);};
  const selectNoteTab=(id:string)=>{if(selectedId===id&&(!editorOpen||editingNote))return;if(leaveEditor())activateNote(id);};
  const pinNoteTab=(id:string)=>updateNoteTabs(previous=>pinTab(previous,id));
  const closeNoteTab=(id:string)=>{
    if(id===selectedId&&!leaveEditor())return;
    const previous=noteTabsRef.current;
    const index=previous.ids.indexOf(id);
    const next=updateNoteTabs(state=>closeTab(state,id));
    if(id===selectedId){
      const adjacent=next.ids[Math.min(Math.max(index,0),next.ids.length-1)];
      if(adjacent)activateNote(adjacent,true);else navigate('notes');
    }
  };
  const openAccount=()=>{if(leaveEditor()){setAccountOpen(true);setProfileOpen(false);}};
  const openProfileSettings=()=>{if(user){setProfileSettingsOpen(true);setProfileOpen(false);}};
  const profileUpdated=(account:SessionUser)=>{sessionGeneration.current+=1;setUser(account);setSessionDisplay(account);cacheSessionDisplay(account);void refreshLibrary();notify('个人资料已更新');};
  const closeSidebarDrawer=()=>{sidebar.closeDrawer();sidebarToggleRef.current?.focus();};
  useEffect(()=>{if(sidebarRef.current)sidebarRef.current.inert=!sidebar.visible;},[sidebar.visible]);
  useEffect(()=>{
    if(!sidebar.isMobile||!sidebar.drawerOpen)return;
    const panel=sidebarRef.current;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    panel?.focus();
    const trap=(event:KeyboardEvent)=>{
      if(event.key!=='Tab'||!panel)return;
      const items=[...panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')].filter(item=>item.getClientRects().length>0);
      if(!items.length)return;
      if(event.shiftKey&&(document.activeElement===items[0]||document.activeElement===panel)){event.preventDefault();items[items.length-1].focus();}
      else if(!event.shiftKey&&document.activeElement===items[items.length-1]){event.preventDefault();items[0].focus();}
    };
    document.addEventListener('keydown',trap);
    return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',trap);};
  },[sidebar.isMobile,sidebar.drawerOpen]);
  const refreshLibrary=async()=>{
    const generation=++refreshGeneration.current;
    const identityGeneration=++sessionGeneration.current;
    await Promise.allSettled([
      apiRequest<LibraryIndex>('/notes/index').then(index=>{
        if(generation!==refreshGeneration.current)return;
        liveIndexReceived.current=true;
        const next=materializeIndex(index);
        setNotes(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);setWorkspaceFolders(previous=>JSON.stringify(previous)===JSON.stringify(index.folders||[])?previous:index.folders||[]);setLibraryTotals(index.totals);setStorageReady(true);setIndexVerified(true);setLoadError('');void cacheIndex(index);
      }).catch(cause=>{if(generation===refreshGeneration.current)setLoadError(cause instanceof Error?cause.message:'知识库加载失败，请重试。');}),
      authApi.session().then(session=>{
        if(identityGeneration!==sessionGeneration.current)return;
        setUser(session.user);setSessionDisplay(session.user);setSessionReady(true);cacheSessionDisplay(session.user);
      }),
      apiRequest<{members:(Omit<WorkspaceMember,'role'>&{role:'admin'|'member'})[]}>('/members').then(members=>setWorkspaceMembers(members.members.map<WorkspaceMember>(member=>({...member,role:member.role==='admin'?'空间管理员':'协作成员'})))),
    ]);
  };
  useEffect(()=>{
    void readCachedIndex().then(index=>{if(index&&!liveIndexReceived.current){setNotes(materializeIndex(index));setWorkspaceFolders(index.folders||[]);setLibraryTotals(index.totals);setStorageReady(true);}});
    void refreshLibrary();
    const legacyTimer=setTimeout(()=>{
      const legacy=migrateLocalWorkspace();
      void loadLegacyNotes().then(saved=>setLegacyNotes(saved||legacy.notes||[])).catch(()=>setLegacyNotes(legacy.notes||[]));
    },1200);
    const focus=()=>{if(document.visibilityState==='visible')void refreshLibrary();};
    const expired=()=>{sessionGeneration.current+=1;setUser(null);setSessionDisplay(null);setSessionReady(true);cacheSessionDisplay(null);notify('登录已过期，请重新登录后继续操作。');};
    window.addEventListener('focus',focus);window.addEventListener('session-expired',expired);
    const timer=setInterval(focus,30000);
    return()=>{refreshGeneration.current+=1;sessionGeneration.current+=1;clearTimeout(legacyTimer);clearInterval(timer);window.removeEventListener('focus',focus);window.removeEventListener('session-expired',expired);};
  },[]);
  useEffect(()=>{
    if(!query.trim()){setSearchBusy(false);setSearchResult(undefined);return;}
    let active=true;setSearchBusy(true);
    const controller=new AbortController();
    const timer=setTimeout(()=>{void apiRequest<{ids:string[]}>(`/notes/search?q=${encodeURIComponent(query)}`,{signal:controller.signal}).then(result=>{if(active){setSearchResult({query,ids:new Set(result.ids)});setSearchBusy(false);}}).catch(()=>{if(active){setSearchBusy(false);setLoadError('全文搜索暂时无法连接，请重试。');}});},180);
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[query,notes]);
  useEffect(()=>{
    if(page!=='graph')return;
    let active=true;setGraphError('');
    void notesApi.list().then(saved=>{if(active)setGraphNotes(saved);}).catch(cause=>{if(active)setGraphError(cause instanceof Error?cause.message:'图谱暂时无法读取');});
    return()=>{active=false;};
  },[page,notes]);
  useEffect(()=>{try{localStorage.setItem('zhiyu-stars-v1',JSON.stringify(favorites));}catch{/* Keep the current session usable. */}},[favorites]);
  useEffect(()=>{
    const keyboard=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();if(!document.querySelector('[aria-modal="true"]'))searchRef.current?.focus();}if(e.key==='Escape'){setNotificationsOpen(false);setProfileOpen(false);sidebar.closeDrawer();}};
    const onHash=()=>{
      let next:string|null=null;
      try{next=window.location.hash.startsWith('#note/')?decodeURIComponent(window.location.hash.slice(6)):null;}catch{/* Treat an invalid link as the overview. */}
      if(next!==selectedIdRef.current&&!navigationGuard.current()){history.pushState(null,'',location.pathname+location.search+(selectedIdRef.current?`#note/${encodeURIComponent(selectedIdRef.current)}`:''));return;}
      setSelectedId(next);selectedIdRef.current=next;if(next){updateNoteTabs(previous=>openTab(previous,next));setPage('notes');}
    };
    const beforeUnload=(event:BeforeUnloadEvent)=>{if(editorDirty.current||editorBusy.current){event.preventDefault();event.returnValue='';}};
    document.addEventListener('keydown',keyboard);window.addEventListener('hashchange',onHash);window.addEventListener('popstate',onHash);onHash();
    window.addEventListener('beforeunload',beforeUnload);
    return()=>{document.removeEventListener('keydown',keyboard);window.removeEventListener('hashchange',onHash);window.removeEventListener('popstate',onHash);window.removeEventListener('beforeunload',beforeUnload);clearTimeout(toastTimer.current);};
  },[]);
  useEffect(()=>{try{sessionStorage.setItem(NOTE_TABS_KEY,JSON.stringify(noteTabs));}catch{/* Tabs still work when storage is unavailable. */}},[noteTabs]);
  useEffect(()=>{
    if(!indexVerified)return;
    const valid=notes.map(note=>note.id);
    if(editorOpen&&editingNote)valid.push(editingNote.id);
    updateNoteTabs(previous=>reconcileTabs(previous,valid));
    if(selectedId&&!editorOpen&&!valid.includes(selectedId)){
      setSelectedId(null);selectedIdRef.current=null;setPage('notes');setQuery('');setCategory('全部分类');
      history.replaceState(null,'',location.pathname+location.search);
    }
  },[notes,indexVerified,editorOpen,editingNote,selectedId,updateNoteTabs]);
  useEffect(()=>{if(!user)setProfileSettingsOpen(false);},[user]);
  useEffect(()=>{
    // Wait for verified identity; guest rechecks must respect a dismissed prompt.
    if(sessionReady&&!user?.id)setAccountOpen(true);
  },[sessionReady,user?.id]);
  useEffect(()=>{if(sessionReady&&user?.role!=='admin'&&page==='reading-stats')setPage('overview');},[sessionReady,user?.role,page]);
  const toggleFavorite=(id:string)=>setFavorites(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);
  const sortedNotes=useMemo(()=>[...notes].sort((a,b)=>new Date(b.updatedAt).getTime()-new Date(a.updatedAt).getTime()),[notes]);
  const filteredNotes=useMemo(()=>sortedNotes.filter(note=>(page!=='favorites'&&!(page==='overview'&&tableTab==='我的收藏')||favorites.includes(note.id))&&(category==='全部分类'||getFolderPath(note)===category||getFolderPath(note).startsWith(`${category}/`)||(category==='未分类'&&!getFolderPath(note)))&&(!query.trim()||searchResult?.query===query&&searchResult.ids.has(note.id)||`${note.title} ${note.tags.join(' ')} ${note.author}`.toLowerCase().includes(query.toLowerCase()))),[sortedNotes,page,tableTab,favorites,category,query,searchResult]);
  const currentSummary=useMemo(()=>notes.find(n=>n.id===selectedId),[notes,selectedId]);
  const noteDocument=useNoteDocument(selectedId,currentSummary?.revision);
  const currentNote=useMemo(()=>noteDocument.note&&(!indexVerified||currentSummary)?{...noteDocument.note,...currentSummary,content:noteDocument.note.content,attachments:noteDocument.note.attachments,attachmentSizes:noteDocument.note.attachmentSizes,revision:noteDocument.note.revision}:undefined,[noteDocument.note,currentSummary,indexVerified]);
  const readingTracker=useReadingTracker({
    userId:sessionReady?user?.id||null:null,
    noteId:currentNote?.id===renderedReaderId?renderedReaderId:null,
    enabled:Boolean(selectedId&&selectedId===renderedReaderId&&!editorOpen&&!importOpen&&!accountOpen&&!profileSettingsOpen&&!deleteTarget&&!deleteFolderTarget&&!avatarMember&&!sidebar.drawerOpen),
  });
  const allCategories=useMemo(()=>getCategories(notes),[notes]);
  const allFolderPaths=useMemo(()=>getFolderPaths(notes,workspaceFolders.map(folder=>folder.path)),[notes,workspaceFolders]);
  const categories=useMemo(()=>allCategories.map((name,i)=>{const count=notes.filter(note=>getFolderPath(note)===name||getFolderPath(note).startsWith(`${name}/`)||(name==='未分类'&&!getFolderPath(note))).length;return {...categoryPalette[i%categoryPalette.length],name,count,percent:notes.length?Math.round(count/notes.length*100):0};}),[notes,allCategories]);
  const totalAttachments=libraryTotals?.attachments??0;
  const allTags=useMemo(()=>[...new Set(notes.flatMap(n=>n.tags))],[notes]);
  const visibleUser=user||(!sessionReady?sessionDisplay:null);
  const currentRole=!sessionReady?'正在连接…':user?(user.role==='admin'?'空间管理员':'协作成员'):'未登录';
  const initials=(visibleUser?.name||'访客').includes(' ')?(visibleUser?.name||'访客').split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]).join('').toUpperCase():Array.from(visibleUser?.name||'访客').slice(-1).join('');
  const storedBytes=(libraryTotals?.contentBytes??0)+(libraryTotals?.attachmentBytes??0);
  const storedSize=storedBytes<1024?'0 KB':storedBytes<1024*1024?`${number(Math.ceil(storedBytes/1024))} KB`:`${(storedBytes/1024/1024).toFixed(1)} MB`;
  const applySaved=(saved:ImportedNote)=>{
    refreshGeneration.current+=1;
    cacheDocument(saved);
    const metadata=indexNote(saved);
    setNotes(previous=>previous.some(note=>note.id===saved.id)?previous.map(note=>note.id===saved.id?metadata:note):[metadata,...previous]);
    void refreshLibrary();
  };
  const openImport=()=>{if(!leaveEditor())return;if(!sessionReady){notify('正在确认登录状态，请稍候。');return;}if(!user){pendingAction.current='import';setAccountOpen(true);return;}setImportOpen(true);};
  const openCreate=()=>{if(!leaveEditor())return;if(!sessionReady){notify('正在确认登录状态，请稍候。');return;}if(!user){pendingAction.current='create';setAccountOpen(true);return;}setEditingNote(null);setEditorOpen(true);sidebar.closeDrawer();window.scrollTo({top:0});};
  const openEdit=(note:ImportedNote)=>{if(!canEditNote(note,user)){notify('此笔记仅作者可修改。');return;}if(!leaveEditor())return;updateNoteTabs(previous=>openTab(previous,note.id,true));setEditingNote(note);setEditorOpen(true);window.scrollTo({top:0});};
  const handleImport=async(imported:ImportedNote[],report:ImportReport)=>{
    if(!user)throw new Error('请先登录，再导入笔记。');
    const result=await notesApi.importBatch(sanitizeWorkspaceNotes(imported));
    // IDs and links come from the server. Reimports update the original note,
    // so favorites and open tabs keep pointing at the same durable identity.
    const saved=new Map(result.notes.map(note=>[note.id,note]));
    const openIds=new Set(noteTabsRef.current.ids);
    for(const note of saved.values())if(openIds.has(note.id)||peekDocument(note.id))cacheDocument(note);
    const active=selectedIdRef.current?saved.get(selectedIdRef.current):undefined;
    if(active)cacheDocument(active);
    refreshGeneration.current+=1;
    setNotes(previous=>{
      const merged=new Map(previous.map(note=>[note.id,note]));
      for(const note of saved.values()){
        const current=merged.get(note.id);
        if(current?.revision!==undefined&&note.revision!==undefined&&current.revision>note.revision)continue;
        merged.set(note.id,indexNote(note));
      }
      return [...merged.values()];
    });
    void refreshLibrary();
    const updated=result.updatedCount>0?`，更新 ${number(result.updatedCount)} 篇（保留阅读统计）`:'';
    notify(`导入完成：新增 ${number(result.createdCount)} 篇${updated}，${number(report.attachments)} 个附件`);
  };
  const handleSave=async(draft:NoteDraft)=>{
    if(!user)throw new Error('请先登录后保存笔记。');
    if(editingNote&&!canEditNote(editingNote,user))throw new Error('你没有修改此笔记的权限。');
    const saved=editingNote?await notesApi.update({...editingNote,...draft}):await notesApi.create(draft);
    applySaved(saved);editorDirty.current=false;editorBusy.current=false;setEditorOpen(false);setEditingNote(null);showNote(saved.id,true);notify(editingNote?'笔记修改已保存':'新笔记已保存');
  };
  const moveNote=async(id:string,folder:string)=>{
    try{
      const summary=notes.find(item=>item.id===id);
      if(!summary)throw new Error('文档已不存在，请刷新目录后重试。');
      const note=await fetchDocument(id);
      if(!canEditNote(note,user))throw new Error('你没有移动此文档的权限。');
      if(editorBusy.current)throw new Error('正在保存，请稍候再移动文档。');
      if(isExcludedPath(folder))throw new Error('此目录不可用于知识库分类。');
      if(getFolderPath(note)===folder)return;
      const filename=getNotePath(note).split('/').pop()||`${note.title}.md`;
      const path=folder?`${folder}/${filename}`:filename;
      const key=(value:string)=>value.normalize('NFC').toLocaleLowerCase();
      if(notes.some(item=>item.id!==note.id&&key(getNotePath(item))===key(path)))throw new Error('目标文件夹已有同名文档，请先重命名或选择其他文件夹。');
      if(editingNote?.id===id&&!leaveEditor())throw new DOMException('已取消移动','AbortError');
      applySaved(await notesApi.update({...note,path,category:folder.split('/')[0]||'未分类'}));
      notify('文档已移动');
    }catch(cause){
      if(!(cause instanceof DOMException&&cause.name==='AbortError')){
        notify(cause instanceof Error?cause.message:'移动失败，请重试。');
        void refreshLibrary();
      }
      throw cause;
    }
  };
  const requireDirectoryUser=()=>{
    if(!sessionReady||!user)throw new Error('请先登录，再整理文档目录。');
    return user;
  };
  const createDirectoryNote=async(folder:string,name:string)=>{
    requireDirectoryUser();
    const title=name.trim().normalize('NFC').replace(/\.(md|markdown)$/i,'');
    if(!title||title==='.'||title==='..'||Array.from(title).length>252||/[\\/<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)||/[. ]$/.test(title))throw new Error('请输入有效的笔记名称，不能包含路径分隔符、控制字符或无效文件名字符。');
    const path=`${folder?`${folder}/`:''}${title}.md`;
    const key=(value:string)=>value.normalize('NFC').toLocaleLowerCase();
    if(notes.some(note=>key(getNotePath(note))===key(path))||allFolderPaths.some(value=>key(value)===key(path)))throw new Error('这个位置已有同名文件或文件夹，请换一个名称。');
    if(!leaveEditor())throw new DOMException('已取消新建','AbortError');
    const saved=await notesApi.create({title,content:'',path,category:folder.split('/')[0]||'未分类',tags:[]});
    applySaved(saved);showNote(saved.id,true);setEditingNote(saved);setEditorOpen(true);sidebar.closeDrawer();window.scrollTo({top:0});
    notify('笔记已创建，可以直接开始写作');
  };
  const createDirectoryFolder=async(parent:string,name:string)=>{
    requireDirectoryUser();
    const folder=await foldersApi.create(parent,name);
    refreshGeneration.current+=1;
    setWorkspaceFolders(previous=>[...previous.filter(item=>item.path!==folder.path),folder]);
    await refreshLibrary();notify('文件夹已创建');
  };
  const renameDirectoryNote=async(id:string,name:string)=>{
    const account=requireDirectoryUser();
    const note=notes.find(item=>item.id===id);
    if(!note)throw new Error('文档已不存在，请刷新目录后重试。');
    if(!canEditNote(note,account))throw new Error('你没有重命名此笔记的权限。');
    if(editorBusy.current)throw new Error('正在保存，请稍候再重命名。');
    if(editingNote?.id===id&&!leaveEditor())throw new DOMException('已取消重命名','AbortError');
    applySaved(await notesApi.rename(id,name,note.revision));notify('笔记已重命名');
  };
  const renameDirectoryFolder=async(path:string,name:string)=>{
    requireDirectoryUser();
    if(editorBusy.current)throw new Error('正在保存，请稍候再重命名。');
    if(editingNote&&folderContains(path,getFolderPath(editingNote))&&!leaveEditor())throw new DOMException('已取消重命名','AbortError');
    const index=await foldersApi.rename(path,name);
    refreshGeneration.current+=1;liveIndexReceived.current=true;
    setNotes(materializeIndex(index));setWorkspaceFolders(index.folders||[]);setLibraryTotals(index.totals);setStorageReady(true);setIndexVerified(true);setLoadError('');void cacheIndex(index);
    notify('文件夹及其子目录已重命名');
  };
  const requestDirectoryDelete=(id:string)=>{
    const note=notes.find(item=>item.id===id);
    if(!note||!canDeleteNote(note,user)){notify('只有作者可以删除此笔记。');return;}
    if(editingNote?.id===id&&!leaveEditor())return;
    setDeleteTarget(note);
  };
  const requestDirectoryFolderDelete=(path:string)=>{
    if(!canDeleteDirectoryFolder(path)){notify('文件夹内含有无权删除的笔记或文件夹。');return;}
    setDeleteFolderTarget(path);
  };
  const deleteDirectoryFolder=async()=>{
    requireDirectoryUser();
    const path=deleteFolderTarget;
    if(!path||!canDeleteDirectoryFolder(path))throw new Error('文件夹已不存在，或包含无权删除的笔记或文件夹。');
    if(editorBusy.current)throw new Error('正在保存，请稍候再删除文件夹。');
    const deletesEditor=Boolean(editingNote&&folderContains(path,getFolderPath(editingNote)));
    if(deletesEditor&&editorDirty.current&&!window.confirm('此文件夹内有尚未保存的修改，确定删除并放弃这些修改吗？'))throw new DOMException('已取消删除，未保存的修改已保留。','AbortError');
    const index=await foldersApi.remove(path);
    const validIds=new Set(index.notes.map(note=>note.id));
    refreshGeneration.current+=1;liveIndexReceived.current=true;
    for(const note of notes)if(!validIds.has(note.id))forgetDocument(note.id);
    setNotes(materializeIndex(index));setWorkspaceFolders(index.folders||[]);setLibraryTotals(index.totals);setStorageReady(true);setIndexVerified(true);setLoadError('');void cacheIndex(index);
    setFavorites(previous=>previous.filter(id=>validIds.has(id)));
    const remainingTabs=updateNoteTabs(previous=>reconcileTabs(previous,validIds));
    if(deletesEditor){editorDirty.current=false;setEditorOpen(false);setEditingNote(null);}
    if(deleteTarget&&!validIds.has(deleteTarget.id))setDeleteTarget(null);
    if(selectedIdRef.current&&!validIds.has(selectedIdRef.current)){
      const adjacent=remainingTabs.ids[remainingTabs.ids.length-1];
      if(adjacent)activateNote(adjacent,true);
      else{setSelectedId(null);selectedIdRef.current=null;setPage('notes');history.replaceState(null,'',location.pathname+location.search);}
    }
    if(category!=='全部分类'&&folderContains(path,category))setCategory('全部分类');
    setDeleteFolderTarget(null);notify('文件夹及其全部子目录和笔记已删除');
  };
  const toggleSharing=async(note:ImportedNote,enabled:boolean)=>{
    if(!canManageSharing(user))throw new Error('只有管理员可以调整协作权限。');
    applySaved(await notesApi.sharing(note.id,enabled,note.revision));
    notify(enabled?'已允许所有成员编辑此笔记':'已恢复为仅作者可编辑');
  };
  const deleteNote=async()=>{
    if(!deleteTarget||!canDeleteNote(deleteTarget,user))throw new Error('只有作者可以删除此笔记。');
    const id=deleteTarget.id;
    await notesApi.remove(id);refreshGeneration.current+=1;forgetDocument(id);
    setNotes(previous=>previous.filter(note=>note.id!==id));setFavorites(previous=>previous.filter(value=>value!==id));
    setDeleteTarget(null);closeNoteTab(id);notify('笔记已删除');void refreshLibrary();
  };
  const register=(account:SessionUser)=>{
    sessionGeneration.current+=1;setUser(account);setSessionDisplay(account);setSessionReady(true);cacheSessionDisplay(account);setAccountOpen(false);setProfileOpen(false);setProfileSettingsOpen(false);
    if(setupToken){setSetupToken('');const url=new URL(location.href);url.searchParams.delete('setup');history.replaceState(null,'',url.pathname+url.search+url.hash);}
    try{localStorage.removeItem('zhiyu-user-v1');}catch{/* The server session is the source of identity. */}
    void refreshLibrary();notify(`欢迎，${account.name}`);
    if(pendingAction.current==='import')setImportOpen(true);
    if(pendingAction.current==='create'){setEditingNote(null);setEditorOpen(true);sidebar.closeDrawer();window.scrollTo({top:0});}
    pendingAction.current=null;
  };
  const logout=async()=>{if(!leaveEditor())return;try{await readingTracker.stop();await authApi.logout();refreshGeneration.current+=1;sessionGeneration.current+=1;setUser(null);setSessionDisplay(null);setSessionReady(true);cacheSessionDisplay(null);setProfileOpen(false);pendingAction.current=null;notify('已退出登录');}catch(cause){notify(cause instanceof Error?cause.message:'退出失败，请重试。');}};
  const pendingLegacy=useMemo(()=>getPendingLegacyNotes(legacyNotes,notes),[legacyNotes,notes]);
  const migrate=async()=>{
    if(user?.role!=='admin'||migrationBusy)return;
    const count=pendingLegacy.length;setMigrationBusy(true);setMigrationStatus('正在准备旧版笔记…');
    try{const {migrateLegacyNotes}=await import('./lib/migration');const migrated=await migrateLegacyNotes(legacyNotes,setMigrationStatus);refreshGeneration.current+=1;setNotes(previous=>{const merged=new Map(previous.map(note=>[note.id,note]));for(const note of migrated)merged.set(note.id,indexNote(note));return [...merged.values()];});setLegacyNotes([]);void refreshLibrary();notify(`已迁移 ${number(count)} 篇笔记，原浏览器数据已保留`);}
    catch(cause){setMigrationStatus(cause instanceof Error?cause.message:'迁移失败，原浏览器数据仍保留，可稍后重试。');}
    finally{setMigrationBusy(false);}
  };

  const directoryActions=useRef({openNote,openPinnedNote,moveNote,createDirectoryNote,createDirectoryFolder,renameDirectoryNote,renameDirectoryFolder,requestDirectoryDelete,requestDirectoryFolderDelete});
  directoryActions.current={openNote,openPinnedNote,moveNote,createDirectoryNote,createDirectoryFolder,renameDirectoryNote,renameDirectoryFolder,requestDirectoryDelete,requestDirectoryFolderDelete};
  const openDirectoryNote=useCallback((id:string)=>directoryActions.current.openNote(id),[]);
  const pinDirectoryNote=useCallback((id:string)=>directoryActions.current.openPinnedNote(id),[]);
  const moveDirectoryNote=useCallback((id:string,folder:string)=>directoryActions.current.moveNote(id,folder),[]);
  const canMoveDirectoryNote=useCallback((note:ImportedNote)=>canEditNote(note,user),[user]);
  const createNoteInDirectory=useCallback((folder:string,name:string)=>directoryActions.current.createDirectoryNote(folder,name),[]);
  const createFolderInDirectory=useCallback((parent:string,name:string)=>directoryActions.current.createDirectoryFolder(parent,name),[]);
  const renameNoteInDirectory=useCallback((id:string,name:string)=>directoryActions.current.renameDirectoryNote(id,name),[]);
  const renameFolderInDirectory=useCallback((path:string,name:string)=>directoryActions.current.renameDirectoryFolder(path,name),[]);
  const deleteNoteInDirectory=useCallback((id:string)=>directoryActions.current.requestDirectoryDelete(id),[]);
  const deleteFolderInDirectory=useCallback((path:string)=>directoryActions.current.requestDirectoryFolderDelete(path),[]);
  const canDeleteDirectoryNote=useCallback((note:ImportedNote)=>canDeleteNote(note,user),[user]);
  const canRenameDirectoryFolder=useCallback((path:string)=>{
    if(!user)return false;
    const containedNotes=notes.filter(note=>folderContains(path,getFolderPath(note)));
    const containedFolders=workspaceFolders.filter(folder=>folderContains(path,folder.path));
    return Boolean(containedNotes.length||containedFolders.length)&&containedNotes.every(note=>canEditNote(note,user))&&containedFolders.every(folder=>folder.ownerId===user.id||user.role==='admin');
  },[notes,workspaceFolders,user]);
  const canDeleteDirectoryFolder=useCallback((path:string)=>{
    if(!user||!path)return false;
    const containedNotes=notes.filter(note=>folderContains(path,getFolderPath(note)));
    const containedFolders=workspaceFolders.filter(folder=>folderContains(path,folder.path));
    return Boolean(containedNotes.length||containedFolders.length)&&containedNotes.every(note=>canDeleteNote(note,user))&&containedFolders.every(folder=>folder.ownerId===user.id||user.role==='admin');
  },[notes,workspaceFolders,user]);

  const tabNotes=noteTabs.ids.map(id=>notes.find(note=>note.id===id)).filter((note):note is ImportedNote=>Boolean(note));
  const documentTabs=<NoteTabs tabs={tabNotes.map(note=>({id:note.id,title:note.title,path:getNotePath(note),preview:noteTabs.previewId===note.id}))} activeId={editorOpen&&!editingNote?null:selectedId} onSelect={selectNoteTab} onPin={pinNoteTab} onClose={closeNoteTab}/>;

  const navItem=(id:Page,Icon:typeof FileText,label:string,extra?:ReactNode)=><button className={`nav-item ${page===id?'active':''}`} onClick={()=>navigate(id)}><Icon size={18}/><span>{label}</span>{extra}</button>;
  const noteTable=(limit?:number)=><div className="table-scroll" onPointerEnter={warmReader} onFocusCapture={warmReader}><table className="notes-table"><thead><tr><th>笔记名称</th><th>所属分类</th><th>创建者</th><th>更新时间 <ChevronDown size={11}/></th><th aria-label="收藏"/></tr></thead><tbody>{filteredNotes.slice(0,limit).map((note,i)=><tr key={note.id} onClick={()=>openNote(note.id)} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter')openNote(note.id);}}><td><span className={`file-icon file-${i%4}`}><FileText size={18}/></span><span className="note-name"><strong>{note.title}</strong><span>{note.tags.slice(0,2).map(tag=><span key={tag}># {tag}</span>)}</span></span></td><td><span className="category-pill" style={{background:categories.find(c=>c.name===note.category)?.bg||'#f1ecfb',color:categories.find(c=>c.name===note.category)?.color||'#8670e5'}}>{note.category}</span></td><td><span className="author-cell"><UserAvatar className="avatar-xs" src={note.ownerAvatarUrl} name={note.author} fallback={note.avatar} style={{background:note.color}}/>{note.author}</span></td><td className="date-cell">{dateLabel(note.updatedAt)}</td><td><button className={`star-button ${favorites.includes(note.id)?'starred':''}`} title={favorites.includes(note.id)?'取消收藏':'收藏笔记'} aria-label={favorites.includes(note.id)?`取消收藏 ${note.title}`:`收藏 ${note.title}`} onClick={e=>{e.stopPropagation();toggleFavorite(note.id);}}><Star size={16} fill={favorites.includes(note.id)?'currentColor':'none'}/></button></td></tr>)}</tbody></table>{!filteredNotes.length&&<div className="empty-state"><Search size={30}/><strong>{query?(searchBusy?'正在搜索全文…':'没有找到相关笔记'):'这里还没有笔记'}</strong><p>{query?(searchBusy?'目录和正文同时检索，请稍候。':'换一个关键词，或试试按分类查找。'):'导入已有笔记，或写下第一个想法。'}</p><button className="button secondary" onClick={()=>query?setQuery(''):openImport()}>{query?'清除搜索':'导入笔记'}</button></div>}</div>;

  return <div className={`app-shell ${selectedId||editorOpen?'workspace-is-reading':''} ${sidebar.collapsed?'sidebar-collapsed':''} ${sidebar.resizing?'sidebar-is-resizing':''}`} style={sidebar.style}>
    {sidebar.isMobile&&sidebar.drawerOpen&&<div className="sidebar-scrim" onClick={closeSidebarDrawer} aria-hidden="true"/>}
    <aside ref={sidebarRef} id="workspace-sidebar" className={`sidebar ${sidebar.drawerOpen?'is-open':''}`} hidden={!sidebar.isMobile&&sidebar.collapsed} aria-label="文档导航" aria-hidden={!sidebar.visible} tabIndex={-1}>
      <div className="sidebar-head"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('overview');}} title={SPACE_FULL_AFFILIATION}><span className="brand-mark"><Layers size={24} strokeWidth={1.8}/></span><span className="brand-name">知屿<span>{SPACE_AFFILIATION}</span></span></a><button className="icon-button sidebar-drawer-close" aria-label="关闭文档导航" onClick={closeSidebarDrawer}><X size={19}/></button></div>
      <div className="sidebar-workspace" title={SPACE_FULL_AFFILIATION}><FolderOpen size={16}/><strong>{SPACE_NAME}</strong><span>{storageReady?`${number(notes.length)} 篇文档`:'正在连接…'}</span></div>
      <nav className="sidebar-main-nav" aria-label="主导航">{navItem('overview',LayoutDashboard,'知识概览')}</nav>
      <div className="sidebar-directory-heading"><strong>文档目录</strong><div className="directory-actions"><button className="icon-button" aria-label="查看全部文档" title="查看全部文档" onClick={()=>navigate('notes')}><List size={17}/></button><button className="icon-button" aria-label="新建笔记" title="新建笔记" onClick={openCreate}><Plus size={18}/></button><button className="icon-button" aria-label="导入笔记" title="导入笔记" onClick={openImport}><Upload size={16}/></button></div></div>
      <div className="sidebar-directory" onPointerEnter={warmReader} onFocusCapture={warmReader}>{!storageReady&&<div className="directory-loading" role="status" aria-label="正在加载文档目录"><i/><i/><i/><i/><i/></div>}<MemoFolderTree notes={notes} selectedPath="" onSelect={ignoreFolderSelection} onOpenNote={openDirectoryNote} onPinNote={pinDirectoryNote} activeNoteId={selectedId||undefined} browseOnly showToolbar extraFolders={workspaceFolders} canCreate={sessionReady&&Boolean(user)} canMoveNote={canMoveDirectoryNote} onMoveNote={moveDirectoryNote} canRenameFolder={canRenameDirectoryFolder} canDeleteFolder={canDeleteDirectoryFolder} canRenameNote={canMoveDirectoryNote} canDeleteNote={canDeleteDirectoryNote} onCreateNote={createNoteInDirectory} onCreateFolder={createFolderInDirectory} onRenameFolder={renameFolderInDirectory} onDeleteFolder={deleteFolderInDirectory} onRenameNote={renameNoteInDirectory} onDeleteNote={deleteNoteInDirectory}/></div>
      <>{user?.role==='admin'&&<nav className="sidebar-admin-nav" aria-label="管理员功能">{navItem('reading-stats',Clock3,'阅读统计')}</nav>}</><nav className="sidebar-utilities" aria-label="工作空间功能">{navItem('graph',Network,'知识图谱')}{navItem('tags',Tag,'标签管理')}{navItem('members',Users,'空间成员')}</nav>
      <div className="sidebar-bottom"><div className="sidebar-storage"><HardDrive size={14}/><span title={`${number(notes.length)} 篇文档 · ${number(totalAttachments)} 个附件`}>{storedSize} · {number(totalAttachments)} 个附件</span><button className="icon-button" aria-label="使用帮助" title="使用帮助" onClick={()=>notify('拖动文档到文件夹可移动位置，拖动侧栏边缘可调宽；目录支持搜索和定位当前文档。')}><CircleHelp size={16}/></button></div></div>
    </aside>
    <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={sidebar.maximumWidth} aria-valuenow={sidebar.width} tabIndex={0} hidden={sidebar.isMobile||sidebar.collapsed} title="拖动调整侧栏宽度，双击恢复默认" {...sidebar.resizeProps}/>

    <div className={`workspace-main ${tabNotes.length?'workspace-has-tabs':''}`}>
      <header className="topbar"><div className="breadcrumbs"><button ref={sidebarToggleRef} className="icon-button sidebar-toggle" aria-label={sidebar.visible?"收起侧栏":"展开侧栏"} title={sidebar.visible?"收起侧栏":"展开侧栏"} aria-controls="workspace-sidebar" aria-expanded={sidebar.visible} onClick={sidebar.toggle}>{sidebar.visible?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}</button><span className="breadcrumb-parent">工作空间</span><ChevronRight size={13}/><span>{editorOpen?(editingNote?.title||'新建笔记'):currentNote?currentNote.title:titles[page]}</span></div><div className="topbar-right"><div className="global-search"><Search size={16}/><input ref={searchRef} aria-label="搜索笔记" placeholder="搜索笔记、标签或内容…" value={query} onChange={e=>{if(!leaveEditor())return;if(selectedId)history.replaceState(null,'',location.pathname+location.search);setSelectedId(null);setQuery(e.target.value);if(!['overview','notes','recent','favorites'].includes(page))setPage('notes');}}/><kbd><Command size={11}/> K</kbd></div><ReadingSettingsButton/><ThemePicker value={themePreference} onChange={setThemePreference}/><div className="topbar-divider"/><div className="popover-anchor"><button className="icon-button notification-button" aria-label="通知" aria-expanded={notificationsOpen} onClick={()=>{setNotificationsOpen(!notificationsOpen);setProfileOpen(false);}}><Bell size={19}/>{!notificationsRead&&<span className="notification-dot"/>}</button>{notificationsOpen&&<div className="top-popover notification-popover"><div className="popover-heading"><strong>空间动态</strong><button className="icon-button" aria-label="全部标为已读" onClick={()=>setNotificationsRead(true)}><CheckCheck size={17}/></button></div><div className="notification-entry"><span className="event-icon"><Sparkles size={16}/></span><div><strong>欢迎来到你的知识空间</strong><p>从导入你的第一份笔记开始，让知识连接起来。</p><small>知识库使用指引</small></div></div><button className="popover-action" onClick={()=>{setNotificationsOpen(false);openImport();}}>导入笔记 <ArrowRight size={14}/></button></div>}</div><div className="popover-anchor"><button className="profile-button" onClick={()=>{setProfileOpen(!profileOpen);setNotificationsOpen(false);}} aria-label="账号菜单" aria-expanded={profileOpen} aria-busy={!sessionReady} disabled={!sessionReady}><UserAvatar className="avatar-profile" src={visibleUser?.avatarUrl} name={visibleUser?.name||'访客'} fallback={initials}/><span>{visibleUser?.name||(sessionReady?'访客':'正在连接…')}<small>{currentRole}</small></span><ChevronDown size={12}/></button>{profileOpen&&<div className="top-popover profile-popover"><div className="profile-popover-info"><strong>{user?.name||'访客'}</strong><small>{user?.email||'欢迎体验知屿知识库'}</small></div>{user&&<button onClick={openProfileSettings}><UserRoundPen size={16}/>个人资料</button>}<button onClick={openAccount}><LogIn size={16}/>{user?'切换账号':'注册 / 登录'}</button><button onClick={()=>{navigate('members');setProfileOpen(false);}}><Users size={16}/>空间成员</button>{user&&<button onClick={()=>void logout()}><ArrowDownLeft size={16}/>退出登录</button>}<p>登录后可创建笔记，其他成员默认只读</p></div>}</div></div></header>

      {(!selectedId||!currentNote||editorOpen)&&documentTabs}
      <main className={`main-content ${selectedId||editorOpen?'reading-content':page==='graph'?'graph-content':''}`}>
        {loadError&&<div className="workspace-banner" role="alert"><span>{loadError}</span><button className="text-button" onClick={()=>void refreshLibrary()}>重新连接</button></div>}
        {user?.role==='admin'&&pendingLegacy.length>0&&<div className="workspace-banner migration-banner"><div><strong>此浏览器有 {number(pendingLegacy.length)} 篇旧版笔记</strong><p>{migrationStatus||'迁移到共享知识库后，所有设备均可查看。原浏览器数据会保留。'}</p></div><button className="button secondary" disabled={migrationBusy} onClick={()=>void migrate()}>{migrationBusy?'正在迁移…':'迁移本机已有笔记'}</button></div>}
        {editorOpen ? <Suspense fallback={<div className="inline-editor-loading" role="status">正在打开编辑器…</div>}><NoteEditor inline key={editingNote?.id||'new-note'} categories={allFolderPaths} initialCategory={currentNote?getFolderPath(currentNote):category==='全部分类'||category==='未分类'?'':category} existingNote={editingNote||undefined} open onClose={leaveEditor} onSave={handleSave} onDirtyChange={setEditorDirty} onBusyChange={setEditorBusy}/></Suspense> : selectedId ? currentNote ? <Suspense fallback={<section className="kr-reader reader-loading"><div className="kr-tabbar">{documentTabs}</div><ReadingPlaceholder/></section>}><ReaderPresence noteId={currentNote.id} onChange={setRenderedReaderId}/><KnowledgeReader tabs={documentTabs} note={currentNote} notes={notes} onOpenNote={openNote} onClose={()=>navigate('notes')} favorite={favorites.includes(currentNote.id)} onToggleFavorite={()=>toggleFavorite(currentNote.id)} canEdit={canEditNote(currentNote,user)} canDelete={canDeleteNote(currentNote,user)} canManageSharing={canManageSharing(user)} collaborative={currentNote.collaborative===true} onEdit={()=>openEdit(currentNote)} onDelete={()=>setDeleteTarget(currentNote)} onToggleSharing={enabled=>toggleSharing(currentNote,enabled)} /></Suspense> : <div className="reader-pending">{noteDocument.error?<div className="empty-state reader-missing" role="alert"><FileText size={32}/><strong>{noteDocument.error}</strong><button className="button secondary" onClick={noteDocument.retry}>重新读取</button><button className="button secondary" onClick={()=>navigate('notes')}>返回知识库</button></div>:<ReadingPlaceholder/>}</div> : !storageReady ? <ReadingPlaceholder label="正在连接知识空间"/> : <>
        <div className="page-heading"><div><div className="heading-eyebrow">YOUR KNOWLEDGE, CONNECTED</div><h1>{titles[page]}{page==='overview'&&<span className="heading-sparkle">✧</span>}</h1><p>{descriptions[page]}</p></div>{page!=='reading-stats'&&<div className="heading-actions">{page==='overview'?<label className="range-select"><span className="calendar-mini"><i/><i/></span><select aria-label="统计时间范围" value={range} onChange={e=>setRange(e.target.value)}><option>近 30 天</option><option>近 7 天</option></select><ChevronDown size={13}/></label>:<button className="button secondary" onClick={openCreate}><Plus size={16}/>新建笔记</button>}<button className="button primary" onClick={openImport}><Upload size={16}/>导入笔记</button></div>}</div>

        {page==='overview'&&<>
          <section className="metrics-grid" aria-label="知识库统计">
            {[{title:'笔记总数',value:notes.length,detail:'当前知识库的文档',Icon:FileText,tone:'purple'}, {title:'知识分类',value:allFolderPaths.length,detail:'按原有目录整理',Icon:FolderOpen,tone:'mint'}, {title:'附件资源',value:totalAttachments,detail:'已关联的图片与文件',Icon:Layers,tone:'blue'}, {title:'空间成员',value:workspaceMembers.length,detail:'含 1 位空间管理员',Icon:Users,tone:'peach'}].map(metric=><article className={`metric-card metric-${metric.tone}`} key={metric.title}><div className="metric-top"><span className="metric-label">{metric.title}</span><span className={`metric-icon ${metric.tone}`}><metric.Icon size={20} strokeWidth={1.7}/></span></div><div className="metric-value">{number(metric.value)}<span>{metric.title==='笔记总数'?'篇':metric.title==='空间成员'?'人':'个'}</span></div><div className="metric-bottom"><span>{metric.detail}</span></div></article>)}
          </section>
          <div className="charts-grid"><section className="panel growth-panel"><div className="panel-header"><div><h2>知识在生长 <span className="subtle-dot"/></h2><p>每一次积累，都让未来多一种可能</p></div><div className="chart-switch"><button className={range==='近 30 天'?'selected':''} onClick={()=>setRange('近 30 天')}>本月</button><button className={range==='近 7 天'?'selected':''} onClick={()=>setRange('近 7 天')}>近 7 天</button></div></div><Suspense fallback={<div className="chart-loading" style={{height:242}}/>}><GrowthChart range={range} notes={notes} theme={resolvedTheme}/></Suspense></section><section className="panel distribution-panel"><div className="panel-header"><div><h2>知识分布</h2><p>看看你的好奇心，停留在哪里</p></div><button className="icon-button" aria-label="查看全部分类文档" onClick={()=>navigate('notes')}><MoreHorizontal size={19}/></button></div><div className="distribution-body"><Suspense fallback={<div className="chart-loading" style={{height:190}}/>}><CategoryChart data={categories.map(c=>({name:c.name,value:c.count,color:c.color}))} theme={resolvedTheme}/></Suspense><div className="category-legend">{!categories.length&&<p className="distribution-empty">导入文档后，在这里查看分类分布。</p>}{categories.map(c=><button key={c.name} onClick={()=>{if(navigate('notes'))setCategory(c.name);}}><span className="legend-dot" style={{background:c.color}}/><span>{c.name}</span><b>{number(c.count)}</b><small>{c.percent}%</small></button>)}</div></div></section></div>
          <div className="bottom-grid"><section className="panel recent-panel"><div className="recent-header"><div className="panel-tabs">{['最近更新','我的收藏'].map(tab=><button key={tab} className={tableTab===tab?'active':''} onClick={()=>setTableTab(tab)}>{tab}{tab==='最近更新'&&<span>{number(notes.length)}</span>}</button>)}</div><button className="text-button" onClick={()=>navigate(tableTab==='我的收藏'?'favorites':'notes')}>查看全部 <ArrowRight size={14}/></button></div>{noteTable(5)}<div className="table-footer"><span><span className="status-dot"/>灵感与知识，持续更新中</span><span>共 {number(filteredNotes.length)} 篇笔记</span></div></section><section className="import-feature"><div className="feature-topline"><span className="obsidian-chip"><ObsidianIcon/>OBSIDIAN FRIENDLY</span><span className="feature-star">✦</span></div><h2>你的知识，<br/>不必从头开始。</h2><p>把熟悉的 Obsidian 笔记带过来，<br/>让每一个链接，都找到归处。</p><div className="folder-art" aria-hidden="true"><div className="art-orbit"/><div className="floating-diamond diamond-one"/><div className="floating-diamond diamond-two"/><div className="art-document doc-back"><span/><span/><span/></div><div className="art-document doc-front"><FileText size={25}/><span/><span/></div><div className="art-folder-back"/><div className="art-folder-front"><span><Network size={24}/></span></div><div className="art-image"><span/><span/><i/></div><div className="art-link"><Network size={15}/></div></div><div className="feature-tags"><span><Check size={12}/>保留图片附件</span><span><Check size={12}/>识别双向链接</span></div><button className="feature-button" onClick={openImport}>导入我的知识库 <ArrowUpRight size={17}/></button><small>支持 Markdown · ZIP · 文件夹</small></section></div>
        </>}

        {['notes','recent','favorites'].includes(page)&&<section className="panel library-panel"><div className="library-toolbar"><div><span className="library-count">{number(filteredNotes.length)} 篇文档</span><label className="filter-select"><Folder size={15}/><select aria-label="按分类筛选" value={category} onChange={e=>setCategory(e.target.value)}><option>全部分类</option>{notes.some(note=>!getFolderPath(note))&&<option>未分类</option>}{allFolderPaths.map(c=><option key={c}>{c}</option>)}</select><ChevronDown size={12}/></label></div><div className="view-switch"><button aria-label="列表视图" className={layout==='list'?'selected':''} onClick={()=>setLayout('list')}><List size={17}/></button><button aria-label="卡片视图" className={layout==='grid'?'selected':''} onClick={()=>setLayout('grid')}><Grid2X2 size={16}/></button></div></div>{category!=='全部分类'&&<div className="folder-location-bar"><Folder size={14}/><strong>{SPACE_NAME} / {category}</strong><span>包含子文件夹</span><button onClick={()=>setCategory('全部分类')}>显示全部</button></div>}{layout==='list'?noteTable():<div className="note-card-grid" onPointerEnter={warmReader} onFocusCapture={warmReader}>{filteredNotes.map(note=><button key={note.id} className="note-preview-card" onClick={()=>openNote(note.id)}><FileText size={22}/><h2>{note.title}</h2><p>{note.excerpt||note.content.replace(/[#*`>[\]]/g,'').slice(0,95)}</p><div><span>{note.category}</span><small>{dateLabel(note.updatedAt)}</small></div></button>)}{!filteredNotes.length&&<div className="empty-state">暂无相关笔记</div>}</div>}<div className="table-footer"><span>内容已同步到共享知识库</span><button className="text-button" onClick={openCreate}><Plus size={14}/>记录新想法</button></div></section>}

        {page==='tags'&&<section className="panel tags-panel"><div className="panel-header"><div><h2>主题，让知识相遇</h2><p>点击任意标签，查看相关笔记</p></div><span className="category-pill">{number(allTags.length)} 个标签</span></div><div className="tag-cloud">{allTags.map((tag,i)=><button key={tag} style={{background:categoryPalette[i%categoryPalette.length].bg,color:categoryPalette[i%categoryPalette.length].color}} onClick={()=>{if(navigate('notes'))setQuery(tag);}}><Hash size={16}/>{tag}<span>{number(notes.filter(n=>n.tags.includes(tag)).length)}</span></button>)}</div></section>}
        {page==='graph'&&(graphError?<div className="empty-state" role="alert">{graphError}</div>:graphNotes.length||!notes.length?<Suspense fallback={<ReadingPlaceholder label="正在绘制知识图谱"/>}><ObsidianGraph notes={graphNotes} onOpenNote={openNote} theme={resolvedTheme}/></Suspense>:<ReadingPlaceholder label="正在连接知识图谱"/>)}
        {page==='reading-stats'&&user?.role==='admin'&&<Suspense fallback={<ReadingPlaceholder label="正在读取阅读统计"/>}><ReadingAnalytics onOpenNote={openNote}/></Suspense>}
        {page==='members'&&<section className="panel members-panel"><div className="panel-header"><div><h2>在一起，让知识更有价值</h2><p>一个人的记录，也可以成为团队的灵感</p></div><button className="button primary" onClick={openAccount}><Plus size={16}/>注册新账号</button></div><div className="table-scroll"><table className="member-table"><thead><tr><th>成员</th><th>邮箱</th><th>空间角色</th><th>加入时间</th><th>状态</th></tr></thead><tbody>{workspaceMembers.map(m=><tr key={m.email}><td><>{m.avatarUrl?<button type="button" className="member-avatar-button" aria-label={`查看${m.name}的头像`} title="点击查看头像大图" onClick={()=>setAvatarMember(m)}><UserAvatar src={m.avatarUrl} name={m.name} fallback={m.initial} style={{background:m.color}}/></button>:<UserAvatar name={m.name} fallback={m.initial} style={{background:m.color}}/>}</><strong>{m.name}</strong></td><td>{m.email}</td><td><span className={`role-pill ${m.role==='空间管理员'?'admin':''}`}>{m.role==='空间管理员'&&<ShieldCheck size={13}/>} {m.role}</span></td><td>{m.joined}</td><td><span className="member-status"><span className="status-dot"/>已加入</span></td></tr>)}</tbody></table></div><div className="member-info"><ShieldCheck size={18}/><p>成员默认只能编辑、删除自己的笔记。管理员可为单篇笔记开启所有成员协作编辑；协作成员不能删除他人的笔记。</p></div></section>}
        </>}
        <footer className="page-footer"><span>知屿<span className="footer-dot">·</span>让每一份知识，都有归处</span><span><span className="status-dot"/>共享知识库<span className="footer-dot">·</span>{new Intl.DateTimeFormat('zh-CN').format(new Date())}</span></footer>
      </main>
    </div>
    <Suspense fallback={null}>
      {importOpen&&<ImportModal categories={allFolderPaths} open={importOpen} onClose={()=>setImportOpen(false)} onImport={handleImport}/>}
      {profileSettingsOpen&&user&&<ProfileSettings key={user.id} user={user} onClose={()=>setProfileSettingsOpen(false)} onUpdated={profileUpdated}/>}
      {avatarMember?.avatarUrl&&<AvatarViewer key={avatarMember.avatarUrl} name={avatarMember.name} src={avatarMember.avatarUrl} onClose={()=>setAvatarMember(null)}/>}
      {accountOpen&&<AccountModal open={accountOpen} setupToken={setupToken||undefined} onClose={()=>{setAccountOpen(false);pendingAction.current=null;}} onRegister={register}/>}
    </Suspense>
    {deleteTarget&&<DeleteNoteDialog note={deleteTarget} onClose={()=>setDeleteTarget(null)} onConfirm={deleteNote}/>}
    {deleteFolderTarget&&<DeleteFolderDialog path={deleteFolderTarget} noteCount={notes.filter(note=>folderContains(deleteFolderTarget,getFolderPath(note))).length} childFolderCount={allFolderPaths.filter(path=>path!==deleteFolderTarget&&folderContains(deleteFolderTarget,path)).length} onClose={()=>setDeleteFolderTarget(null)} onConfirm={deleteDirectoryFolder}/>}
    {toast&&<div className="toast" role="status"><span><Check size={15}/></span>{toast}<button aria-label="关闭提示" onClick={()=>setToast('')}><X size={15}/></button></div>}
  </div>;
}

function ObsidianIcon(){return <svg width="15" height="17" viewBox="0 0 24 28" fill="none" aria-hidden="true"><path d="m14 1 8 7-3 16-9 3-8-9 5-13 7-4Z" fill="#9984D6"/><path d="m14 1-3 11 8 12 3-16-8-7Z" fill="#6D53A3"/><path d="m11 12-9 6 8 9 1-15Z" fill="#B9A5E4"/><path d="m7 5 4 7 3-11-7 4Z" fill="#D2C3F0"/></svg>;}

function ReadingPlaceholder({label="正在读取文档"}:{label?:string}){return <div className="reading-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><i className="placeholder-heading"/><i/><i/><i/><i className="placeholder-short"/></div>;}

function ReaderPresence({noteId,onChange}:{noteId:string;onChange:(id:string|null)=>void}){useEffect(()=>{onChange(noteId);return()=>onChange(null);},[noteId,onChange]);return null;}
