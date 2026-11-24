// 跨端同步中心弹层：局域网同步（LAN · 扫码配对 · 自动发现）+ WebDAV 云同步（坚果云 / Nextcloud / AList）。

import { api } from '../api.js';
import { state, setState } from '../store.js';
import { toast, openModal, closeModal, escapeHtml, formatTime, relativeTime } from '../ui.js';
import { flushPendingSave, openBookInEditor, clearEditor } from '../editor.js';
import { renderToc } from '../sidebar.js';
import { renderCards } from '../cards.js';
import { reloadWorkspace } from './bookshelf.js';
import { renderQrSvg } from '../qr.js';

const WEBDAV_PRESETS = {
  jianguoyun: {
    label: '坚果云',
    url: 'https://dav.jianguoyun.com/dav/',
    hint: '坚果云请在网页端「账户信息 → 安全选项 → 第三方应用管理」生成专属「应用密码」，不要填登录密码。',
  },
  nextcloud: {
    label: 'Nextcloud / OwnCloud',
    url: 'https://your-server/remote.php/dav/files/username/',
    hint: '填写 Nextcloud 左下角设置里显示的 WebDAV 完整地址，并建议使用应用专用密码。',
  },
  alist: {
    label: 'AList / 群晖 NAS',
    url: 'https://your-nas:5006/dav/',
    hint: '支持 AList（/dav）与群晖 WebDAV Server；若使用局域网自签证书建议走 HTTP 或受信任证书。',
  },
  custom: {
    label: '自定义 WebDAV',
    url: '',
    hint: '任何兼容 RFC 4918 的标准 WebDAV 服务器均可使用。',
  },
};

const PLATFORM_LABEL = {
  windows: 'Windows 电脑',
  macos: 'macOS 电脑',
  linux: 'Linux 电脑',
  android: 'Android 手机',
};

let autoSyncTimer = null;

/** 根据最新同步状态刷新顶栏和底栏的指示器。 */
export function updateSyncIndicator() {
  const topBtn = document.getElementById('syncBtn');
  const chip = document.getElementById('syncStatusChip');
  const lanOn = Boolean(state.lanStatus?.running);
  const davOn = Boolean(state.settings?.webdav?.enabled && state.settings?.webdav?.url);

  if (topBtn) {
    topBtn.classList.toggle('online', lanOn || davOn);
    topBtn.classList.toggle('syncing', Boolean(state.syncing));
  }
  if (chip) {
    if (state.syncing) {
      chip.textContent = '同步中…';
      chip.classList.add('on');
    } else if (lanOn) {
      chip.textContent = `LAN :${state.lanStatus.port}`;
      chip.classList.add('on');
    } else if (davOn) {
      const last = state.settings.webdav.lastSyncAt;
      chip.textContent = last ? `云同步 · ${relativeTime(last)}` : 'WebDAV 就绪';
      chip.classList.remove('on');
    } else {
      chip.textContent = '跨端同步';
      chip.classList.remove('on');
    }
  }
}

/** 同步后安全重载工作区与当前章节，确保远端变更立即反映在界面上。 */
export async function reloadAfterSync() {
  const prevBookId = state.book?.id || '';
  await reloadWorkspace();
  const books = state.registry.books || [];
  if (prevBookId && books.some((b) => b.id === prevBookId)) {
    await openBookInEditor(prevBookId);
  } else if (books.length) {
    await openBookInEditor(books[0].id);
  } else {
    setState({ book: null, cards: [] });
    clearEditor();
  }
  renderToc();
  renderCards();
  updateSyncIndicator();
}

/** 按配置启动/重启 WebDAV 定时自动同步。 */
export function restartWebDavAutoSync() {
  clearInterval(autoSyncTimer);
  const dav = state.settings?.webdav;
  if (!dav?.enabled || !dav?.autoSync || !dav?.url) return;
  const mins = Math.max(2, Number(dav.autoSyncMins) || 10);
  autoSyncTimer = setInterval(async () => {
    if (state.syncing || state.transitioning || state.saving) return;
    try {
      if (state.dirty) await flushPendingSave();
      setState({ syncing: true });
      updateSyncIndicator();
      const report = await api.webdavSync(null, 'bidirectional');
      setState({ syncing: false });
      const changed = report.downloaded + report.merged + report.deletedLocal;
      if (changed > 0) await reloadAfterSync();
      else updateSyncIndicator();
    } catch {
      setState({ syncing: false });
      updateSyncIndicator();
    }
  }, mins * 60 * 1000);
}

/** 解析用户粘贴的 `heartwrite://192.168.1.5:19820?pin=123456` 或普通地址。 */
function parseConnectInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { url: '', pin: '' };
  if (s.startsWith('heartwrite://')) {
    try {
      const u = new URL(s.replace(/^heartwrite:\/\//, 'http://'));
      return {
        url: `http://${u.host}`,
        pin: u.searchParams.get('pin') || '',
      };
    } catch {
      return { url: s, pin: '' };
    }
  }
  return { url: s, pin: '' };
}

function reportHtml(report) {
  if (!report) return '';
  const summary = [
    `上传 ${report.uploaded || 0}`,
    `下载 ${report.downloaded || 0}`,
    `合并 ${report.merged || 0}`,
    `冲突留档 ${report.conflicts || 0}`,
    `跳过 ${report.skipped || 0}`,
  ].join(' · ');
  const list = (report.details || []).length
    ? `<ul>${report.details.slice(0, 20).map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
    : '<div style="margin-top:4px;opacity:0.85">两端稿件已完全一致，无需传输。</div>';
  return `
    <div class="sync-report">
      <div><strong>✓ ${escapeHtml(report.mode || '同步')}完成（${report.durationMs || 0} ms）</strong> · 对端：${escapeHtml(report.peerName || '-')}</div>
      <div style="margin-top:4px">${summary}</div>
      ${report.conflicts ? '<div style="margin-top:4px;color:var(--md-warn);font-weight:600">提示：冲突章节的另一端原文已自动存入「历史版本」，绝不会丢稿。</div>' : ''}
      ${list}
    </div>`;
}

export async function openSyncCenter(initialTab = 'lan') {
  try {
    const st = await api.lanStatus();
    setState({ lanStatus: st });
  } catch { /* 预览模式下沿用默认状态 */ }

  let activeTab = initialTab;
  let discoveredPeers = [];

  openModal({
    title: '跨端同步中心（局域网 & WebDAV）',
    width: 'wide',
    body: `
      <div class="modal-tabs" id="syncTabs">
        <button type="button" class="modal-tab ${activeTab === 'lan' ? 'active' : ''}" data-tab="lan">📡 局域网同步（电脑 ↔ 手机）</button>
        <button type="button" class="modal-tab ${activeTab === 'webdav' ? 'active' : ''}" data-tab="webdav">☁ WebDAV 云同步（坚果云等）</button>
      </div>
      <div id="syncBody"></div>`,
    footer: `<span class="spacer">统一三向差异合并 · 冲突自动保留历史版本 · 零丢稿</span>
             <button class="mini" data-role="close">关闭</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="close"]').onclick = closeModal;
      const container = bodyEl.querySelector('#syncBody');
      const tabs = bodyEl.querySelector('#syncTabs');

      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        activeTab = btn.dataset.tab;
        tabs.querySelectorAll('.modal-tab').forEach((t) => t.classList.toggle('active', t === btn));
        renderPane();
      });

      const renderPane = () => {
        if (activeTab === 'lan') renderLanPane(container);
        else renderWebDavPane(container);
      };

      const renderLanPane = (host) => {
        const lan = state.settings.lan || {};
        const st = state.lanStatus || {};
        const running = Boolean(st.running);
        const pin = st.pin || lan.pin || '------';
        const port = st.port || lan.port || 19820;
        const deviceName = state.settings.deviceName || st.deviceName || '我的写心设备';
        const addrs = (st.addresses || []).length ? st.addresses : ['127.0.0.1'];
        const uri = st.connectUri || `heartwrite://${addrs[0]}:${port}?pin=${pin}`;

        host.innerHTML = `
          <div class="sync-card">
            <div class="sync-card-head">
              <h4>本机作为局域网同步主机</h4>
              <span class="status-badge ${running ? 'ok' : ''}">${running ? `● 服务运行中 · 端口 ${port}` : '○ 未启动'}</span>
            </div>
            <div class="form-grid" style="margin-bottom:12px">
              <div class="field">
                <label>本机设备名</label>
                <input id="lanDeviceName" type="text" value="${escapeHtml(deviceName)}" placeholder="如：家里电脑 / 随身手机" />
              </div>
              <div class="field">
                <label>监听端口</label>
                <input id="lanPort" type="number" min="1024" max="65535" value="${port}" />
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
              <button type="button" class="primary" id="lanToggleBtn">${running ? '停止同步服务' : '开启本机同步服务'}</button>
              <button type="button" class="mini" id="lanRegenPinBtn">刷新 6 位配对码</button>
              ${running ? '<button type="button" class="mini" id="lanCopyUriBtn">复制配对连接串</button>' : ''}
            </div>
            ${running ? `
              <div class="lan-pair-grid">
                <div>
                  <div style="font-size:12px;color:var(--md-on-surface-variant);margin-bottom:6px">配对 PIN 码（另一台设备输入或扫码即可同步）</div>
                  <div class="pin-display">${escapeHtml(pin)}</div>
                  <div class="kv-list" style="margin-top:10px">
                    <div class="kv"><span class="k">局域网地址</span><span>${addrs.map((ip) => `http://${escapeHtml(ip)}:${port}`).join(' / ')}</span></div>
                    <div class="kv"><span class="k">一键连接串</span><code style="word-break:break-all;font-size:11.5px">${escapeHtml(uri)}</code></div>
                  </div>
                </div>
                <div class="qr-box" title="扫码或复制连接串配对">${renderQrSvg(uri)}</div>
              </div>` : '<div class="hint">开启后，同一 Wi-Fi 下的电脑或手机写心客户端即可自动发现本机并一键双向同步稿件。</div>'}
          </div>

          <div class="sync-card">
            <div class="sync-card-head">
              <h4>连接局域网里的另一台设备</h4>
              <button type="button" class="mini" id="lanScanBtn">🔍 扫描附近设备</button>
            </div>
            <div id="lanPeersBox"></div>
            <div class="form-grid" style="margin-top:10px">
              <div class="field full">
                <label>对方地址（支持直接粘贴 <code>heartwrite://...</code> 配对串，会自动拆出 PIN）</label>
                <input id="lanPeerUrl" type="text" value="${escapeHtml(lan.lastPeerUrl || '')}" placeholder="例如：192.168.1.8:19820 或 heartwrite://192.168.1.8:19820?pin=123456" />
              </div>
              <div class="field">
                <label>对方 6 位配对 PIN 码</label>
                <input id="lanPeerPin" type="text" value="${escapeHtml(lan.lastPeerPin || '')}" placeholder="6 位数字" maxlength="12" />
              </div>
              <div class="field">
                <label>同步策略</label>
                <select id="lanDirection">
                  <option value="bidirectional">智能双向合并（推荐 · 冲突自动留存历史版本）</option>
                  <option value="push">仅上传（以本机为准推送到对方）</option>
                  <option value="pull">仅下载（以对方为准拉取到本机）</option>
                </select>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
              <button type="button" class="mini" id="lanPingBtn">测试连通</button>
              <button type="button" class="primary" id="lanSyncNowBtn">⚡ 立即局域网同步</button>
              ${lan.lastSyncAt ? `<span class="hint" style="align-self:center">上次局域网同步：${formatTime(lan.lastSyncAt)}</span>` : ''}
            </div>
            <div id="lanReportBox"></div>
          </div>`;

        const renderPeers = () => {
          const box = host.querySelector('#lanPeersBox');
          if (!discoveredPeers.length) {
            box.innerHTML = '<div class="hint">点击右上角「扫描附近设备」自动发现同一 Wi-Fi 下开启了同步服务的电脑或手机。</div>';
            return;
          }
          box.innerHTML = `<div class="peer-list">${discoveredPeers
            .map(
              (p, idx) => `<div class="peer-row">
                <div>
                  <strong>${escapeHtml(p.deviceName)}</strong>
                  <small>${escapeHtml(PLATFORM_LABEL[p.platform] || p.platform)} · ${escapeHtml(p.url)} · ${p.books} 部作品</small>
                </div>
                <button type="button" class="mini" data-pick-peer="${idx}">选用</button>
              </div>`,
            )
            .join('')}</div>`;
          box.querySelectorAll('[data-pick-peer]').forEach((btn) => {
            btn.onclick = () => {
              const peer = discoveredPeers[Number(btn.dataset.pickPeer)];
              if (peer) {
                host.querySelector('#lanPeerUrl').value = peer.url;
                toast(`已填入 ${peer.deviceName} 的地址，请输入其 PIN 码后同步`, 'ok');
              }
            };
          });
        };
        renderPeers();

        host.querySelector('#lanPeerUrl').addEventListener('input', (e) => {
          const parsed = parseConnectInput(e.target.value);
          if (parsed.pin) {
            e.target.value = parsed.url;
            host.querySelector('#lanPeerPin').value = parsed.pin;
            toast('已自动解析配对地址与 PIN 码', 'ok');
          }
        });

        host.querySelector('#lanToggleBtn').onclick = async () => {
          try {
            if (running) {
              const nextSt = await api.lanStop();
              setState({ lanStatus: nextSt });
              toast('局域网同步服务已停止', 'ok');
            } else {
              const nextPort = Number(host.querySelector('#lanPort').value) || 19820;
              const nextName = host.querySelector('#lanDeviceName').value.trim();
              const nextSt = await api.lanStart({ port: nextPort, deviceName: nextName || null });
              setState({
                lanStatus: nextSt,
                settings: {
                  ...state.settings,
                  deviceName: nextSt.deviceName || state.settings.deviceName,
                  lan: { ...state.settings.lan, serverEnabled: true, port: nextSt.port, pin: nextSt.pin },
                },
              });
              toast(`局域网同步已开启（端口 ${nextSt.port}）`, 'ok');
            }
            updateSyncIndicator();
            renderLanPane(host);
          } catch (e) {
            toast(e.message, 'err');
          }
        };

        host.querySelector('#lanRegenPinBtn').onclick = async () => {
          try {
            const nextSt = await api.lanRegeneratePin();
            setState({
              lanStatus: nextSt,
              settings: { ...state.settings, lan: { ...state.settings.lan, pin: nextSt.pin } },
            });
            toast(`新配对码：${nextSt.pin}`, 'ok');
            renderLanPane(host);
          } catch (e) {
            toast(e.message, 'err');
          }
        };

        const copyBtn = host.querySelector('#lanCopyUriBtn');
        if (copyBtn) {
          copyBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText(uri);
              toast('已复制配对连接串，可直接粘贴到另一台设备', 'ok');
            } catch {
              toast('复制失败，请手动复制连接串', 'warn');
            }
          };
        }

        host.querySelector('#lanScanBtn').onclick = async () => {
          const btn = host.querySelector('#lanScanBtn');
          btn.disabled = true;
          btn.textContent = '扫描中…';
          try {
            discoveredPeers = await api.lanScanPeers();
            renderPeers();
            toast(discoveredPeers.length ? `发现 ${discoveredPeers.length} 台写心设备` : '未发现其他设备，请确认对方已开启服务且在同一 Wi-Fi', discoveredPeers.length ? 'ok' : 'warn');
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '🔍 扫描附近设备';
          }
        };

        host.querySelector('#lanPingBtn').onclick = async () => {
          const parsed = parseConnectInput(host.querySelector('#lanPeerUrl').value);
          if (!parsed.url) { toast('请先输入对方地址', 'warn'); return; }
          try {
            const res = await api.lanPingPeer(parsed.url);
            toast(`已连上「${res.deviceName}」（${PLATFORM_LABEL[res.platform] || res.platform} · ${res.books} 本书）`, 'ok');
          } catch (e) {
            toast(e.message, 'err');
          }
        };

        host.querySelector('#lanSyncNowBtn').onclick = async () => {
          const parsed = parseConnectInput(host.querySelector('#lanPeerUrl').value);
          const peerUrl = parsed.url;
          const peerPin = (parsed.pin || host.querySelector('#lanPeerPin').value || '').trim();
          const direction = host.querySelector('#lanDirection').value;
          if (!peerUrl || !peerPin) {
            toast('请填写对方地址和 6 位配对 PIN 码', 'warn');
            return;
          }
          const btn = host.querySelector('#lanSyncNowBtn');
          const out = host.querySelector('#lanReportBox');
          btn.disabled = true;
          btn.textContent = '同步中…';
          setState({ syncing: true });
          updateSyncIndicator();
          try {
            if (state.dirty) await flushPendingSave();
            const report = await api.lanSyncPeer(peerUrl, peerPin, direction);
            out.innerHTML = reportHtml(report);
            setState({ syncing: false });
            await reloadAfterSync();
            toast('局域网同步完成！', 'ok');
          } catch (e) {
            setState({ syncing: false });
            updateSyncIndicator();
            out.innerHTML = `<div class="sync-report err">同步失败：${escapeHtml(e.message)}</div>`;
            toast(`同步失败：${e.message}`, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '⚡ 立即局域网同步';
          }
        };
      };

      const renderWebDavPane = (host) => {
        const dav = state.settings.webdav || {};
        const presetKey = WEBDAV_PRESETS[dav.preset] ? dav.preset : 'jianguoyun';
        host.innerHTML = `
          <div class="sync-card">
            <div class="sync-card-head">
              <h4>WebDAV 服务器配置</h4>
              <span class="status-badge ${dav.enabled && dav.url ? 'ok' : ''}">${dav.enabled && dav.url ? '● 已启用' : '○ 未配置'}</span>
            </div>
            <div class="preset-row" id="davPresets">
              ${Object.entries(WEBDAV_PRESETS)
                .map(([k, p]) => `<button type="button" class="mini ${k === presetKey ? 'on' : ''}" data-preset="${k}">${p.label}</button>`)
                .join('')}
            </div>
            <div class="hint" id="davPresetHint" style="margin-bottom:12px">${escapeHtml(WEBDAV_PRESETS[presetKey].hint)}</div>
            <div class="form-grid">
              <div class="field full">
                <label>服务器地址（Base URL）</label>
                <input id="davUrl" type="url" value="${escapeHtml(dav.url || '')}" placeholder="https://dav.jianguoyun.com/dav/" />
              </div>
              <div class="field">
                <label>账号 / 用户名</label>
                <input id="davUser" type="text" value="${escapeHtml(dav.username || '')}" placeholder="邮箱或用户名" />
              </div>
              <div class="field">
                <label>密码 / 应用授权码</label>
                <input id="davPass" type="password" value="${escapeHtml(dav.password || '')}" placeholder="坚果云请填应用密码" />
              </div>
              <div class="field">
                <label>远端同步目录</label>
                <input id="davPath" type="text" value="${escapeHtml(dav.remotePath || '/HeartWrite')}" placeholder="/HeartWrite" />
              </div>
              <div class="field">
                <label>同步策略</label>
                <select id="davDirection">
                  <option value="bidirectional">智能双向合并（推荐 · 零丢稿）</option>
                  <option value="push">仅上传（以本机覆盖云端）</option>
                  <option value="pull">仅下载（以云端覆盖本机）</option>
                </select>
              </div>
              <div class="field">
                <div class="switch-row" style="padding-top:18px">
                  <span>启用定时自动云同步</span>
                  <label class="switch"><input type="checkbox" id="davAutoSync" ${dav.autoSync ? 'checked' : ''} /><i></i></label>
                </div>
              </div>
              <div class="field">
                <label>自动同步间隔（分钟）</label>
                <input id="davAutoMins" type="number" min="2" max="120" value="${dav.autoSyncMins || 10}" />
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
              <button type="button" class="mini" id="davSaveBtn">保存配置</button>
              <button type="button" class="mini" id="davTestBtn">测试连接</button>
              <button type="button" class="primary" id="davSyncBtn">☁ 立即云同步</button>
              ${dav.lastSyncAt ? `<span class="hint" style="align-self:center">上次云同步：${formatTime(dav.lastSyncAt)}</span>` : ''}
            </div>
            <div id="davReportBox"></div>
          </div>`;

        let chosenPreset = presetKey;
        const collectDav = () => ({
          ...state.settings.webdav,
          enabled: Boolean(host.querySelector('#davUrl').value.trim()),
          preset: chosenPreset,
          url: host.querySelector('#davUrl').value.trim(),
          username: host.querySelector('#davUser').value.trim(),
          password: host.querySelector('#davPass').value,
          remotePath: host.querySelector('#davPath').value.trim() || '/HeartWrite',
          autoSync: host.querySelector('#davAutoSync').checked,
          autoSyncMins: Math.max(2, Number(host.querySelector('#davAutoMins').value) || 10),
        });

        host.querySelector('#davPresets').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-preset]');
          if (!btn) return;
          chosenPreset = btn.dataset.preset;
          const p = WEBDAV_PRESETS[chosenPreset];
          host.querySelectorAll('#davPresets .mini').forEach((b) => b.classList.toggle('on', b === btn));
          host.querySelector('#davPresetHint').textContent = p.hint;
          if (p.url) host.querySelector('#davUrl').value = p.url;
        });

        host.querySelector('#davSaveBtn').onclick = async () => {
          const nextDav = collectDav();
          const next = { ...state.settings, webdav: nextDav };
          try {
            const saved = await api.saveSettings(next);
            setState({ settings: { ...next, ...saved } });
            restartWebDavAutoSync();
            updateSyncIndicator();
            toast('WebDAV 配置已保存', 'ok');
          } catch (e) {
            toast(e.message, 'err');
          }
        };

        host.querySelector('#davTestBtn').onclick = async () => {
          const cfg = collectDav();
          const btn = host.querySelector('#davTestBtn');
          btn.disabled = true;
          btn.textContent = '测试中…';
          try {
            const res = await api.webdavTest(cfg);
            toast(res.message, res.ok ? 'ok' : 'err');
          } catch (e) {
            toast(e.message, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '测试连接';
          }
        };

        host.querySelector('#davSyncBtn').onclick = async () => {
          const cfg = collectDav();
          const direction = host.querySelector('#davDirection').value;
          const btn = host.querySelector('#davSyncBtn');
          const out = host.querySelector('#davReportBox');
          btn.disabled = true;
          btn.textContent = '云同步中…';
          setState({ syncing: true });
          updateSyncIndicator();
          try {
            if (state.dirty) await flushPendingSave();
            const report = await api.webdavSync(cfg, direction);
            out.innerHTML = reportHtml(report);
            setState({ syncing: false });
            await reloadAfterSync();
            restartWebDavAutoSync();
            toast('WebDAV 云同步完成！', 'ok');
          } catch (e) {
            setState({ syncing: false });
            updateSyncIndicator();
            out.innerHTML = `<div class="sync-report err">云同步失败：${escapeHtml(e.message)}</div>`;
            toast(`云同步失败：${e.message}`, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '☁ 立即云同步';
          }
        };
      };

      renderPane();
    },
  });
}
