//! 局域网同步（LAN Sync）：
//! - 内置轻量级异步 HTTP/1.1 同步服务端（基于 `tokio::net::TcpListener`，支持 PC 与 Android 互为服务端）；
//! - UDP 局域网广播发现（端口 19821），自动发现同一 Wi-Fi 下开启同步服务的写心设备；
//! - 6 位配对 PIN 鉴权 + 路径白名单保护；
//! - 客户端通过统一的三向同步引擎执行双向合并 / 仅上传 / 仅下载。

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::storage::Store;
use crate::sync::{
    build_local_manifest, compute_sync_plan, current_platform, load_sync_state, merge_blob_bytes,
    read_blob, rebuild_registry_from_disk, save_sync_state, sha256_hex, trash_synced_blob,
    write_blob_atomic, SyncActionKind, SyncDirection, SyncManifest, SyncReport,
    SYNC_PROTOCOL_VERSION,
};
use crate::text::now_ms;

pub const DEFAULT_LAN_PORT: u16 = 19820;
pub const LAN_DISCOVERY_PORT: u16 = 19821;
const MAX_HTTP_BODY: usize = 32 * 1024 * 1024; // 32MB

/// 局域网服务实时状态（供前端展示 IP、端口、PIN 与连接码）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerStatus {
    pub running: bool,
    pub port: u16,
    pub pin: String,
    pub device_id: String,
    pub device_name: String,
    pub addresses: Vec<String>,
    /// 供扫码 / 一键粘贴的连接串：`heartwrite://192.168.1.5:19820?pin=123456`
    pub connect_uri: String,
}

/// 局域网中发现的写心同伴设备。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPeerInfo {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub url: String,
    pub books: usize,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeaconPacket {
    app: String,
    protocol: u32,
    device_id: String,
    device_name: String,
    platform: String,
    port: u16,
    books: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub ok: bool,
    pub app: String,
    pub protocol: u32,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub books: usize,
    pub requires_pin: bool,
}

/// 运行期局域网同步管理器（挂载在 `AppState` 中）。
pub struct LanRuntime {
    shutdown: Mutex<Option<watch::Sender<bool>>>,
    status: Mutex<LanServerStatus>,
    peers: Arc<Mutex<BTreeMap<String, LanPeerInfo>>>,
}

impl Default for LanRuntime {
    fn default() -> Self {
        Self {
            shutdown: Mutex::new(None),
            status: Mutex::new(LanServerStatus::default()),
            peers: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

/// 服务启动时传给后台任务的共享上下文。
pub struct LanHostContext {
    pub root: PathBuf,
    pub device_id: String,
    pub device_name: String,
    pub pin: String,
    /// 当远端向本机推送完数据并调用 `/api/commit` 时触发，负责重载内存 Store 并通知前端。
    pub on_commit: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    /// 查询当前书架书籍数量（用于 ping / beacon）。
    pub book_count: Arc<dyn Fn() -> usize + Send + Sync>,
}

impl LanRuntime {
    pub fn status(&self) -> LanServerStatus {
        self.status.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn discovered_peers(&self, self_device_id: &str) -> Vec<LanPeerInfo> {
        let now = now_ms();
        let Ok(mut map) = self.peers.lock() else {
            return Vec::new();
        };
        // 清理 25 秒未发心跳的离线设备
        map.retain(|id, p| id != self_device_id && now - p.last_seen_ms < 25_000);
        map.values().cloned().collect()
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.shutdown.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(true);
            }
        }
        if let Ok(mut st) = self.status.lock() {
            st.running = false;
        }
    }

    /// 启动内置局域网 HTTP 同步服务与 UDP 广播发现。
    pub async fn start(&self, port: u16, ctx: Arc<LanHostContext>) -> Result<LanServerStatus, String> {
        self.stop();

        let bind_addr = format!("0.0.0.0:{port}");
        let listener = TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("无法监听端口 {port}（可能已被占用）：{e}"))?;
        let actual_port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(port);

        let (tx, rx) = watch::channel(false);
        let addrs = detect_local_ipv4s();
        let primary_ip = addrs.first().cloned().unwrap_or_else(|| "127.0.0.1".into());
        let connect_uri = format!("heartwrite://{primary_ip}:{actual_port}?pin={}", ctx.pin);

        let status = LanServerStatus {
            running: true,
            port: actual_port,
            pin: ctx.pin.clone(),
            device_id: ctx.device_id.clone(),
            device_name: ctx.device_name.clone(),
            addresses: addrs,
            connect_uri,
        };
        if let Ok(mut guard) = self.shutdown.lock() {
            *guard = Some(tx);
        }
        if let Ok(mut st) = self.status.lock() {
            *st = status.clone();
        }

        // 1) HTTP/1.1 同步服务端主循环
        let mut http_rx = rx.clone();
        let http_ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = http_rx.changed() => {
                        if *http_rx.borrow() { break; }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, _addr)) => {
                                let c = http_ctx.clone();
                                tokio::spawn(async move {
                                    let _ = handle_http_connection(stream, c).await;
                                });
                            }
                            Err(_) => {
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                }
            }
        });

        // 2) UDP 局域网广播（每 3 秒发一次设备在线信标）
        let mut bcast_rx = rx.clone();
        let bcast_ctx = ctx.clone();
        tokio::spawn(async move {
            let Ok(sock) = tokio::net::UdpSocket::bind("0.0.0.0:0").await else {
                return;
            };
            let _ = sock.set_broadcast(true);
            let mut interval = tokio::time::interval(Duration::from_secs(3));
            loop {
                tokio::select! {
                    _ = bcast_rx.changed() => {
                        if *bcast_rx.borrow() { break; }
                    }
                    _ = interval.tick() => {
                        let pkt = BeaconPacket {
                            app: "heartwrite".into(),
                            protocol: SYNC_PROTOCOL_VERSION,
                            device_id: bcast_ctx.device_id.clone(),
                            device_name: bcast_ctx.device_name.clone(),
                            platform: current_platform().into(),
                            port: actual_port,
                            books: (bcast_ctx.book_count)(),
                        };
                        if let Ok(payload) = serde_json::to_vec(&pkt) {
                            let target = format!("255.255.255.255:{LAN_DISCOVERY_PORT}");
                            let _ = sock.send_to(&payload, &target).await;
                        }
                    }
                }
            }
        });

        // 3) UDP 监听局域网其他设备广播
        let peers_ref = self.peers.clone();
        let mut listen_rx = rx;
        tokio::spawn(async move {
            spawn_udp_peer_listener(peers_ref, &mut listen_rx).await;
        });

        Ok(status)
    }

    /// 主动在局域网扫描 1.2 秒，收集在线设备信标并合并到已发现列表。
    pub async fn scan_peers(&self, self_device_id: &str) -> Vec<LanPeerInfo> {
        let peers_ref = self.peers.clone();
        let _ = tokio::time::timeout(Duration::from_millis(1200), async {
            if let Ok(sock) = bind_reusable_udp(LAN_DISCOVERY_PORT) {
                let mut buf = [0u8; 2048];
                while let Ok((n, src)) = sock.recv_from(&mut buf).await {
                    record_beacon_packet(&peers_ref, &buf[..n], src.ip());
                }
            }
        })
        .await;
        self.discovered_peers(self_device_id)
    }
}

fn bind_reusable_udp(port: u16) -> std::io::Result<tokio::net::UdpSocket> {
    let std_sock = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port))?;
    std_sock.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(std_sock)
}

async fn spawn_udp_peer_listener(
    peers: Arc<Mutex<BTreeMap<String, LanPeerInfo>>>,
    shutdown: &mut watch::Receiver<bool>,
) {
    let Ok(sock) = bind_reusable_udp(LAN_DISCOVERY_PORT) else {
        return;
    };
    let mut buf = [0u8; 2048];
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
            }
            recv = sock.recv_from(&mut buf) => {
                if let Ok((n, src)) = recv {
                    record_beacon_packet(&peers, &buf[..n], src.ip());
                }
            }
        }
    }
}

fn record_beacon_packet(
    peers: &Arc<Mutex<BTreeMap<String, LanPeerInfo>>>,
    data: &[u8],
    src_ip: IpAddr,
) {
    let Ok(pkt) = serde_json::from_slice::<BeaconPacket>(data) else {
        return;
    };
    if pkt.app != "heartwrite" || pkt.port == 0 {
        return;
    }
    let ip_str = match src_ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    };
    let info = LanPeerInfo {
        device_id: pkt.device_id.clone(),
        device_name: pkt.device_name,
        platform: pkt.platform,
        url: format!("http://{ip_str}:{}", pkt.port),
        books: pkt.books,
        last_seen_ms: now_ms(),
    };
    if let Ok(mut map) = peers.lock() {
        map.insert(pkt.device_id, info);
    }
}

/// 跨平台探测本机局域网 IPv4（无需外部系统库，Windows / Linux / Android 通用）。
pub fn detect_local_ipv4s() -> Vec<String> {
    let mut out = Vec::new();
    for probe in ["10.255.255.255:80", "192.168.1.1:80", "8.8.8.8:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(probe).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    if let IpAddr::V4(v4) = addr.ip() {
                        if !v4.is_loopback() && !v4.is_unspecified() {
                            let s = v4.to_string();
                            if !out.contains(&s) {
                                out.push(s);
                            }
                        }
                    }
                }
            }
        }
    }
    if out.is_empty() {
        out.push("127.0.0.1".into());
    }
    out
}

/// 生成随机 6 位数字配对 PIN。
pub fn generate_pin() -> String {
    let u = uuid::Uuid::new_v4();
    let bytes = u.as_bytes();
    let num = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
    format!("{num:06}")
}

/// 解析 `heartwrite://ip:port?pin=123456` 或普通 `http://ip:port` 地址。
pub fn normalize_peer_address(raw: &str, fallback_pin: &str) -> Result<(String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请输入对端设备的局域网地址（例如 192.168.1.8:19820）".into());
    }
    let normalized = if trimmed.starts_with("heartwrite://") {
        trimmed.replacen("heartwrite://", "http://", 1)
    } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = url::Url::parse(&normalized).map_err(|e| format!("地址格式不正确：{e}"))?;
    let host = parsed.host_str().ok_or("地址缺少主机 IP")?;
    let port = parsed.port().unwrap_or(DEFAULT_LAN_PORT);
    let scheme = parsed.scheme();
    let base = format!("{scheme}://{host}:{port}");
    let pin = parsed
        .query_pairs()
        .find(|(k, _)| k == "pin")
        .map(|(_, v)| v.into_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| fallback_pin.trim().to_string());
    Ok((base, pin))
}

// ---------------------------------------------------------------------------
// 轻量级 HTTP/1.1 同步服务端实现
// ---------------------------------------------------------------------------

struct RawHttpRequest {
    method: String,
    target: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<RawHttpRequest, String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if buf.len() > 64 * 1024 {
            return Err("请求头过大".into());
        }
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("连接已关闭".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
    };

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.split("\r\n");
    let req_line = lines.next().ok_or("空请求")?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next().ok_or("缺少请求方法")?.to_ascii_uppercase();
    let target = parts.next().ok_or("缺少请求路径")?.to_string();

    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if content_len > MAX_HTTP_BODY {
        return Err("请求体超过 32MB 上限".into());
    }

    let mut body = buf[(header_end + 4)..].to_vec();
    while body.len() < content_len {
        let remaining = content_len - body.len();
        let to_read = remaining.min(chunk.len());
        let n = stream.read(&mut chunk[..to_read]).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_len);

    Ok(RawHttpRequest {
        method,
        target,
        headers,
        body,
    })
}

async fn send_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Access-Control-Allow-Origin: *\r\n\
         \r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

async fn send_json(stream: &mut TcpStream, status: u16, reason: &str, value: &impl Serialize) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let _ = send_http_response(stream, status, reason, "application/json; charset=utf-8", &body).await;
}

fn query_param(target: &str, key: &str) -> Option<String> {
    let fake = format!("http://localhost{target}");
    let u = url::Url::parse(&fake).ok()?;
    u.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

async fn handle_http_connection(mut stream: TcpStream, ctx: Arc<LanHostContext>) -> Result<(), String> {
    let req = tokio::time::timeout(Duration::from_secs(30), read_http_request(&mut stream))
        .await
        .map_err(|_| "读取请求超时".to_string())??;

    let path = req.target.split('?').next().unwrap_or(&req.target);

    if req.method == "GET" && path == "/api/ping" {
        let ping = PingResponse {
            ok: true,
            app: "heartwrite".into(),
            protocol: SYNC_PROTOCOL_VERSION,
            device_id: ctx.device_id.clone(),
            device_name: ctx.device_name.clone(),
            platform: current_platform().into(),
            books: (ctx.book_count)(),
            requires_pin: !ctx.pin.is_empty(),
        };
        send_json(&mut stream, 200, "OK", &ping).await;
        return Ok(());
    }

    // 除 ping 外，所有数据接口均校验配对 PIN
    if !ctx.pin.is_empty() {
        let sent_pin = req.headers.get("x-sync-pin").map(String::as_str).unwrap_or("");
        if sent_pin != ctx.pin {
            send_json(
                &mut stream,
                401,
                "Unauthorized",
                &serde_json::json!({ "ok": false, "error": "配对码（PIN）不正确" }),
            )
            .await;
            return Ok(());
        }
    }

    match (req.method.as_str(), path) {
        ("GET", "/api/manifest") => match build_local_manifest(&ctx.root, &ctx.device_id, &ctx.device_name) {
            Ok(manifest) => send_json(&mut stream, 200, "OK", &manifest).await,
            Err(e) => {
                send_json(&mut stream, 500, "Internal Server Error", &serde_json::json!({ "error": e })).await;
            }
        },
        ("GET", "/api/blob") => {
            let Some(rel) = query_param(&req.target, "path") else {
                send_json(&mut stream, 400, "Bad Request", &serde_json::json!({ "error": "缺少 path 参数" })).await;
                return Ok(());
            };
            match read_blob(&ctx.root, &rel) {
                Ok(bytes) => {
                    let _ = send_http_response(&mut stream, 200, "OK", "application/octet-stream", &bytes).await;
                }
                Err(e) => {
                    send_json(&mut stream, 404, "Not Found", &serde_json::json!({ "error": e })).await;
                }
            }
        }
        ("PUT", "/api/blob") => {
            let Some(rel) = query_param(&req.target, "path") else {
                send_json(&mut stream, 400, "Bad Request", &serde_json::json!({ "error": "缺少 path 参数" })).await;
                return Ok(());
            };
            match write_blob_atomic(&ctx.root, &rel, &req.body) {
                Ok(_) => send_json(&mut stream, 200, "OK", &serde_json::json!({ "ok": true })).await,
                Err(e) => {
                    send_json(&mut stream, 400, "Bad Request", &serde_json::json!({ "error": e })).await;
                }
            }
        }
        ("DELETE", "/api/blob") => {
            let Some(rel) = query_param(&req.target, "path") else {
                send_json(&mut stream, 400, "Bad Request", &serde_json::json!({ "error": "缺少 path 参数" })).await;
                return Ok(());
            };
            match trash_synced_blob(&ctx.root, &rel) {
                Ok(_) => send_json(&mut stream, 200, "OK", &serde_json::json!({ "ok": true })).await,
                Err(e) => {
                    send_json(&mut stream, 400, "Bad Request", &serde_json::json!({ "error": e })).await;
                }
            }
        }
        ("POST", "/api/commit") => match (ctx.on_commit)() {
            Ok(_) => send_json(&mut stream, 200, "OK", &serde_json::json!({ "ok": true })).await,
            Err(e) => {
                send_json(&mut stream, 500, "Internal Server Error", &serde_json::json!({ "error": e })).await;
            }
        },
        _ => {
            send_json(&mut stream, 404, "Not Found", &serde_json::json!({ "error": "未知接口" })).await;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 局域网同步客户端（连接另一台设备并执行三向合并）
// ---------------------------------------------------------------------------

fn build_lan_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(45))
        .no_proxy()
        .build()
        .map_err(|e| format!("初始化局域网客户端失败：{e}"))
}

/// 探测指定局域网设备是否在线。
pub async fn ping_lan_peer(raw_url: &str) -> Result<PingResponse, String> {
    let (base, _) = normalize_peer_address(raw_url, "")?;
    let client = build_lan_http_client()?;
    let resp = client
        .get(format!("{base}/api/ping"))
        .send()
        .await
        .map_err(|e| format!("无法连接到 {base}（请确认双方在同一局域网且对端已开启同步服务）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("对端响应异常：HTTP {}", resp.status().as_u16()));
    }
    resp.json::<PingResponse>()
        .await
        .map_err(|e| format!("解析对端信息失败：{e}"))
}

/// 与指定局域网设备执行完整同步，返回同步报告与重载后的 Store。
pub async fn sync_with_lan_peer(
    root: &PathBuf,
    device_id: &str,
    device_name: &str,
    raw_url: &str,
    pin: &str,
    direction: SyncDirection,
) -> Result<(SyncReport, Store), String> {
    let started = Instant::now();
    let (base, final_pin) = normalize_peer_address(raw_url, pin)?;
    let client = build_lan_http_client()?;

    // 1) 获取远端清单（顺带校验 PIN）
    let manifest_resp = client
        .get(format!("{base}/api/manifest"))
        .header("X-Sync-Pin", &final_pin)
        .send()
        .await
        .map_err(|e| format!("连接对端失败（{base}）：{e}"))?;
    if manifest_resp.status().as_u16() == 401 {
        return Err("配对码（PIN）不正确，请核对对端屏幕上显示的 6 位配对码".into());
    }
    if !manifest_resp.status().is_success() {
        return Err(format!("读取对端清单失败：HTTP {}", manifest_resp.status().as_u16()));
    }
    let remote_manifest: SyncManifest = manifest_resp
        .json()
        .await
        .map_err(|e| format!("解析对端同步清单失败：{e}"))?;

    if !remote_manifest.device_id.is_empty() && remote_manifest.device_id == device_id {
        return Err("不能与本机自己同步，请填写另一台设备的地址".into());
    }

    let peer_name = if remote_manifest.device_name.is_empty() {
        base.clone()
    } else {
        remote_manifest.device_name.clone()
    };
    let peer_key = format!(
        "lan:{}",
        if remote_manifest.device_id.is_empty() {
            base.as_str()
        } else {
            remote_manifest.device_id.as_str()
        }
    );

    // 2) 构建本地清单并计算三向计划
    let local_manifest = build_local_manifest(root, device_id, device_name)?;
    let mut sync_state = load_sync_state(root);
    let baseline = sync_state.baselines.get(&peer_key).cloned().unwrap_or_default();
    let (actions, skipped) = compute_sync_plan(&local_manifest, &remote_manifest, &baseline, direction);

    let mut report = SyncReport {
        ok: true,
        mode: "lan".into(),
        peer_name: peer_name.clone(),
        skipped,
        ..Default::default()
    };

    let mut next_baseline = baseline;
    // 把本来就一致的条目也更新进基线
    for (rel, l) in &local_manifest.entries {
        if let Some(r) = remote_manifest.entries.get(rel) {
            if l.hash == r.hash {
                next_baseline.insert(rel.clone(), l.hash.clone());
            }
        }
    }

    let mut remote_changed = false;

    // 3) 依次执行同步计划
    for act in actions {
        let encoded_path: String = url::form_urlencoded::byte_serialize(act.path.as_bytes()).collect();
        let blob_url = format!("{base}/api/blob?path={encoded_path}");
        match act.action {
            SyncActionKind::Upload => {
                let bytes = read_blob(root, &act.path)?;
                let hash = sha256_hex(&bytes);
                let r = client
                    .put(&blob_url)
                    .header("X-Sync-Pin", &final_pin)
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|e| format!("上传 {} 失败：{e}", act.path))?;
                if !r.status().is_success() {
                    return Err(format!("上传 {} 被拒绝：HTTP {}", act.path, r.status().as_u16()));
                }
                next_baseline.insert(act.path.clone(), hash);
                report.uploaded += 1;
                remote_changed = true;
                report.details.push(format!("↑ 上传 {}", act.path));
            }
            SyncActionKind::Download => {
                let r = client
                    .get(&blob_url)
                    .header("X-Sync-Pin", &final_pin)
                    .send()
                    .await
                    .map_err(|e| format!("下载 {} 失败：{e}", act.path))?;
                if !r.status().is_success() {
                    return Err(format!("下载 {} 失败：HTTP {}", act.path, r.status().as_u16()));
                }
                let bytes = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
                let hash = sha256_hex(&bytes);
                write_blob_atomic(root, &act.path, &bytes)?;
                next_baseline.insert(act.path.clone(), hash);
                report.downloaded += 1;
                report.details.push(format!("↓ 下载 {}", act.path));
            }
            SyncActionKind::Merge => {
                let local_bytes = read_blob(root, &act.path)?;
                let r = client
                    .get(&blob_url)
                    .header("X-Sync-Pin", &final_pin)
                    .send()
                    .await
                    .map_err(|e| format!("拉取冲突文件 {} 失败：{e}", act.path))?;
                if !r.status().is_success() {
                    return Err(format!("拉取冲突文件 {} 失败：HTTP {}", act.path, r.status().as_u16()));
                }
                let remote_bytes = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
                let (merged_bytes, had_conflict) =
                    merge_blob_bytes(&act.entry_kind, &local_bytes, &remote_bytes, &peer_name)?;
                let hash = sha256_hex(&merged_bytes);
                write_blob_atomic(root, &act.path, &merged_bytes)?;
                let put_r = client
                    .put(&blob_url)
                    .header("X-Sync-Pin", &final_pin)
                    .body(merged_bytes)
                    .send()
                    .await
                    .map_err(|e| format!("回传合并结果 {} 失败：{e}", act.path))?;
                if !put_r.status().is_success() {
                    return Err(format!("回传合并结果 {} 失败：HTTP {}", act.path, put_r.status().as_u16()));
                }
                next_baseline.insert(act.path.clone(), hash);
                report.merged += 1;
                remote_changed = true;
                if had_conflict {
                    report.conflicts += 1;
                    report.details.push(format!("⇄ 合并冲突（旧稿已存为历史版本）{}", act.path));
                } else {
                    report.details.push(format!("⇄ 合并 {}", act.path));
                }
            }
            SyncActionKind::DeleteLocal => {
                trash_synced_blob(root, &act.path)?;
                next_baseline.remove(&act.path);
                report.deleted_local += 1;
                report.details.push(format!("✕ 本地移入回收站 {}", act.path));
            }
            SyncActionKind::DeleteRemote => {
                let r = client
                    .delete(&blob_url)
                    .header("X-Sync-Pin", &final_pin)
                    .send()
                    .await
                    .map_err(|e| format!("删除远端 {} 失败：{e}", act.path))?;
                if !r.status().is_success() {
                    return Err(format!("删除远端 {} 失败：HTTP {}", act.path, r.status().as_u16()));
                }
                next_baseline.remove(&act.path);
                report.deleted_remote += 1;
                remote_changed = true;
                report.details.push(format!("✕ 远端移入回收站 {}", act.path));
            }
        }
    }

    // 4) 通知对端重载内存书架并推送事件到其界面
    if remote_changed {
        let _ = client
            .post(format!("{base}/api/commit"))
            .header("X-Sync-Pin", &final_pin)
            .send()
            .await;
    }

    // 5) 持久化基线并重建本机书架索引
    sync_state.baselines.insert(peer_key, next_baseline);
    save_sync_state(root, &sync_state)?;
    let fresh_store = rebuild_registry_from_disk(root)?;

    report.duration_ms = started.elapsed().as_millis() as u64;
    report.finished_at = now_ms();
    Ok((report, fresh_store))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_end_to_end_bidirectional_and_conflict_sync() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir_a = std::env::temp_dir().join(format!("hw-lan-a-{}", uuid::Uuid::new_v4()));
            let dir_b = std::env::temp_dir().join(format!("hw-lan-b-{}", uuid::Uuid::new_v4()));
            let mut store_a = Store::load(dir_a.clone()).unwrap();
            let _store_b = Store::load(dir_b.clone()).unwrap();

            let book = store_a.create_book("星海物语", "写心酱", "轻小说").unwrap();
            let ch_id = book.volumes[0].chapters[0].id.clone();
            store_a
                .save_chapter(&book.id, &ch_id, "第一章：流星划过屋顶。", None, None, None, true, "初稿", "manual")
                .unwrap();

            let host_store = Arc::new(Mutex::new(store_a));
            let host_store_commit = host_store.clone();
            let host_store_count = host_store.clone();
            let root_a_commit = dir_a.clone();

            let lan = LanRuntime::default();
            let status = lan
                .start(
                    0,
                    Arc::new(LanHostContext {
                        root: dir_a.clone(),
                        device_id: "dev-pc".into(),
                        device_name: "电脑端".into(),
                        pin: "246810".into(),
                        on_commit: Arc::new(move || {
                            let fresh = rebuild_registry_from_disk(&root_a_commit)?;
                            *host_store_commit.lock().unwrap() = fresh;
                            Ok(())
                        }),
                        book_count: Arc::new(move || host_store_count.lock().unwrap().registry.books.len()),
                    }),
                )
                .await
                .unwrap();

            let url = format!("http://127.0.0.1:{}", status.port);

            // 错误 PIN 必须被拦截
            let bad = sync_with_lan_peer(&dir_b, "dev-phone", "手机端", &url, "000000", SyncDirection::Bidirectional).await;
            assert!(bad.is_err());

            // 首次同步：手机端完整拉取电脑端的书与章节
            let (rep1, mut store_b) =
                sync_with_lan_peer(&dir_b, "dev-phone", "手机端", &url, "246810", SyncDirection::Bidirectional)
                    .await
                    .unwrap();
            assert!(rep1.downloaded >= 3, "应下载 book/cards/chapter: {rep1:?}");
            assert_eq!(store_b.read_content(&book.id, &ch_id).unwrap().content, "第一章：流星划过屋顶。");

            // 双端同时修改同一章 -> 触发零丢稿冲突合并
            {
                let mut a = host_store.lock().unwrap();
                a.save_chapter(&book.id, &ch_id, "电脑端续写的新剧情。", None, None, None, false, "", "auto")
                    .unwrap();
            }
            std::thread::sleep(Duration::from_millis(15));
            store_b
                .save_chapter(&book.id, &ch_id, "手机端通勤写的剧情。", None, None, None, false, "", "auto")
                .unwrap();

            let (rep2, store_b2) =
                sync_with_lan_peer(&dir_b, "dev-phone", "手机端", &url, "246810", SyncDirection::Bidirectional)
                    .await
                    .unwrap();
            assert_eq!(rep2.conflicts, 1, "应检测到 1 处冲突并智能合并: {rep2:?}");

            // 两端内容一致且另一端稿件完整保存在历史版本中
            let final_b = store_b2.read_content(&book.id, &ch_id).unwrap();
            let final_a = host_store.lock().unwrap().read_content(&book.id, &ch_id).unwrap();
            assert_eq!(final_a.content, final_b.content);
            assert!(final_b.versions.iter().any(|v| v.kind == "conflict" && v.content == "电脑端续写的新剧情。"));

            lan.stop();
            let _ = std::fs::remove_dir_all(&dir_a);
            let _ = std::fs::remove_dir_all(&dir_b);
        });
    }
}
