// 开发诊断：抓取 WebView 自身的渲染结果并报告视口尺寸/DPI。
// 通过环境变量 NOVEL_MANAGER_SELFTEST=1 自动执行，结果写入数据目录。
import { log } from './api.js';

const params = new URLSearchParams(window.location.search);
if (window.__MOGE_SELFTEST__ === true || params.has('selftest')) {
  setTimeout(async () => {
    const info = [
      `innerWidth=${window.innerWidth}`,
      `innerHeight=${window.innerHeight}`,
      `devicePixelRatio=${window.devicePixelRatio}`,
      `screen=${window.screen.width}x${window.screen.height}`,
      `availScreen=${window.screen.availWidth}x${window.screen.availHeight}`,
      `inspectorWidth=${document.getElementById('inspector').getBoundingClientRect().width}`,
      `sidebarWidth=${document.getElementById('sidebar').getBoundingClientRect().width}`,
      `mainWidth=${document.querySelector('.main').getBoundingClientRect().width}`,
      `cards=${document.querySelectorAll('.card-item').length}`,
      `tocRows=${document.querySelectorAll('.chapter-row').length}`,
    ];
    log(`[viewport] ${info.join(' ')}`);
    const sel = document.getElementById('statusSelect');
    log(
      `[status-ui] 选项=${sel.options.length} 当前=${sel.value} 宽度=${Math.round(sel.getBoundingClientRect().width)}` +
        ` 主题=${document.documentElement.getAttribute('data-theme')} 会话字数=${window.__moge.state.sessionChars}`,
    );
    try {
      const diag = await window.__TAURI__.core.invoke('window_diag');
      log(`[window] ${diag}`);
    } catch (e) {
      log(`[window] 失败: ${e && e.message ? e.message : e}`);
    }
  }, 2500);
}
