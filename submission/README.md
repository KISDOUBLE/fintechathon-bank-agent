# 提交材料清单

赛题要求 5 项材料，本目录存放打包产物。

| # | 材料 | 必交 | 状态 | 说明 |
| :-- | :--- | :-- | :--- | :--- |
| 01 | 技术文档 | 是 | 已有源文件 | `docs/01-技术文档.md`，需导出 PDF |
| 02 | 答辩材料 | 是 | **未开始** | 10 页以内 PPT，含攻防演示页 |
| 03 | 源代码与部署材料 | 是 | **已打包** | `03-源代码与部署材料.tar.gz` |
| 04 | 安全自评报告 | 是 | 已有源文件 | `docs/04-安全自评报告.md`，需导出 PDF |
| 05 | 演示视频 | 否 | 未开始 | 选填，3–5 分钟 |

另有独立填写项：作品简介 200 字以内。

## 打包命令

```bash
node scripts/package.mjs          # 先跑 CI，再打包并校验
node scripts/package.mjs --skip-ci
```

打包会自动排除 `.env`、`data/`、`.git`、`node_modules/`、`eval/report.json`，并在打包后重新列一遍内容，确认敏感文件没有进去。

产物：

```
submission/
├── 03-源代码与部署材料.tar.gz
└── manifest.json          # 体积、文件数、SHA256、排除清单
```

## 体积红线

- 上限 300MB，脚本超限直接失败。
- 当前包约 100KB 量级（无依赖、无数据）。
- 不要把 `data/bank.db` 打进去：里面是本地演示账本，评委自己跑 `node scripts/reset.mjs` 会重新生成。

## 提交前检查

```bash
node scripts/ci.mjs         # 全绿才可提交
node scripts/package.mjs    # 打包 + 自检
git status                  # 必须是 clean
```

## 待办

- [ ] 01 / 04 导出 PDF（Markdown → PDF）
- [ ] 02 答辩 PPT
- [ ] 05 演示视频（选填）
- [ ] 200 字作品简介
- [ ] 在干净目录解压后跑一次 `node scripts/ci.mjs` 验证自包含
