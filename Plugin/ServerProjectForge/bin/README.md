# ProjectForge AST Indexer Runtimes

此目录存放 ServerProjectForge 配套的原生索引器。本服务器仓库采用独立运行时交付策略：`win32-x64/` 不提交 Git；已有部署升级时必须保留该目录，并核验其内容与当前插件兼容。仅检出源码不能视为完整索引器部署。

目录约定：

```text
bin/
├── win32-x64/
│   └── projectforge_indexer.exe
├── win32-arm64/
│   └── projectforge_indexer.exe
├── darwin-x64/ | darwin-arm64/ | linux-x64/ | linux-arm64/
│   └── projectforge_indexer
```

原构建脚本位于配套 VCPChat 源码仓库，以下不是本后端仓库已提供构建入口的声明：

```text
rust_projectforge_indexer/build-runtime.js
```

规则：

1. 构建只原生编译当前操作系统和 CPU 架构；其他平台请在对应平台构建。
2. VCPChat 上游曾随源码跟踪 Windows x64 bootstrap EXE；本 ServerProjectForge 部署不沿用该 Git 策略。交付清单必须单独记录 EXE 来源、大小、SHA-256 与适配的插件版本，并以实际符号查询验证协议兼容。不能仅因前端发布了新 EXE 就替换服务器旧插件的配套运行时；没有该验收时保留原运行时。新目录部署须另行提供已验证的 EXE。
3. 二进制缺失或协议不匹配时插件不会失败：Outline / FindSymbol / `symbol=` 给出降级提示，其他施工命令照常可用。
4. Windows 上替换索引器前，应在获准维护窗口正常停止持有该 EXE 的索引进程及相关宿主；服务器宿主不等同于前端 VChat。不得在本插件文档中默认授权关闭生产服务。保留原件和回退清单后再进行替换。