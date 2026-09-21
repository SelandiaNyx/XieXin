//! 极简 ZIP 写入器（存储模式，不压缩）：用于生成 EPUB 电子书。
//! 仅实现写文件所需的最小结构，不依赖外部压缩库。

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for b in data {
        crc = table[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

struct Entry {
    name: String,
    data: Vec<u8>,
    offset: u32,
    crc: u32,
}

/// 按顺序写入若干文件，产出标准 ZIP 字节流。
pub struct ZipWriter {
    entries: Vec<Entry>,
    body: Vec<u8>,
}

impl Default for ZipWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl ZipWriter {
    pub fn new() -> Self {
        Self { entries: Vec::new(), body: Vec::new() }
    }

    pub fn add(&mut self, name: impl AsRef<str>, data: impl AsRef<[u8]>) {
        let name = name.as_ref();
        let data = data.as_ref();
        let offset = self.body.len() as u32;
        let crc = crc32(data);
        let name_bytes = name.as_bytes();

        let mut header = Vec::with_capacity(30 + name_bytes.len());
        header.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // 本地文件头签名
        header.extend_from_slice(&20u16.to_le_bytes()); // 版本
        header.extend_from_slice(&0x0800u16.to_le_bytes()); // 标志位：UTF-8 文件名
        header.extend_from_slice(&0u16.to_le_bytes()); // 压缩方式：存储
        header.extend_from_slice(&0u16.to_le_bytes()); // 修改时间
        header.extend_from_slice(&0u16.to_le_bytes()); // 修改日期
        header.extend_from_slice(&crc.to_le_bytes());
        header.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 压缩后大小
        header.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 原始大小
        header.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        header.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段长度
        header.extend_from_slice(name_bytes);

        self.body.extend_from_slice(&header);
        self.body.extend_from_slice(data);
        self.entries.push(Entry {
            name: name.to_string(),
            data: data.to_vec(),
            offset,
            crc,
        });
    }

    pub fn finish(self) -> Vec<u8> {
        let cd_offset = self.body.len() as u32;
        let mut central = Vec::new();
        for e in &self.entries {
            let name_bytes = e.name.as_bytes();
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // 中央目录签名
            central.extend_from_slice(&20u16.to_le_bytes()); // 创建版本
            central.extend_from_slice(&20u16.to_le_bytes()); // 需要版本
            central.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8
            central.extend_from_slice(&0u16.to_le_bytes()); // 存储
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&e.crc.to_le_bytes());
            central.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段
            central.extend_from_slice(&0u16.to_le_bytes()); // 注释
            central.extend_from_slice(&0u16.to_le_bytes()); // 磁盘号
            central.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
            central.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
            central.extend_from_slice(&e.offset.to_le_bytes());
            central.extend_from_slice(name_bytes);
        }
        let cd_size = central.len() as u32;
        let count = self.entries.len() as u16;

        let mut out = self.body;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes()); // 中央目录结束记录
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_known_value() {
        // "123456789" 的标准 CRC-32 结果
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn zip_signature() {
        let mut z = ZipWriter::new();
        z.add("mimetype", "application/epub+zip");
        let bytes = z.finish();
        assert_eq!(&bytes[0..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert_eq!(&bytes[bytes.len() - 22..bytes.len() - 18], &[0x50, 0x4b, 0x05, 0x06]);
    }
}
