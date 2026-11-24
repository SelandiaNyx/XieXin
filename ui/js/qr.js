// 轻量级纯本地 ISO/IEC 18004 QR Code SVG 生成器（Byte 模式 · ECC Level L · Version 1–5，零外部依赖）。
// 专为局域网同步配对串（如 heartwrite://192.168.1.8:19820?pin=482910）生成清晰可扫二维码。

const VERSIONS = [
  null,
  { size: 21, data: 19, ec: 7, align: [] },
  { size: 25, data: 34, ec: 10, align: [6, 18] },
  { size: 29, data: 55, ec: 15, align: [6, 22] },
  { size: 33, data: 80, ec: 20, align: [6, 26] },
  { size: 37, data: 108, ec: 26, align: [6, 30] },
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < ecCount - 1; j += 1) res[j] = res[j + 1];
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

function formatBits(mask) {
  // ECC Level L = 0b01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function encodeMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let ver = 1;
  while (ver < VERSIONS.length && bytes.length + 2 > VERSIONS[ver].data) ver += 1;
  if (ver >= VERSIONS.length) return null;
  const spec = VERSIONS[ver];
  const n = spec.size;

  // 1. 构造字节流：模式(0100) + 长度(8bit) + 数据 + 终止符 + 填充字节
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = spec.data * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = new Uint8Array(spec.data);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    codewords[i >> 3] = v;
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  for (let i = bits.length >> 3; i < spec.data; i += 1) {
    codewords[i] = pads[pi & 1];
    pi += 1;
  }
  const ec = rsRemainder(codewords, spec.ec);
  const all = new Uint8Array(spec.data + spec.ec);
  all.set(codewords, 0);
  all.set(ec, spec.data);

  // 2. 初始化矩阵与功能区标记
  const mat = Array.from({ length: n }, () => new Uint8Array(n));
  const func = Array.from({ length: n }, () => new Uint8Array(n));
  const setFunc = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    mat[r][c] = dark ? 1 : 0;
    func[r][c] = 1;
  };

  // Finder + 分隔符
  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= n || c >= n) continue;
        const dark =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r, c, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // 对齐图形
  for (const ar of spec.align) {
    for (const ac of spec.align) {
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === n - 7) || (ar === n - 7 && ac === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(ar + dr, ac + dc, d !== 1);
        }
      }
    }
  }

  // 定位线与暗模块
  for (let i = 8; i < n - 8; i += 1) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  setFunc(n - 8, 8, true);

  // 预留格式区
  for (let i = 0; i <= 8; i += 1) {
    if (!func[8][i]) func[8][i] = 1;
    if (!func[i][8]) func[i][8] = 1;
  }
  for (let i = n - 8; i < n; i += 1) {
    func[8][i] = 1;
    func[i][8] = 1;
  }

  // 3. 蛇形填充数据位 + Mask 0 ((r + c) % 2 === 0)
  const mask = 0;
  let bitIdx = 0;
  let up = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step += 1) {
      const r = up ? n - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        if (func[r][c]) continue;
        let bit = 0;
        if (bitIdx < all.length * 8) {
          bit = (all[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
        }
        bitIdx += 1;
        mat[r][c] = bit ^ ((r + c) % 2 === 0 ? 1 : 0);
      }
    }
    up = !up;
  }

  // 4. 写入格式信息
  const fmt = formatBits(mask);
  const fbit = (i) => (fmt >> i) & 1;
  for (let i = 0; i <= 5; i += 1) mat[8][i] = fbit(14 - i);
  mat[8][7] = fbit(8);
  mat[8][8] = fbit(7);
  mat[7][8] = fbit(6);
  for (let i = 0; i <= 5; i += 1) mat[5 - i][8] = fbit(5 - i);
  for (let i = 0; i <= 7; i += 1) mat[8][n - 1 - i] = fbit(i);
  for (let i = 0; i <= 6; i += 1) mat[n - 1 - i][8] = fbit(14 - i);

  return mat;
}

/** 将文本渲染为内联 SVG 二维码（含 2 模块静区）。 */
export function renderQrSvg(text) {
  const mat = encodeMatrix(text);
  if (!mat) return '<span class="hint">连接串过长</span>';
  const n = mat.length;
  const pad = 2;
  const total = n + pad * 2;
  let d = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (mat[r][c]) d += `M${c + pad},${r + pad}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="局域网同步二维码"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#18181b"/></svg>`;
}
