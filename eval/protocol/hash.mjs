/**
 * Soul 4.0 Eval — kanonischer Protokoll-Hash (Preregistration als Code, F02).
 *
 * Berechnet den SHA-256 über ALLE Dateien in eval/protocol/ deterministisch:
 * - Dateien werden rekursiv gesammelt und nach relativem Pfad sortiert.
 * - *.json wird kanonisch serialisiert (rekursiv sortierte Keys, kein Whitespace)
 *   → die Key-Reihenfolge in der Datei ist für den Hash irrelevant.
 * - Alle anderen Dateien gehen als rohe Bytes ein.
 * - Der Protokoll-Hash ist der SHA-256 über das Manifest
 *   "relPath\nsha256(content)\n" je Datei, in sortierter Pfad-Reihenfolge.
 *
 * Verwendung (VOR dem ersten Messlauf, siehe README.md):
 *   node eval/protocol/hash.mjs                      → Hash nur berechnen
 *   node eval/protocol/hash.mjs --register <db-Pfad> → Hash berechnen UND als
 *     Ledger-Event 'eval.protocol_registered' ins Soul-Ledger schreiben (F05).
 *
 * Ledger-Verankerung (registerProtocolHash): schreibt direkt per
 * better-sqlite3 in die events-Tabelle — mit EXAKT der Struktur, die
 * src/kernel/db.ts anlegt (CREATE TABLE IF NOT EXISTS ist identisch, ein
 * bestehendes Soul-Ledger wird unverändert weiterbenutzt). Idempotent:
 * ist derselbe protocol_hash bereits registriert, ist der Aufruf ein No-op.
 * Der Event-Typ 'eval.protocol_registered' ist in der EventType-Union von
 * src/kernel/ledger.ts nachgetragen (Migration-v12-Welle).
 *
 * Jede Änderung an eval/protocol/ ändert den Hash = sichtbare
 * Protokoll-Revision; eine laufende Messwelle ist damit verworfen.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

/**
 * Kanonische JSON-Serialisierung: rekursiv sortierte Object-Keys, Arrays in
 * gegebener Reihenfolge, kein Whitespace. Nur JSON-Werte erlaubt (fail-closed).
 * @param {any} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalize: non-finite number is not JSON');
    return JSON.stringify(value);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new TypeError(`canonicalize: unsupported type ${t}`);
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * Hasht den Inhalt EINER Protokoll-Datei kanonisch:
 * *.json → canonicalize(parse), sonst rohe Bytes.
 * @param {string} absPath
 * @param {string} relPath
 * @returns {string} sha256 hex
 */
export function hashFileCanonical(absPath, relPath) {
  const raw = readFileSync(absPath);
  if (relPath.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      throw new Error(`hashFileCanonical: ${relPath} is not valid JSON: ${e.message}`);
    }
    return sha256Hex(Buffer.from(canonicalize(parsed), 'utf8'));
  }
  return sha256Hex(raw);
}

/**
 * Kanonischer Protokoll-Hash über ein Verzeichnis.
 * @param {string} dir
 * @returns {{protocol_hash:string, algorithm:string, files:Array<{path:string, sha256:string}>}}
 */
export function hashProtocolDir(dir) {
  const relPaths = listFilesRecursive(dir);
  if (relPaths.length === 0) throw new Error(`hashProtocolDir: no files under ${dir}`);
  const files = relPaths.map((relPath) => ({
    path: relPath,
    sha256: hashFileCanonical(join(dir, ...relPath.split('/')), relPath),
  }));
  const manifest = files.map((f) => `${f.path}\n${f.sha256}\n`).join('');
  return {
    protocol_hash: sha256Hex(Buffer.from(manifest, 'utf8')),
    algorithm: 'sha256(manifest of sorted "relPath\\nsha256(canonical content)\\n"); json canonicalized with sorted keys',
    files,
  };
}

// --- Ledger-Verankerung (F05) -----------------------------------------------

/**
 * DDL identisch zu src/kernel/db.ts (events-Tabelle + Indizes) — damit eine
 * Wegwerf-/Pilot-DB dieselbe Struktur bekommt und ein echtes Soul-Ledger
 * unverändert weiterbenutzt wird. Bewusst KEINE weiteren Soul-Tabellen:
 * dieses Skript verankert nur das Protokoll, es ist kein zweiter Kernel.
 */
const EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    actor TEXT NOT NULL DEFAULT 'system',
    recorded_at TEXT NOT NULL,
    valid_from TEXT,
    valid_until TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_recorded ON events(recorded_at);
`;

/**
 * Berechnet den Protokoll-Hash und verankert ihn als Ledger-Event
 * 'eval.protocol_registered' in der Soul-DB unter dbPath.
 *
 * Idempotent: trägt das Ledger bereits ein Event mit DEMSELBEN protocol_hash,
 * wird nichts geschrieben (registered:false, already_registered:true).
 * Ein ANDERER bereits registrierter Hash ist kein Fehler, sondern eine neue,
 * sichtbare Protokoll-Revision — sie wird als neues Event angehängt und die
 * Vorgänger-Hashes werden im Ergebnis mitgeliefert.
 *
 * async, weil better-sqlite3 nur bei tatsächlicher Registrierung gebraucht
 * und deshalb lazy importiert wird (der reine Hash-Pfad bleibt dependency-frei).
 *
 * @param {string} dbPath  Pfad zur SQLite-DB (Soul-Ledger oder Wegwerf-DB)
 * @param {{protocolDir?: string}} opts
 * @returns {Promise<{protocol_hash:string, registered:boolean, already_registered:boolean, previous_hashes:string[], seq:number|null}>}
 */
export async function registerProtocolHash(dbPath, opts = {}) {
  const protocolDir = opts.protocolDir ?? dirname(fileURLToPath(import.meta.url));
  const { protocol_hash, algorithm, files } = hashProtocolDir(protocolDir);

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  try {
    db.exec(EVENTS_DDL);
    const rows = db
      .prepare(`SELECT seq, payload FROM events WHERE event_type = 'eval.protocol_registered' ORDER BY seq ASC`)
      .all();
    const seen = rows.map((r) => {
      try {
        return JSON.parse(r.payload)?.protocol_hash ?? null;
      } catch {
        return null;
      }
    });
    if (seen.includes(protocol_hash)) {
      return {
        protocol_hash,
        registered: false,
        already_registered: true,
        previous_hashes: seen.filter((h) => h && h !== protocol_hash),
        seq: null,
      };
    }
    const result = db
      .prepare(
        `INSERT INTO events (event_type, entity_type, entity_id, payload, actor, recorded_at, valid_from, valid_until)
         VALUES ('eval.protocol_registered', 'eval_protocol', ?, ?, 'system', ?, NULL, NULL)`
      )
      .run(
        protocol_hash,
        JSON.stringify({
          protocol_hash,
          algorithm,
          file_count: files.length,
          files: files.map((f) => f.path),
          protocol_dir: 'eval/protocol',
        }),
        new Date().toISOString()
      );
    return {
      protocol_hash,
      registered: true,
      already_registered: false,
      previous_hashes: seen.filter(Boolean),
      seq: Number(result.lastInsertRowid),
    };
  } finally {
    db.close();
  }
}

// --- CLI -------------------------------------------------------------------

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const regIdx = args.indexOf('--register');
  const dbPath = regIdx >= 0 ? args[regIdx + 1] : null;
  const positional = args.filter((a, i) => a !== '--register' && i !== regIdx + 1);
  const protocolDir = positional[0] ?? dirname(fileURLToPath(import.meta.url));

  if (regIdx >= 0 && !dbPath) {
    process.stderr.write('Usage: node hash.mjs [protocolDir] [--register <db-path>]\n');
    process.exit(64);
  }

  const result = hashProtocolDir(protocolDir);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (dbPath) {
    const reg = await registerProtocolHash(dbPath, { protocolDir });
    process.stderr.write(
      reg.registered
        ? `\neval.protocol_registered geschrieben (seq ${reg.seq}): ${reg.protocol_hash}\n`
        : `\nprotocol_hash bereits registriert — No-op: ${reg.protocol_hash}\n`
    );
  } else {
    process.stderr.write(
      '\nprotocol_hash muss VOR dem ersten Messlauf ins Ledger geschrieben werden: ' +
        'node eval/protocol/hash.mjs --register <pfad/zu/memories.db>\n'
    );
  }
}
