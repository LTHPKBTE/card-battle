# 第三方软件声明 / Third-Party Notices

本仓库以 **GPL-3.0-only** 发布 (见 [`LICENSE`](./LICENSE))。

构建产物 `dist/卡牌系统/酒馆助手脚本-卡牌系统.json` 中**内联**了下列第三方代码。
它们各自按其原始许可证授权, 本仓库不对它们主张任何权利。

## 内联进构建产物的组件

### vue-style-loader

- 用途: 把 `.vue` 单文件组件里的样式注入页面
- 许可证: MIT
- 版权: Copyright (c) 2016-present Evan You
- 内联文件: `lib/addStylesClient.js`、`lib/listToStyles.js`
- 主页: <https://github.com/vuejs/vue-style-loader>

### style-loader

- 用途: 把 `import './x.css'` 的样式注入页面
- 许可证: MIT
- 版权: Copyright JS Foundation and other contributors
- 主页: <https://github.com/webpack-contrib/style-loader>

两者的 MIT 许可证全文:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 不进入产物的依赖

其余的 npm 依赖 (vue、pinia、zod、yaml、json5、jsonrepair、lodash、jquery、toastr 等)
经 webpack 的 `externals` 配置改为**运行时从 CDN 动态 import 或直接使用酒馆网页上的全局变量**,
因此不由本仓库分发, 各自的许可证在酒馆页面加载它们时才生效。
完整清单与版本见 [`package.json`](./package.json)。

## 未使用的代码

`script_bundle.ts`、`webpack.config.ts`、`eslint.config.mjs` 等构建配置是照着
`tavern_helper_template` 的同类文件写的。该模板采用 Aladdin Free Public License (AFPL),
它自己声明**不是开源许可证**, 且要求衍生作品整体以 AFPL 授权、禁止涉及付款的分发, 与本仓库的
GPL-3.0 无法并存。因此本仓库**不打包模板的任何代码**, 只在编译期读取它的 `@types` 类型定义;
细节与边界见 [`AGENTS.md`](./AGENTS.md) 的「许可与依赖边界」。
