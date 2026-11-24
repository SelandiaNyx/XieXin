//! AI 创作助手引擎：
//! - 支持 OpenAI 兼容协议（DeepSeek / 硅基流动 / Kimi / 通义千问 / 智谱 / OpenRouter / 本地 Ollama 等）、
//!   Anthropic Claude 与 Google Gemini；
//! - 全程由 Rust 侧异步请求并解析 SSE 流式输出（避开浏览器 CORS 限制，且密钥仅留存在本机）；
//! - 支持按作品持久化对话历史、随时中止生成、自动拉取可用模型列表与拼装小说上下文。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::storage::{read_json, write_json_atomic, AiProfile, BookMeta, Card};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub skill: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiChatHistory {
    pub book_id: String,
    pub messages: Vec<AiChatMessage>,
}

/// 前端发给 AI 助手的上下文选项。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiContextPayload {
    pub book_title: String,
    pub book_genre: String,
    pub book_summary: String,
    pub chapter_title: String,
    pub chapter_summary: String,
    pub chapter_excerpt: String,
    pub selected_text: String,
    pub cards_summary: String,
    pub custom_system_prompt: String,
}

/// 流式事件（通过 Tauri `ai:stream` 推送给前端）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub request_id: String,
    /// "delta" | "done" | "error" | "aborted"
    pub kind: String,
    pub text: String,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub ok: bool,
    pub model: String,
    pub reply: String,
    pub latency_ms: u64,
}

/// 运行期中止句柄表（每个请求对应一个 `watch::Sender<bool>`）。
#[derive(Default)]
pub struct AiRuntime {
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl AiRuntime {
    pub fn register(&self, request_id: &str) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        if let Ok(mut map) = self.active.lock() {
            map.insert(request_id.to_string(), tx);
        }
        rx
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        if let Ok(mut map) = self.active.lock() {
            if let Some(tx) = map.remove(request_id) {
                let _ = tx.send(true);
                return true;
            }
        }
        false
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut map) = self.active.lock() {
            map.remove(request_id);
        }
    }
}

fn build_ai_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("初始化 AI HTTP 客户端失败：{e}"))
}

/// 把小说元信息、相关设定卡片与当前章节整理为结构化系统提示词。
pub fn build_novel_system_prompt(ctx: &AiContextPayload) -> String {
    let mut parts = Vec::new();
    let base = if ctx.custom_system_prompt.trim().is_empty() {
        "你是「写心酱」，一位专业、细腻且熟悉中文长篇小说与轻小说创作的 AI 写作搭档。\
         请严格贴合作者的既有文风、人物设定与世界观进行创作，避免说教或多余套话；\
         当作者要求续写、润色或扩写正文时，直接输出可用于小说的优美正文段落。"
    } else {
        ctx.custom_system_prompt.trim()
    };
    parts.push(base.to_string());

    if !ctx.book_title.trim().is_empty() {
        let mut meta = format!("【当前作品】《{}》", ctx.book_title.trim());
        if !ctx.book_genre.trim().is_empty() {
            meta.push_str(&format!("（类型：{}）", ctx.book_genre.trim()));
        }
        if !ctx.book_summary.trim().is_empty() {
            meta.push_str(&format!("\n简介：{}", ctx.book_summary.trim()));
        }
        parts.push(meta);
    }

    if !ctx.cards_summary.trim().is_empty() {
        parts.push(format!("【关联人物与世界观设定】\n{}", ctx.cards_summary.trim()));
    }

    if !ctx.chapter_title.trim().is_empty() || !ctx.chapter_summary.trim().is_empty() {
        let mut ch = format!("【当前章节】{}", ctx.chapter_title.trim());
        if !ctx.chapter_summary.trim().is_empty() {
            ch.push_str(&format!("\n本章大纲/备忘：{}", ctx.chapter_summary.trim()));
        }
        parts.push(ch);
    }

    if !ctx.selected_text.trim().is_empty() {
        parts.push(format!("【作者当前选中的片段】\n{}", ctx.selected_text.trim()));
    } else if !ctx.chapter_excerpt.trim().is_empty() {
        parts.push(format!("【当前章节正文参考】\n{}", ctx.chapter_excerpt.trim()));
    }

    parts.join("\n\n")
}

/// 辅助函数：把作品卡片整理为紧凑上下文（置顶优先，控制字符上限）。
pub fn summarize_cards_for_ai(book: Option<&BookMeta>, cards: &[Card], max_chars: usize) -> String {
    let mut sorted: Vec<&Card> = cards.iter().collect();
    sorted.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at)));
    let mut out = String::new();
    let _ = book;
    for c in sorted {
        let kind = match c.kind.as_str() {
            "character" => "人物",
            "plot" => "剧情",
            "world" => "设定",
            _ => "灵光",
        };
        let fields: Vec<String> = c.fields.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        let line = format!(
            "- [{}] {}{}{}\n",
            kind,
            c.title,
            if fields.is_empty() { String::new() } else { format!("（{}）", fields.join("，")) },
            if c.content.trim().is_empty() {
                String::new()
            } else {
                format!("：{}", c.content.trim().replace('\n', " "))
            }
        );
        if out.chars().count() + line.chars().count() > max_chars {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// 读取 / 保存单本书的 AI 对话记录。
pub fn load_chat_history(root: &Path, book_id: &str) -> Result<AiChatHistory, String> {
    if book_id.trim().is_empty() {
        return Ok(AiChatHistory::default());
    }
    let path = root.join("books").join(book_id).join("ai-chat.json");
    Ok(read_json(&path)?.unwrap_or_else(|| AiChatHistory {
        book_id: book_id.to_string(),
        messages: Vec::new(),
    }))
}

pub fn save_chat_history(root: &Path, book_id: &str, messages: Vec<AiChatMessage>) -> Result<(), String> {
    if book_id.trim().is_empty() {
        return Ok(());
    }
    let path = root.join("books").join(book_id).join("ai-chat.json");
    // 最多保留最近 120 条消息，防止对话文件无限膨胀
    let trimmed = if messages.len() > 120 {
        messages[messages.len() - 120..].to_vec()
    } else {
        messages
    };
    write_json_atomic(
        &path,
        &AiChatHistory {
            book_id: book_id.to_string(),
            messages: trimmed,
        },
    )
}

/// 拉取远端可用模型列表（OpenAI 兼容 `/models` 与 Gemini `/models`）。
pub async fn fetch_models(provider: &str, base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let client = build_ai_client()?;
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 API 地址（Base URL）".into());
    }

    if provider == "anthropic" {
        return Ok(vec![
            "claude-sonnet-4-20250514".into(),
            "claude-3-7-sonnet-latest".into(),
            "claude-3-5-haiku-latest".into(),
        ]);
    }

    if provider == "gemini" {
        let url = format!("{base}/models?key={}", api_key.trim());
        let resp = client.get(&url).send().await.map_err(|e| format!("拉取 Gemini 模型失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("拉取模型失败：HTTP {}", resp.status().as_u16()));
        }
        let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        if let Some(arr) = val.get("models").and_then(|v| v.as_array()) {
            for m in arr {
                if let Some(name) = m.get("name").and_then(|v| v.as_str()) {
                    let clean = name.strip_prefix("models/").unwrap_or(name);
                    if clean.contains("gemini") {
                        out.push(clean.to_string());
                    }
                }
            }
        }
        return Ok(out);
    }

    // OpenAI 兼容接口（含 DeepSeek / SiliconFlow / Kimi / Ollama 等）
    let url = if base.ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    };
    let mut req = client.get(&url);
    if !api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key.trim()));
    }
    let resp = req.send().await.map_err(|e| format!("拉取模型列表失败：{e}"))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("获取模型列表失败（HTTP {code}）：{}", body.chars().take(180).collect::<String>()));
    }
    let val: serde_json::Value = resp.json().await.map_err(|e| format!("解析模型列表失败：{e}"))?;
    let mut models = Vec::new();
    if let Some(arr) = val.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    } else if let Some(arr) = val.get("models").and_then(|v| v.as_array()) {
        // Ollama /api/tags 格式兜底
        for item in arr {
            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    models.sort();
    models.dedup();
    Ok(models)
}

/// 快速连通性测试（非流式短回复）。
pub async fn test_connection(profile: &AiProfile) -> Result<AiTestResult, String> {
    let start = std::time::Instant::now();
    let mut reply = String::new();
    let (_, cancel_rx) = watch::channel(false);
    let msgs = vec![AiChatMessage {
        role: "user".into(),
        content: "你好，请用不超过 15 个字简短打个招呼，证明连接正常。".into(),
        created_at: 0,
        skill: String::new(),
    }];
    let ctx = AiContextPayload {
        custom_system_prompt: "你是写心写作助手，只需极简回复确认在线。".into(),
        ..Default::default()
    };
    let mut test_profile = profile.clone();
    test_profile.max_tokens = 64;

    stream_chat(&test_profile, &msgs, &ctx, cancel_rx, |delta, _reasoning| {
        reply.push_str(delta);
    })
    .await?;

    Ok(AiTestResult {
        ok: true,
        model: profile.model.clone(),
        reply: reply.trim().to_string(),
        latency_ms: start.elapsed().as_millis() as u64,
    })
}

/// 执行流式对话，持续通过回调 `on_delta(text, reasoning)` 吐出增量文本。
pub async fn stream_chat<F>(
    profile: &AiProfile,
    messages: &[AiChatMessage],
    ctx: &AiContextPayload,
    mut cancel_rx: watch::Receiver<bool>,
    mut on_delta: F,
) -> Result<String, String>
where
    F: FnMut(&str, &str),
{
    let base = profile.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先在「设置 → AI 助手」配置 API 地址".into());
    }
    if profile.model.trim().is_empty() {
        return Err("请先填写或选择一个 AI 模型名称".into());
    }
    let provider = profile.provider.trim().to_ascii_lowercase();
    let system_prompt = build_novel_system_prompt(ctx);
    let client = build_ai_client()?;

    let resp = match provider.as_str() {
        "anthropic" => {
            let url = if base.ends_with("/messages") {
                base.to_string()
            } else {
                format!("{base}/messages")
            };
            let api_msgs: Vec<serde_json::Value> = messages
                .iter()
                .filter(|m| m.role == "user" || m.role == "assistant")
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let body = serde_json::json!({
                "model": profile.model.trim(),
                "system": system_prompt,
                "messages": api_msgs,
                "temperature": profile.temperature,
                "max_tokens": profile.max_tokens.clamp(64, 16384),
                "stream": true
            });
            client
                .post(&url)
                .header("x-api-key", profile.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求 Claude 接口失败：{e}"))?
        }
        "gemini" => {
            let url = format!(
                "{base}/models/{}:streamGenerateContent?alt=sse&key={}",
                profile.model.trim(),
                profile.api_key.trim()
            );
            let contents: Vec<serde_json::Value> = messages
                .iter()
                .filter(|m| m.role == "user" || m.role == "assistant")
                .map(|m| {
                    let r = if m.role == "assistant" { "model" } else { "user" };
                    serde_json::json!({ "role": r, "parts": [{ "text": m.content }] })
                })
                .collect();
            let body = serde_json::json!({
                "systemInstruction": { "parts": [{ "text": system_prompt }] },
                "contents": contents,
                "generationConfig": {
                    "temperature": profile.temperature,
                    "maxOutputTokens": profile.max_tokens.clamp(64, 16384)
                }
            });
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求 Gemini 接口失败：{e}"))?
        }
        _ => {
            // 默认走 OpenAI 兼容 `/chat/completions`
            let url = if base.ends_with("/chat/completions") {
                base.to_string()
            } else {
                format!("{base}/chat/completions")
            };
            let mut api_msgs = vec![serde_json::json!({ "role": "system", "content": system_prompt })];
            for m in messages {
                if m.role == "user" || m.role == "assistant" {
                    api_msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
                }
            }
            let body = serde_json::json!({
                "model": profile.model.trim(),
                "messages": api_msgs,
                "temperature": profile.temperature,
                "max_tokens": profile.max_tokens.clamp(64, 16384),
                "stream": true
            });
            let mut req = client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&body);
            if !profile.api_key.trim().is_empty() {
                req = req.header("Authorization", format!("Bearer {}", profile.api_key.trim()));
            }
            req.send().await.map_err(|e| format!("请求 AI 接口失败：{e}"))?
        }
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let err_text = resp.text().await.unwrap_or_default();
        let friendly = parse_api_error(&err_text);
        return Err(format!("AI 接口返回错误（HTTP {code}）：{friendly}"));
    }

    let mut full_text = String::new();
    let mut sse_buf = String::new();
    let mut stream = resp.bytes_stream();

    loop {
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return Err("__ABORTED__".into());
                }
            }
            next = stream.next() => {
                let Some(item) = next else { break };
                let bytes = item.map_err(|e| format!("读取流式响应中断：{e}"))?;
                sse_buf.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = sse_buf.find('\n') {
                    let line = sse_buf[..pos].trim_end_matches('\r').to_string();
                    sse_buf.drain(..=pos);
                    if let Some((delta, reasoning)) = parse_sse_line(&provider, &line) {
                        if !delta.is_empty() || !reasoning.is_empty() {
                            full_text.push_str(&delta);
                            on_delta(&delta, &reasoning);
                        }
                    }
                }
            }
        }
    }

    // 处理可能未以换行结尾的残余 JSON（如某些服务未走 SSE 直接返回整段 JSON）
    let tail = sse_buf.trim();
    if !tail.is_empty() {
        if let Some((delta, reasoning)) = parse_sse_line(&provider, tail) {
            if !delta.is_empty() || !reasoning.is_empty() {
                full_text.push_str(&delta);
                on_delta(&delta, &reasoning);
            }
        } else if full_text.is_empty() {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(tail) {
                if let Some(txt) = val
                    .pointer("/choices/0/message/content")
                    .and_then(|v| v.as_str())
                    .or_else(|| val.pointer("/content/0/text").and_then(|v| v.as_str()))
                {
                    full_text.push_str(txt);
                    on_delta(txt, "");
                }
            }
        }
    }

    Ok(full_text)
}

/// 解析单行 SSE `data: {...}`，提取 `(正文增量, 思考过程增量)`。
pub fn parse_sse_line(provider: &str, line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let payload = trimmed.strip_prefix("data:")?.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    let val: serde_json::Value = serde_json::from_str(payload).ok()?;

    match provider {
        "anthropic" => {
            if val.get("type").and_then(|v| v.as_str()) == Some("content_block_delta") {
                let text = val.pointer("/delta/text").and_then(|v| v.as_str()).unwrap_or("");
                let thinking = val.pointer("/delta/thinking").and_then(|v| v.as_str()).unwrap_or("");
                if !text.is_empty() || !thinking.is_empty() {
                    return Some((text.to_string(), thinking.to_string()));
                }
            }
            None
        }
        "gemini" => {
            let text = val
                .pointer("/candidates/0/content/parts/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !text.is_empty() {
                return Some((text.to_string(), String::new()));
            }
            None
        }
        _ => {
            let delta = val.pointer("/choices/0/delta")?;
            let text = delta.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let reasoning = delta
                .get("reasoning_content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !text.is_empty() || !reasoning.is_empty() {
                return Some((text.to_string(), reasoning.to_string()));
            }
            None
        }
    }
}

fn parse_api_error(raw: &str) -> String {
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(msg) = val
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .or_else(|| val.get("message").and_then(|v| v.as_str()))
        {
            return msg.chars().take(240).collect();
        }
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "请检查 API 地址、密钥和模型名称".into()
    } else {
        trimmed.chars().take(240).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_deepseek_anthropic_and_gemini_sse_lines() {
        let oa = r#"data: {"choices":[{"delta":{"content":"樱花","reasoning_content":"构思中"}}]}"#;
        assert_eq!(parse_sse_line("openai", oa), Some(("樱花".into(), "构思中".into())));
        assert_eq!(parse_sse_line("openai", "data: [DONE]"), None);

        let cl = r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"星夜"}}"#;
        assert_eq!(parse_sse_line("anthropic", cl), Some(("星夜".into(), String::new())));

        let gm = r#"data: {"candidates":[{"content":{"parts":[{"text":"微风"}]}}]}"#;
        assert_eq!(parse_sse_line("gemini", gm), Some(("微风".into(), String::new())));
    }

    #[test]
    fn builds_rich_novel_system_prompt_with_cards_and_selection() {
        let ctx = AiContextPayload {
            book_title: "樱落星海".into(),
            book_genre: "轻小说".into(),
            book_summary: "天台上的约定".into(),
            chapter_title: "第一章 放学后的风".into(),
            chapter_summary: "主角初遇转学生".into(),
            chapter_excerpt: "正文内容".into(),
            selected_text: "选中段落".into(),
            cards_summary: "- [人物] 星野凛：傲娇剑道少女".into(),
            custom_system_prompt: String::new(),
        };
        let prompt = build_novel_system_prompt(&ctx);
        assert!(prompt.contains("樱落星海"));
        assert!(prompt.contains("星野凛"));
        assert!(prompt.contains("选中段落"));
        assert!(!prompt.contains("正文内容"), "有选中文本时应优先聚焦选中片段");
    }
}
