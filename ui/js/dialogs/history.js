// 历史版本对比与回滚弹层。

import { api } from '../api.js';
import { state, findChapter } from '../store.js';
import {
  toast, openModal, closeModal, confirmDialog, escapeHtml, formatTime, relativeTime,
} from '../ui.js';
import { restoreChapterVersion, countLocal } from '../editor.js';
import { refreshBook } from '../sidebar.js';

export async function openHistory() {
  if (!state.book || !state.activeChapterId) { toast('请先打开一章', 'warn'); return; }
  const chapterId = state.activeChapterId;
  const bookId = state.book.id;
  let versions = [];
  try {
    versions = await api.listVersions(bookId, chapterId);
  } catch (e) { toast(e.message, 'err'); return; }
  const ch = findChapter(chapterId);

  const rows = versions.length
    ? versions
        .map(
          (v) => `<div class="version-row" data-version-id="${v.id}">
            <span class="version-kind ${v.kind}">${kindLabel(v.kind)}</span>
            <div style="flex:1;min-width:0">
              <div class="v-time">${relativeTime(v.createdAt)} <span class="v-meta">${formatTime(v.createdAt)}</span></div>
              <div class="v-meta">${escapeHtml(v.label || '')}</div>
            </div>
            <span class="v-chars">${v.chars.toLocaleString()} 字</span>
          </div>`,
        )
        .join('')
    : '<div class="empty-note">本章还没有历史版本。<br/>编辑后自动保存或按 Ctrl+Shift+S 手动打快照即可生成。</div>';

  openModal({
    title: `历史版本 · ${ch ? ch.title : ''}`,
    width: 'wide',
    body: `<div style="display:grid;grid-template-columns:300px 1fr;gap:14px">
        <div class="version-list" id="versionList">${rows}</div>
        <div id="versionDetail" class="empty-note">选择左侧任一版本查看对比</div>
      </div>`,
    footer: `<span class="spacer">共 ${versions.length} 个版本（保留上限可在设置中调整）</span>
             <button class="mini" data-role="close">关闭</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="close"]').onclick = closeModal;
      const detail = bodyEl.querySelector('#versionDetail');
      bodyEl.querySelectorAll('.version-row').forEach((row) => {
        row.addEventListener('click', async () => {
          bodyEl.querySelectorAll('.version-row').forEach((r) => r.classList.remove('active'));
          row.classList.add('active');
          const vid = row.dataset.versionId;
          detail.innerHTML = '<div class="empty-note">加载中…</div>';
          try {
            const d = await api.versionDetail(bookId, chapterId, vid);
            const { left, right } = diffHtml(d.content, d.current);
            detail.innerHTML = `
              <div class="kv-list" style="margin-bottom:8px">
                <div class="kv"><span class="k">版本时间</span><span>${formatTime(d.meta.createdAt)}</span></div>
                <div class="kv"><span class="k">版本字数</span><span>${d.meta.chars.toLocaleString()} 字（当前 ${countLocal(d.current).toLocaleString()} 字）</span></div>
              </div>
              <div style="display:flex;gap:6px;margin-bottom:8px">
                <button class="mini" id="restoreBtn">回滚到此版本</button>
                <button class="mini" id="copyBtn">复制版本内容</button>
                <button class="mini" id="delBtn" style="color:var(--danger)">删除该版本</button>
              </div>
              <div class="diff-view">
                <div class="diff-pane"><h5>历史版本（- 表示已删除）</h5><pre class="diff-text">${left}</pre></div>
                <div class="diff-pane"><h5>当前正文（+ 表示新增）</h5><pre class="diff-text">${right}</pre></div>
              </div>`;
            detail.querySelector('#restoreBtn').onclick = async () => {
              const ok = await confirmDialog('回滚版本', '当前正文会先被存为一个新版本，然后回滚到你选择的历史版本。继续吗？', { okText: '回滚' });
              if (!ok) return;
              try {
                if (!await restoreChapterVersion(bookId, chapterId, vid)) return;
                closeModal();
                await refreshBook();
                toast('已回滚到历史版本', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            };
            detail.querySelector('#copyBtn').onclick = async () => {
              try {
                await navigator.clipboard.writeText(d.content);
                toast('版本内容已复制到剪贴板', 'ok');
              } catch {
                toast('复制失败，请手动选择文本', 'warn');
              }
            };
            detail.querySelector('#delBtn').onclick = async () => {
              const ok = await confirmDialog('删除版本', '删除后无法恢复，确定吗？', { okText: '删除', danger: true });
              if (!ok) return;
              try {
                await api.deleteVersion(bookId, chapterId, vid);
                closeModal();
                openHistory();
                toast('版本已删除', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            };
          } catch (e) {
            detail.innerHTML = `<div class="empty-note">加载失败：${escapeHtml(e.message)}</div>`;
          }
        });
      });
    },
  });
}

function kindLabel(kind) {
  return { auto: '自动', manual: '手动', restore: '回滚', import: '导入', current: '当前' }[kind] || kind;
}

/** 逐行 LCS 差异，输出两侧 HTML。 */
export function diffHtml(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const MAX = 900;
  if (n * m > 250000 || n > MAX || m > MAX) {
    return { left: escapeHtml(oldText), right: escapeHtml(newText) };
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const left = [];
  const right = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push(escapeHtml(a[i]));
      right.push(escapeHtml(b[j]));
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.push(`<del>${escapeHtml(a[i]) || '&nbsp;'}</del>`);
      i += 1;
    } else {
      right.push(`<ins>${escapeHtml(b[j]) || '&nbsp;'}</ins>`);
      j += 1;
    }
  }
  while (i < n) { left.push(`<del>${escapeHtml(a[i]) || '&nbsp;'}</del>`); i += 1; }
  while (j < m) { right.push(`<ins>${escapeHtml(b[j]) || '&nbsp;'}</ins>`); j += 1; }
  return { left: left.join('\n'), right: right.join('\n') };
}
