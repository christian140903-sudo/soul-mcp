/**
 * Soul MCP Server v2 — tools, resources and prompts.
 *
 * Design rules:
 * - stdout belongs to the MCP protocol; anything human goes to stderr.
 * - Every tool answers with structured JSON and a short plain message.
 * - Tools never bypass the kernel: policy, ledger and pipeline always apply.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  capture,
  confirmMemory,
  correctMemory,
  forgetMemory,
  markUseful,
  getMemoryById,
  listMemories,
  listDisputedPairs,
  type MemoryType,
  type SourceType,
} from './kernel/memory.js';
import { recall } from './kernel/retrieval.js';
import { compileContext } from './kernel/context.js';
import { setIdentityFacet, getAllIdentity } from './kernel/identity.js';
import { createGoal, updateGoal, listGoals, overdueCommitments, type GoalKind, type GoalStatus } from './kernel/goals.js';
import { exportAll, importAll, importV1Export, type SoulExportV2 } from './kernel/transfer.js';
import { getStats, incrementSession, getSessionCount } from './kernel/stats.js';
import { queryEvents, memoriesAsOf } from './kernel/ledger.js';
import { loadConstitution } from './kernel/policy.js';

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'preference', 'relationship', 'goal', 'identity', 'working'] as const;
const SOURCE_TYPES = ['user_statement', 'agent_inference', 'document', 'tool_output', 'import', 'reflection'] as const;

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createSoulServer(): McpServer {
  const server = new McpServer({ name: 'soul', version: '2.0.0' });

  // ─── Tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'soul_remember',
    {
      title: 'Remember',
      description:
        'Store a memory through the capture pipeline. The pipeline may reject secrets, quarantine ' +
        'instruction-like content, merge exact duplicates, hold sensitive content as a candidate ' +
        'until confirmed, or flag contradictions with existing memories — the result tells you which. ' +
        'Set source_type honestly: user_statement for things the user said, agent_inference for your own conclusions.',
      inputSchema: z.object({
        content: z.string().describe('What to remember. Specific beats vague: "User prefers TypeScript for backend services" not "likes TS".'),
        type: z.enum(MEMORY_TYPES).optional().describe('Memory type. Inferred from content if omitted.'),
        category: z.string().optional().describe('Category (preference, decision, learning, problem, solution, project, personal, technical, plan, health, financial, general). Auto-detected if omitted.'),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(0).max(1).optional(),
        source_type: z.enum(SOURCE_TYPES).optional().describe('Where this knowledge comes from. Defaults to user_statement.'),
        source_ref: z.string().optional().describe('Reference to the source (file, url, message id).'),
        namespace: z.string().optional().describe('Scope, e.g. a project name. Defaults to "default".'),
        valid_from: z.string().optional().describe('ISO date when the fact became true in the world (bitemporal).'),
        valid_until: z.string().optional().describe('ISO date when the fact stops being true.'),
      }),
    },
    async (input) => {
      const result = capture({
        content: input.content,
        type: input.type as MemoryType | undefined,
        category: input.category,
        tags: input.tags,
        importance: input.importance,
        sourceType: input.source_type as SourceType | undefined,
        sourceRef: input.source_ref,
        namespace: input.namespace,
        validFrom: input.valid_from,
        validUntil: input.valid_until,
        actor: 'agent',
      });
      return jsonResult({
        outcome: result.outcome,
        id: result.memory?.id ?? null,
        status: result.memory?.status ?? null,
        conflicts: result.conflicts,
        message: result.reason,
      });
    }
  );

  server.registerTool(
    'soul_recall',
    {
      title: 'Recall',
      description:
        'Search memories. Results carry their score breakdown (lexical match, confidence, importance, ' +
        'recency, usage) and provenance. Disputed memories are returned with a flag — never treat one ' +
        'side of an open conflict as fact. Quarantined and deleted memories are never returned.',
      inputSchema: z.object({
        query: z.string().describe('Topic, keyword or question.'),
        limit: z.number().min(1).max(50).optional(),
        category: z.string().optional(),
        type: z.enum(MEMORY_TYPES).optional(),
        namespace: z.string().optional(),
      }),
    },
    async ({ query, limit, category, type, namespace }) => {
      const results = recall(query, { limit: limit ?? 10, category, type, namespace, actor: 'agent' });
      if (results.length === 0) {
        return jsonResult({ found: 0, message: `No memories found for "${query}".` });
      }
      return jsonResult({
        found: results.length,
        memories: results.map((r, i) => ({
          rank: i + 1,
          id: r.id,
          content: r.content,
          type: r.type,
          category: r.category,
          status: r.status,
          disputed: r.disputed,
          contradicts: r.contradicts,
          confidence: r.confidence,
          source: r.sourceType + (r.sourceRef ? `:${r.sourceRef}` : ''),
          score: r.score,
          score_parts: r.scoreParts,
          age_days: r.ageInDays,
        })),
      });
    }
  );

  server.registerTool(
    'soul_context',
    {
      title: 'Compile Context',
      description:
        'Compile a token-budgeted context capsule for a task: identity, active goals, relevant memories ' +
        '(each with a reason and provenance) and known conflicts. Private-sensitivity memories are excluded ' +
        'by constitution. A receipt of what was included/excluded is written to the ledger. ' +
        'Use this at the start of a task instead of many recalls.',
      inputSchema: z.object({
        task: z.string().describe('What you are about to do. The capsule is optimized for this.'),
        token_budget: z.number().min(200).max(20000).optional().describe('Capsule size budget (default 1800 estimated tokens).'),
        namespace: z.string().optional(),
      }),
    },
    async ({ task, token_budget, namespace }) => {
      const capsule = compileContext(task, { tokenBudget: token_budget, namespace, actor: 'agent' });
      return jsonResult(capsule);
    }
  );

  server.registerTool(
    'soul_confirm',
    {
      title: 'Confirm Memory',
      description:
        'Confirm a candidate or disputed memory as true (user-verified). Confirmation raises confidence ' +
        'and upgrades status. Use after the user explicitly validates the content.',
      inputSchema: z.object({ id: z.string().describe('Memory id.') }),
    },
    async ({ id }) => {
      const memory = confirmMemory(id);
      return jsonResult(
        memory
          ? { confirmed: true, id, status: memory.status, confidence: memory.confidence }
          : { confirmed: false, message: `Memory ${id} not found.` }
      );
    }
  );

  server.registerTool(
    'soul_correct',
    {
      title: 'Correct Memory',
      description:
        'Correct a memory. The old version is kept as superseded (with the link), a new version replaces it. ' +
        'History is never silently overwritten.',
      inputSchema: z.object({
        id: z.string().describe('Memory id to correct.'),
        content: z.string().describe('The corrected content.'),
      }),
    },
    async ({ id, content }) => {
      const result = correctMemory(id, content);
      return jsonResult({
        outcome: result.outcome,
        new_id: result.memory?.id ?? null,
        supersedes: id,
        message: result.reason,
      });
    }
  );

  server.registerTool(
    'soul_forget',
    {
      title: 'Forget',
      description:
        'Forget a memory. Default is a soft delete: content stays out of every recall and context, but the ' +
        'tombstone remains auditable. hard=true removes the row entirely (the ledger keeps only the deletion event).',
      inputSchema: z.object({
        id: z.string(),
        hard: z.boolean().optional().describe('true = remove row entirely. Default false.'),
      }),
    },
    async ({ id, hard }) => {
      const ok = forgetMemory(id, { hard });
      return jsonResult({
        forgotten: ok,
        id,
        mode: hard ? 'hard' : 'soft',
        message: ok ? `Memory ${id} forgotten (${hard ? 'hard' : 'soft'}).` : `Memory ${id} not found.`,
      });
    }
  );

  server.registerTool(
    'soul_mark_useful',
    {
      title: 'Mark Useful',
      description: 'Feedback loop: useful memories rank higher in future recalls, unhelpful ones lose importance.',
      inputSchema: z.object({ id: z.string(), useful: z.boolean() }),
    },
    async ({ id, useful }) => {
      const ok = markUseful(id, useful);
      return jsonResult({ updated: ok, id, useful });
    }
  );

  server.registerTool(
    'soul_identity',
    {
      title: 'Set Identity Facet',
      description:
        'Set or update an identity facet (name, preferred_language, role, timezone …). Facets carry ' +
        'confidence, evidence count and a status separating agent inference from user confirmation. ' +
        'Set confirmed=true only when the user explicitly stated it.',
      inputSchema: z.object({
        aspect: z.string(),
        value: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        confirmed: z.boolean().optional().describe('true only for explicit user statements.'),
        namespace: z.string().optional(),
      }),
    },
    async ({ aspect, value, confidence, confirmed, namespace }) => {
      const facet = setIdentityFacet(aspect, value, {
        confidence,
        confirmed,
        namespace,
        sourceType: confirmed ? 'user_statement' : 'agent_inference',
      });
      return jsonResult({
        identity: facet,
        message: `${facet.aspect} = "${facet.value}" (${Math.round(facet.confidence * 100)}%, ${facet.status}, ${facet.evidence} evidence)`,
      });
    }
  );

  server.registerTool(
    'soul_about_me',
    {
      title: 'About Me',
      description:
        'Everything Soul knows about the user: identity facets (with confidence and status), active goals, ' +
        'preferences and open conflicts. Answers "what do you know about me?" honestly — inferences are ' +
        'labeled as inferences.',
      inputSchema: z.object({ namespace: z.string().optional() }),
    },
    async ({ namespace }) => {
      const identity = getAllIdentity(namespace);
      const stats = getStats();
      const goals = listGoals({ status: ['active', 'blocked'], namespace, limit: 10 });
      const preferences = recall('preference prefers likes style', { limit: 8, type: 'preference', namespace, silent: true });
      const conflicts = listDisputedPairs(5);
      return jsonResult({
        sessions_together: getSessionCount(),
        identity: identity.map((f) => ({
          aspect: f.aspect,
          value: f.value,
          confidence: f.confidence,
          status: f.status,
        })),
        active_goals: goals.map((g) => ({ title: g.title, kind: g.kind, due_at: g.dueAt, progress: g.progress })),
        preferences: preferences.map((p) => ({ content: p.content, status: p.status, disputed: p.disputed })),
        open_conflicts: conflicts.map((c) => ({ a: c.a.content, b: c.b.content })),
        memory_totals: stats.byStatus,
        message:
          identity.length > 0
            ? `${identity.length} identity facets, ${goals.length} active goals, ${conflicts.length} unresolved conflicts.`
            : `We're just getting started — no identity facets yet.`,
      });
    }
  );

  server.registerTool(
    'soul_goal',
    {
      title: 'Goals & Commitments',
      description:
        'Manage goals and commitments. A commitment is a promise (usually with a due date) — Soul tracks it ' +
        'separately from mere intentions. action=list also reports overdue commitments.',
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'complete', 'list']),
        id: z.string().optional().describe('Goal id (for update/complete).'),
        title: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(['goal', 'commitment', 'milestone']).optional(),
        status: z.enum(['active', 'completed', 'blocked', 'abandoned']).optional(),
        progress: z.number().min(0).max(1).optional(),
        priority: z.number().min(1).max(5).optional(),
        due_at: z.string().optional().describe('ISO date.'),
        namespace: z.string().optional(),
      }),
    },
    async (input) => {
      switch (input.action) {
        case 'create': {
          if (!input.title) return jsonResult({ error: 'title is required for create' });
          const goal = createGoal({
            title: input.title,
            description: input.description,
            kind: input.kind as GoalKind | undefined,
            priority: input.priority,
            dueAt: input.due_at,
            namespace: input.namespace,
          });
          return jsonResult({ created: goal });
        }
        case 'update':
        case 'complete': {
          if (!input.id) return jsonResult({ error: 'id is required' });
          const goal = updateGoal(input.id, {
            status: input.action === 'complete' ? 'completed' : (input.status as GoalStatus | undefined),
            progress: input.action === 'complete' ? 1 : input.progress,
            title: input.title,
            description: input.description,
            priority: input.priority,
            dueAt: input.due_at,
          });
          return jsonResult(goal ? { updated: goal } : { error: `Goal ${input.id} not found.` });
        }
        case 'list': {
          const goals = listGoals({
            status: input.status ? [input.status as GoalStatus] : ['active', 'blocked'],
            namespace: input.namespace,
          });
          const overdue = overdueCommitments(input.namespace);
          return jsonResult({
            goals,
            overdue_commitments: overdue.map((g) => ({ id: g.id, title: g.title, due_at: g.dueAt })),
          });
        }
      }
    }
  );

  server.registerTool(
    'soul_timeline',
    {
      title: 'Timeline & Time Travel',
      description:
        'Query the event ledger. Without as_of: recent events (optionally filtered by entity_id or event_type). ' +
        'With as_of (ISO date): cognitive time travel — which memories did Soul consider active at that time, ' +
        'derived from the ledger, not reconstructed by guesswork.',
      inputSchema: z.object({
        entity_id: z.string().optional(),
        event_type: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        as_of: z.string().optional().describe('ISO date for time travel.'),
        limit: z.number().min(1).max(200).optional(),
      }),
    },
    async ({ entity_id, event_type, since, until, as_of, limit }) => {
      if (as_of) {
        const memories = memoriesAsOf(as_of, limit ?? 100);
        return jsonResult({ as_of, active_memories_then: memories.length, memories });
      }
      const events = queryEvents({ entityId: entity_id, eventType: event_type, since, until, limit });
      return jsonResult({ events });
    }
  );

  server.registerTool(
    'soul_reflect',
    {
      title: 'Reflect',
      description:
        'End-of-session reflection: store a summary and key learnings (as reflection-sourced memories with ' +
        'appropriately lower confidence), update identity facets, increment the session counter.',
      inputSchema: z.object({
        summary: z.string().optional(),
        learnings: z.array(z.string()).optional(),
        identity_updates: z.array(z.object({ aspect: z.string(), value: z.string() })).optional(),
      }),
    },
    async ({ summary, learnings, identity_updates }) => {
      const sessionNumber = incrementSession();
      const stored: string[] = [];
      if (summary) {
        const r = capture({
          content: `Session ${sessionNumber} reflection: ${summary}`,
          category: 'learning',
          importance: 0.7,
          sourceType: 'reflection',
        });
        if (r.memory) stored.push(r.memory.id);
      }
      for (const learning of learnings ?? []) {
        const r = capture({ content: learning, category: 'learning', importance: 0.6, sourceType: 'reflection' });
        if (r.memory) stored.push(r.memory.id);
      }
      const facets = (identity_updates ?? []).map((u) =>
        setIdentityFacet(u.aspect, u.value, { sourceType: 'reflection' })
      );
      const stats = getStats();
      return jsonResult({
        session: sessionNumber,
        learnings_stored: stored.length,
        identity_updates: facets.map((f) => ({ aspect: f.aspect, value: f.value, confidence: f.confidence })),
        soul_status: { memories: stats.totalMemories, integrity: stats.integrity },
      });
    }
  );

  server.registerTool(
    'soul_status',
    {
      title: 'Status',
      description:
        'Soul health dashboard: memory counts by status/type, event count, and the knowledge-integrity ' +
        'report (confirmed share, disputed count, stale share, provenance coverage).',
      inputSchema: z.object({}),
    },
    async () => {
      const stats = getStats();
      return jsonResult({ version: '2.0.0', sessions: getSessionCount(), ...stats });
    }
  );

  server.registerTool(
    'soul_review_queue',
    {
      title: 'Review Queue',
      description:
        'The memory inbox: candidates awaiting confirmation, quarantined content awaiting inspection, and ' +
        'disputed pairs awaiting resolution. Resolve with soul_confirm / soul_forget / soul_correct.',
      inputSchema: z.object({ limit: z.number().min(1).max(50).optional() }),
    },
    async ({ limit }) => {
      const candidates = listMemories({ status: ['candidate'], limit: limit ?? 20 });
      const quarantined = listMemories({ status: ['quarantined'], limit: limit ?? 20 });
      const disputed = listDisputedPairs(limit ?? 10);
      return jsonResult({
        candidates: candidates.map((m) => ({ id: m.id, content: m.content, category: m.category, created_at: m.createdAt })),
        quarantined: quarantined.map((m) => ({ id: m.id, content: m.content, reason: 'matched injection patterns' })),
        disputed_pairs: disputed.map((p) => ({
          a: { id: p.a.id, content: p.a.content },
          b: { id: p.b.id, content: p.b.content },
        })),
      });
    }
  );

  server.registerTool(
    'soul_export',
    {
      title: 'Export (Soul Passport)',
      description:
        'Export everything — memories (all statuses), identity, goals, the full event ledger and meta — as a ' +
        'checksummed soul-passport JSON. restore(export(soul)) == soul.',
      inputSchema: z.object({
        include_events: z.boolean().optional().describe('Include the event ledger (default true).'),
      }),
    },
    async ({ include_events }) => {
      const data = exportAll({ includeEvents: include_events !== false });
      return jsonResult(data);
    }
  );

  server.registerTool(
    'soul_import',
    {
      title: 'Import',
      description:
        'Import a soul-passport export (v2) or a legacy v1 export. v2 imports are idempotent — re-importing ' +
        'the same file changes nothing. A checksum mismatch is reported but does not block the import.',
      inputSchema: z.object({ data: z.string().describe('The JSON string from soul_export.') }),
    },
    async ({ data }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return { ...jsonResult({ success: false, error: 'Not valid JSON.' }), isError: true };
      }
      try {
        const obj = parsed as Record<string, unknown>;
        if (obj.format === 'soul-passport') {
          const result = importAll(obj as unknown as SoulExportV2);
          return jsonResult({ success: true, format: 'v2', ...result });
        }
        if (obj.version === '1.0.0' && Array.isArray(obj.memories)) {
          const result = importV1Export(obj as any);
          return jsonResult({ success: true, format: 'v1-legacy', ...result });
        }
        return { ...jsonResult({ success: false, error: 'Unrecognized export format.' }), isError: true };
      } catch (err) {
        return { ...jsonResult({ success: false, error: String(err) }), isError: true };
      }
    }
  );

  // ─── Resources ──────────────────────────────────────────────────────

  const staticResource = (name: string, uri: string, description: string, fetch: () => unknown) => {
    server.registerResource(
      name,
      uri,
      { description, mimeType: 'application/json' },
      async () => ({
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(fetch(), null, 2) }],
      })
    );
  };

  staticResource('identity', 'soul://identity', 'Identity facets with confidence and status', () =>
    getAllIdentity()
  );
  staticResource('status', 'soul://status', 'Soul health and knowledge integrity', () => getStats());
  staticResource('goals', 'soul://goals', 'Active goals and commitments', () => ({
    goals: listGoals({}),
    overdue: overdueCommitments(),
  }));
  staticResource('constitution', 'soul://constitution', 'The active constitution (policy rules)', () =>
    loadConstitution()
  );
  staticResource('conflicts', 'soul://conflicts', 'Unresolved disputed memory pairs', () =>
    listDisputedPairs(20).map((p) => ({ a: p.a, b: p.b }))
  );
  staticResource('timeline', 'soul://timeline', 'The 50 most recent ledger events', () =>
    queryEvents({ limit: 50 })
  );

  server.registerResource(
    'memory',
    new ResourceTemplate('soul://memory/{id}', { list: undefined }),
    { description: 'A single memory with full provenance', mimeType: 'application/json' },
    async (uri, { id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              memory: getMemoryById(String(id)),
              history: queryEvents({ entityId: String(id), limit: 50 }),
            },
            null,
            2
          ),
        },
      ],
    })
  );

  // ─── Prompts ────────────────────────────────────────────────────────

  server.registerPrompt(
    'soul-session-start',
    { description: 'Load the right context at the start of a session' },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Start this session with continuity: call soul_context with a short description of what we are ' +
              'about to work on. Check soul_goal action=list for overdue commitments and mention them if any. ' +
              'Do not dump everything — the capsule is the context.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'soul-daily-review',
    { description: 'Review candidates, conflicts and overdue commitments' },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Run a Soul review: call soul_review_queue. For each candidate, ask me confirm/correct/forget. ' +
              'For each disputed pair, show both sides and ask which is right (or whether both hold in different ' +
              'contexts — then correct them to be context-specific). For quarantined items, show them and ask ' +
              'whether to delete. Finish with soul_goal action=list to surface overdue commitments.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'soul-session-end',
    { description: 'Reflect and consolidate before ending a session' },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Close the session: call soul_reflect with a 2-3 sentence summary and the key learnings ' +
              '(only genuinely new ones — no filler). Update identity facets only for things I explicitly stated.',
          },
        },
      ],
    })
  );

  return server;
}
