// ✨ AI 写心酱创作助手面板：
// - 支持 OpenAI 兼容 / DeepSeek / 硅基流动 / Claude / Gemini / 本地 Ollama；
// - 监听 Rust `ai:stream` SSE 流式事件（含深度思考 reasoning 折叠区）；
// - 提供 6 项小说专属一键技能（续写、润色、扩写、脑洞、章纲、提取设定卡）及一键插入/替换/入库操作。

import { api, listen } from './api.js';
import { state, setState, findChapter, activeAiProfile } from './store.js';
import { toast, escapeHtml, confirmDialog } from './ui.js';
import {
  editorValue, getSelection, insertText, setChapterSynopsis,
} from './editor.js';
import { reloadCards } from './cards.js';

const SKILL_PROMPTS = {
  continue: () => '请紧接当前章节结尾，自然续写 400～600 字小说正文，保持人物性格、语气与场景连贯，直接输出正文。',
  polish: (sel) =>
    sel
      ? '请润色我选中的这段正文，增强画面感、动作细节与情感张力，保持原意不变，直接输出润色后的正文。'
      : '请润色当前章节的最后两段，增强画面感与节奏张力，直接输出润色后的正文。',
  expand: (sel) =>
    sel
      ? '请对我选中的这段内容进行细腻扩写，补充感官细节、微表情、环境氛围与心理活动，直接输出扩写后的正文。'
      : '请将当前章节结尾场景扩写得更加细腻生动，补充环境氛围与人物神态描写。',
  brainstorm: (sel) =>
    sel
      ? '围绕我选中的片段，提供 3 个风格迥异的后续剧情转折方案（如：温情推进 / 悬疑反转 / 冲突爆发），每个方案简明列出看点。'
      : '结合当前章节内容与设定，提供 3 个有吸引力的后续剧情推进或反转思路。',
  summarize: () => '请用 80～150 字精炼概括本章核心剧情、人物变化与埋下的伏笔，适合作为章纲备忘保存。',
  'extract-card': () =>
    '请从本章中提取 1 个最关键的人物或世界观设定，按「标题 / 分类（人物/剧情/设定）/ 简介 / 关键词标签」整理，方便我一键保存为设定卡片。',
};

const SKILL_LABEL = {
  continue: '智能续写',
  polish: '文笔润色',
  expand: '细节扩写',
  brainstorm: '剧情脑洞',
  summarize: '生成章纲',
  'extract-card': '提取设定',
};

let els = {};
let activeStream = null; // { requestId, msgIndex, text, reasoning }
let onOpenSettingsHook = null;

export function initAiAssistant({ onOpenSettings } = {}) {
  onOpenSettingsHook = onOpenSettings || null;
  els = {
    pane: document.getElementById('aiPane'),
    badge: document.getElementById('aiModelBadge'),
    profileSelect: document.getElementById('aiProfileSelect'),
    ctxChapter: document.getElementById('aiCtxChapter'),
    ctxCards: document.getElementById('aiCtxCards'),
    ctxOutline: document.getElementById('aiCtxOutline'),
    skills: document.getElementById('aiSkills'),
    messages: document.getElementById('aiMessages'),
    input: document.getElementById('aiInput'),
    sendBtn: document.getElementById('aiSendBtn'),
    stopBtn: document.getElementById('aiStopBtn'),
    statusText: document.getElementById('aiStatusText'),
    clearBtn: document.getElementById('aiClearBtn'),
    configBtn: document.getElementById('aiConfigBtn'),
  };
  if (!els.pane) return;

  els.profileSelect.addEventListener('change', async () => {
    const id = els.profileSelect.value;
    const nextAi = { ...state.settings.ai, activeProfileId: id };
    const next = { ...state.settings, ai: nextAi };
    setState({ settings: next });
    renderAiHeader();
    try {
      await api.saveSettings(next);
    } catch { /* ignore */ }
  });

  for (const btn of [els.ctxChapter, els.ctxCards, els.ctxOutline]) {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.ctx;
      const nextAi = { ...state.settings.ai, [key]: !state.settings.ai[key] };
      const next = { ...state.settings, ai: nextAi };
      setState({ settings: next });
      renderAiHeader();
      try {
        await api.saveSettings(next);
      } catch { /* ignore */ }
    });
  }

  els.skills.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-skill]');
    if (!btn) return;
    runAiSkill(btn.dataset.skill);
  });

  els.sendBtn.addEventListener('click', () => sendComposer());
  els.stopBtn.addEventListener('click', () => stopAiStream());
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendComposer();
    }
  });

  els.clearBtn.addEventListener('click', async () => {
    if (!state.aiMessages.length) return;
    const ok = await confirmDialog('清空对话', '确定清空当前作品与写心酱的聊天记录吗？', { okText: '清空', danger: true });
    if (!ok) return;
    setState({ aiMessages: [] });
    renderAiMessages();
    if (state.book) api.aiSaveHistory(state.book.id, []).catch(() => {});
  });

  els.configBtn.addEventListener('click', () => {
    if (typeof onOpenSettingsHook === 'function') onOpenSettingsHook('ai');
  });

  els.messages.addEventListener('click', onMessageAction);

  void listen('ai:stream', handleStreamEvent);
  renderAiHeader();
  renderAiMessages();
}

export function renderAiHeader() {
  if (!els.profileSelect) return;
  const aiCfg = state.settings?.ai || {};
  const profiles = Array.isArray(aiCfg.profiles) ? aiCfg.profiles : [];
  const active = activeAiProfile();
  els.profileSelect.innerHTML = profiles
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === active.id ? 'selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.model || '未填模型')}</option>`,
    )
    .join('');

  const configured = Boolean(active.apiKey || active.id === 'ollama' || /127\.0\.0\.1|localhost/.test(active.baseUrl || ''));
  els.badge.textContent = configured
    ? `${active.name} · ${active.model}`
    : `${active.name} · 待填写 API Key（点右上角齿轮）`;

  els.ctxChapter.classList.toggle('on', aiCfg.includeChapter !== false);
  els.ctxCards.classList.toggle('on', aiCfg.includeCards !== false);
  els.ctxOutline.classList.toggle('on', aiCfg.includeOutline !== false);
}

export async function loadAiHistoryForBook(bookId) {
  if (!bookId) {
    setState({ aiMessages: [] });
    renderAiMessages();
    return;
  }
  try {
    const hist = await api.aiLoadHistory(bookId);
    setState({ aiMessages: Array.isArray(hist?.messages) ? hist.messages : [] });
  } catch {
    setState({ aiMessages: [] });
  }
  renderAiMessages();
}

export function openAiPane() {
  setState({ inspectorOpen: true, inspectorPane: 'ai' });
  renderAiHeader();
  setTimeout(() => els.input?.focus(), 60);
}

export function runAiSkill(skill, explicitSelection = '') {
  openAiPane();
  if (state.aiStreaming) {
    toast('写心酱正在创作中，请稍候或先停止当前生成', 'warn');
    return;
  }
  const sel = explicitSelection || getSelection().text || '';
  if (skill === 'ask') {
    els.input.value = `关于这段选中的内容，请帮我分析一下节奏和人物表现：\n`;
    els.input.focus();
    return;
  }
  const builder = SKILL_PROMPTS[skill];
  const prompt = builder ? builder(sel) : '';
  if (!prompt) return;
  void sendAiPrompt(prompt, { skill, selectedOverride: sel });
}

function sendComposer() {
  const text = (els.input?.value || '').trim();
  if (!text) return;
  els.input.value = '';
  void sendAiPrompt(text, { skill: '' });
}

function buildContextPayload(selectedOverride = '') {
  const aiCfg = state.settings?.ai || {};
  const ch = findChapter(state.activeChapterId);
  const fullText = editorValue() || '';
  const maxChars = Math.max(500, Number(aiCfg.contextChars) || 2500);
  const excerpt = aiCfg.includeChapter !== false
    ? (fullText.length > maxChars ? fullText.slice(-maxChars) : fullText)
    : '';
  const selected = selectedOverride || getSelection().text || '';

  let cardsSummary = '';
  if (aiCfg.includeCards !== false && state.cards.length) {
    const sorted = state.cards
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const lines = [];
    let len = 0;
    for (const c of sorted) {
      const f = Object.entries(c.fields || {}).map(([k, v]) => `${k}:${v}`).join('，');
      const line = `- [${c.kind}] ${c.title}${f ? `（${f}）` : ''}${c.content ? `：${c.content.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
      if (len + line.length > 1400) break;
      lines.push(line);
      len += line.length;
    }
    cardsSummary = lines.join('\n');
  }

  return {
    bookTitle: state.book?.title || '',
    bookGenre: state.book?.genre || '',
    bookSummary: state.book?.summary || '',
    chapterTitle: ch?.title || '',
    chapterSummary: aiCfg.includeOutline !== false ? (ch?.summary || '') : '',
    chapterExcerpt: excerpt,
    selectedText: selected,
    cardsSummary,
    customSystemPrompt: aiCfg.systemPrompt || '',
  };
}

async function sendAiPrompt(userText, { skill = '', selectedOverride = '' } = {}) {
  const profile = activeAiProfile();
  const isLocal = profile.id === 'ollama' || /127\.0\.0\.1|localhost/.test(profile.baseUrl || '');
  if (!profile.apiKey && !isLocal) {
    toast('请先在设置里填入 AI 接口的 API Key', 'warn');
    if (typeof onOpenSettingsHook === 'function') onOpenSettingsHook('ai');
    return;
  }

  const now = Date.now();
  const history = state.aiMessages.slice();
  const userMsg = { role: 'user', content: userText, createdAt: now, skill };
  const assistantMsg = { role: 'assistant', content: '', reasoning: '', createdAt: now + 1, skill };
  history.push(userMsg, assistantMsg);

  const requestId = `ai-${now}-${Math.random().toString(36).slice(2, 7)}`;
  activeStream = { requestId, msgIndex: history.length - 1, text: '', reasoning: '' };

  setState({ aiMessages: history, aiStreaming: true, aiRequestId: requestId });
  syncStreamingUi(true);
  renderAiMessages();

  // 取最近 10 轮作为多轮对话记忆传给后端
  const outbound = history
    .slice(0, -1)
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt || 0, skill: m.skill || '' }));

  try {
    const full = await api.aiChatStream(requestId, outbound, buildContextPayload(selectedOverride), profile);
    // 若运行在不支持事件推送的预览环境，直接用返回值收尾
    if (activeStream && activeStream.requestId === requestId) {
      if (full && !activeStream.text) {
        activeStream.text = full;
        const msg = state.aiMessages[activeStream.msgIndex];
        if (msg) msg.content = full;
      }
      finishStream(requestId);
    }
  } catch (e) {
    if (activeStream && activeStream.requestId === requestId) {
      const msg = state.aiMessages[activeStream.msgIndex];
      if (msg && !msg.content) msg.content = `⚠ 请求失败：${e.message}`;
      finishStream(requestId);
    }
    toast(`AI 调用失败：${e.message}`, 'err');
  }
}

function handleStreamEvent(ev) {
  if (!ev || !activeStream || ev.requestId !== activeStream.requestId) return;
  const msg = state.aiMessages[activeStream.msgIndex];
  if (!msg) return;

  if (ev.kind === 'delta') {
    if (ev.text) {
      activeStream.text += ev.text;
      msg.content = activeStream.text;
    }
    if (ev.reasoning) {
      activeStream.reasoning += ev.reasoning;
      msg.reasoning = activeStream.reasoning;
    }
    updateStreamingBubble(activeStream.msgIndex, msg);
  } else if (ev.kind === 'done') {
    if (ev.text && !activeStream.text) {
      msg.content = ev.text;
    }
    finishStream(ev.requestId);
  } else if (ev.kind === 'aborted') {
    if (!msg.content) msg.content = '（已手动停止生成）';
    finishStream(ev.requestId);
  } else if (ev.kind === 'error') {
    msg.content = msg.content ? `${msg.content}\n\n⚠ 中断：${ev.text}` : `⚠ 请求出错：${ev.text}`;
    finishStream(ev.requestId);
  }
}

function finishStream(requestId) {
  if (!activeStream || activeStream.requestId !== requestId) return;
  activeStream = null;
  setState({ aiStreaming: false, aiRequestId: '' });
  syncStreamingUi(false);
  renderAiMessages();
  if (state.book) {
    const clean = state.aiMessages.map((m) => ({
      role: m.role,
      content: m.content || '',
      createdAt: m.createdAt || Date.now(),
      skill: m.skill || '',
    }));
    api.aiSaveHistory(state.book.id, clean).catch(() => {});
  }
}

export async function stopAiStream() {
  if (!state.aiStreaming || !state.aiRequestId) return;
  try {
    await api.aiCancel(state.aiRequestId);
  } catch { /* ignore */ }
}

function syncStreamingUi(streaming) {
  if (!els.sendBtn) return;
  els.sendBtn.hidden = streaming;
  els.stopBtn.hidden = !streaming;
  els.statusText.textContent = streaming ? '✨ 写心酱正在构思并逐字输出…' : '支持流式生成 · 密钥仅存本地';
  els.skills.querySelectorAll('button').forEach((b) => { b.disabled = streaming; });
}

function updateStreamingBubble(idx, msg) {
  const node = els.messages?.querySelector(`[data-ai-idx="${idx}"]`);
  if (!node) {
    renderAiMessages();
    return;
  }
  const bubble = node.querySelector('.ai-bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(msg.content || '…');
  if (msg.reasoning) {
    let det = node.querySelector('.ai-reasoning');
    if (!det) {
      det = document.createElement('details');
      det.className = 'ai-reasoning';
      det.open = true;
      det.innerHTML = '<summary>💭 写心酱的思考过程</summary><div class="ai-reasoning-body"></div>';
      node.insertBefore(det, bubble);
    }
    det.querySelector('.ai-reasoning-body').textContent = msg.reasoning;
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

export function renderAiMessages() {
  if (!els.messages) return;
  if (!state.aiMessages.length) {
    els.messages.innerHTML = `
      <div class="ai-welcome">
        <strong>✦ 你好呀，我是你的创作搭档「写心酱」！</strong>
        我会结合你当前的章节正文、章纲与设定卡片协助你写作。<br/>
        试试点上面的 <b>智能续写 / 文笔润色 / 剧情脑洞</b>，或者在正文里选中一段文字直接唤起我吧～
      </div>`;
    return;
  }
  els.messages.innerHTML = state.aiMessages
    .map((m, idx) => {
      const isUser = m.role === 'user';
      const badge = m.skill && SKILL_LABEL[m.skill] ? `<small style="opacity:0.75;font-size:10.5px">✦ ${SKILL_LABEL[m.skill]}</small>` : '';
      const reasoningHtml =
        !isUser && m.reasoning
          ? `<details class="ai-reasoning"><summary>💭 思考过程（点击展开）</summary><div class="ai-reasoning-body">${escapeHtml(m.reasoning)}</div></details>`
          : '';
      const bodyHtml = isUser ? escapeHtml(m.content || '') : renderMarkdown(m.content || '正在思考…');
      const actions =
        !isUser && m.content && !(state.aiStreaming && idx === state.aiMessages.length - 1)
          ? `<div class="ai-msg-actions">
               <button type="button" class="ai-pill" data-ai-act="insert" data-idx="${idx}">插入光标</button>
               <button type="button" class="ai-pill" data-ai-act="replace" data-idx="${idx}">替换选中</button>
               ${m.skill === 'summarize' ? `<button type="button" class="ai-pill" data-ai-act="synopsis" data-idx="${idx}">填入章纲</button>` : ''}
               <button type="button" class="ai-pill" data-ai-act="card" data-idx="${idx}">存为卡片</button>
               <button type="button" class="ai-pill" data-ai-act="copy" data-idx="${idx}">复制</button>
             </div>`
          : '';
      return `
        <div class="ai-msg ${isUser ? 'user' : 'assistant'}" data-ai-idx="${idx}">
          ${badge}
          ${reasoningHtml}
          <div class="ai-bubble">${bodyHtml}</div>
          ${actions}
        </div>`;
    })
    .join('');
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function onMessageAction(e) {
  const btn = e.target.closest('[data-ai-act]');
  if (!btn) return;
  const msg = state.aiMessages[Number(btn.dataset.idx)];
  if (!msg || !msg.content) return;
  const act = btn.dataset.aiAct;

  if (act === 'insert') {
    if (!state.activeChapterId) { toast('请先打开一个章节', 'warn'); return; }
    insertText(`\n${msg.content.trim()}\n`);
    toast('已插入到正文光标处', 'ok');
  } else if (act === 'replace') {
    if (!state.activeChapterId) { toast('请先打开一个章节', 'warn'); return; }
    const sel = getSelection();
    if (!sel.text) {
      toast('请先在正文中选中要替换的段落', 'warn');
      return;
    }
    insertText(msg.content.trim());
    toast('已替换选中内容', 'ok');
  } else if (act === 'synopsis') {
    setChapterSynopsis(msg.content.trim());
    toast('已写入本章章纲便签', 'ok');
  } else if (act === 'card') {
    if (!state.book) { toast('请先打开一部作品', 'warn'); return; }
    const lines = msg.content.trim().split('\n').filter(Boolean);
    const title = (lines[0] || 'AI 提取设定').replace(/^[#*\-\s【】]+|[】*#]+$/g, '').slice(0, 28) || 'AI 灵感卡片';
    try {
      await api.upsertCard(state.book.id, {
        id: '',
        kind: msg.skill === 'extract-card' ? 'character' : 'inspiration',
        title,
        content: msg.content.trim(),
        tags: ['AI整理'],
        color: '#c0396f',
        pinned: false,
        fields: {},
      });
      await reloadCards();
      toast(`已保存到素材卡片《${title}》`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  } else if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(msg.content);
      toast('已复制到剪贴板', 'ok');
    } catch {
      toast('复制失败，请手动选中复制', 'warn');
    }
  }
}

/** 轻量安全的 Markdown 渲染（防 XSS，支持代码块、粗体、斜体、列表与段落）。 */
function renderMarkdown(md) {
  const src = String(md || '');
  const codeBlocks = [];
  const stripped = src.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `@@CODE_${codeBlocks.length - 1}@@`;
  });

  const blocks = stripped.split(/\n{2,}/).map((block) => {
    const t = block.trim();
    if (!t) return '';
    if (/^@@CODE_\d+@@$/.test(t)) return t;
    const lines = t.split('\n');
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.map(inlineMd).join('<br/>')}</p>`;
  });

  return blocks
    .join('')
    .replace(/@@CODE_(\d+)@@/g, (_, i) => codeBlocks[Number(i)] || '');
}

function inlineMd(line) {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
