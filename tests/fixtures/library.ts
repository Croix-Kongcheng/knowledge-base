import type { Page } from '@playwright/test';
import type { ImportedNote } from '../../src/lib/importer';

export const workflowTitle = '功能检查：知识管理工作流';
export const markdownTitle = '功能检查：Markdown 写作指南';
export const reactTitle = '功能检查：React 组件设计';
export const designTitle = '功能检查：界面与内容';

const base = { tags: ['功能检查'], author: '自动化文档作者', avatar: '测', color: '#e6e6fa' };
export const fixtureNotes: ImportedNote[] = [
  { ...base, id: 'fixture-workflow', title: workflowTitle, category: '学习笔记', path: `学习笔记/${workflowTitle}.md`, updatedAt: '2026-10-25T10:32:00', content: `# ${workflowTitle}\n\n## 我的工作流\n\n整理公开的功能检查内容。\n\n[Markdown 写作指南](#note/fixture-markdown)` },
  { ...base, id: 'fixture-markdown', title: markdownTitle, category: '技术开发', path: `技术开发/${markdownTitle}.md`, updatedAt: '2026-10-25T09:15:00', content: `# ${markdownTitle}\n\n## 常用语法\n\n| 效果 | 写法 |\n| --- | --- |\n| 加粗 | 重点 |\n\n~~~javascript\nconst ideas = ["记录", "连接"];\n~~~\n\n[知识管理工作流](#note/fixture-workflow)` },
  { ...base, id: 'fixture-design', title: designTitle, category: '产品设计', path: `产品设计/${designTitle}.md`, updatedAt: '2026-10-24T15:46:00', content: `# ${designTitle}\n\n清晰的界面层级。` },
  { ...base, id: 'fixture-react', title: reactTitle, category: '技术开发', path: `技术开发/${reactTitle}.md`, updatedAt: '2026-10-24T11:20:00', content: `# ${reactTitle}\n\n组件组合与职责。\n\n[Markdown 写作指南](#note/fixture-markdown)` },
  { ...base, id: 'fixture-life', title: '功能检查：公开生活灵感', category: '生活灵感', path: '生活灵感/公开生活灵感.md', updatedAt: '2026-10-23T17:38:00', content: '# 公开生活灵感\n\n公开的散步观察。' },
  { ...base, id: 'fixture-server', title: '功能检查：服务器部署', category: '技术开发', path: '技术开发/服务器部署.md', updatedAt: '2026-10-22T20:10:00', content: '# 服务器部署\n\n端口转发配置。' },
];

export async function primeWorkspace(page: Page, notes: ImportedNote[], values: Record<string, unknown> = {}) {
  await page.route('**/__workspace_test_setup__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Workspace test setup</title>' }));
  await page.goto('/__workspace_test_setup__');
  await page.evaluate(async ({ notes, values }) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('zhiyu-knowledge', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace');
        if (!request.result.objectStoreNames.contains('assets')) request.result.createObjectStore('assets');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put(notes, 'notes');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { notes, values });
  await page.goto('/');
}
