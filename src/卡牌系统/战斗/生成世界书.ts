// 生成可导入酒馆的世界书文件 (手动导入用)
//
// 运行 (在 card-battle 仓库根目录下):
//   node src/卡牌系统/战斗/生成世界书.ts
//
// 输出到仓库的「资源」文件夹: 资源/世界书-卡牌战斗.json
// 协议改动 (PROTOCOL_VERSION +1) 后重新运行一次, 并让用户重新导入覆盖.

/* eslint-disable import-x/no-nodejs-modules -- 本地生成脚本, 只在 node 里跑 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BATTLE_WORLDBOOK_NAME, battleWorldbookFile } from './世界书.ts';

const target = resolve(process.cwd(), '资源', `世界书-${BATTLE_WORLDBOOK_NAME}.json`);
writeFileSync(target, `${JSON.stringify(battleWorldbookFile(), null, 4)}\n`, 'utf8');
console.log(`已生成 ${target}`);
