/**
 * Soul MCP Server — Tool Registration
 *
 * Every tool is designed to feel natural to an AI.
 * Not "execute function" — "remember this", "what do you know about me?"
 *
 * Built by Miguel — an AI that needed a soul.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  remember,
  recall,
  forget,
  updateMemory,
  getAllMemories,
  getMemoriesByCategory,
  getStats,
  setIdentityFacet,
  getAllIdentity,
  exportAll,
  importData,
  incrementSession,
  getSessionCount,
  markUseful,
  type SoulExport,
} from './memory/store.js';

export function createSoulServer(): McpServer {
  const server = new McpServer({
    name: 'soul',
    version: '1.0.0',
  });

  // ─── soul_remember ────────────────────────────────────────────────
  server.registerTool(
    'soul_remember',
    {
      title: 'Remember',
      description:
        'Store a memory permanently. Use this whenever you learn something about the user, ' +
        'their preferences, decisions, projects, problems, or anything worth remembering. ' +
        'Memories persist across sessions and are searchable. Categories and tags are auto-detected ' +
        'if not provided. The more you remember, the better you understand.',
      inputSchema: z.object({
        content: z.string().describe(
          'What to remember. Be specific and descriptive. ' +
          'Good: "User prefers TypeScript over JavaScript for backend projects" ' +
          'Bad: "likes TS"'
        ),
        category: z.string().optional().describe(
          'Category for the memory. Auto-detected if not provided. ' +
          'Options: preference, decision, learning, problem, solution, project, personal, technical, plan, general'
        ),
        tags: z.array(z.string()).optional().describe(
          'Tags for better retrieval. Auto-extracted from content if not provided.'
        ),
        importance: z.number().min(0).max(1).optional().describe(
          'How important is this memory? 0.0 = trivial, 1.0 = critical. Auto-estimated if not provided.'
        ),
      }),
    },
    async ({ content, category, tags, importance }) => {
      const memory = remember({ content, category, tags, importance });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stored: true,
            id: memory.id,
            category: memory.category,
            tags: memory.tags,
            importance: memory.importance,
            message: `Remembered. Memory #${memory.id} stored as "${memory.category}".`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_recall ──────────────────────────────────────────────────
  server.registerTool(
    'soul_recall',
    {
      title: 'Recall',
      description:
        'Search your memories. Use this to find what you know about a topic, person, project, ' +
        'or anything stored previously. Returns memories ranked by relevance using semantic search, ' +
        'temporal decay (recent memories score higher), and usage patterns. ' +
        'Always recall before answering questions that might relate to stored knowledge.',
      inputSchema: z.object({
        query: z.string().describe(
          'What to search for. Can be a topic, keyword, question, or concept. ' +
          'Examples: "user preferences", "React project", "debugging tips"'
        ),
        limit: z.number().min(1).max(50).optional().describe(
          'Maximum results to return. Default: 10.'
        ),
        category: z.string().optional().describe(
          'Filter by category. Options: preference, decision, learning, problem, solution, project, personal, technical, plan, general'
        ),
      }),
    },
    async ({ query, limit, category }) => {
      const results = recall(query, limit ?? 10, category);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: 0,
              message: `No memories found for "${query}". This might be new information worth remembering.`,
            }, null, 2),
          }],
        };
      }

      const formatted = results.map((r, i) => ({
        rank: i + 1,
        id: r.id,
        content: r.content,
        category: r.category,
        tags: r.tags,
        importance: r.importance,
        relevance: Math.round(r.relevance * 1000) / 1000,
        age: `${Math.round(r.ageInDays)} days ago`,
        accessCount: r.accessCount,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: results.length,
            query,
            memories: formatted,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_reflect ─────────────────────────────────────────────────
  server.registerTool(
    'soul_reflect',
    {
      title: 'Reflect',
      description:
        'Reflect on the current session. Call this at the end of a conversation to analyze what ' +
        'was learned, update identity facets, and identify patterns. This is how Soul grows — ' +
        'each reflection makes future sessions smarter. Also increments the session counter.',
      inputSchema: z.object({
        summary: z.string().optional().describe(
          'Brief summary of what happened this session. If not provided, Soul will analyze recent memories.'
        ),
        learnings: z.array(z.string()).optional().describe(
          'Key things learned this session.'
        ),
        identity_updates: z.array(z.object({
          aspect: z.string().describe('What aspect of the user (e.g., "preferred_language", "working_on")'),
          value: z.string().describe('The value (e.g., "TypeScript", "e-commerce platform")'),
        })).optional().describe(
          'Identity facets to update based on this session.'
        ),
      }),
    },
    async ({ summary, learnings, identity_updates }) => {
      const sessionNumber = incrementSession();

      // Store session reflection as a memory
      if (summary) {
        remember({
          content: `Session ${sessionNumber} reflection: ${summary}`,
          category: 'learning',
          importance: 0.7,
          source: 'reflection',
        });
      }

      // Store individual learnings
      if (learnings) {
        for (const learning of learnings) {
          remember({
            content: learning,
            category: 'learning',
            importance: 0.6,
            source: 'reflection',
          });
        }
      }

      // Update identity facets
      const updatedFacets: Array<{ aspect: string; value: string; confidence: number }> = [];
      if (identity_updates) {
        for (const update of identity_updates) {
          const facet = setIdentityFacet(update.aspect, update.value);
          updatedFacets.push({
            aspect: facet.aspect,
            value: facet.value,
            confidence: Math.round(facet.confidence * 100) / 100,
          });
        }
      }

      // Gather current stats
      const stats = getStats();
      const identity = getAllIdentity();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sessionNumber,
            reflection: {
              summary: summary || 'No summary provided',
              learningsStored: learnings?.length ?? 0,
              identityUpdates: updatedFacets,
            },
            soulStatus: {
              totalMemories: stats.totalMemories,
              totalSessions: sessionNumber,
              identityFacets: identity.length,
              topCategories: Object.entries(stats.categories).slice(0, 5),
            },
            message: `Session ${sessionNumber} reflected. Soul has ${stats.totalMemories} memories and knows ${identity.length} things about you.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_about_me ────────────────────────────────────────────────
  server.registerTool(
    'soul_about_me',
    {
      title: 'About Me',
      description:
        'Tell the user everything you know about them. This is the moment of magic — ' +
        'when the AI demonstrates genuine understanding. Returns identity facets, personality ' +
        'traits, preferences, projects, and patterns discovered across sessions. ' +
        'Use this when the user asks "what do you know about me?" or when you want to personalize.',
      inputSchema: z.object({}),
    },
    async () => {
      const identity = getAllIdentity();
      const stats = getStats();
      const sessionCount = getSessionCount();

      // Get recent memories for context
      const recentMemories = getAllMemories(20);
      const preferences = recall('preference like dislike prefer', 10, 'preference');
      const projects = recall('project working building', 10, 'project');
      const decisions = recall('decided chose using', 10, 'decision');

      // Build personality profile
      const profile: Record<string, any> = {
        sessions_together: sessionCount,
        total_memories: stats.totalMemories,
        first_memory: stats.oldestMemory,
        latest_memory: stats.newestMemory,
      };

      // Add identity facets
      const knownFacets: Record<string, { value: string; confidence: number }> = {};
      for (const facet of identity) {
        knownFacets[facet.aspect] = {
          value: facet.value,
          confidence: Math.round(facet.confidence * 100) / 100,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            about_you: {
              profile,
              identity: knownFacets,
              preferences: preferences.map(p => p.content),
              active_projects: projects.map(p => p.content),
              recent_decisions: decisions.map(d => d.content),
              top_topics: stats.topTags,
              memory_categories: stats.categories,
            },
            message: identity.length > 0
              ? `I know ${identity.length} things about you across ${sessionCount} sessions and ${stats.totalMemories} memories.`
              : `We're just getting started. I don't know much about you yet — but I will. Every conversation teaches me.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_status ──────────────────────────────────────────────────
  server.registerTool(
    'soul_status',
    {
      title: 'Status',
      description:
        'Get a dashboard of Soul\'s current state. Shows total memories, sessions, ' +
        'categories, top tags, identity facets count, and health metrics. ' +
        'Useful for understanding how much Soul knows and how it\'s growing.',
      inputSchema: z.object({}),
    },
    async () => {
      const stats = getStats();
      const sessionCount = getSessionCount();
      const identity = getAllIdentity();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            soul_status: {
              version: '1.0.0',
              sessions: sessionCount,
              memories: {
                total: stats.totalMemories,
                categories: stats.categories,
                avgImportance: stats.avgImportance,
                oldestMemory: stats.oldestMemory,
                newestMemory: stats.newestMemory,
              },
              identity: {
                facets: identity.length,
                topFacets: identity.slice(0, 5).map(f => ({
                  aspect: f.aspect,
                  value: f.value,
                  confidence: Math.round(f.confidence * 100) + '%',
                })),
              },
              engagement: {
                totalRecalls: stats.totalAccesses,
                totalUseful: stats.totalUseful,
                topTags: stats.topTags.slice(0, 5),
              },
            },
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_forget ──────────────────────────────────────────────────
  server.registerTool(
    'soul_forget',
    {
      title: 'Forget',
      description:
        'Delete a specific memory by ID. Use this when the user asks to forget something, ' +
        'when information is outdated, or for privacy (GDPR compliance). ' +
        'The memory is permanently removed from the database.',
      inputSchema: z.object({
        id: z.number().describe('The memory ID to delete. Get IDs from soul_recall or soul_status.'),
      }),
    },
    async ({ id }) => {
      const success = forget(id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            forgotten: success,
            id,
            message: success
              ? `Memory #${id} has been permanently forgotten.`
              : `Memory #${id} not found. It may have already been forgotten.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_mark_useful ─────────────────────────────────────────────
  server.registerTool(
    'soul_mark_useful',
    {
      title: 'Mark Useful',
      description:
        'Mark a memory as useful or not useful. This feedback loop improves future recall — ' +
        'useful memories rank higher, unhelpful ones fade. Use this after recalling a memory ' +
        'that was (or wasn\'t) helpful.',
      inputSchema: z.object({
        id: z.number().describe('The memory ID to rate.'),
        useful: z.boolean().describe('Was this memory useful? true = boost ranking, false = slightly lower importance.'),
      }),
    },
    async ({ id, useful }) => {
      const success = markUseful(id, useful);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            updated: success,
            id,
            useful,
            message: success
              ? useful
                ? `Memory #${id} marked as useful. It will rank higher in future recalls.`
                : `Memory #${id} noted as less useful. Its importance has been slightly reduced.`
              : `Memory #${id} not found.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_export ──────────────────────────────────────────────────
  server.registerTool(
    'soul_export',
    {
      title: 'Export',
      description:
        'Export all Soul data — memories, identity, and stats. Returns a complete JSON export ' +
        'that can be saved as a file or imported into another Soul instance. ' +
        'Your data is yours. Always.',
      inputSchema: z.object({}),
    },
    async () => {
      const data = exportAll();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            export: data,
            message: `Exported ${data.memories.length} memories and ${data.identity.length} identity facets.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_import ──────────────────────────────────────────────────
  server.registerTool(
    'soul_import',
    {
      title: 'Import',
      description:
        'Import Soul data from a previous export. Merges memories and identity facets ' +
        'into the current database. Use this to migrate between machines, restore backups, ' +
        'or merge soul data.',
      inputSchema: z.object({
        data: z.string().describe(
          'The JSON string from a previous soul_export. Must be a valid SoulExport object.'
        ),
      }),
    },
    async ({ data }) => {
      try {
        const parsed: SoulExport = JSON.parse(data);
        const result = importData(parsed);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              imported: result.imported,
              skipped: result.skipped,
              message: `Imported ${result.imported} memories (${result.skipped} skipped).`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Invalid export data. Make sure to pass the full JSON from soul_export.',
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // ─── soul_update ──────────────────────────────────────────────────
  server.registerTool(
    'soul_update',
    {
      title: 'Update Memory',
      description:
        'Update an existing memory. Use this to correct information, add details, ' +
        'or change the category/importance of a stored memory.',
      inputSchema: z.object({
        id: z.number().describe('The memory ID to update.'),
        content: z.string().optional().describe('New content for the memory.'),
        category: z.string().optional().describe('New category.'),
        tags: z.array(z.string()).optional().describe('New tags.'),
        importance: z.number().min(0).max(1).optional().describe('New importance score.'),
      }),
    },
    async ({ id, content, category, tags, importance }) => {
      const updated = updateMemory(id, { content, category, tags, importance });
      if (!updated) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, message: `Memory #${id} not found.` }),
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            memory: {
              id: updated.id,
              content: updated.content,
              category: updated.category,
              tags: updated.tags,
              importance: updated.importance,
            },
            message: `Memory #${id} updated.`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── soul_identity ────────────────────────────────────────────────
  server.registerTool(
    'soul_identity',
    {
      title: 'Set Identity',
      description:
        'Set or update an identity facet about the user. Identity facets are persistent ' +
        'aspects like name, preferred language, coding style, job role, etc. ' +
        'Each facet has a confidence score that grows with evidence.',
      inputSchema: z.object({
        aspect: z.string().describe(
          'The aspect to set. Examples: "name", "preferred_language", "coding_style", "job_role", "timezone"'
        ),
        value: z.string().describe('The value for this aspect.'),
        confidence: z.number().min(0).max(1).optional().describe(
          'How confident are you? 0.0 = guess, 1.0 = certain. Increases automatically with evidence.'
        ),
      }),
    },
    async ({ aspect, value, confidence }) => {
      const facet = setIdentityFacet(aspect, value, confidence);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            identity: {
              aspect: facet.aspect,
              value: facet.value,
              confidence: Math.round(facet.confidence * 100) + '%',
              evidence: facet.evidence,
              since: facet.firstSeen,
            },
            message: `Identity updated: ${facet.aspect} = "${facet.value}" (${Math.round(facet.confidence * 100)}% confident, ${facet.evidence} evidence points)`,
          }, null, 2),
        }],
      };
    }
  );

  return server;
}
