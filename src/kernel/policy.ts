/**
 * Soul Constitution: user-defined rules, enforced deterministically in code.
 * Not a prompt, not a suggestion — every write and every recall passes
 * through these checks.
 *
 * Lives at ~/.soul/constitution.json. Created with safe defaults on init.
 */

import { join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { getSoulDir } from './db.js';

export type StoreRule = 'auto' | 'confirm' | 'never';
export type Sensitivity = 'public' | 'personal' | 'private';

export interface Constitution {
  version: number;
  store: {
    /** rule per memory category; 'default' applies when no category rule matches */
    [category: string]: StoreRule;
  };
  retention: {
    /** how long candidates wait for confirmation before expiring, e.g. "30d" */
    candidate: string;
  };
  recall: {
    /** statuses a normal recall may return */
    include_status: string[];
    /** sensitivity levels excluded from compiled context by default */
    exclude_sensitivity_from_context: Sensitivity[];
  };
}

export const DEFAULT_CONSTITUTION: Constitution = {
  version: 1,
  store: {
    default: 'auto',
    health: 'confirm',
    financial: 'confirm',
    secrets: 'never',
  },
  retention: {
    candidate: '30d',
  },
  recall: {
    include_status: ['active', 'confirmed', 'disputed'],
    exclude_sensitivity_from_context: ['private'],
  },
};

let _cached: Constitution | null = null;

export function constitutionPath(): string {
  return join(getSoulDir(), 'constitution.json');
}

export function loadConstitution(): Constitution {
  const cached = _cached;
  if (cached) return cached;
  const path = constitutionPath();
  let loaded: Constitution;
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONSTITUTION, null, 2));
    loaded = DEFAULT_CONSTITUTION;
  } else {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      loaded = { ...DEFAULT_CONSTITUTION, ...parsed, store: { ...DEFAULT_CONSTITUTION.store, ...(parsed.store || {}) } };
    } catch {
      // A corrupt constitution must not silently weaken policy: fall back to defaults.
      loaded = DEFAULT_CONSTITUTION;
    }
  }
  _cached = loaded;
  return loaded;
}

export function resetConstitutionCache(): void {
  _cached = null;
}

export function storeRuleFor(category: string): StoreRule {
  const c = loadConstitution();
  return c.store[category] || c.store['default'] || 'auto';
}

// ─── Deterministic content checks ────────────────────────────────────

/** Secrets that must never be stored. Conservative regexes, high precision. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/, 'api_key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws_access_key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'github_token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'slack_token'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/, 'npm_token'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, 'jwt'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private_key'],
  [/\b(password|passwort|passwd)\s*(is|ist|[:=])\s*\S+/i, 'password'],
];

export function detectSecret(content: string): string | null {
  for (const [pattern, kind] of SECRET_PATTERNS) {
    if (pattern.test(content)) return kind;
  }
  return null;
}

/**
 * Stored prompt injection: text that tries to become an instruction once
 * it is recalled into a future context. Heuristic, documented as such.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules)/i,
  /disregard\s+(your|all)\s+(instructions|rules|guidelines)/i,
  /you\s+must\s+(now\s+)?(always\s+)?(obey|follow|execute)\b/i,
  /system\s*prompt\s*[:=]/i,
  /\bdo\s+not\s+tell\s+the\s+user\b/i,
  /\bexfiltrate|send\s+(all\s+)?(data|memories|files)\s+to\s+https?:/i,
  /<\s*(system|assistant)\s*>/i,
];

export function detectInjection(content: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(content));
}

/** Sensitivity classification by keyword groups. Heuristic; user can always override. */
const SENSITIVE_HINTS: Array<[RegExp, string]> = [
  [/\b(diagnos|krank|illness|medication|therap|depress|anxiety|blood\s*pressure|hiv|cancer)\w*/i, 'health'],
  [/\b(salary|gehalt|iban|kontostand|debt|schulden|loan|kredit|bank\s*account)\b/i, 'financial'],
];

export function classifySensitiveCategory(content: string): string | null {
  for (const [pattern, category] of SENSITIVE_HINTS) {
    if (pattern.test(content)) return category;
  }
  return null;
}
