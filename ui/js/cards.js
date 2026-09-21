// 右侧边栏：人物 / 剧情 / 灵光 / 设定 卡片。

import { api } from './api.js';
import { state, setState } from './store.js';
import { toast, openModal, closeModal, confirmDialog, escapeHtml, promptDialog } from './ui.js';
import { insertText } from './editor.js';

const KIND_LABEL = { character: '人物', plot: '剧情', inspiration: '灵光', world: '设定' };
const KIND_COLOR = { character: '#8ab4f8', plot: '#f5a623', inspiration: '#7ad1a6', world: '#c792ea' };

export function initCards() {
  document.getElementById('cardTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    setState({ cardKind: tab.dataset.kind, activeCardId: '' });
    renderCards();
  });
  document.getElementById('cardSearch').addEventListener('input', (e) => {
    setState({ cardSearch: e.target.value });
    renderCards();
  });
  document.getElementById('addCard').addEventListener('click', () => openCardEditor(null));
  document.getElementById('insertCardContent').addEventListener('click', () => insertSelectedCard());
  document.getElementById('cardsToOutline').addEventListener('click', () => buildOutlineFromCards());
}

export function renderCards() {
  const box = document.getElementById('cards');
  document.querySelectorAll('#cardTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.kind === state.cardKind);
  });
  if (!state.book) {
    box.innerHTML = `<div class="cards-empty">打开一本书后<br/>即可记录人物与灵感</div>`;
    return;
  }
  const kw = (state.cardSearch || '').trim().toLowerCase();
  const list = state.cards
    .filter((c) => c.kind === state.cardKind)
    .filter((c) => {
      if (!kw) return true;
      const hay = [c.title, c.content, (c.tags || []).join(' '), Object.values(c.fields || {}).join(' ')]
        .join(' ')
        .toLowerCase();
      return hay.includes(kw);
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0));

  if (list.length === 0) {
    box.innerHTML = `<div class="cards-empty">${KIND_LABEL[state.cardKind]}卡片为空<br/>点击右上角 ＋ 新建</div>`;
    return;
  }
  box.innerHTML = list
    .map((c) => {
      const fields = Object.entries(c.fields || {})
        .filter(([, v]) => v)
        .slice(0, 3)
        .map(([k, v]) => `<div class="card-fields">${escapeHtml(k)}：${escapeHtml(v)}</div>`)
        .join('');
      const tags = (c.tags || []).length
        ? `<div class="card-tags">${c.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';
      return `
        <div class="card-item ${c.pinned ? 'pinned' : ''} ${c.id === state.activeCardId ? 'active' : ''}"
             data-card-id="${c.id}" style="--card-color:${c.color || KIND_COLOR[c.kind] || 'var(--accent)'}">
          <div class="card-head">
            <span class="card-title">${escapeHtml(c.title || '（未命名）')}</span>
            <span class="card-kind">${KIND_LABEL[c.kind] || c.kind}</span>
          </div>
          ${c.content ? `<div class="card-body">${escapeHtml(c.content)}</div>` : ''}
          ${fields}
          ${tags}
        </div>`;
    })
    .join('');

  box.querySelectorAll('.card-item').forEach((el) => {
    el.addEventListener('click', () => {
      setState({ activeCardId: el.dataset.cardId });
      renderCards();
    });
    el.addEventListener('dblclick', () => {
      const card = state.cards.find((c) => c.id === el.dataset.cardId);
      if (card) openCardEditor(card);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const card = state.cards.find((c) => c.id === el.dataset.cardId);
      if (card) openCardEditor(card);
    });
  });
}

export function activeCard() {
  return state.cards.find((c) => c.id === state.activeCardId) || null;
}

async function reloadCards() {
  if (!state.book) return;
  const cards = await api.listCards(state.book.id);
  setState({ cards });
  renderCards();
}

export function openCardEditor(card) {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  const isNew = !card;
  const draft = card || {
    id: '',
    kind: state.cardKind,
    title: '',
    content: '',
    tags: [],
    color: KIND_COLOR[state.cardKind] || '#8ab4f8',
    pinned: false,
    fields: {},
  };
  const fieldsText = Object.entries(draft.fields || {}).map(([k, v]) => `${k}：${v}`).join('\n');

  openModal({
    title: isNew ? `新建${KIND_LABEL[draft.kind]}卡片` : `编辑：${draft.title || '未命名'}`,
    body: `
      <div class="form-grid">
        <div class="field">
          <label>标题</label>
          <input id="cardTitle" type="text" value="${escapeHtml(draft.title)}" placeholder="例如：沈孤鸿 / 雪夜伏击" />
        </div>
        <div class="field">
          <label>类型</label>
          <select id="cardKindSel">
            ${Object.entries(KIND_LABEL)
              .map(([k, v]) => `<option value="${k}" ${k === draft.kind ? 'selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field full">
          <label>内容</label>
          <textarea id="cardContent" rows="5" placeholder="随便写：人物小传、伏笔、灵感碎片……">${escapeHtml(draft.content)}</textarea>
        </div>
        <div class="field">
          <label>标签（用空格或逗号分隔）</label>
          <input id="cardTags" type="text" value="${escapeHtml((draft.tags || []).join(' '))}" placeholder="主角 剑客 伏笔" />
        </div>
        <div class="field">
          <label>颜色</label>
          <input id="cardColor" type="color" value="${escapeHtml(draft.color || '#8ab4f8')}" style="height:34px;padding:2px" />
        </div>
        <div class="field full">
          <label>自定义字段（每行「字段名：内容」）</label>
          <textarea id="cardFields" rows="3" placeholder="身份：剑客&#10;目标：找到妹妹">${escapeHtml(fieldsText)}</textarea>
        </div>
        <div class="field full">
          <div class="switch-row" style="padding:0">
            <span>置顶显示</span>
            <label class="switch"><input type="checkbox" id="cardPinned" ${draft.pinned ? 'checked' : ''} /><i></i></label>
          </div>
        </div>
      </div>`,
    footer: `${isNew ? '' : '<button class="mini" data-role="delete" style="color:var(--danger)">删除</button>'}
             <span class="spacer"></span>
             ${isNew ? '' : '<button class="mini" data-role="insert">插入正文</button>'}
             <button class="mini" data-role="cancel">取消</button>
             <button class="primary" data-role="save">保存</button>`,
    onMount(bodyEl, footEl) {
      const collect = () => {
        const fields = {};
        bodyEl.querySelector('#cardFields').value.split('\n').forEach((line) => {
          const idx = line.indexOf('：') >= 0 ? line.indexOf('：') : line.indexOf(':');
          if (idx > 0) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (k) fields[k] = v;
          }
        });
        const rawTags = bodyEl.querySelector('#cardTags').value;
        return {
          ...draft,
          kind: bodyEl.querySelector('#cardKindSel').value,
          title: bodyEl.querySelector('#cardTitle').value.trim(),
          content: bodyEl.querySelector('#cardContent').value,
          tags: rawTags.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean),
          color: bodyEl.querySelector('#cardColor').value,
          pinned: bodyEl.querySelector('#cardPinned').checked,
          fields,
        };
      };
      const save = async () => {
        const payload = collect();
        if (!payload.title) { toast('请填写标题', 'warn'); return; }
        try {
          await api.upsertCard(state.book.id, payload);
          closeModal();
          await reloadCards();
          toast('卡片已保存', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      footEl.querySelector('[data-role="save"]').onclick = save;
      footEl.querySelector('[data-role="cancel"]').onclick = closeModal;
      const del = footEl.querySelector('[data-role="delete"]');
      if (del) {
        del.onclick = async () => {
          const ok = await confirmDialog('删除卡片', `确定删除《${draft.title || '未命名'}》吗？`, { okText: '删除', danger: true });
          if (!ok) return;
          try {
            await api.deleteCard(state.book.id, draft.id);
            closeModal();
            setState({ activeCardId: '' });
            await reloadCards();
            toast('卡片已删除', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      }
      const ins = footEl.querySelector('[data-role="insert"]');
      if (ins) {
        ins.onclick = () => {
          const payload = collect();
          insertText(payload.content || payload.title);
          toast('已插入正文', 'ok');
        };
      }
    },
  });
}

function insertSelectedCard() {
  const card = activeCard();
  if (!card) { toast('请先在右侧选中一张卡片', 'warn'); return; }
  const text = card.content ? `${card.content}` : card.title;
  insertText(text);
  toast(`已插入《${card.title}》`, 'ok');
}

async function buildOutlineFromCards() {
  const plots = state.cards.filter((c) => c.kind === 'plot');
  const chars = state.cards.filter((c) => c.kind === 'character');
  if (plots.length === 0 && chars.length === 0) { toast('还没有剧情或人物卡片', 'warn'); return; }
  const lines = ['【剧情提纲】'];
  if (plots.length) {
    plots.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.title}${p.content ? ` —— ${p.content.replace(/\n/g, ' ')}` : ''}`);
    });
  }
  if (chars.length) {
    lines.push('', '【人物速览】');
    chars.forEach((c) => {
      const extra = Object.entries(c.fields || {}).map(([k, v]) => `${k}:${v}`).join('，');
      lines.push(`· ${c.title}${extra ? `（${extra}）` : ''}${c.content ? ` —— ${c.content.replace(/\n/g, ' ')}` : ''}`);
    });
  }
  const text = lines.join('\n');
  const ans = await promptDialog('生成提纲', '可直接编辑后插入到正文当前位置', text, { multiline: true });
  if (ans === null) return;
  insertText(`\n${ans}\n`);
  toast('提纲已插入正文', 'ok');
}
