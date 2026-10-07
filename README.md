# 写心 · HeartWrite · 本地小说写作工作台

一个用 **Rust + Tauri 2** 写成的原生 Windows 桌面应用，专门用来写长篇小说。
完全离线运行，所有稿件都存在本机，自带版本历史、导出、卡片灵感墙与一键排版。

## 本次更新：创作工作台与保存可靠性

- 新工作台采用浅灰底、青绿色强调色、统一线性图标与三栏布局。顶部集中保存、快照、历史和导出，正文工具条提供排版与专注模式。
- 左侧新增每日创作目标，右侧统一素材卡片与分类筛选；支持 1040×640 最小窗口、深色主题与键盘焦点。
- 保存请求排队执行；保存期间继续输入不会清除未保存标记。切章、换书、回滚和正常关闭窗口会先等待保存成功。
- 使用同目录临时文件、同步写盘、直接替换原文件。替换失败保留原文件和临时文件；损坏的章节、卡片、索引会明确报错，不再按空数据覆盖。
- 手动快照保存当前正文（包含已自动保存的内容）；修正回滚后正文不刷新、括号配对、英文数字统计和确认弹窗。
- 普通启动现在遵守 `--data-dir`；内置自检使用独立临时目录。

`pwsh -File dev.ps1 test` 运行前端回归、**三档视口的界面回归**、Rust 核心测试和纯函数自检
（Node 测试需要 Node.js；界面回归另需 Node ≥ 22 与本机 Chrome，没有就自动跳过）。
`node tests/preview-server.cjs` 在本机 4173 端口预览真实界面；预览只使用内存示例数据，实际保存与导出请使用桌面应用。
界面验收截图用 `.tooling/screenshot.ps1` 生成，编号命名的那些会进仓库（详见下文「界面验收与截图」）。

## 手机端 / 窄屏适配

界面原本是按 1040×640 以上的桌面窗口设计的，Android 版能装上，但三栏挤进一部手机就没法写了。
现在多了一层 `ui/mobile.css` + `ui/js/mobile.js`，把同一套界面收进手机；**桌面端（≥901px 且带鼠标）的
布局与操作完全不变**——所有移动端规则都在 `@media (max-width: 900px)` 或 `@media (hover: none)` 里。

- **单列 + 抽屉**：目录与素材变成左右滑出的抽屉，正文独占屏幕；点遮罩、点章节、开弹层都会自动收起抽屉。
  窄屏上两个抽屉不会同时开着（保留刚打开的那个）。
- **顶栏瘦身**：只留「目录 / 章节标题 / 更多 / 保存」，搜索、快照、历史、导出、素材、设置收进「更多」底部菜单；
  章节状态、排版、专注仍留在正文工具条上，状态栏只留保存状态与计数器。
- **触屏操作**：桌面上悬停才出现的 ↑↓✎✕ 在手机上会挤掉章节标题，因此改成每行一个 **⋮**，
  点开是底部操作面板（上移 / 下移 / 重命名 / 移动到其他卷 / 删除），面板项就是原来那些按钮；
  触屏同时关掉 `draggable`——HTML5 拖拽在手机上不工作，跨卷整理改用「移动到其他卷…」弹层
  （选目标卷 + 插入位置，位置按"先把本章摘掉之后"的目标卷列表算，与后端 `move_chapter_to` 的语义一致）。
- **返回键**：Android 硬件返回键默认会把应用直接退掉。现在接了
  `tauri-plugin-mobile-onbackpressed-listener`（只在 Android/iOS 编译），按
  「行内面板 → 弹层 → 抽屉 → 退出专注/查找 → 关闭窗口」的顺序消费；
  最后一档走 `getCurrentWindow().close()`，也就是应用原有的保存守卫，不会丢稿。
- **弹层铺满整屏**：标题固定、正文滚动、底部按钮贴屏幕下沿；表单改单列、统计卡片两列、版本对比上下堆叠、
  大纲表收起「概要」列、主题预览改为纵向堆叠。
- **手机细节**：`100dvh` 跟随地址栏与输入法高度、`env(safe-area-inset-*)` 避开刘海和手势条、
  点击目标放大到 38~48px、`viewport-fit=cover` 与 `interactive-widget=resizes-content`；
  手机上不自动聚焦正文，免得一开屏就弹输入法。
- **窗口配置**：桌面端才指定 `inner_size` / `min_inner_size`；原来那条 1040×640 的最小尺寸会把手机版卡在桌面布局上。

Android 侧的其余差异（没有系统文件选择器、导出写到应用私有目录、导入 TXT 暂不支持）见下文「三个平台怎么构建」。

## 界面动效

整套界面共用一套动效令牌（时长 110 / 190 / 280 / 420ms，曲线 `cubic-bezier(0.16, 1, 0.3, 1)`，
即 Windows 11 / Fluent 的"起步快、收尾慢"观感），具体包括：

- 左右栏收起展开时**列宽平滑过渡**，不是瞬间消失
- 弹层入场轻微缩放淡入、关闭时**播放收拢动画**再消失；点击遮罩也能关
- 目录树、右侧卡片、弹层表单**错峰淡入**（每项延迟 20~35ms，有层次不晃眼）
- 切换章节同步更新正文和章节标识，以轻微的纸张入场动画提示切换
- 字数统计**数字滚动**变化，而不是生硬替换
- 所有按钮、卡片、列表项都有按下缩放与悬停过渡；提示条滑入滑出
- 首次渲染加了一层动画守卫（`no-anim`），避免开屏瞬间抖动
- 完整尊重系统的「减少动态效果」设置（`prefers-reduced-motion`）

## 功能一览

**左上：设置 + 书籍选择**
- 点击左上角书籍卡片打开「书架」：新建 / 切换 / 编辑资料 / 删除作品，也可导入 `.json` 备份。
- 齿轮按钮打开设置：**7 套主题**（浅色 / 羊皮纸 / 暗色 / Material Design 3 亮色 / MD3 暗色 / 极简黑白 / 青绿护眼）、
  **可搜索的字体选择器**（自动扫描系统字体，可搜索、可预览；装新字体只需把字体文件放进系统字体文件夹再点「重新扫描」）、
  字号、行距、字间距、正文栏宽、自动保存间隔、单章历史版本上限、新版本字数阈值、每日目标、一键排版风格。
- 「**预览效果**」按钮就在「保存设置」旁边：会用**当前尚未保存**的主题 + 字体 + 字号 + 行距渲染一整屏
  （侧栏、正文、状态标签、右侧卡片），还能一键轮换主题对比；关闭预览即恢复原样，不会动已保存的设置。

**左侧：卷 / 章管理**
- 树形目录：卷可折叠，章节显示**状态色点**、字数与版本数。
- 卷、章均支持新增、重命名（双击）、上移 / 下移、删除（进回收站）。
- 章节可**拖拽**到任意卷的任意位置，跨卷移动。
- 顶部搜索框即时过滤章节；左下角是**可折叠的功能面板**（点标题栏即可收起，只留一条窄条，状态会被记住），
  内含新建书 / 卷 / 章、全文搜索、查找替换、导入文本、大纲视图、回收站、数据体检、专注模式、番茄钟、快捷键说明。

**章节状态**（顶栏下拉，切换后有颜色与提示反馈）
- 创作阶段：草稿 → 初稿 → 修订中 → 已定稿
- 发布阶段：待发布 → 已发布 → 待返修
- 状态会同步到左侧目录树的色点与「大纲」表格，方便一眼看出哪章还没定稿、哪章需要返工。
- 参考了 [Scrivener 的状态标记模型](https://www.literatureandlatte.com/blog/three-ways-to-mark-the-status-of-items-in-your-scrivener-project)
  与[中文网文的大纲→草稿→初稿→修改→发布流程](https://zhuanlan.zhihu.com/p/24169783405)。

**右上：字数统计 + 一键排版**
- 实时显示**全书字数**、本章字数、今日字数，点击展开详细统计（中文 / 英文单词 / 平均每章 / 最长章节 / 版本与卡片数量 / 每日目标进度条）。
- 「一键排版」**点一下直接生效**，不再弹确认框：清理行尾空格、合并多余空行、统一段首缩进
  （中文缩进＝段首两个全角空格 / 网文风格＝段间空行 / 仅整理空格三种可选）、自动补章节标题。
  排版前的正文会**先自动存成一个历史版本**，状态栏会冒出「↺ 撤销排版」按钮，也可以直接 `Ctrl+Z` 还原。
- 写作时按 **回车会自动延续段首缩进**（新段落自动带上两个全角空格），`Tab` 也能手动插缩进。
- 旁边还有 `⇄` 对比历史版本、`⛁` 手动快照、`⏱` 历史版本列表、`⤓` 导出。

**右下：时间与状态 + 番茄钟**
- 状态栏时钟实时走秒，同时显示保存状态、版本数、光标行列、选中字数、**本次会话新增字数**、番茄钟倒计时、存储占用。
- 番茄钟是一个完整的专注写作计时器：可**开始 / 暂停 / 继续 / 停止 / 重置 / 跳到下一阶段**，
  专注、短休息、长休息时长与「每几个番茄长休息」都能调，支持阶段结束自动进入下一阶段，
  计时在后台照常走，状态栏常驻显示剩余时间，设置会记住。

**右侧：人物 / 剧情 / 灵光 / 设定卡片**
- 四类卡片可筛选、搜索、置顶、标签、颜色与自定义字段（每行「字段名：内容」）。
- 双击卡片编辑；选中后「插入正文」把内容写到光标处；「生成提纲」把剧情与人物卡片汇总成提纲插入正文。

**历史版本管理**
- 编辑自动保存；累计改动超过阈值或距上一版本超过 3 分钟时自动生成版本，也可 `Ctrl+Shift+S` 手动打快照。
- 版本列表 + 双栏逐行差异对比（`-` 删除 / `+` 新增），支持回滚（回滚前自动存档）、复制版本内容、删除单个版本。

**本地导出**
- **EPUB 电子书**（自带目录、样式与元数据，可直接导入微信读书 / 多看 / Apple Books，Kindle 需转格式）、
  TXT（带 UTF-8 BOM，记事本不乱码）、Markdown、HTML 网页（自带排版样式）、JSON 完整备份（含历史版本与卡片）。
- 可导出整本书 / 指定卷 / 当前章节，可选页眉、卷名、章节名、段落缩进；留空路径会自动命名并编号保存到数据目录 `exports/`。
- 记录最近 20 次导出位置，可一键定位到资源管理器。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+S` | 保存当前章节 |
| `Ctrl+Shift+S` | 保存并创建历史快照 |
| `Ctrl+Shift+F` | 一键排版（直接生效，可 Ctrl+Z 撤销） |
| `Ctrl+Z` | 撤销一次一键排版 |
| `Ctrl+E` | 导出 |
| `Ctrl+Y` | 历史版本对比 |
| `Ctrl+F` | 全文搜索（正文 + 卡片） |
| `Ctrl+H` | 查找替换 |
| `Ctrl+N` | 新建书籍 |
| `Ctrl+Alt+N` | 新建章节 |
| `Ctrl+P` | 番茄钟 |
| `Ctrl+K` | 把选中卡片插入正文 |
| `F9` / `F10` / `F11` | 左栏 / 右栏 / 专注模式 |
| `Esc` | 关闭弹层、退出专注模式 |

写作时 `Tab` 插入全角缩进，`"` 自动成对，回车自动延续段首缩进，正文区域高度自动增长。

## 数据存放位置

默认在 `%APPDATA%\com.heartwrite.novelmanager`：

```
settings.json                          全局设置
books.json                             书架索引
books/<bookId>/book.json               卷章目录树
books/<bookId>/cards.json              人物 / 剧情 / 灵光 / 设定卡片
content/<bookId>/<chapterId>.json      章节正文 + 历史版本
exports/                               默认导出目录
trash/                                 删除内容（可在回收站清空）
recent-exports.json                    最近导出记录
```

整个目录拷走就是完整备份；`NOVEL_MANAGER_DATA_DIR` 环境变量或命令行 `--data-dir <路径>` 可自定义位置。

**改名前的稿件会自动迁移。** 应用叫「墨阁」时数据目录是 `%APPDATA%\com.moge.novelmanager`，
改名后换成上面的路径。首次以新名字启动时，只要新目录还不存在、旧目录里有稿件，
程序就会把旧目录整体搬过来（同盘用改名，跨盘退回复制且两个目录都保留），
并在 `ui-log.txt` 记一行迁移日志。已有新目录时不会覆盖，旧目录原地不动。

## 构建与运行

当前工作区已准备好本地工具链（`.cargo` / `.rustup` / `.tooling`），无需全局安装 Rust。这些工具链目录未纳入 Git，新克隆环境需要自行准备 Rust 和对应的 Windows 构建工具。

```powershell
pwsh -File dev.ps1 check      # 类型检查
pwsh -File dev.ps1 build      # 调试构建
pwsh -File dev.ps1 run        # 启动应用
pwsh -File dev.ps1 test       # 前端回归 + Rust 核心测试 + 纯函数自检
pwsh -File dev.ps1 smoke      # 无头端到端自检（建书→写作→版本→排版→导出→导入→回收站→重载）
pwsh -File dev.ps1 release    # 发布构建（target/release/novel-manager.exe）
pwsh -File packaging/package.ps1 # 构建并打包 release/HeartWrite-Windows.zip
```

便携版解压后运行 `HeartWrite/HeartWrite.exe`，并保留旁边的 `WebView2Loader.dll`。程序继续使用原来的默认稿件目录。

应用内「设置 → 运行内置自检」也能随时跑一遍同样的全流程检查。

### 三个平台怎么构建

Windows 可以在本机构建；**Linux 与 Android 必须用 CI**，理由不是偷懒而是硬约束：

| 目标 | 在哪里构建 | 为什么不能在本机 |
| --- | --- | --- |
| Windows 便携版 | 本机（`packaging/package.ps1`） | — |
| Arch Linux 便携版 | `.github/workflows/build-linux.yml`，跑在 `archlinux:base-devel` 容器里 | Windows 无法产出 ELF 可执行文件，链接需要 ELF 工具链与 glibc；本机也没有 WSL 或容器运行时 |
| Android APK | `.github/workflows/build-android.yml`，跑在 Ubuntu | 需要 Android SDK + NDK + JDK；本机未安装 |

两个工作流都支持手动触发（Actions 页面 → Run workflow），推送 `v0.1.*` / `v0.2.*` / `v1.*` 形式的 tag 时会自动构建**并把产物挂到对应 Release**。

Arch 用户有两条路：

```bash
# 路线一：装系统包（AUR，使用 CI 预编译产物，不需要 Rust 与 -dev 依赖）
cd packaging/arch && makepkg -si

# 路线二：直接用便携版压缩包（解压即用，与 Windows 便携版同构）
tar -xzf XieXin-linux-0.1.1.tar.gz && ./XieXin-linux-0.1.1/HeartWrite
```

**Android 上的行为差异**（不是 bug，是平台限制）：`rfd` 没有 Android 后端，所以文件选择器不可用。
导出会直接写到应用私有导出目录（与桌面端"不指定路径"时一致），导入 TXT 暂不支持。
其余功能——写作、版本历史、字数统计、一键排版、EPUB/TXT/MD/HTML/JSON 导出、卡片墙——都可用。
界面本身已按手机窄屏适配（见上文「手机端 / 窄屏适配」），桌面端行为不受影响。

### 界面验收与截图

```powershell
pwsh -File .tooling/screenshot.ps1 -Name app                              # 主界面
pwsh -File .tooling/screenshot.ps1 -Name settings -Url "index.html?open=settings"
pwsh -File .tooling/screenshot.ps1 -Name preview  -Url "index.html?open=preview&theme=md3"
```

截图会自动编号写入 `.shots/`（如 `.shots/04-preview.png`）。按 `.gitignore` 约定，**只有编号命名的截图会进仓库**，
其余（调试用的中间产物）留在本地，因此顺手 `git add .shots` 就能把"这一轮已核对过的界面状态"固化进提交。

手机端截同一个套路，用 `.tooling/mobile-shot.mjs`（无头 Chrome + 真实手机视口，会模拟触屏与粗指针）：

```powershell
node tests/preview-server.cjs                                   # 先起预览服务（另一个终端）
# 触屏手机：主界面 / 目录抽屉 / 顶栏「更多」/ 整屏弹层 / 行内 ⋮ 操作面板
node .tooling/mobile-shot.mjs --name mobile-editor
node .tooling/mobile-shot.mjs --name mobile-toc      --eval "document.getElementById('toggleSidebar').click()"
node .tooling/mobile-shot.mjs --name mobile-more     --eval "document.getElementById('mobileMore').click()"
node .tooling/mobile-shot.mjs --name mobile-settings --eval "document.getElementById('openSettings').click()"
node .tooling/mobile-shot.mjs --name mobile-row-actions `
  --eval "document.getElementById('toggleSidebar').click(); setTimeout(() => document.querySelector('.chapter-row .row-more').click(), 500)"
# 另外两档对照
node .tooling/mobile-shot.mjs --name tablet --w 1024 --h 768            # 触屏平板：三栏 + 行内 ⋮
node .tooling/mobile-shot.mjs --name desk   --w 1440 --h 900 --hover    # 桌面鼠标：移动端规则全不生效
```

`--eval` 会在截图前执行一段 JS，它同时也是断言手段：脚本抛错就说明界面行为不对。
仓库里的 `.shots/07-mobile-editor.png` ~ `11-mobile-row-actions.png` 就是手机那五条命令产出的
（编号由脚本自己递增；`--name` 里带路径分隔符时按完整路径写）。

同一条链路也固化成了回归测试，随 `dev.ps1 test` 一起跑：

```powershell
node --test tests/mobile-ui.test.mjs    # 窄屏 390×844 / 触屏平板 1024×768 / 桌面 1440×900
```

它检查的是"移动端规则各自生效、且不污染桌面"这类容易回归的东西（抽屉与遮罩联动、点章节收起抽屉、
⋮ 面板项与重命名/跨卷移动、整屏弹层几何与底部按钮贴边、Android 返回键的分层消费、
桌面端 ⋮ 与「更多」必须隐藏）。
需要 Node ≥ 22（内置 WebSocket）与本机 Chrome/Edge，两者缺一就自动 skip，不会拖垮别的测试。

要做纯界面改动（不经 Rust、不碰真实稿件）时，可以用内存示例数据在浏览器里预览：

```powershell
node tests/preview-server.cjs   # http://127.0.0.1:4173 ，加 ?empty 看空状态
```

### 本机工具链说明（为什么这样搭）

本机没有 MSVC 生成工具，因此使用 **`x86_64-pc-windows-gnu`** 目标：

- rustc / cargo 装在仓库内的 `.rustup` / `.cargo`；
- 链接器与 binutils 使用仓库内的 **w64devkit（MinGW-w64）**，即 `.tooling/mingw/w64devkit`，
  并把 rustc 自带的导入库复制进它的 `lib` 目录；
- MinGW 的 `windres` 无法处理**带空格的路径**，所以 `dev.ps1` 会建立一个无空格的目录联接
  `C:\novel-manager-build`，在其中执行 cargo（`tauri-build` 需要编译 Windows 资源）；
- 若目录联接创建失败，脚本会自动退回 8.3 短路径。

依赖：Windows + WebView2 运行时（Win10/11 系统自带）。

### 从零装回这套工具链

工具链目录都在 `.gitignore` 里，新克隆的仓库需要自己装一遍（装完 `dev.ps1` 原样可用）：

```powershell
# 1) rustup + GNU 目标工具链，装进工作区（与 dev.ps1 的 RUSTUP_HOME / CARGO_HOME 约定一致）
$env:RUSTUP_HOME = "$PWD\.rustup"; $env:CARGO_HOME = "$PWD\.cargo"
Invoke-WebRequest https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe -OutFile rustup-init.exe
.\rustup-init.exe -y --no-modify-path --profile default --default-toolchain stable-x86_64-pc-windows-gnu

# 2) MinGW-w64：w64devkit 解压到 .tooling\mingw\（v1.23.0 是最后一个提供的 .zip 版本）
Invoke-WebRequest https://github.com/skeeto/w64devkit/releases/download/v1.23.0/w64devkit-1.23.0.zip -OutFile w64devkit.zip
Expand-Archive w64devkit.zip -DestinationPath .tooling\mingw

pwsh -File dev.ps1 check      # 验证：能编译就说明工具链齐了
```

w64devkit 不带 `libgcc_eh.a` 这类 GCC 运行库，而 rustc 的 GNU 目标链接时会要，所以 `dev.ps1`
每次启动都会把 rustc 自带的 `self-contained` 导入库里 **MinGW 缺的那些**补进去（已存在的不覆盖），
报错 `ld.exe: cannot find -lgcc_eh` 就是这一步没做过。

### VS Code 里怎么用

仓库自带一套团队级配置（`.vscode/`，个人配置仍被 gitignore）：

- `extensions.json`：打开仓库时提示安装 rust-analyzer、Tauri、CodeLLDB、Even Better TOML、Dependi、
  PowerShell、Prettier、HTML CSS Support、YAML、GitHub Actions / Pull Requests、EditorConfig 与中文语言包；
- `settings.json`：把 `RUSTUP_HOME` / `CARGO_HOME` / MinGW 路径塞给 rust-analyzer，
  所以工作区工具链不在 PATH 上也能补全和跳转；顺手排除了 `target/`、`.rustup/`、`.tooling/mingw/` 的搜索与监听；
- `tasks.json`：`dev.ps1 check / build / test / smoke / run`、界面预览服务、手机视口截图；
- `launch.json`：CodeLLDB 直接调 `novel-manager.exe`（cargo 由前置任务在 dev.ps1 的环境里跑），
  另有"空数据目录"配置和浏览器调界面的配置。

`.editorconfig` 与 `.prettierrc.json` 是编码约定：除 `*.ps1` 用 CRLF 外一律 LF、缩进 2 空格（Rust 4 空格）、
Prettier 沿用仓库既有的单引号 + 120 列；`ui/index.html` 是手写折行的，已放进 `.prettierignore`。
`gh auth login` 需要手动跑一次，GitHub 那两个插件才有数据。

### 开发辅助开关（日常使用不需要）

| 环境变量 / 参数 | 作用 |
| --- | --- |
| `--smoke-test` | 无头跑完整端到端自检后退出 |
| `--self-check` | 只跑纯函数自检后退出 |
| `--data-dir <路径>` | 指定数据目录 |
| `NOVEL_MANAGER_DATA_DIR` | 同上（环境变量形式） |
| `NOVEL_MANAGER_SELFTEST=1` | 启动时写入一套示例数据（《剑气长河》），便于验收界面 |
| `NOVEL_MANAGER_UITEST=1` | 启动后自动跑 25 项界面交互验收（打开/关闭各弹层、按钮、字数、主题、字体、番茄钟、导出格式），结果写入 `ui-log.txt` |
| `NOVEL_MANAGER_CLOSETEST=1` | 配合 UITEST，在界面自检后验证关闭前保存并自动退出；仅在临时测试目录中使用 |
| `NOVEL_MANAGER_START_URL=<路径>` | 自定义入口页，例如 `index.html?open=stats` 直接展开统计面板、`index.html?theme=md3` 直接换配色 |

数据目录下的 `ui-log.txt` 会记录前端启动信息与未捕获异常，排查界面问题时可先看它。
开发用的示例数据、界面自检和视口诊断都放在 `ui/js/dev/`，**产品页面不引用它们**：
只有设置上面这些开关时，Rust 侧才会把 `js/dev/inject.js` 动态挂进去，正式使用不会加载分毫。

## 已知限制（尚未处理）

以下是代码审查确认存在、但当前版本**没有**修的问题，按优先级排列：

1. **历史版本与正文同存一个文件**（`content/<bookId>/<chapterId>.json`）。每次保存都要把该章全部历史版本重新序列化，每次读取（搜索、导出、字数统计）也都要全部解析。默认保留 30 版时无感；若把「历史版本保留数量」调到上限 200 且章节很长，保存与切章会明显变慢。计划改为一个版本一个文件。
2. **导出 TXT/MD/HTML 会重复读一遍全书**：先为页眉调用 `book_stats`（逐章读文件计数），渲染时再读一遍。页眉其实只需目录树里已缓存的 `charCount`。
3. **手填「保存位置」会直接覆盖同名文件**：留空时自动编号、用「选择…」时系统会问是否替换，但手动粘贴一个已存在的路径会静默覆盖（包括覆盖上次的 JSON 备份）。
4. **`books.json` / `settings.json` 损坏时启动即退出**，没有提示窗口和恢复入口。稿件文件本身完好，但用户会以为"书架没了"。
5. 计数/显示不一致的三处小问题：首次保存新章节会留下一个「自动存档 0 字」的空版本；删除单个版本后目录树版本数不刷新；导入 JSON 备份后每章显示 0 个版本。都不影响正文。
6. **手机端界面没有真机自动化验收**：`tests/mobile-ui.test.mjs` 跑的是无头 Chrome 的视口模拟，
   能覆盖布局与交互逻辑，但软键盘遮挡、刘海安全区（模拟环境里 inset 恒为 0）、触摸手势、
   Android 返回键的真实回调都只有 CI 出的 APK 装到设备上才能确认。本机没有 JDK/SDK/NDK，
   也没有模拟器，这一步目前只能人工做。

## 代码结构

```
src-tauri/src/
  lib.rs          应用入口、命令注册、--smoke-test 自检模式
  main.rs         Windows 可执行入口
  app.rs          Tauri 状态与全部 IPC 命令
  storage.rs      本地持久化（书籍/卷/章/卡片/历史版本/设置）
  export.rs       导出渲染（TXT/MD/HTML/JSON/EPUB）与文件对话框
  zip.rs          极简 ZIP 写入器（EPUB 容器，无外部压缩依赖）
  text.rs         字数统计、中文数字、一键排版、章节切分、查找替换
  text_decode.rs  TXT 导入编码嗅探（UTF-8 / GBK / UTF-16）
  smoke.rs        端到端自检脚本
ui/
  index.html      三栏工作台骨架
  styles.css      7 套主题与基础组件样式
  workspace.css   新版工作台布局、主题细节与窗口适配
  mobile.css      手机 / 窄屏适配（单列 + 抽屉 + 整屏弹层，桌面端不受影响）
  js/main.js      入口、快捷键、会话统计、全局事件绑定
  js/store.js     全局状态（含章节状态表）
  js/api.js       IPC 封装
  js/viewport.js  窄屏 / 触屏判断（两者分开，且避免模块互相 import）
  js/sidebar.js   卷章目录树（含拖拽、状态色点、触屏 ⋮、移动到其他卷）
  js/editor.js    正文编辑、自动保存、字数统计、章节状态、切章与保存加锁
  js/cards.js     卡片墙
  js/mobile.js    手机端交互（抽屉遮罩、行内操作面板、顶栏「更多」、Android 返回键）
  js/pomodoro.js  番茄钟（开始/暂停/重置/跳过、时长设置、本地保存）
  js/dialogs.js   书架/设置/导出/历史/统计/大纲/搜索/回收站/帮助
  js/ui.js        提示条、通用弹层、数字滚动动效
  js/dev/         开发专用（产品页面不引用，仅设置开关时由 Rust 注入）
    inject.js     按开关动态加载下面几个
    seed.js       示例数据（截图/手工验收用）
    uitest.js     界面自动验收（28 项交互检查）
    diag.js       视口 / DPI 诊断
src-tauri/tests/
  core.rs         挂载 storage/text/export/zip 模块，让 cargo test 无需链接桌面事件循环
tests/
  editor.test.cjs 前端回归（Node 原生 test + vm 假 DOM，覆盖并发保存与切章丢稿）
  mobile-ui.test.mjs  移动端界面回归（无头 Chrome 跑三档视口）
  lib/chrome-cdp.mjs  极简 CDP 客户端（回归与截图共用，不引入 puppeteer）
  preview-server.cjs / preview-fixture.js  浏览器内的内存数据界面预览
packaging/
  package.ps1     产出便携版目录与 release/HeartWrite-Windows.zip
dev.ps1           一行命令完成构建 / 运行 / 自检 / 发布
.tooling/         本机工具链（MinGW-w64、图标生成器、截图脚本）
  screenshot.ps1  桌面窗口截图（跑真实应用）
  mobile-shot.mjs 手机视口截图（无头 Chrome，模拟触屏）
.vscode/          团队级编辑器配置（插件推荐 / 工作区设置 / 任务 / 调试）
.editorconfig     编码与换行约定（与 .gitattributes 对齐）
.prettierrc.json  Prettier 规则（单引号 + 120 列，沿用仓库既有风格）
.shots/           编号命名的界面验收截图（进仓库）
```

## 许可证

写心采用 **GNU General Public License v3.0（GPL-3.0）**，完整条款见仓库根目录的 [LICENSE](LICENSE)。

用大白话说：

- 你可以自由地使用、修改、再发布这个软件，也包括商用。
- **但只要你把修改过的版本分发出去**（传到网上、拷给别人、随产品附带），就必须把**完整的对应源码**同样按 GPL-3.0 公开。
- 不能把它改成闭源软件再发布，也不能只发二进制不给源码。
- 本软件不提供任何担保。

只在自己电脑上用、或者自己改着玩，不需要公开任何东西——GPL 约束的是「分发」这个动作，不是「使用」。

> **用写心写出来的小说，版权 100% 属于你自己**，跟这个协议没有关系。
> GPL 管的是软件本身的源码，不会传染到你的作品上。
