/**
 * 数据体积的量法 (纯函数, 便于 node 测试).
 *
 * 酒馆会把变量整份序列化后写进聊天文件, 所以「占了多少」的真实代价是 **UTF-8 字节数**:
 * 一个汉字占 3 字节, 拿字符数当单位会低估两三倍.
 *
 * 界面上一律用二进制单位 (B / KiB / MiB) —— 和文件大小同一个读法, 用户不用心算换算.
 */

/** 复用同一个编码器 (量卡牌库时要调上千次) */
const ENCODER = new TextEncoder();

/** 一段数据的 JSON 体积 (UTF-8 字节数; 序列化失败返回 0) */
export function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : ENCODER.encode(text).length;
  } catch {
    return 0;
  }
}

/** 把字节数说成人话 (B / KiB / MiB) */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
