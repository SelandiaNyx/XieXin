//! WebDAV 云同步（RFC 4918）：
//! 全面兼容坚果云（Jianguoyun）、Nextcloud、OwnCloud、AList、群晖等标准 WebDAV 服务。
//! 复用统一的三向差异与零丢稿冲突合并引擎，在远端目录（默认 `/HeartWrite/`）维护同步清单与稿件镜像。

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::storage::{Store, WebDavConfig};
use crate::sync::{
    build_local_manifest, compute_sync_plan, load_sync_state, merge_blob_bytes, read_blob,
    rebuild_registry_from_disk, save_sync_state, sha256_hex, trash_synced_blob, write_blob_atomic,
    SyncActionKind, SyncDirection, SyncManifest, SyncReport,
};
use crate::text::now_ms;

const REMOTE_MANIFEST_NAME: &str = "sync-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavTestResult {
    pub ok: bool,
    pub status: u16,
    pub message: String,
    pub resolved_url: String,
}

fn build_dav_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("初始化 WebDAV 客户端失败：{e}"))
}

fn auth_header_value(username: &str, password: &str) -> String {
    let raw = format!("{username}:{password}");
    format!("Basic {}", crate::cover::base64_encode(raw.as_bytes()))
}

/// 组合 WebDAV 根地址与子路径，妥善处理斜杠与 URL 编码。
pub fn join_dav_url(base_url: &str, remote_path: &str, rel: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请填写 WebDAV 服务器地址".into());
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("WebDAV 地址必须以 https:// 或 http:// 开头".into());
    }
    let mut url = base.to_string();
    for seg in remote_path
        .trim()
        .split('/')
        .chain(rel.trim().split('/'))
        .filter(|s| !s.is_empty())
    {
        url.push('/');
        // 路径段安全编码（保留安全字符，中文与空格编码为 %XX）
        let encoded: String = url::form_urlencoded::byte_serialize(seg.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        url.push_str(&encoded);
    }
    Ok(url)
}

/// 递归确保远端目录存在（MKCOL，201 创建成功 / 405 已存在均视为正常）。
async fn ensure_remote_dir(
    client: &reqwest::Client,
    auth: &str,
    base_url: &str,
    remote_path: &str,
    sub_dir: &str,
    created_cache: &mut BTreeSet<String>,
) -> Result<(), String> {
    let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;
    let all_segs: Vec<&str> = remote_path
        .trim()
        .split('/')
        .chain(sub_dir.trim().split('/'))
        .filter(|s| !s.is_empty())
        .collect();

    let mut acc = String::new();
    for seg in all_segs {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(seg);
        if created_cache.contains(&acc) {
            continue;
        }
        let target = format!("{}/", join_dav_url(base_url, "", &acc)?);
        let resp = client
            .request(mkcol.clone(), &target)
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("创建远端目录 {acc} 失败：{e}"))?;
        let code = resp.status().as_u16();
        // 201 Created, 200 OK, 204 No Content, 301/302 Redirect, 405 Method Not Allowed (已存在), 409/403 稍后 PUT 校验
        if matches!(code, 200 | 201 | 204 | 301 | 302 | 405) {
            created_cache.insert(acc.clone());
        } else if code == 401 {
            return Err("WebDAV 认证失败（401）：请检查用户名与密码（坚果云请使用「应用密码」）".into());
        } else if code == 403 {
            return Err(format!("WebDAV 无权限创建目录 {acc}（403），请确认远端路径可写"));
        } else {
            return Err(format!("创建远端目录 {acc} 返回 HTTP {code}"));
        }
    }
    Ok(())
}

/// 测试 WebDAV 连通性与账号权限（PROPFIND Depth: 0）。
pub async fn test_webdav_connection(cfg: &WebDavConfig) -> Result<WebDavTestResult, String> {
    let client = build_dav_client()?;
    let auth = auth_header_value(&cfg.username, &cfg.password);
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    // 先测根 URL 是否能认证通过
    let root_url = format!("{}/", join_dav_url(&cfg.url, "", "")?);
    let resp = client
        .request(propfind.clone(), &root_url)
        .header("Authorization", &auth)
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| format!("无法连接到 WebDAV 服务器：{e}"))?;
    let code = resp.status().as_u16();

    if code == 401 {
        return Ok(WebDavTestResult {
            ok: false,
            status: code,
            message: "认证失败（401）：账号或密码错误。若使用坚果云，请在网页端「安全选项 → 第三方应用管理」生成专用应用密码。".into(),
            resolved_url: root_url,
        });
    }
    if code == 403 {
        return Ok(WebDavTestResult {
            ok: false,
            status: code,
            message: "访问被拒绝（403）：账号没有该目录的读写权限。".into(),
            resolved_url: root_url,
        });
    }

    // 再测试 / 创建目标同步子目录
    let target_url = format!("{}/", join_dav_url(&cfg.url, &cfg.remote_path, "")?);
    let sub_resp = client
        .request(propfind, &target_url)
        .header("Authorization", &auth)
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| format!("检查同步目录失败：{e}"))?;
    let sub_code = sub_resp.status().as_u16();

    if matches!(sub_code, 200 | 207) {
        return Ok(WebDavTestResult {
            ok: true,
            status: sub_code,
            message: "连接成功！已就绪，可以开始同步稿件。".into(),
            resolved_url: target_url,
        });
    }
    if sub_code == 404 {
        let mut cache = BTreeSet::new();
        ensure_remote_dir(&client, &auth, &cfg.url, &cfg.remote_path, "", &mut cache).await?;
        return Ok(WebDavTestResult {
            ok: true,
            status: 201,
            message: format!("连接成功！已自动在云端创建同步目录「{}」。", cfg.remote_path),
            resolved_url: target_url,
        });
    }

    Ok(WebDavTestResult {
        ok: false,
        status: sub_code,
        message: format!("服务器返回异常状态码 HTTP {sub_code}，请确认 WebDAV 地址是否正确。"),
        resolved_url: target_url,
    })
}

async fn dav_get_bytes(client: &reqwest::Client, auth: &str, url: &str) -> Result<Option<Vec<u8>>, String> {
    let resp = client
        .get(url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("下载 {url} 失败：{e}"))?;
    let code = resp.status().as_u16();
    if code == 404 {
        return Ok(None);
    }
    if code == 401 {
        return Err("WebDAV 认证失败（401）：请检查账号与应用密码".into());
    }
    if !resp.status().is_success() {
        return Err(format!("下载失败（HTTP {code}）：{url}"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok(Some(bytes))
}

async fn dav_put_bytes(
    client: &reqwest::Client,
    auth: &str,
    url: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let resp = client
        .put(url)
        .header("Authorization", auth)
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("上传 {url} 失败：{e}"))?;
    let code = resp.status().as_u16();
    if code == 401 {
        return Err("WebDAV 认证失败（401）".into());
    }
    if !resp.status().is_success() {
        return Err(format!("上传失败（HTTP {code}）：{url}"));
    }
    Ok(())
}

async fn dav_delete(client: &reqwest::Client, auth: &str, url: &str) -> Result<(), String> {
    let resp = client
        .delete(url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("删除远端文件失败：{e}"))?;
    let code = resp.status().as_u16();
    if code == 404 || resp.status().is_success() {
        return Ok(());
    }
    Err(format!("删除远端文件失败（HTTP {code}）"))
}

/// 执行完整的 WebDAV 同步（支持双向智能合并 / 仅上传 / 仅下载）。
pub async fn sync_with_webdav(
    root: &PathBuf,
    device_id: &str,
    device_name: &str,
    cfg: &WebDavConfig,
    direction: SyncDirection,
) -> Result<(SyncReport, Store), String> {
    let started = Instant::now();
    let client = build_dav_client()?;
    let auth = auth_header_value(&cfg.username, &cfg.password);
    let remote_path = if cfg.remote_path.trim().is_empty() {
        "/HeartWrite"
    } else {
        cfg.remote_path.trim()
    };

    let mut dir_cache = BTreeSet::new();
    ensure_remote_dir(&client, &auth, &cfg.url, remote_path, "", &mut dir_cache).await?;

    // 1) 下载远端清单（首次同步时远端尚无清单，视为空）
    let manifest_url = join_dav_url(&cfg.url, remote_path, REMOTE_MANIFEST_NAME)?;
    let remote_manifest: SyncManifest = match dav_get_bytes(&client, &auth, &manifest_url).await? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("远端 sync-manifest.json 损坏：{e}"))?,
        None => SyncManifest::default(),
    };

    let peer_key = format!("webdav:{}", join_dav_url(&cfg.url, remote_path, "")?);
    let peer_label = if remote_manifest.device_name.is_empty() {
        "WebDAV 云端".to_string()
    } else {
        format!("WebDAV（{}）", remote_manifest.device_name)
    };

    // 2) 计算三向同步计划
    let local_manifest = build_local_manifest(root, device_id, device_name)?;
    let mut sync_state = load_sync_state(root);
    let baseline = sync_state.baselines.get(&peer_key).cloned().unwrap_or_default();
    let (actions, skipped) = compute_sync_plan(&local_manifest, &remote_manifest, &baseline, direction);

    let mut report = SyncReport {
        ok: true,
        mode: "webdav".into(),
        peer_name: peer_label.clone(),
        skipped,
        ..Default::default()
    };

    let mut next_baseline = baseline;
    for (rel, l) in &local_manifest.entries {
        if let Some(r) = remote_manifest.entries.get(rel) {
            if l.hash == r.hash {
                next_baseline.insert(rel.clone(), l.hash.clone());
            }
        }
    }

    // 3) 依次执行同步计划
    for act in actions {
        let file_url = join_dav_url(&cfg.url, remote_path, &act.path)?;
        let parent_rel = act
            .path
            .rsplit_once('/')
            .map(|(p, _)| p)
            .unwrap_or("");

        match act.action {
            SyncActionKind::Upload => {
                ensure_remote_dir(&client, &auth, &cfg.url, remote_path, parent_rel, &mut dir_cache).await?;
                let bytes = read_blob(root, &act.path)?;
                let hash = sha256_hex(&bytes);
                dav_put_bytes(&client, &auth, &file_url, bytes).await?;
                next_baseline.insert(act.path.clone(), hash);
                report.uploaded += 1;
                report.details.push(format!("↑ 上传 {}", act.path));
            }
            SyncActionKind::Download => {
                if let Some(bytes) = dav_get_bytes(&client, &auth, &file_url).await? {
                    let hash = sha256_hex(&bytes);
                    write_blob_atomic(root, &act.path, &bytes)?;
                    next_baseline.insert(act.path.clone(), hash);
                    report.downloaded += 1;
                    report.details.push(format!("↓ 下载 {}", act.path));
                }
            }
            SyncActionKind::Merge => {
                let local_bytes = read_blob(root, &act.path)?;
                let remote_bytes = dav_get_bytes(&client, &auth, &file_url)
                    .await?
                    .unwrap_or_else(|| local_bytes.clone());
                let (merged_bytes, had_conflict) =
                    merge_blob_bytes(&act.entry_kind, &local_bytes, &remote_bytes, &peer_label)?;
                let hash = sha256_hex(&merged_bytes);
                write_blob_atomic(root, &act.path, &merged_bytes)?;
                ensure_remote_dir(&client, &auth, &cfg.url, remote_path, parent_rel, &mut dir_cache).await?;
                dav_put_bytes(&client, &auth, &file_url, merged_bytes).await?;
                next_baseline.insert(act.path.clone(), hash);
                report.merged += 1;
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
                dav_delete(&client, &auth, &file_url).await?;
                next_baseline.remove(&act.path);
                report.deleted_remote += 1;
                report.details.push(format!("✕ 云端删除 {}", act.path));
            }
        }
    }

    // 4) 重建本机索引并把最新清单写回云端
    let fresh_store = rebuild_registry_from_disk(root)?;
    let mut final_manifest = build_local_manifest(root, device_id, device_name)?;
    // 合并两端的有效墓碑（保留尚未被重建的删除记录）
    for (k, ts) in remote_manifest.tombstones {
        if !final_manifest.entries.contains_key(&k) {
            final_manifest
                .tombstones
                .entry(k)
                .and_modify(|cur| *cur = (*cur).max(ts))
                .or_insert(ts);
        }
    }
    let manifest_bytes = serde_json::to_vec_pretty(&final_manifest).map_err(|e| e.to_string())?;
    dav_put_bytes(&client, &auth, &manifest_url, manifest_bytes).await?;

    // 更新本地基线
    for (k, v) in &final_manifest.entries {
        next_baseline.insert(k.clone(), v.hash.clone());
    }
    sync_state.baselines.insert(peer_key, next_baseline);
    save_sync_state(root, &sync_state)?;

    report.duration_ms = started.elapsed().as_millis() as u64;
    report.finished_at = now_ms();
    Ok((report, fresh_store))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 内存模拟标准 WebDAV 服务器（支持 PROPFIND / MKCOL / GET / PUT / DELETE 与 Basic Auth）。
    async fn spawn_mock_webdav() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
        let dirs: Arc<Mutex<BTreeSet<String>>> = Arc::new(Mutex::new(BTreeSet::from(["/".to_string()])));

        let handle = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let files = files.clone();
                let dirs = dirs.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let header_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                    let mut lines = head.split("\r\n");
                    let first = lines.next().unwrap_or("");
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("/").trim_end_matches('/').to_string();
                    let norm_path = if path.is_empty() { "/".to_string() } else { path };

                    let mut clen = 0usize;
                    let mut auth = String::new();
                    for l in lines {
                        if let Some((k, v)) = l.split_once(':') {
                            if k.eq_ignore_ascii_case("content-length") {
                                clen = v.trim().parse().unwrap_or(0);
                            } else if k.eq_ignore_ascii_case("authorization") {
                                auth = v.trim().to_string();
                            }
                        }
                    }
                    let mut body = buf[(header_end + 4)..].to_vec();
                    while body.len() < clen {
                        let Ok(n) = sock.read(&mut tmp).await else { break };
                        if n == 0 { break; }
                        body.extend_from_slice(&tmp[..n]);
                    }
                    body.truncate(clen);

                    let expected_auth = auth_header_value("writer", "secret");
                    let (status, resp_body): (u16, Vec<u8>) = if auth != expected_auth {
                        (401, b"Unauthorized".to_vec())
                    } else {
                        match method.as_str() {
                            "PROPFIND" => {
                                if dirs.lock().unwrap().contains(&norm_path) || files.lock().unwrap().contains_key(&norm_path) {
                                    (207, b"<multistatus/>".to_vec())
                                } else {
                                    (404, b"Not Found".to_vec())
                                }
                            }
                            "MKCOL" => {
                                let mut d = dirs.lock().unwrap();
                                if d.contains(&norm_path) {
                                    (405, b"Exists".to_vec())
                                } else {
                                    d.insert(norm_path);
                                    (201, b"Created".to_vec())
                                }
                            }
                            "PUT" => {
                                files.lock().unwrap().insert(norm_path, body);
                                (201, b"OK".to_vec())
                            }
                            "GET" => match files.lock().unwrap().get(&norm_path) {
                                Some(b) => (200, b.clone()),
                                None => (404, b"Not Found".to_vec()),
                            },
                            "DELETE" => {
                                files.lock().unwrap().remove(&norm_path);
                                (204, Vec::new())
                            }
                            _ => (405, Vec::new()),
                        }
                    };
                    let header = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        resp_body.len()
                    );
                    let _ = sock.write_all(header.as_bytes()).await;
                    let _ = sock.write_all(&resp_body).await;
                });
            }
        });

        (format!("http://127.0.0.1:{port}"), handle)
    }

    #[test]
    fn webdav_end_to_end_test_and_sync_across_two_devices() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (base_url, srv) = spawn_mock_webdav().await;
            let cfg = WebDavConfig {
                enabled: true,
                preset: "custom".into(),
                url: base_url,
                username: "writer".into(),
                password: "secret".into(),
                remote_path: "/HeartWrite".into(),
                auto_sync: false,
                auto_sync_mins: 10,
                last_sync_at: 0,
            };

            let check = test_webdav_connection(&cfg).await.unwrap();
            assert!(check.ok, "WebDAV 连通性测试应成功: {check:?}");

            let dir_a = std::env::temp_dir().join(format!("hw-dav-a-{}", uuid::Uuid::new_v4()));
            let dir_b = std::env::temp_dir().join(format!("hw-dav-b-{}", uuid::Uuid::new_v4()));
            let mut store_a = Store::load(dir_a.clone()).unwrap();
            let _store_b = Store::load(dir_b.clone()).unwrap();

            let book = store_a.create_book("樱落纪年", "云雀", "二次元轻小说").unwrap();
            let ch_id = book.volumes[0].chapters[0].id.clone();
            store_a
                .save_chapter(&book.id, &ch_id, "樱花落在天台栏杆上。", None, None, None, true, "第一稿", "manual")
                .unwrap();

            // 设备 A 上传到 WebDAV
            let (r1, _) = sync_with_webdav(&dir_a, "pc-1", "PC", &cfg, SyncDirection::Bidirectional)
                .await
                .unwrap();
            assert!(r1.uploaded >= 3, "设备 A 应上传整本书: {r1:?}");

            // 设备 B 从 WebDAV 下载
            let (r2, store_b) = sync_with_webdav(&dir_b, "phone-1", "Phone", &cfg, SyncDirection::Bidirectional)
                .await
                .unwrap();
            assert!(r2.downloaded >= 3, "设备 B 应下载整本书: {r2:?}");
            assert_eq!(store_b.read_content(&book.id, &ch_id).unwrap().content, "樱花落在天台栏杆上。");

            srv.abort();
            let _ = std::fs::remove_dir_all(&dir_a);
            let _ = std::fs::remove_dir_all(&dir_b);
        });
    }
}
