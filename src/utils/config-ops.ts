/**
 * Config Operations — 統一 envelope 變更 helper
 *
 * Fix #4: 封裝 assertLockOwnership → saveSnapshot → bump configVersion → saveEnvelope 流程。
 *
 * 此模組獨立於 config-envelope.ts，以避免循環依賴：
 *   config-ops → config-envelope
 *   config-ops → config-history
 */

import { assertLockOwnership } from './global-lock.js';
import { getConfigEnvelope, saveConfigEnvelope, type ConfigEnvelope } from './config-envelope.js';
import { saveSnapshot } from './config-history.js';

/**
 * 統一 envelope 變更 helper
 *
 * 流程：
 * 1. assertLockOwnership（確認仍持有 lock）
 * 2. 讀取最新 envelope
 * 3. 儲存 pre-mutate 快照（crash safety）
 * 4. 執行 mutator
 * 5. Bump configVersion + 更新 updatedAt
 * 6. saveConfigEnvelope（含 assert）
 * 7. 儲存 post-mutate 快照
 *
 * @param fencingToken - 必須持有 global-lock 的 fencing token
 * @param mutator - 對 envelope 進行修改的函式
 * @param reason - 此次變更的說明（用於 snapshot）
 * @returns 更新後的 envelope
 */
export function mutateEnvelope(
  fencingToken: string,
  mutator: (env: ConfigEnvelope) => void,
  reason: string,
): ConfigEnvelope {
  // 1. 確認仍持有 lock
  assertLockOwnership(fencingToken);

  // 2. 讀取最新 envelope
  const envelope = getConfigEnvelope();
  const previousVersion = envelope.configVersion;

  // 3. 儲存 pre-mutate 快照（crash safety：若後續步驟 crash，snapshot 仍有記錄）
  saveSnapshot({
    configVersion: previousVersion,
    previousVersion: null, // ensureConsistency 會在啟動時補建 previousVersion
    timestamp: Date.now(),
    envelope: structuredClone(envelope),
    reason: `pre-mutate: ${reason}`,
    graduated: false,
  });

  // 4. 執行修改
  mutator(envelope);

  // 5. Bump configVersion + 更新 updatedAt
  envelope.configVersion = previousVersion + 1;
  envelope.updatedAt = Date.now();

  // 6. 儲存新 envelope（含 assertLockOwnership 二次確認）
  saveConfigEnvelope(envelope, fencingToken);

  // 7. 儲存新版本快照
  saveSnapshot({
    configVersion: envelope.configVersion,
    previousVersion: previousVersion,
    timestamp: Date.now(),
    envelope: structuredClone(envelope),
    reason,
    graduated: false,
  });

  return envelope;
}
