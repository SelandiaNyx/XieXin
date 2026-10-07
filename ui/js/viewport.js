// 视口与输入设备判断。
//
// 「窄屏」和「触屏」是两件事，不能混：
//   · 窄屏（≤900px）→ 单列 + 抽屉布局；
//   · 触屏（没有悬停）→ 放大点击目标、隐藏悬停才出现的按钮、禁用 HTML5 拖拽。
// 触屏平板就是「宽屏 + 触屏」，两边规则会同时生效，所以判断必须分开。
//
// 单独成模块是为了避免 sidebar.js ↔ mobile.js 互相 import 形成环。

const mqNarrow = window.matchMedia('(max-width: 900px)');
const mqCoarse = window.matchMedia('(hover: none), (pointer: coarse)');

/** 当前是不是窄屏布局（抽屉 + 单列）。 */
export function isNarrow() {
  return mqNarrow.matches;
}

/** 当前是不是触屏（没有悬停能力）。 */
export function isTouch() {
  return mqCoarse.matches;
}

/** 窄屏或触屏都算"移动端"，用于决定要不要自动聚焦正文（避免一开屏就弹键盘）。 */
export function isMobile() {
  return mqNarrow.matches || mqCoarse.matches;
}

/** 旋转屏幕 / 拉伸窗口 / 折叠屏展开时回调，用来重算依赖视口的 UI。 */
export function onViewportChange(fn) {
  for (const mq of [mqNarrow, mqCoarse]) {
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
  }
}
