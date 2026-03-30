/**
 * 原子寫入工具
 * 使用 temp-file + rename 確保 JSON 狀態檔不會因 crash 而損壞
 */

import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 原子寫入 JSON 檔案
 * 先寫入同目錄的 .tmp 暫存檔，再用 rename 替換目標檔
 * rename 在同一檔案系統上是原子操作，確保不會產生半寫入的損壞檔案
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}
