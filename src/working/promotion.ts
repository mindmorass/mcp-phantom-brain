import { appendToLog } from '../vault/filesystem.js';
import type { Finding, TaskState } from './db.js';
import { logger } from '../shared/logger.js';

/**
 * Phase 0 stub: logs findings rather than promoting to Memory/ atoms.
 * Full promotion (via brain_synthesize with source:"working_memory") is Phase 5.
 */
export async function promoteTaskToVault(state: TaskState): Promise<{ created: number; appended: number; skipped: number }> {
  const counts = { created: 0, appended: 0, skipped: 0 };

  for (const finding of state.findings as Finding[]) {
    if (finding.importance === 'low') {
      counts.skipped++;
      continue;
    }
    await appendToLog(`task-finding [${finding.memory_type ?? 'episodic'}]: ${finding.content.slice(0, 120)}`);
    counts.created++;
  }

  logger.info('Task promotion logged (Phase 0 stub — full promotion is Phase 5)', {
    task_id: state.task.task_id,
    ...counts,
  });

  return counts;
}
