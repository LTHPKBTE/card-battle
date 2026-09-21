/* eslint-disable import-x/no-named-as-default, import-x/no-named-as-default-member, import-x/no-nodejs-modules */
// 酒馆助手脚本 · 打包成可导入的 JSON
//
// webpack 的产物是 `dist/<脚本目录>/index.js`, 而酒馆助手「脚本库」的导入格式是一份 JSON
// (`@types/function/script.d.ts` 里的 `Script` 类型): 脚本代码放在 `content` 字段里, 再带上名称 / id 等元数据.
//
// 这个文件就是两者的转换器, 并作为 webpack 插件挂在每个脚本入口上:
//
//   pnpm build / pnpm build:dev
//     → dist/<脚本目录>/index.js
//     → dist/<脚本目录>/酒馆助手脚本-<脚本名>.json   ← 酒馆里点「导入」选中它即可
//
// 关于 id (酒馆助手里 id 相同的脚本会被覆盖, id 不同则新增):
// - 默认按脚本目录路径算出一个固定 id (UUID v5), 每次打包都一样, 所以重复导入不会攒出一堆同名脚本;
// - 想自己指定 id (比如接管一个已经导入过的脚本), 在脚本目录里放 `script.json`, 写 `{ "id": "..." }`;
//   这个文件里还能写 `enabled` / `info` / `data` / `export_with`.
//
// `button` 不写进产物: 不传的话酒馆助手会自动识别脚本里 `appendInexistentScriptButtons` 注册的按钮.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import webpack from 'webpack';
import { z } from 'zod';

/** 可选的元数据文件名 (放在脚本目录里, 与 index.ts 同级) */
export const SCRIPT_META_FILENAME = 'script.json';

/** 生成的文件名前缀, 例如 `酒馆助手脚本-卡牌系统.json` */
const BUNDLE_PREFIX = '酒馆助手脚本-';

/** 算 UUID v5 用的命名空间 (本项目随便定的一个固定 UUID, 免得和其他工具的 v5 撞车) */
const UUID_NAMESPACE = '2f5c9f5e-3f0f-4a5a-9c1f-7d8b6a4e2c10';

/** 日志前缀 (与 webpack.config.ts 里其它日志保持一致) */
const LOG_TAG = '\x1b[36m[script_bundle]\x1b[0m';

/**
 * `script.json` 的结构: 就是酒馆助手的 `Script` 去掉打包时才知道的 `content` 和 `name`.
 *
 * 字段全部可选 —— 不写就用这里的默认值.
 */
const ScriptMetaSchema = z.object({
  /** 脚本 id; 不写就按脚本目录路径算一个固定的 */
  id: z.string().optional(),
  /** 导入后是否启用 */
  enabled: z.boolean().prefault(true),
  /** 脚本介绍 */
  info: z.string().prefault(''),
  /** 脚本自带的 data */
  data: z.record(z.string(), z.any()).prefault({}),
  /** 导出脚本时是否携带 data / button */
  export_with: z
    .object({
      data: z.boolean().prefault(true),
      button: z.boolean().prefault(true),
    })
    .prefault({}),
});

/** `script.json` 里能写的东西 */
export type ScriptMeta = z.infer<typeof ScriptMetaSchema>;

/** 解析完的元数据: id 一定存在 */
type ResolvedScriptMeta = Omit<ScriptMeta, 'id'> & { id: string };

/** 一份可导入酒馆助手的脚本, 已经序列化好 */
export interface ScriptBundle {
  /** 文件名, 例如 `酒馆助手脚本-卡牌系统.json` */
  filename: string;
  /** 文件内容 */
  text: string;
}

/** 脚本在项目里的相对路径 (用来算默认 id; 统一成正斜杠, 免得 Windows 和 CI 算出不同的 id) */
function script_key(script_dir: string): string {
  const relative = path.relative(import.meta.dirname, script_dir);
  return (relative.startsWith('..') ? script_dir : relative).split(path.sep).join('/');
}

/** 按 RFC 4122 算一个 UUID v5 */
function uuid_v5(name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(UUID_NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(name, 'utf-8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // 版本 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** 读 `script.json`; 没有这个文件就全用默认值 */
function read_script_meta(script_dir: string): ResolvedScriptMeta {
  const file = path.join(script_dir, SCRIPT_META_FILENAME);
  const { id, ...rest } = fs.existsSync(file) ? parse_script_meta(fs.readFileSync(file, 'utf-8'), file) : {};
  return { ...ScriptMetaSchema.parse({}), ...rest, id: id || uuid_v5(script_key(script_dir)) };
}

/** 解析 `script.json`, 格式不对时抛出带文件名和字段路径的错误 */
function parse_script_meta(text: string, file: string): ScriptMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`'${file}' 不是合法的 JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const parsed = ScriptMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`'${file}' 格式不对: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** 去掉末尾的 sourceMappingURL 注释 (酒馆里没有对应的 map 文件, 留着只会在控制台报 404) */
function strip_source_mapping(code: string): string {
  return code.replace(/\n?(?:\/\/[#@] sourceMappingURL=\S+|\/\*[#@] sourceMappingURL=\S+ \*\/)\s*$/, '');
}

/**
 * 把打包好的脚本代码转成可导入酒馆助手的 JSON.
 *
 * 抛错时调用方负责提示 (不中断 webpack 打包: `index.js` 才是主产物).
 */
export function build_script_bundle(script_file: string, code: string): ScriptBundle {
  const script_dir = path.dirname(path.resolve(script_file));
  const name = path.basename(script_dir);
  const meta = read_script_meta(script_dir);
  const bundle = {
    type: 'script',
    enabled: meta.enabled,
    name,
    id: meta.id,
    content: strip_source_mapping(code),
    info: meta.info,
    data: meta.data,
    export_with: meta.export_with,
  };
  return { filename: `${BUNDLE_PREFIX}${name}.json`, text: JSON.stringify(bundle, null, 2) };
}

/**
 * webpack 插件: 打包完把 `index.js` 顺手转成可导入的 JSON 一起产出.
 *
 * 这里用 `emitAsset` 而不是自己写文件: 产物目录开了 `output.clean`,
 * 直接写到磁盘上的文件会在下一次编译时被 webpack 当成陈旧文件删掉.
 */
export function script_bundle(script_file: string) {
  const asset_name = `${path.parse(script_file).name}.js`;
  return {
    apply(compiler: webpack.Compiler) {
      compiler.hooks.thisCompilation.tap('script_bundle', compilation => {
        // REPORT 阶段: 此时 index.js 已经过 minimize / devtool 处理, 拿到的就是最终代码
        compilation.hooks.processAssets.tap(
          { name: 'script_bundle', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT },
          () => {
            const source = compilation.getAsset(asset_name)?.source.source();
            if (source === undefined) {
              console.error(`${LOG_TAG} 没找到产物 '${asset_name}', 跳过生成可导入的 JSON`);
              return;
            }
            try {
              const { filename, text } = build_script_bundle(
                script_file,
                Buffer.isBuffer(source) ? source.toString('utf-8') : source,
              );
              compilation.emitAsset(filename, new webpack.sources.RawSource(text));
              const file_path = path.join(compiler.outputPath, filename);
              console.info(`${LOG_TAG} 已生成可导入的 '${path.relative(import.meta.dirname, file_path)}'`);
            } catch (error) {
              console.error(
                `${LOG_TAG} 生成可导入的 JSON 失败: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        );
      });
    },
  };
}
