// 开发验收入口。这个文件**不会**被产品页面引用：
// 只有设置 NOVEL_MANAGER_SELFTEST / NOVEL_MANAGER_UITEST，或用 ?dev=1 打开时，
// 由 Rust 侧的 initialization_script 动态 import 它，正式使用不会加载分毫。
//
// 用法（开发时）：
//   NOVEL_MANAGER_SELFTEST=1                     写入示例数据，便于截图验收
//   NOVEL_MANAGER_UITEST=1                       跑界面自动验收（25 项交互检查）
//   NOVEL_MANAGER_START_URL=index.html?open=stats 直接展开某个弹层
//   ?dev=1&theme=md3                             浏览器/预览服务器里也能直接激活

const params = new URLSearchParams(window.location.search);
const dev = window.__MOGE_DEV__ === true || params.has('dev') || params.has('selftest');
const seeded = window.__MOGE_SELFTEST__ === true || params.has('selftest');
const uitest = window.__MOGE_UITEST__ === true || params.has('uitest');

if (dev) {
  const scripts = [];
  if (seeded) scripts.push(import('./seed.js'));
  if (uitest) scripts.push(import('./uitest.js'));
  await Promise.all(scripts);
  // 视口 / DPI 诊断只在需要看尺寸时加载
  if (params.has('diag')) await import('./diag.js');
}
