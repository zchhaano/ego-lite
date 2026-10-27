# ego-lite 安全审计报告

审计日期：2026-10-27。基准提交：`aecc5831fc5a9ea01a078b632185992a3a7ac448`。

## 修复记录（2026-10-27）

SEC-01 至 SEC-06 的仓库内修复已实现，尚未提交或发布。下面的原始发现和 PoC 输出保留作为修复前证据；其中原始行号对应基准提交，当前实现请看本表链接。

| 项目 | 当前实现 |
| --- | --- |
| SEC-01 | [安装脚本](skills/ego-browser/scripts/install.sh)在安装及启动前验证完整签名、固定 Apple Developer ID `JGQLC6YQYJ`、bundle ID `com.citrolabs.ego.lite` 和 Gatekeeper；保留隔离属性，仅允许 HTTPS 下载及重定向，拒绝 PKG 分支。 |
| SEC-02 | [静态校验](package/ego-browser/src/learning/validate-learning-format.ts)只解析 JSON 和 Acorn AST，不再导入模块；只接受可静态识别的本地函数导出，不支持重导出或动态计算的 callable。 |
| SEC-03 | [统一文件读取](package/ego-browser/src/learning/safe-site-file.ts)限制真实路径、普通文件及每文件 1 MiB，拒绝站点根、子目录和文件软链接；使用 `O_NOFOLLOW`、文件身份检查及有界读取。清单、笔记和工具入口共同使用。 |
| SEC-04 | [下载实现](package/ego-browser/src/driver/downloads.ts)要求唯一下载及匹配文件名，拒绝第二个 GUID、不明文件、软链接及多个临时文件；恢复页面策略期间也继续取消新出现的 GUID。保留不同 Page 并发下载与缺少最终进度事件时的文件检查。 |
| SEC-05 | 默认传输总期限 120 秒、无字节进展期限 30 秒、大小 100 MiB；新增 `downloadTimeout`、`downloadIdleTimeout`、`maxDownloadBytes` 选项。开始等待、原生取消和恢复均有期限；失败释放等待者并清理文件，恢复失败不会返回成功产物。 |
| SEC-06 | [CI 说明](.github/star-history/README.md)：全部外部 Action 固定已核实的完整 SHA，checkout 不保存凭据；图表生成只读，发布独立且仅默认分支执行；用公开聚合星标 API 代替需要额外权限的个体列表，仅发布四个限定的普通数据文件。 |

**验证与限制：** 新增安装器、学习包、下载和 CI 边界行为测试；安全测试先在修复前失败，再验证修复后的拒绝行为。全量测试、格式、类型、学习包及 CI 本地检查的最终结果记录于实施计划。已加入真实浏览器下载资源限制用例并尝试运行下载生命周期、资源限制、跨 TaskSpace 并发三项 E2E，但当前环境缺少 `ego-browser`，三项均未能启动，浏览器断言数为 0；不算通过。未运行线上工作流或发布。

**实际安装包兼容性：** 对官方 ARM64 DMG 进行了只读下载、挂载及临时 staging 验证，未安装、启动或移除安全属性。所取得应用版本为 `0.6.1.13`，DMG SHA-256 为 `56c415ce29cd68250e83de31eda5f659564edaf58d204eadad6d43b6b9fa6817`。其 Apple 开发者身份为 `CITRO LABS PTE. LIMITED (JGQLC6YQYJ)`，bundle ID 符合预期，Gatekeeper 接受；但严格深度签名检查因嵌套组件的 `com.apple.FinderInfo` 失败，正常 `ditto` staging 后仍失败。修复后的安装器会拒绝此包，需发布方提供通过验证的发行物。上述摘要仅记录所检查样本，并非新增的可信发布清单。

**仍然存在的边界：** 这些修复不能审计或约束闭源浏览器和原生桥接。显式运行 Node 站点工具及其 imports 仍是可信代码执行；同用户可持续修改的目录不是沙箱，学习包需来自可信、稳定的目录。下载字节检查是进度与磁盘轮询防护，不能提供操作系统硬配额；原生取消或恢复失败会报告错误，但无法保证失去响应的浏览器已停止传输。SVG 检查约束发布文件，不是 SVG 内容净化器。

## 结论与范围

优先处理安装链的发布者验证，以及站点工具校验时执行代码的问题。另已复现知识笔记符号链接越界读取、下载文件身份混淆和下载开始后缺少完成期限。下表的等级考虑了影响与攻击前提，不能解读为任意网页都能直接获得宿主权限。

| 编号 | 等级 | 问题 | 证据与前提 |
| --- | --- | --- | --- |
| SEC-01 | 高，条件性 | 安装包未经发布者验证，并移除隔离属性 | 代码确认；需要安装源或本地候选应用被替换 |
| SEC-02 | 高，条件性 | 校验器执行尚未通过校验的站点模块 | 临时目录复现；需要引入不可信学习包并运行校验 |
| SEC-03 | 中 | 知识笔记可通过符号链接读取站点目录外文件 | 临时目录复现；需要可安装含符号链接的学习包 |
| SEC-04 | 中 | 下载元数据与实际返回文件可能不属于同一下载 | 模拟 CDP 复现；同页第二个获准下载进入同一目录 |
| SEC-05 | 中，资源防护缺口 | 下载开始后没有完成期限或大小限制 | 等待不结束已复现；需要卡住或持续发送的下载源 |
| SEC-06 | 低，加固项 | CI Action 引用及绘图任务权限可进一步收紧 | 配置确认；未发现或证明 Action 已被攻陷 |

原始审计覆盖开源 Node.js/TypeScript harness、学习包加载与校验、下载与文件操作、安装脚本、插件入口、依赖锁文件和 GitHub Actions。审计阶段未修改运行时或安装逻辑；随后经用户授权实施了上表修复。

**范围限制：** Ego Lite 浏览器、原生 `globalThis.ego` 桥接、浏览器更新器及实际 Chromium 版本不在本仓库中。未运行真实浏览器 E2E、未测试线上服务、未运行安装器、未验证 GitHub 上的分支保护设置。下载问题的真实浏览器触发条件仍需专项 E2E 验证。技能附带的框架参考没有针对该 Node CLI/CDP 架构的专用条目，本报告依据代码、无害复现和相关官方资料形成。

## 高风险

### SEC-01：安装链缺少发布者校验，并主动移除隔离属性

**位置：** [install.sh:161](/Volumes/SSD1T/projects/ego-lite/skills/ego-browser/scripts/install.sh:161)、[install.sh:182](/Volumes/SSD1T/projects/ego-lite/skills/ego-browser/scripts/install.sh:182)、[install.sh:187](/Volumes/SSD1T/projects/ego-lite/skills/ego-browser/scripts/install.sh:187)、[install.sh:207](/Volumes/SSD1T/projects/ego-lite/skills/ego-browser/scripts/install.sh:207)、[install.sh:227](/Volumes/SSD1T/projects/ego-lite/skills/ego-browser/scripts/install.sh:227)。

脚本通过 HTTPS 下载 DMG，挂载后只检查应用是否包含可执行的 `ego-browser`，没有验证预期开发者身份、签名、公证状态或来自独立可信来源的摘要。应用安装路径随后删除 `com.apple.quarantine`；已经存在的应用也会经过该步骤。PKG 分支直接调用系统安装器，并可能使用 `sudo`。

**影响：** 如果攻击者能替换分发源内容或被识别为已安装的候选应用，脚本会把不可信程序纳入安装和启动流程；恶意 PKG 在获准提权后可能以管理员权限执行安装脚本。HTTPS 能保护传输，但不能证明下载内容来自预期发布者。这里不假设普通网络攻击者能绕过 TLS，也不声称移除 quarantine 会关闭 macOS 的全部恶意软件防护。

**修复建议：** 保留隔离属性；安装或提权之前验证应用/PKG 签名和预期 Team ID，并检查适用的公证与系统安全评估结果；任何失败都停止。若提供摘要，应从可信且可验证的发布清单取得，不能只信任与安装包一起被替换的普通 checksum 文件。不要仅通过文件名和可执行位认定应用身份。Apple 将 Developer ID 签名与公证用于分发软件的身份和完整性验证，参见 [Apple 官方说明](https://developer.apple.com/developer-id/)。

**验证：** 静态检查确认流程；没有下载、安装或启动替代程序。

### SEC-02：站点工具校验器会执行未通过校验的代码

**位置：** [validate-learning-format.ts:38](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/learning/validate-learning-format.ts:38)、[validate-learning-format.ts:96](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/learning/validate-learning-format.ts:96)、[validate-site-skills.ts:20](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/scripts/validate-site-skills.ts:20)。

`validateLearning()` 使用动态 `import()` 检查 Node 工具的导出。导入会执行模块顶层代码及其依赖，而且即使之前已经发现清单错误，流程仍然继续导入。这使“检查一个学习包”本身成为代码执行操作。

**攻击前提与影响：** 开发者或 agent 对下载、第三方贡献、尚未审查的学习包运行校验。模块获得校验进程拥有的 Node.js 权限，包括读取该用户可访问的文件、使用环境中的凭据和启动子进程。此处风险在于把校验当成接受第三方包之前的安全检查；`runSiteTool()` 主动运行已信任工具的能力本身是设计功能。

**复现：** 临时学习包的 `name` 故意设为空，模块顶层仅在该临时目录写入无害标记。校验返回 1 个错误，但标记已写入；无需调用工具导出的函数。

**修复建议：** 默认校验只解析 JSON、路径和 JS AST，检查声明及可静态确认的导出。动态加载检查单独作为可信代码执行步骤；确有必要接收不可信代码时，使用不含凭据、文件访问受限、默认禁网且有资源上限的进程隔离环境。仅把 `import()` 换成 `node:vm` 不构成安全隔离，[Node 官方文档明确说明 vm 不是安全机制](https://nodejs.org/api/vm.html)。

**边界：** 没有证明网页能够直接写入学习目录；也没有把普通 PR CI 执行仓库代码误判为新增的权限提升。当前 CI 测试 job 使用 `contents: read`。

## 中风险

### SEC-03：知识笔记路径限制可被符号链接绕过

**位置：** [learning/index.ts:61](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/learning/index.ts:61)、[learning/index.ts:111](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/learning/index.ts:111)。

`isLearningNotePath()` 用 `resolve()`/`relative()` 检查路径看起来是否属于 `notes/*.md`，随后 `readFile()` 跟随符号链接。没有检查链接最终指向哪里。学习包校验器同样接受这样的笔记。

**攻击前提与影响：** 不可信包中的符号链接被保留并安装，且 `learnContext()` 加载匹配域名的知识。`notes/overview.md` 可以指向站点目录外、当前进程可读取的文件；读取结果会作为知识内容返回。若调用方再记录结果或发送给模型，该内容就可能继续传播。这里已证明本地读取和返回，未声称发生了真实网络外传。

**复现：** 在临时目录创建合成私密文本，使 `notes/overview.md` 链接到它。`validateLearning()` 返回 0 个错误，`loadLearnedContext()` 返回该文件内容。

**修复建议：** 对站点目录、`notes` 目录和笔记目标验证规范化后的真实路径；检查目标是普通文件。若包格式不需要符号链接，可拒绝路径各级的符号链接。对可能被并发修改的目录，单次 `realpath()` 校验仍存在检查与读取之间的竞态，应结合不可变/只读包目录及适当的文件打开策略。对笔记大小加上上限。

### SEC-04：并发下载可能使返回文件与记录的 URL 不一致

**位置：** [downloads.ts:102](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:102)、[downloads.ts:123](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:123)、[downloads.ts:293](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:293)。

代码保存第一次 `downloadWillBegin` 的 GUID、URL 和建议文件名，但真正选取下载文件时只查找临时目录中唯一一个不以 `.crdownload` 结尾的普通文件。选取结果没有绑定到所记录的 GUID，也不要求该 GUID 已完成。第二次开始下载的事件被忽略。

**攻击前提与影响：** 同一页面在等待期间有第二个获准下载写入同一目录，且它先完成。第一份文件仍是 `.crdownload` 时，轮询就会将第二份文件作为第一份下载返回。调用方看到的 URL/建议文件名与 `path()`/`saveAs()` 获取的内容不一致，可能误处理或保存攻击者提供的内容。这不是自动执行下载文件的漏洞。

**复现：** 模拟两个不同 GUID 的下载，第一个仅创建未完成文件，第二个创建完整文件。没有发送第一个 GUID 的完成事件，第一份 artifact 仍返回第二份文件路径。

**修复建议：** 将完成事件、GUID 和磁盘文件可靠关联；关联不明确时失败，避免以“目录中恰好只有一个完整文件”认定来源。可在出现第二个下载时拒绝当前结果，作为近期防护。CDP 的 `allowAndName` 可以按 GUID 命名，但它是 BrowserContext 级配置，采用前必须保证不会破坏现有 Page/任务隔离；不能直接替换现有调用。`suggestedFilename` 也不保证等于实际磁盘文件名，参见 [CDP 官方协议定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Browser.pdl)。

**验证边界：** 已证明 harness 对这组事件与文件状态的处理错误；尚未在真实 Ego Lite 中验证多下载权限、事件路由和时序。

### SEC-05：下载开始后缺少完成期限和资源上限

**位置：** [downloads.ts:131](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:131)、[downloads.ts:171](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:171)、[downloads.ts:258](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:258)、[downloads.ts:287](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/driver/downloads.ts:287)。

收到开始事件后，代码清除等待计时器。之后如果文件没有完成、没有取消事件，完成 Promise 一直等待，轮询计时器继续存活，`path()`、`saveAs()`、`failure()` 和 `delete()` 都没有独立的期限。没有检查进度中的字节数或限制临时目录占用。

**影响：** 被访问的下载源可通过不结束的传输拖住自动化任务；持续传输还可能占用大量磁盘。具体磁盘耗尽没有在本次审计中实施，宿主进程管理器若另有限额会降低影响。

**复现：** 配置开始等待期限为 30 ms，立即发送下载开始事件，在 180 ms 后完成 Promise 仍未结束，下载行为未恢复默认。

**语义说明：** `waitForEvent()` 的 timeout 只约束事件到来是合理的 API 语义；本项指出的是缺少额外的下载完成/空闲期限和资源预算，并非声称现有事件 timeout 的实现违反契约。

**修复建议：** 增加可配置的下载完成期限、无进度期限及字节上限。触发限制时取消对应 GUID、停止轮询、恢复页面下载策略并释放所有等待者。取消与清理应有独立期限，不能无限依赖浏览器发出终态事件。

## 低风险与信任边界加固

### SEC-06：Action 引用和第三方绘图任务权限

**位置：** [ci.yml:25](/Volumes/SSD1T/projects/ego-lite/.github/workflows/ci.yml:25)、[ci.yml:62](/Volumes/SSD1T/projects/ego-lite/.github/workflows/ci.yml:62)、[star-history.yml:20](/Volumes/SSD1T/projects/ego-lite/.github/workflows/star-history.yml:20)、[star-history.yml:80](/Volumes/SSD1T/projects/ego-lite/.github/workflows/star-history.yml:80)。

多个 Action 使用版本标签，尚未固定完整提交 SHA。绘图工作流整项使用 `contents: write`，第三方渲染逻辑与推送步骤处于同一 job。渲染器源码已固定 SHA，且它的 checkout 设置了 `persist-credentials: false`，这是已有保护；但不会把整个 job 的写权限隔离到最后的发布步骤。

建议将 Action 固定到验证过的完整 SHA；评估把渲染与发布拆成独立 job，只给发布 job 写权限，并严格限定其接收的产物。若读取星标数据确实需要额外权限，按实际 API 需求配置。这里未证明任何依赖已受攻击，也未验证线上仓库的 token/分支规则。[GitHub 官方安全建议](https://docs.github.com/en/actions/reference/security/secure-use?learn=getting_started&learnProduct=actions)说明了完整 SHA 固定和最小权限原则。

### 需要明确记录的架构边界

- [run.ts:96](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/run.ts:96) 执行 agent 提交的 Node.js 脚本；[learning/index.ts:151](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/learning/index.ts:151) 执行站点 Node 工具。这些是高权限可执行代码，不能把 TaskSpace 当成文件系统或操作系统沙箱。
- [helpers.ts:752](/Volumes/SSD1T/projects/ego-lite/package/ego-browser/src/helpers.ts:752) 在直接 CLI 路径自动导入工作区 `agent_helpers.js`，其导出还能覆盖部分 helpers。工作区、学习包及其更新来源应有与执行脚本相同的信任要求。网页返回内容应作为数据处理，不应自动升级为脚本、学习包或安装指令。
- 原生桥接负责最终的用户控制权和任务空间约束，依据 [native-bindings-api.md:54](/Volumes/SSD1T/projects/ego-lite/docs/native-bindings-api.md:54)。本次没有证明原生授权绕过；跨任务 CDP 附着、浏览器级命令、原生 IPC 调用方鉴权仍需在闭源部分验证。

## 验证记录

环境：macOS，Node.js `v24.12.0`。项目声明支持 Node.js 22+。

| 检查 | 结果与范围 |
| --- | --- |
| `npm audit --json --ignore-scripts` | npm 官方 registry 返回 0 个已知漏洞；87 个依赖节点，包含开发和可选依赖，不覆盖闭源浏览器 |
| `npm run build` | 退出码 0 |
| `npm run typecheck` | 退出码 0 |
| `node --test --test-reporter=dot 'src/**/*.test.mjs'` | 退出码 0；现有 harness 测试通过，不能替代安全验证 |
| 当前 Git 跟踪文本的密钥特征扫描 | 检查 209 个文本文件，未命中所选私钥/GitHub/AWS/OpenAI token 特征；不覆盖历史提交，也不是完整 secret scanning |
| 四项无害 PoC | 均复现；只使用临时文件、合成内容和模拟 CDP，临时目录已清理 |

可复现脚本：[security-audit-repro.mjs](/Volumes/SSD1T/projects/ego-lite/docs/security-audit-repro.mjs)。在完成 `package/ego-browser` 构建后，从仓库根运行：

```sh
node docs/security-audit-repro.mjs
```

该脚本现已转换为安全回归测试入口：成功表示修复后的防护行为通过。以下保留的是原始审计时证明问题存在的历史输出：

```json
{"test":"symlink_note_escape","validationErrors":0,"outsideFileIncluded":true}
{"test":"validator_executes_rejected_module","validationErrors":1,"topLevelCodeExecuted":true}
{"test":"started_download_has_no_deadline","configuredStartTimeoutMs":30,"observedAfterMs":180,"completion":"pending","defaultRestored":false}
{"test":"download_identity_confusion","advertisedUrl":"https://audit.invalid/intended.txt","advertisedFilename":"intended.txt","returnedFile":"other.txt","expectedGuidCompleted":false}
```

当前 API schema、help 与使用指南已同步。完整实施与验证记录见 [修复计划](docs/superpowers/plans/2026-10-27-security-remediation.md)；真实浏览器验证仍需具备可用 Ego Lite CLI 的环境。
