/**
 * brain_synthesize — Phase 0 synthesis worker.
 *
 * Claims one item from the queue, reads its raw content, writes a stub
 * summary page under Wiki/summaries/, appends a synthesis log line, and
 * records Raw -> Wiki mapping in provenance.json. Phase 2 will replace
 * the stub body with real extraction + gate verdicts.
 *
 * Failure handling: any error after a successful claim unclaims the item
 * so it stays in the pending queue for the next run.
 */
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CONFIG } from '../config.js';
import { writeAtomicFile, withFileLock } from '../vault/filesystem.js';
import { slugFromTitle } from '../vault/naming.js';
import {
  claimNextItem,
  markDone,
  unclaimItem,
} from '../vault/queue.js';
import {
  readProvenance,
  writeProvenance,
  type ProvenanceEntry,
} from '../vault/provenance.js';
import { indexWikiEntry } from '../vault/search.js';
import { nowISO } from '../shared/utils.js';
import { logger } from '../shared/logger.js';
import { formatError } from '../shared/errors.js';

export const BrainSynthesizeSchema = z.object({}).strict();

export const brainSynthesizeToolDefinition = {
  name: 'brain_synthesize',
  description:
    'Process the next queued item from brain_learn. Reads the raw document, writes a summary ' +
    'page to Wiki/summaries/, appends a line to Wiki/_log.md, and records the Raw -> Wiki ' +
    'mapping in _index/provenance.json. Phase 0 writes a stub summary; full extraction lands ' +
    'in Phase 2.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};

const STUB_BODY_LIMIT = 2000;

async function nextAvailableSummaryPath(slug: string): Promise<{ relPath: string; absPath: string; finalSlug: string }> {
  const summariesDir = path.join(CONFIG.VAULT_PATH, CONFIG.WIKI_FOLDER, CONFIG.WIKI_SUMMARIES);
  let candidate = slug;
  let counter = 2;
  while (true) {
    const absPath = path.join(summariesDir, `${candidate}.md`);
    try {
      await fs.stat(absPath);
      candidate = `${slug}-${counter}`;
      counter++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const relPath = path.posix.join(CONFIG.WIKI_FOLDER, CONFIG.WIKI_SUMMARIES, `${candidate}.md`);
        return { relPath, absPath, finalSlug: candidate };
      }
      throw err;
    }
  }
}

function buildSummaryPage(opts: {
  title: string;
  rawPath: string;
  sourceUrl?: string;
  capturedAt: string;
  synthesizedAt: string;
  body: string;
}): string {
  const { title, rawPath, sourceUrl, capturedAt, synthesizedAt, body } = opts;
  const escapedTitle = title.replace(/"/g, '\\"');
  const sourceUrlLine = sourceUrl ? `source_url: "${sourceUrl}"\n` : '';
  const truncated = body.slice(0, STUB_BODY_LIMIT);
  const truncatedNote = body.length > STUB_BODY_LIMIT ? '\n\n<!-- Body truncated at 2000 chars for Phase 0 stub -->' : '';
  return (
    `---\n` +
    `title: "${escapedTitle}"\n` +
    `kind: summary\n` +
    `source: "${rawPath}"\n` +
    sourceUrlLine +
    `captured_at: "${capturedAt}"\n` +
    `synthesized_at: "${synthesizedAt}"\n` +
    `reliability: pending\n` +
    `tags: []\n` +
    `---\n\n` +
    `${truncated}${truncatedNote}\n\n` +
    `<!-- Full extraction: Phase 2 -->\n`
  );
}

export async function runBrainSynthesize(_input: z.infer<typeof BrainSynthesizeSchema>) {
  const claim = await claimNextItem();
  if (!claim) {
    return {
      status: 'empty' as const,
      message: 'Queue is empty. Nothing to synthesize.',
    };
  }

  const [claimedPath, item] = claim;

  try {
    // Read raw content from vault
    const rawAbsPath = path.join(CONFIG.VAULT_PATH, item.raw_path);
    const rawContent = await fs.readFile(rawAbsPath, 'utf-8');

    const synthesizedAt = nowISO();
    const { relPath: summaryRel, absPath: summaryAbs, finalSlug } = await nextAvailableSummaryPath(slugFromTitle(item.title));

    // Write summary page
    const page = buildSummaryPage({
      title: item.title,
      rawPath: item.raw_path,
      ...(item.source_url !== undefined && { sourceUrl: item.source_url }),
      capturedAt: item.captured_at,
      synthesizedAt,
      body: rawContent,
    });
    await writeAtomicFile(summaryAbs, page);

    // Append to Wiki/_log.md (append-only, serialized via lock)
    const logPath = path.join(CONFIG.VAULT_PATH, CONFIG.WIKI_FOLDER, CONFIG.WIKI_LOG_FILE);
    const logLine =
      `\n## ${synthesizedAt} — ${item.title}\n` +
      `- Source: ${item.raw_path}\n` +
      `- Summary: ${summaryRel}\n` +
      `- Gate: pending (Phase 2 not yet implemented)\n`;
    await withFileLock(logPath, async () => {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, logLine, 'utf-8');
    });

    // Update provenance.json
    const provenance = await readProvenance();
    const entry: ProvenanceEntry = {
      wiki_pages: [summaryRel],
      synthesized_at: synthesizedAt,
      reliability: 'pending',
      content_hash: item.content_hash,
    };
    provenance[item.raw_path] = entry;
    await writeProvenance(provenance);

    // Done — move the queue item to done/
    await markDone(claimedPath);

    // Index the new summary page so brain_recall sees it without a full rebuild.
    // relPath for the wiki index is relative to Wiki/, not the vault root.
    const wikiRelPath = path.posix.join(CONFIG.WIKI_SUMMARIES, `${finalSlug}.md`);
    indexWikiEntry(wikiRelPath, item.title, 'summary', [], rawContent.slice(0, STUB_BODY_LIMIT), synthesizedAt, synthesizedAt);

    logger.info('brain_synthesize processed item', {
      raw_path: item.raw_path,
      summary: summaryRel,
    });

    return {
      status: 'synthesized' as const,
      raw_path: item.raw_path,
      summary_path: summaryRel,
      synthesized_at: synthesizedAt,
      message: `Synthesized ${item.raw_path} -> ${summaryRel}. Phase 0 stub — Phase 2 will add extraction + gate.`,
    };
  } catch (err) {
    // Restore the queue item so the next call can retry.
    try {
      await unclaimItem(claimedPath);
    } catch (unclaimErr) {
      logger.error('Failed to unclaim queue item after synthesis error', {
        claimedPath,
        error: String(unclaimErr),
      });
    }
    throw err;
  }
}

export async function handleBrainSynthesize(args: unknown): Promise<CallToolResult> {
  try {
    const input = BrainSynthesizeSchema.parse(args);
    const result = await runBrainSynthesize(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    logger.error('brain_synthesize failed', { error: String(err) });
    return {
      content: [{ type: 'text', text: `Error in brain_synthesize: ${formatError(err)}` }],
      isError: true,
    };
  }
}
