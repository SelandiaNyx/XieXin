// 写作统计、大纲、全文搜索、查找替换、回收站、导入文本、数据体检与使用说明弹层。

import { api } from '../api.js';
import {
  state, setState, chapters, findChapter, bookCharCount, bookChapterCount, statusInfo,
} from '../store.js';
import {
  toast, openModal, closeModal, confirmDialog, escapeHtml, formatBytes, formatTime,
} from '../ui.js';
import { insertText, updateCounts, todayChars } from '../editor.js';
import { refreshBook, renderToc } from '../sidebar.js';
import { reloadWorkspace, switchBook } from './bookshelf.js';

const KIND_LABEL = { character: '人物', plot: '剧情', inspiration: '灵光', world: '设定' };

// ------------------------------------------------------------------ 统计

export async function openStats() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  let stats;
  try {
    stats = await api.bookStats(state.book.id);
  } catch (e) { toast(e.message, 'err'); return; }
  const today = todayChars();
  const goal = Number(state.settings.dailyGoal) || 3000;
  const pct = Math.min(100, Math.round((today / goal) * 100));
  const chapter = findChapter(state.activeChapterId);
  const chapterChars = chapter ? chapter.charCount || 0 : 0;
  const chaptersList = chapters();
  const longest = chaptersList.slice().sort((a, b) => (b.charCount || 0) - (a.charCount || 0))[0];

  openModal({
    title: '字数统计',
    width: 'narrow',
    body: `
      <div class="stat-grid">
        <div class="stat-card"><div class="k">全书字数</div><div class="v">${stats.charCount.toLocaleString()}</div></div>
        <div class="stat-card"><div class="k">本章字数</div><div class="v">${chapterChars.toLocaleString()}</div></div>
        <div class="stat-card"><div class="k">今日字数</div><div class="v">${today.toLocaleString()}</div></div>
      </div>
      <div class="section-title">每日目标（${goal.toLocaleString()} 字）</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="kv" style="margin-top:6px"><span class="k">完成度</span><span>${pct}%（还差 ${Math.max(0, goal - today).toLocaleString()} 字）</span></div>
      <div class="section-title">作品概况</div>
      <div class="kv-list">
        <div class="kv"><span class="k">卷 / 章</span><span>${stats.volumes} 卷 · ${stats.chapters} 章</span></div>
        <div class="kv"><span class="k">中文字符</span><span>${stats.cjk.toLocaleString()}</span></div>
        <div class="kv"><span class="k">英文单词</span><span>${stats.words.toLocaleString()}</span></div>
        <div class="kv"><span class="k">历史版本总数</span><span>${stats.versions}</span></div>
        <div class="kv"><span class="k">卡片数量</span><span>${stats.cards}</span></div>
        <div class="kv"><span class="k">平均每章</span><span>${stats.chapters ? Math.round(stats.charCount / stats.chapters).toLocaleString() : 0} 字</span></div>
        <div class="kv"><span class="k">最长章节</span><span>${longest ? `${escapeHtml(longest.title)}（${(longest.charCount || 0).toLocaleString()} 字）` : '-'}</span></div>
        <div class="kv"><span class="k">本次会话新增</span><span>${state.sessionChars.toLocaleString()} 字</span></div>
        <div class="kv"><span class="k">数据占用</span><span>${formatBytes(state.storageBytes)}</span></div>
      </div>`,
    footer: `<button class="mini" data-role="refresh">刷新</button><button class="primary" data-role="ok">好</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="ok"]').onclick = closeModal;
      footEl.querySelector('[data-role="refresh"]').onclick = () => { closeModal(); openStats(); };
    },
  });
}

// ------------------------------------------------------------------ 大纲

export function openOutline() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  const rows = state.book.volumes
    .map((v) => {
      const volChars = v.chapters.reduce((s, c) => s + (c.charCount || 0), 0);
      const head = `<tr data-volume-id="${v.id}"><td colspan="5" style="background:var(--accent-soft);font-weight:600">
          ${escapeHtml(v.title)} · ${v.chapters.length} 章 · ${volChars.toLocaleString()} 字</td></tr>`;
      const body = v.chapters
        .map(
          (c) => `<tr data-chapter-id="${c.id}">
            <td>${escapeHtml(c.title)}</td>
            <td class="num">${(c.charCount || 0).toLocaleString()}</td>
            <td class="num">${c.versions || 0}</td>
            <td><span class="status-pill" style="display:inline-block;background:${escapeHtml(statusInfo(c.status).color)};margin-right:6px"></span>${escapeHtml(statusInfo(c.status).label)}</td>
            <td>${escapeHtml(c.summary || '')}</td>
          </tr>`,
        )
        .join('');
      return head + body;
    })
    .join('');
  const total = bookCharCount();
  openModal({
    title: `大纲 · ${state.book.title}`,
    width: 'wide',
    body: `<div class="kv-list" style="margin-bottom:10px">
        <div class="kv"><span class="k">总字数</span><span>${total.toLocaleString()}</span></div>
        <div class="kv"><span class="k">章节数</span><span>${bookChapterCount()}</span></div>
      </div>
      <table class="outline-table">
        <thead><tr><th>章节</th><th style="text-align:right">字数</th><th style="text-align:right">版本</th><th>状态</th><th>概要</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">还没有章节</td></tr>'}</tbody>
      </table>`,
    footer: `<span class="spacer">双击行可跳转</span><button class="primary" data-role="ok">好</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="ok"]').onclick = closeModal;
      bodyEl.querySelectorAll('tr[data-chapter-id]').forEach((tr) => {
        tr.addEventListener('click', async () => {
          closeModal();
          await window.__moge.openChapter(tr.dataset.chapterId);
        });
      });
    },
  });
}

// ------------------------------------------------------------------ 搜索

export function openSearch() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  openModal({
    title: '全文搜索',
    body: `<div class="field"><input id="searchInput" type="search" placeholder="输入关键词，回车搜索（章节正文 + 卡片）" /></div>
           <div id="searchResults" style="margin-top:12px"></div>`,
    footer: '<button class="mini" data-role="close">关闭</button>',
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="close"]').onclick = closeModal;
      const input = bodyEl.querySelector('#searchInput');
      const out = bodyEl.querySelector('#searchResults');
      const run = async () => {
        const kw = input.value.trim();
        if (!kw) { out.innerHTML = ''; return; }
        out.innerHTML = '<div class="empty-note">搜索中…</div>';
        const hits = [];
        // 正文搜索交给 Rust 一次遍历完成：一次 IPC，且不必把每章的历史版本都传过来
        try {
          const found = await api.searchBook(state.book.id, kw);
          for (const h of found) {
            hits.push({
              type: 'chapter',
              id: h.chapterId,
              title: h.chapterTitle,
              where: `${h.volumeTitle} · 命中 ${h.count} 处`,
              snippet: `${escapeHtml(h.head)}<mark>${escapeHtml(h.hit)}</mark>${escapeHtml(h.tail)}`,
            });
          }
        } catch (e) {
          out.innerHTML = `<div class="empty-note">搜索失败：${escapeHtml(e.message)}</div>`;
          return;
        }
        state.cards.forEach((c) => {
          const hay = `${c.title}\n${c.content}\n${(c.tags || []).join(' ')}`;
          if (hay.toLowerCase().includes(kw.toLowerCase())) {
            hits.push({
              type: 'card',
              id: c.id,
              title: c.title,
              where: `卡片 · ${KIND_LABEL[c.kind] || c.kind}`,
              snippet: escapeHtml(c.content.slice(0, 90)),
            });
          }
        });
        out.innerHTML = hits.length
          ? `<div class="hit-list">${hits
              .map(
                (hit, i) => `<div class="hit" data-index="${i}">
                  <div class="hit-where">${escapeHtml(hit.where)}</div>
                  <div><b>${escapeHtml(hit.title)}</b></div>
                  <div style="color:var(--ink-soft);margin-top:4px">…${hit.snippet}…</div>
                </div>`,
              )
              .join('')}</div>`
          : '<div class="empty-note">没有找到匹配内容</div>';
        out.querySelectorAll('.hit').forEach((el) => {
          el.addEventListener('click', async () => {
            const hit = hits[Number(el.dataset.index)];
            if (hit.type === 'chapter') {
              closeModal();
              await window.__moge.openChapter(hit.id);
            } else {
              const { renderCards } = await import('../cards.js');
              const card = state.cards.find((c) => c.id === hit.id);
              setState({ cardKind: card.kind, activeCardId: card.id, cardSearch: '' });
              renderCards();
              toast('已在右侧定位该卡片', 'ok');
            }
          });
        });
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
      void run;
    },
  });
}

// ------------------------------------------------------------------ 查找替换（编辑区内）

export function toggleFindBar(show) {
  const bar = document.getElementById('findBar');
  bar.hidden = show === undefined ? !bar.hidden : !show;
  if (!bar.hidden) document.getElementById('findInput').focus();
}

export function initFindBar() {
  const bar = document.getElementById('findBar');
  const findInput = document.getElementById('findInput');
  const replaceInput = document.getElementById('replaceInput');
  const caseSensitive = document.getElementById('caseSensitive');
  document.getElementById('closeFind').onclick = () => { bar.hidden = true; };
  const editor = () => document.getElementById('editor');

  const findNext = () => {
    const kw = findInput.value;
    if (!kw) return;
    const view = editor();
    const hay = caseSensitive.checked ? view.value : view.value.toLowerCase();
    const needle = caseSensitive.checked ? kw : kw.toLowerCase();
    const from = view.selectionEnd;
    let idx = hay.indexOf(needle, from);
    if (idx < 0) idx = hay.indexOf(needle, 0);
    if (idx < 0) { toast('没有找到匹配内容', 'warn'); return; }
    view.focus();
    view.setSelectionRange(idx, idx + kw.length);
    const line = view.value.slice(0, idx).split('\n').length;
    const lineHeight = parseFloat(getComputedStyle(view).lineHeight) || 34;
    document.getElementById('editorWrap').scrollTop = Math.max(0, (line - 4) * lineHeight);
  };

  document.getElementById('findNext').onclick = findNext;
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findNext(); });
  document.getElementById('replaceOne').onclick = () => {
    const view = editor();
    const kw = findInput.value;
    if (!kw) return;
    const hay = caseSensitive.checked ? view.value : view.value.toLowerCase();
    const needle = caseSensitive.checked ? kw : kw.toLowerCase();
    const sel = view.value.slice(view.selectionStart, view.selectionEnd);
    if (sel && (caseSensitive.checked ? sel === kw : sel.toLowerCase() === kw.toLowerCase())) {
      const start = view.selectionStart;
      view.setSelectionRange(start, view.selectionEnd);
      insertText(replaceInput.value);
      updateCounts();
    }
    void hay;
    void needle;
    findNext();
  };
  document.getElementById('replaceAllBtn').onclick = async () => {
    const view = editor();
    const kw = findInput.value;
    if (!kw) return;
    try {
      const [text, report] = await api.replaceAll(view.value, kw, replaceInput.value, caseSensitive.checked);
      view.value = text;
      view.dispatchEvent(new Event('input', { bubbles: true }));
      updateCounts();
      toast(`已替换 ${report.replaced} 处（${report.beforeChars} → ${report.afterChars} 字）`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ------------------------------------------------------------------ 回收站

export async function openTrash() {
  try {
    const list = await api.listTrash();
    const canOpen = state.hasNativePickers;
    openModal({
      title: '回收站',
      body: list.length
        ? `<div style="display:flex;flex-direction:column;gap:6px">${list
            .map(
              (t) => `<div class="trash-row">
                <span class="t-name">${escapeHtml(t.name)}</span>
                <span class="t-size">${formatBytes(t.size)} · ${formatTime(t.deletedAt)}</span>
                ${canOpen ? `<button class="mini" data-role="open" data-path="${escapeHtml(t.path)}">定位</button>` : ''}
              </div>`,
            )
            .join('')}</div>`
        : '<div class="empty-note">回收站是空的</div>',
      footer: `<span class="spacer">删除的书籍/章节会先移到这里</span>
               <button class="mini" data-role="clean" style="color:var(--danger)">清空回收站</button>
               <button class="primary" data-role="ok">好</button>`,
      onMount(bodyEl, footEl) {
        footEl.querySelector('[data-role="ok"]').onclick = closeModal;
        footEl.querySelector('[data-role="clean"]').onclick = async () => {
          const ok = await confirmDialog('清空回收站', '所有回收站内容将被永久删除，确定吗？', { okText: '永久删除', danger: true });
          if (!ok) return;
          try {
            const n = await api.emptyTrash();
            closeModal();
            toast(`已永久删除 ${n} 项`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
        bodyEl.querySelectorAll('[data-role="open"]').forEach((btn) => {
          btn.onclick = () => api.openInExplorer(btn.dataset.path).catch(() => {});
        });
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ 导入 / 体检 / 帮助

export async function importTextDialog() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  const volId = state.activeVolumeId || (state.book.volumes[0] && state.book.volumes[0].id);
  const canPick = state.hasNativePickers;
  openModal({
    title: '导入文本与备份',
    width: 'narrow',
    body: `<div class="field"><label>导入方式</label>
        <select id="impMode">
          <option value="file">从 TXT / MD 文件导入（自动识别"第X章"分章）</option>
          <option value="paste">粘贴文本导入</option>
          <option value="backup">从写心 JSON 备份恢复</option>
        </select></div>
      <div class="field" id="impFileWrap" style="margin-top:10px">
        <label>文件</label>
        <div class="range-row"><input id="impPath" type="text" readonly placeholder="点击右侧按钮选择" />
        <button class="mini" type="button" id="impBrowse">选择…</button></div>
        <input type="file" id="impFileInput" accept=".txt,.md,.markdown,.json" hidden />
      </div>
      <div class="field" id="impPasteWrap" style="margin-top:10px" hidden>
        <label>粘贴内容</label><textarea id="impText" rows="10" placeholder="粘贴整本或整章文本，会自动按章节标题切分"></textarea>
      </div>
      <div class="field" style="margin-top:10px">
        <label>导入到</label>
        <select id="impVolume">${state.book.volumes.map((v) => `<option value="${v.id}" ${v.id === volId ? 'selected' : ''}>${escapeHtml(v.title)}</option>`).join('')}</select>
      </div>`,
    footer: `<button class="mini" data-role="cancel">取消</button><button class="primary" data-role="import">开始导入</button>`,
    onMount(bodyEl, footEl) {
      const mode = bodyEl.querySelector('#impMode');
      const fileInput = bodyEl.querySelector('#impFileInput');
      let pickedText = '';
      const sync = () => {
        const v = mode.value;
        bodyEl.querySelector('#impFileWrap').hidden = v === 'paste';
        bodyEl.querySelector('#impPasteWrap').hidden = v !== 'paste';
      };
      mode.addEventListener('change', sync);
      sync();
      bodyEl.querySelector('#impBrowse').onclick = async () => {
        if (canPick) {
          try {
            const path = await api.pickOpenFile(mode.value === 'backup' ? 'json' : 'txt');
            if (path) {
              pickedText = '';
              bodyEl.querySelector('#impPath').value = path;
            }
          } catch (e) { toast(e.message, 'err'); }
        } else {
          fileInput.accept = mode.value === 'backup' ? '.json,application/json' : '.txt,.md,.markdown,text/plain';
          fileInput.click();
        }
      };
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        pickedText = await f.text();
        bodyEl.querySelector('#impPath').value = f.name;
      });
      footEl.querySelector('[data-role="cancel"]').onclick = closeModal;
      footEl.querySelector('[data-role="import"]').onclick = async () => {
        const v = mode.value;
        try {
          let book;
          if (v === 'backup') {
            if (!canPick) {
              if (!pickedText.trim()) { toast('请先选择 JSON 备份文件', 'warn'); return; }
              book = await api.importBackup(null, true, pickedText);
            } else {
              let path = bodyEl.querySelector('#impPath').value;
              if (!path) {
                path = await api.pickOpenFile('json');
                if (!path) return;
              }
              book = await api.importBackup(path, true, null);
            }
            await reloadWorkspace();
            closeModal();
            await switchBook(book.id);
            toast(`已导入《${book.title}》`, 'ok');
            return;
          }
          if (v === 'file') {
            if (!canPick) {
              if (!pickedText.trim()) { toast('请先选择文本文件', 'warn'); return; }
              book = await api.importText(state.book.id, bodyEl.querySelector('#impVolume').value, null, pickedText);
            } else {
              const path = bodyEl.querySelector('#impPath').value;
              if (!path) { toast('请先选择文件', 'warn'); return; }
              book = await api.importText(state.book.id, bodyEl.querySelector('#impVolume').value, path, null);
            }
          } else {
            const text = bodyEl.querySelector('#impText').value;
            if (!text.trim()) { toast('请粘贴内容', 'warn'); return; }
            book = await api.importText(state.book.id, bodyEl.querySelector('#impVolume').value, null, text);
          }
          setState({ book });
          closeModal();
          renderToc();
          const all = book.volumes.flatMap((vv) => vv.chapters);
          if (all.length) await window.__moge.openChapter(all[all.length - 1].id);
          toast('导入完成', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

export async function runVerify() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  try {
    const issues = await api.verifyBook(state.book.id);
    if (issues.length === 0) {
      toast('数据体检通过，未发现不一致', 'ok');
      return;
    }
    openModal({
      title: '数据体检结果',
      body: `<div class="kv-list">${issues.map((i) => `<div class="kv"><span>${escapeHtml(i)}</span></div>`).join('')}</div>`,
      footer: '<button class="primary" data-role="ok">好</button>',
      onMount(b, f) { f.querySelector('[data-role="ok"]').onclick = closeModal; },
    });
    await refreshBook();
  } catch (e) { toast(e.message, 'err'); }
}

export function openHelp() {
  const shortcuts = [
    ['Ctrl + S', '保存当前章节'],
    ['Ctrl + Shift + S', '保存并创建历史快照'],
    ['Ctrl + Shift + F', '一键排版'],
    ['Ctrl + Shift + A', '呼出 ✨ 写心酱 AI 助手'],
    ['Ctrl + Shift + Y', '打开跨端同步中心'],
    ['Ctrl + Shift + P', '切换阅读预览'],
    ['Ctrl + E', '导出电子书 / 备份'],
    ['Ctrl + Y', '历史版本'],
    ['Ctrl + F', '全文搜索'],
    ['Ctrl + H', '查找替换'],
    ['Ctrl + N', '打开书架'],
    ['Ctrl + Alt + N', '新建章节'],
    ['F9 / F10', '切换左侧目录 / 右侧工作室'],
    ['F11 / Esc', '专注模式 / 关闭弹层'],
    ['Ctrl + P', '番茄钟'],
  ];
  openModal({
    title: '写心 · 使用说明',
    body: `
      <div class="section-title">快捷键</div>
      <div class="shortcut-grid">
        ${shortcuts.map(([k, v]) => `<div class="row"><span>${v}</span><kbd>${k}</kbd></div>`).join('')}
      </div>
      <div class="section-title">跨端同步与 AI 创作</div>
      <div style="font-size:12.5px;line-height:1.9;color:var(--ink-soft)">
        · <b>局域网同步</b>：电脑与手机连入同一 Wi-Fi，在一端开启同步服务并扫码/粘贴配对串，即可零流量双向合并稿件，冲突章节自动保存另一端到历史版本。<br/>
        · <b>WebDAV 云同步</b>：内置坚果云 / Nextcloud / AList 预设，支持一键双向合并与定时自动云同步。<br/>
        · <b>✨ 写心酱 AI</b>：支持 DeepSeek / 硅基流动 / OpenAI / Claude / Gemini / 本地 Ollama 流式续写、润色、扩写、脑洞与提取设定卡，API 密钥仅留存本机。
      </div>
      <div class="section-title">关于</div>
      <div class="kv-list">
        <div class="kv"><span class="k">名称</span><span>写心 · HeartWrite Studio</span></div>
        <div class="kv"><span class="k">版本</span><span>1.0.0</span></div>
        <div class="kv"><span class="k">技术栈</span><span>Rust + Tauri 2（Windows / Linux / Android 跨端原生应用）</span></div>
        <div class="kv"><span class="k">数据目录</span><span style="word-break:break-all">${escapeHtml(state.storageDir)}</span></div>
        <div class="kv"><span class="k">许可证</span><span>GPL-3.0 · 小说版权完全归作者本人所有</span></div>
      </div>`,
    footer: '<button class="primary" data-role="ok">知道了</button>',
    onMount(b, f) { f.querySelector('[data-role="ok"]').onclick = closeModal; },
  });
}
