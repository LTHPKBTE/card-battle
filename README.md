# card-battle

酒馆助手 (Tavern Helper / JS-Slash-Runner) 脚本: **卡牌库 · 卡组 · 卡牌战斗引擎**。

在酒馆的脚本按钮区提供「卡牌库 / 卡组 / 战斗 / 调试」四个面板:

- **卡牌库** — 角色卡变量里维护一个可编辑、可导入导出的卡牌库 (zod 校验, 支持机读效果 YAML)
- **卡组** — 每个聊天文件独立的卡组, 可用酒馆 AI 按提示词生成, 出战时快照进聊天变量
- **战斗** — 数据驱动的卡牌对战引擎 (时机触发 / 修正叠加 / 状态 / 能量 / 询问 / 回放) 与 AI 决策协议
- **调试** — 三个作用域的变量占用与最近通知

卡牌行为写在卡牌的「机读效果」YAML 里, 语法见 [`机读效果.md`](./机读效果.md)。

## 构建

```bash
corepack pnpm install
corepack pnpm build:dev     # 开发构建 → dist\卡牌系统\
corepack pnpm build         # 生产构建
```

产出 `dist\卡牌系统\酒馆助手脚本-卡牌系统.json`, 在酒馆助手的脚本库里点「导入」选中它即可。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src\卡牌系统\` | 脚本源码 (入口 `index.ts`) |
| `资源\` | 需要手动导入酒馆的世界书、正则与 AI 战斗协议 |
| `机读效果.md` | 卡牌机读效果 YAML 的书写语法 |
| [`开发说明.md`](./开发说明.md) | 构建、目录结构、许可证边界等开发向说明 |
| `.agents\` | 开发笔记 |

## 依赖说明

本仓库与参考模板仓库 `../tavern_helper_template` **并列存在**, 但**不复制也不打包**它的任何代码,
只在编译期读它的 `@types` 类型定义 —— **两个目录必须放在同一个父目录下**。

原因与边界详见 [`开发说明.md`](./开发说明.md) 的「许可与依赖边界」。

## 许可证

[GNU General Public License v3.0 only](LICENSE) (`GPL-3.0-only`)。

构建产物中内联了少量第三方代码 (vue-style-loader、css-loader、vue-loader 的运行时文件, 均为 MIT),
声明见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

> 本项目的开发参考了 [tavern_helper_template](https://github.com/StageDog/tavern_helper_template)
> 的构建配置与接口用法。该模板采用 Aladdin Free Public License (AFPL), 它不是开源许可证,
> 且与本项目的 GPL-3.0 不兼容, 因此本项目**不含模板的任何代码**, 详见 [`开发说明.md`](./开发说明.md)。
