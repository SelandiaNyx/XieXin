// 番茄钟：可开始 / 暂停 / 继续 / 停止 / 跳过，专注与休息时长可调，状态本地保存。

import { toast, openModal, closeModal, hhmmss, escapeHtml } from './ui.js';

const KEY = 'heartwrite-pomodoro';

const defaults = {
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  roundsPerLong: 4,
  autoNext: true,
  running: false,
  mode: 'focus', // focus | break | long
  remaining: 25 * 60,
  rounds: 0,
  startedAt: 0,
};

export const pomodoro = { ...defaults };

let timer = null;
let onTick = () => {};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      Object.assign(pomodoro, saved);
      // 应用重启后不自动继续计时，避免"后台偷跑"
      pomodoro.running = false;
      if (!['focus', 'break', 'long'].includes(pomodoro.mode)) pomodoro.mode = 'focus';
      if (!(pomodoro.remaining > 0)) pomodoro.remaining = durationMs('focus') / 1000;
    }
  } catch {
    /* 忽略损坏的本地数据 */
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...pomodoro }));
  } catch {
    /* 忽略 */
  }
}

function durationSeconds(mode) {
  if (mode === 'break') return Math.round(pomodoro.breakMin * 60);
  if (mode === 'long') return Math.round(pomodoro.longBreakMin * 60);
  return Math.round(pomodoro.focusMin * 60);
}

function durationMs(mode) {
  return durationSeconds(mode) * 1000;
}

export function modeLabel(mode) {
  return { focus: '专注', break: '短休息', long: '长休息' }[mode] || mode;
}

export function modeMinutes(mode) {
  return Math.round(durationSeconds(mode) / 60);
}

export function progress() {
  const total = durationSeconds(pomodoro.mode) || 1;
  return Math.min(1, Math.max(0, 1 - pomodoro.remaining / total));
}

export function start(notify = true) {
  if (pomodoro.running) return;
  pomodoro.running = true;
  pomodoro.startedAt = Date.now();
  save();
  render();
  if (notify) toast(`开始${modeLabel(pomodoro.mode)} ${Math.round(pomodoro.remaining / 60)} 分钟`, 'ok');
}

export function pause() {
  if (!pomodoro.running) return;
  pomodoro.running = false;
  save();
  render();
  toast('番茄钟已暂停', 'warn');
}

export function toggle() {
  if (pomodoro.running) pause();
  else start();
}

export function reset() {
  pomodoro.running = false;
  pomodoro.remaining = durationSeconds(pomodoro.mode);
  save();
  render();
}

/** 结束当前阶段并进入下一阶段；`skipped` 表示用户手动跳过。 */
export function nextPhase(skipped = false) {
  if (pomodoro.mode === 'focus') {
    if (!skipped) pomodoro.rounds += 1;
    const long = pomodoro.rounds > 0 && pomodoro.rounds % Math.max(1, pomodoro.roundsPerLong) === 0;
    pomodoro.mode = long ? 'long' : 'break';
    pomodoro.remaining = durationSeconds(pomodoro.mode);
    if (!skipped) {
      toast(`专注完成，${long ? '长休息' : '短休息'} ${modeMinutes(pomodoro.mode)} 分钟`, 'ok', `已完成 ${pomodoro.rounds} 个番茄`);
    } else {
      toast(`已跳到${modeLabel(pomodoro.mode)}`, 'warn');
    }
  } else {
    pomodoro.mode = 'focus';
    pomodoro.remaining = durationSeconds(pomodoro.mode);
    if (!skipped) toast('休息结束，继续写作', 'ok');
  }
  pomodoro.running = pomodoro.autoNext && !skipped;
  if (skipped) pomodoro.running = false;
  save();
  render();
}

/** 手动切换到指定阶段。 */
export function switchMode(mode) {
  pomodoro.mode = mode;
  pomodoro.running = false;
  pomodoro.remaining = durationSeconds(mode);
  save();
  render();
}

export function setDuration(field, minutes) {
  const value = Math.min(180, Math.max(1, Math.round(Number(minutes) || 0)));
  pomodoro[field] = value;
  if (!pomodoro.running) {
    const active = { focusMin: 'focus', breakMin: 'break', longBreakMin: 'long' }[field];
    if (active && active === pomodoro.mode) pomodoro.remaining = durationSeconds(pomodoro.mode);
  }
  save();
  render();
  return value;
}

export function setAutoNext(value) {
  pomodoro.autoNext = Boolean(value);
  save();
  render();
}

export function initPomodoro({ onUpdate } = {}) {
  load();
  if (onUpdate) onTick = onUpdate;
  clearInterval(timer);
  let last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - last) / 1000;
    last = now;
    if (!pomodoro.running) return;
    pomodoro.remaining -= elapsed;
    if (pomodoro.remaining <= 0) {
      pomodoro.remaining = 0;
      nextPhase(false);
      return;
    }
    render();
  }, 250);
  render();
}

export function statusText() {
  return `${modeLabel(pomodoro.mode)} ${hhmmss(pomodoro.remaining)}`;
}

export function render() {
  const chip = document.getElementById('pomodoroChip');
  if (chip) {
    chip.textContent = `${pomodoro.running ? '⏱' : '⏸'} ${statusText()}`;
    chip.classList.toggle('on', pomodoro.running);
    chip.title = pomodoro.running
      ? `${modeLabel(pomodoro.mode)}进行中，点击打开番茄钟面板`
      : '番茄钟已暂停，点击打开面板';
  }
  const chip2 = document.querySelector('.sidebar-bottom .chip[data-action="pomodoro"]');
  if (chip2) chip2.classList.toggle('on', pomodoro.running);
  onTick(pomodoro);
  if (!document.getElementById('pomoModal')) return;
  updateModal();
}

/** 打开番茄钟面板。 */
export function openPomodoroDialog() {
  openModal({
    title: '番茄钟',
    width: 'narrow',
    body: `
      <div id="pomoModal" class="pomodoro">
        <div class="pomo-phase" id="pomoPhase">专注</div>
        <div class="pomo-time" id="pomoTime">25:00</div>
        <div class="progress"><i id="pomoBar" style="width:0%"></i></div>
        <div class="pomo-rounds" id="pomoRounds">已完成 0 个番茄</div>
        <div class="pomo-actions">
          <button class="primary" id="pomoToggle">开始</button>
          <button class="mini" id="pomoReset">重置</button>
          <button class="mini" id="pomoSkip">跳到下一阶段</button>
        </div>
        <div class="section-title">阶段</div>
        <div class="pomo-modes">
          <button class="mini" data-mode="focus">专注</button>
          <button class="mini" data-mode="break">短休息</button>
          <button class="mini" data-mode="long">长休息</button>
        </div>
        <div class="section-title">时长设置</div>
        <div class="form-grid">
          <div class="field"><label>专注（分钟）</label><input id="pomoFocus" type="number" min="1" max="180" value="${pomodoro.focusMin}" /></div>
          <div class="field"><label>短休息（分钟）</label><input id="pomoBreak" type="number" min="1" max="180" value="${pomodoro.breakMin}" /></div>
          <div class="field"><label>长休息（分钟）</label><input id="pomoLong" type="number" min="1" max="180" value="${pomodoro.longBreakMin}" /></div>
          <div class="field"><label>每几个番茄长休息</label><input id="pomoPerLong" type="number" min="1" max="12" value="${pomodoro.roundsPerLong}" /></div>
          <div class="field full">
            <div class="switch-row"><span>阶段结束后自动开始下一阶段</span>
              <label class="switch"><input type="checkbox" id="pomoAuto" ${pomodoro.autoNext ? 'checked' : ''} /><i></i></label>
            </div>
          </div>
        </div>
        <p class="hint" style="font-size:11.5px;color:var(--ink-faint);line-height:1.7;margin:10px 0 0">
          番茄钟是一种专注写作法：先连续专注 ${pomodoro.focusMin} 分钟，再休息 ${pomodoro.breakMin} 分钟，如此循环；
          每完成 ${pomodoro.roundsPerLong} 个番茄做一次长休息。计时在后台照常走，状态栏会一直显示剩余时间。
        </p>
      </div>`,
    footer: `<span class="spacer">设置会自动保存</span><button class="mini" data-role="close">关闭</button>`,
    onMount(bodyEl, footEl) {
      const bindNumber = (id, field) => {
        const input = bodyEl.querySelector(id);
        input.addEventListener('change', () => {
          input.value = setDuration(field, input.value);
          updateModal();
        });
      };
      bindNumber('#pomoFocus', 'focusMin');
      bindNumber('#pomoBreak', 'breakMin');
      bindNumber('#pomoLong', 'longBreakMin');
      bindNumber('#pomoPerLong', 'roundsPerLong');
      bodyEl.querySelector('#pomoAuto').addEventListener('change', (e) => setAutoNext(e.target.checked));
      bodyEl.querySelector('#pomoToggle').onclick = () => toggle();
      bodyEl.querySelector('#pomoReset').onclick = () => reset();
      bodyEl.querySelector('#pomoSkip').onclick = () => nextPhase(true);
      bodyEl.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.onclick = () => switchMode(btn.dataset.mode);
      });
      footEl.querySelector('[data-role="close"]').onclick = () => closeModal();
      updateModal();
    },
  });
}

function updateModal() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('pomoPhase', modeLabel(pomodoro.mode));
  set('pomoTime', hhmmss(pomodoro.remaining));
  set('pomoRounds', `已完成 ${pomodoro.rounds} 个番茄${pomodoro.autoNext ? ' · 自动进入下一阶段' : ''}`);
  const bar = document.getElementById('pomoBar');
  if (bar) bar.style.width = `${Math.round(progress() * 100)}%`;
  const toggleBtn = document.getElementById('pomoToggle');
  if (toggleBtn) toggleBtn.textContent = pomodoro.running ? '暂停' : pomodoro.remaining < durationSeconds(pomodoro.mode) ? '继续' : '开始';
  document.querySelectorAll('#pomoModal [data-mode]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === pomodoro.mode);
  });
  void escapeHtml;
}
