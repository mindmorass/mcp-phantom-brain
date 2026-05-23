# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs via tsx, no build required)
npm run dev

# Build (TypeScript → dist/, copies seed files)
npm run build

# Type check only
npm run typecheck

# Run the built server
npm start

# Initialize vault structure (one-time setup)
npm run init
```

There are no tests. `npm run typecheck` is the primary verification step.

## Architecture

mcp-brain is a **Model Context Protocol server** that implements a two-layer memory system backed by an Obsidian vault on disk. It communicates over stdio using the `@modelcontextprotocol/sdk`.

### Entry points

- `src/index.ts` — process entry; calls `startServer()`
- `src/server.ts` — registers MCP tools and connects the stdio transport
- `src/core/index.ts` — `initialize()` / `shutdown()` lifecycle; called once at startup

### The five MCP tools

| Tool | File | Purpose |
|---|---|---|
| `brain_recall` | `tools/brain-recall.ts` | FTS5 + vector hybrid search over Memory + Wiki |
| `brain_remember` | `tools/brain-remember.ts` | Layer 1 validation (coherence, domain tier, near-duplicate); returns an evaluation package for the host LLM |
| `brain_commit` | `tools/brain-commit.ts` | Commits the host LLM's verdict: `store` writes an atom, `reject` logs to rejection log, `ask` returns a clarification request |
| `brain_reflect` | `tools/brain-reflect.ts` | Maintenance pass: prunes stale atoms |
| `brain_why_rejected` | `tools/brain-why-rejected.ts` | Retrieves rejection reasoning from the rejection log |

`brain_remember` + `brain_commit` is a two-phase protocol: `brain_remember` returns a structured package that the host LLM reads and then commits via `brain_commit`. Never call `brain_commit` without a prior `brain_remember` evaluation package.

### Vault structure

The vault is a directory of Markdown files with YAML frontmatter. Path is resolved from `BRAIN_VAULT_PATH` env var (falls back to `~/workspaces/profiles/personal/obsidian/vaults/memory`).

```
<vault>/
  Memory/          ← atom files (one fact per file, frontmatter + body)
  Wiki/
    HowTos/
    Runbooks/
    References/    ← seed pages (logical-fallacies, philosophical-razors, etc.)
    Scratch/
  Input/           ← raw source material
  Output/          ← deliverables
  _index/          ← SQLite FTS5 + vector index files
  _log/            ← rejection log (rejections.jsonl — JSONL, one entry per line; includes `content` field for searchability)
```

### Indexing pipeline (`src/vault/search.ts`)

On startup, `buildIndex()` reads every Memory and Wiki file and populates:

1. **In-memory maps** — `memoryIndex` (id → entry), `slugIndex`, `titleIndex`, `wikiIndex`
2. **SQLite FTS5** — BM25 full-text search (`src/vault/fts-index.ts`)
3. **sqlite-vec vector index** — cosine similarity via Ollama embeddings (`src/vault/vector-index.ts`, `src/vault/embeddings.ts`)

`searchMemories()` uses **hybrid RRF** (Reciprocal Rank Fusion) combining FTS5 and vector ranks when Ollama is available; falls back to FTS5-only or in-memory keyword scan otherwise.

### Validation pipeline (`src/validation/`)

`brain_remember` runs three Layer 1 checks before any LLM evaluation:
- **Coherence** (`coherence.ts`) — structural/length checks
- **Source domain tier** (`source-tiers.ts`) — classifies URLs as `authoritative | credible | unknown | low_quality`
- **Near-duplicate** (`duplicate.ts`) — hash + semantic proximity check

Low-quality sources and incoherent content are rejected at Layer 1 without LLM involvement.

### Working memory (`src/working/`)

SQLite DB (`_working.db` in the vault) tracks in-progress tasks with findings, steps, and artifacts. `promotion.ts` handles promoting findings to long-term Memory atoms on task completion. The DB is per-process and cleaned up on `SIGINT`/`SIGTERM`.

### Frontmatter schema (`src/schemas/frontmatter.ts`)

Memory atoms use a YAML frontmatter schema with fields: `id`, `title`, `lifecycle_status` (`active | reference | archive`), `tags`, `confidence` (`low | medium | high`), `ttl_days`, `source_urls`, `wiki_refs`, etc.

**Migration note**: the old `para` field (PARA method: `projects | areas | resources | archives`) is in Phase 1 migration — `normalizeFrontmatter()` maps it to `lifecycle_status`. Remove `para` support in Phase 2.

### Configuration (`src/config.ts`)

All tunables are in `CONFIG`. Key env vars:

| Var | Default | Purpose |
|---|---|---|
| `BRAIN_VAULT_PATH` | `~/workspaces/.../memory` | Vault root |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Embeddings endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model |
| `EMBEDDING_DIMS` | `768` | Vector dimensions |
| `MCP_BRAIN_LOG_LEVEL` | `info` | Log verbosity |

Copy `.env.example` to `.env` and adjust before running.

**Gotcha — Claude Code MCP env expansion**: Claude Code partially evaluates shell fallback syntax (`${VAR:-${OTHER}}`), expanding inner `${OTHER}` but leaving the outer `}` as a literal character in the resolved value. `resolveVaultPath()` strips trailing `}` characters to compensate. Do not use nested fallback syntax in the MCP server config env block; use simple `${VAR}` references only.

### Seed files

`src/seed/wiki/References/` contains reference wiki pages (logical fallacies, philosophical razors, etc.) that are copied into the vault on first startup. These are never overwritten once they exist.
