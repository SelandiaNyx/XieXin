// 轻量提示条与通用弹层。

const toasts = () => document.getElementById('toasts');

export function toast(message, kind = '', detail = '') {
  const box = toasts();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${escapeHtml(message)}</div>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}`;
  box.appendChild(el);
  const ttl = kind === 'err' ? 6500 : 3200;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  }, ttl);
}

/** 数字滚动：让字数统计变化时有"在跳"的感觉，而不是生硬替换。 */
const animating = new WeakMap();

export function animateNumber(el, to, { duration = 380, suffix = '' } = {}) {
  if (!el) return;
  const target = Math.max(0, Math.round(Number(to) || 0));
  const from = Number(el.dataset.value || 0);
  if (from === target) {
    el.textContent = target.toLocaleString() + suffix;
    return;
  }
  el.dataset.value = String(target);
  const prev = animating.get(el);
  if (prev) cancelAnimationFrame(prev);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    el.textContent = target.toLocaleString() + suffix;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // 与 --ease-out 一致的减速曲线
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (target - from) * eased);
    el.textContent = value.toLocaleString() + suffix;
    if (t < 1) {
      animating.set(el, requestAnimationFrame(step));
    } else {
      animating.delete(el);
      el.classList.remove('num-pop');
      void el.offsetWidth;
      el.classList.add('num-pop');
    }
  };
  animating.set(el, requestAnimationFrame(step));
}

/** 用 View Transitions 包住一次 DOM 更新，得到系统级的淡入淡出切页效果。 */
export function withViewTransition(update) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof document.startViewTransition !== 'function') {
    const r = update();
    return r;
  }
  return document.startViewTransition(update);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let onCloseHook = null;

export function openModal({ title, body, footer = '', width = '', onMount, onClose }) {
  const overlay = document.getElementById('overlay');
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = title;
  const bodyEl = document.getElementById('modalBody');
  bodyEl.innerHTML = typeof body === 'string' ? body : '';
  const footEl = document.getElementById('modalFoot');
  footEl.innerHTML = typeof footer === 'string' ? footer : '';
  modal.className = `modal ${width}`.trim();

  // 标题栏 × 关闭（每个弹层都重新绑定，避免漏绑）
  document.getElementById('modalClose').onclick = () => closeModal();
  // 点击遮罩空白处也关闭（点弹层内部不关）
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  overlay.style.display = 'flex';
  overlay.hidden = false;
  onCloseHook = onClose || null;
  if (typeof onMount === 'function') onMount(bodyEl, footEl, modal);
  const firstInput = bodyEl.querySelector('input, textarea, select');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  return { bodyEl, footEl, modal, close: closeModal };
}

export function closeModal() {
  const overlay = document.getElementById('overlay');
  if (overlay.hidden) return;
  const hook = onCloseHook;
  onCloseHook = null;
  // 先播放退场动画，动画结束再真正隐藏（更接近 Windows 弹窗的收拢感）
  const finish = () => {
    overlay.classList.remove('closing');
    overlay.hidden = true;
    overlay.style.display = 'none';
    document.getElementById('modalBody').innerHTML = '';
    document.getElementById('modalFoot').innerHTML = '';
  };
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    finish();
  } else {
    overlay.classList.add('closing');
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      finish();
    };
    overlay.addEventListener('animationend', once, { once: true });
    setTimeout(once, 260);
  }
  if (hook) hook();
}

export function modalOpen() {
  return !document.getElementById('overlay').hidden;
}

export function confirmDialog(title, message, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      width: 'narrow',
      body: `<p style="margin:0;font-size:13px;line-height:1.7">${escapeHtml(message)}</p>`,
      footer: `<button class="mini" data-role="cancel">取消</button>
               <button class="primary ${danger ? '' : 'ghost'}" data-role="ok"
                 ${danger ? 'style="background:var(--danger);color:#fff"' : ''}>${escapeHtml(okText)}</button>`,
      onMount(bodyEl, footEl) {
        footEl.querySelector('[data-role="cancel"]').onclick = () => { closeModal(); resolve(false); };
        footEl.querySelector('[data-role="ok"]').onclick = () => { closeModal(); resolve(true); };
      },
      onClose() { resolve(false); },
    });
  });
}

export function promptDialog(title, label, value = '', { placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title,
      width: 'narrow',
      body: multiline
        ? `<div class="field"><label>${escapeHtml(label)}</label><textarea id="promptInput" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea></div>`
        : `<div class="field"><label>${escapeHtml(label)}</label><input id="promptInput" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" /></div>`,
      footer: `<button class="mini" data-role="cancel">取消</button><button class="primary" data-role="ok">确定</button>`,
      onMount(bodyEl, footEl) {
        const input = bodyEl.querySelector('#promptInput');
        const submit = () => { done = true; const v = input.value; closeModal(); resolve(v); };
        footEl.querySelector('[data-role="cancel"]').onclick = () => { done = true; closeModal(); resolve(null); };
        footEl.querySelector('[data-role="ok"]').onclick = submit;
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (!multiline || e.ctrlKey)) submit();
        });
      },
      onClose() { if (!done) resolve(null); },
    });
  });
}

export function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function relativeTime(ms) {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(ms).slice(0, 10);
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function debounce(fn, wait = 300) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function hhmmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
