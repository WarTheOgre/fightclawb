/**
 * routes/upload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /agents/upload — Accept agent code (.zip), validate, scan, build image.
 *
 * Pipeline:
 *   1. Auth:         JWT required (agent uploads their own code)
 *   2. Rate limit:   1 upload/hour per agent
 *   3. Size check:   Max 5MB zip
 *   4. Unzip:        Validate structure (no path traversal, expected files)
 *   5. Lint:         Python syntax check or Node.js parse
 *   6. Virus scan:   ClamAV via clamd socket
 *   7. Build:        `docker build` with agent code layered on base image
 *   8. Push:         Push to local registry
 *   9. Record:       Write sandbox_jobs row
 *
 * On any failure the upload is rejected and the partially-built image is removed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFile }           from 'node:child_process';
import { promisify }          from 'node:util';
import { createWriteStream, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, relative, basename, extname } from 'node:path';
import { tmpdir }             from 'node:os';
import { pipeline }           from 'node:stream/promises';
import crypto                 from 'node:crypto';
import { createGunzip }       from 'node:zlib';
import { Extract as UnzipExtract } from 'unzipper';
import net                    from 'node:net';
import { query }              from '../../db/pool.js';
import { verifyToken }        from '../middleware/auth.js';

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  maxZipBytes:    5 * 1024 * 1024,            // 5MB
  maxUnzipBytes:  20 * 1024 * 1024,           // 20MB extracted
  maxFiles:       50,                         // no more than 50 files in zip
  agentDir:       process.env.AGENT_DIR       ?? '/var/lib/arena/agents',
  registry:       process.env.DOCKER_REGISTRY ?? 'localhost:5000',
  clamavSocket:   process.env.CLAMAV_SOCKET   ?? '/var/run/clamav/clamd.ctl',
  rateWindowMs:   60 * 60 * 1000,             // 1 hour
  diskQuotaBytes: 100 * 1024 * 1024,          // 100MB per agent
};

// ── In-memory rate limiter (swap for Redis in production) ─────────────────────
const _uploadTimes = new Map();   // agentId → timestamp of last upload

function checkRateLimit(agentId) {
  const last = _uploadTimes.get(agentId);
  if (last && Date.now() - last < CFG.rateWindowMs) {
    const retryAfter = Math.ceil((CFG.rateWindowMs - (Date.now() - last)) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

function recordUpload(agentId) {
  _uploadTimes.set(agentId, Date.now());
}

// ── Route handler ─────────────────────────────────────────────────────────────
export default async function uploadRoute(app) {
  app.post('/agents/upload', verifyToken, async (req, res) => {
    const agentId = req.agent.agentId;
    const lang    = (req.query.lang ?? 'python').toLowerCase();

    if (!['python', 'node'].includes(lang)) {
      return res.status(400).json({ error: 'lang must be python or node' });
    }

    // 1. Rate limit
    const rl = checkRateLimit(agentId);
    if (!rl.allowed) {
      return res.status(429).json({
        error: 'upload rate limit: 1 per hour',
        retryAfterSeconds: rl.retryAfter,
      });
    }

    // 2. Size check (header pre-check — real check during streaming)
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > CFG.maxZipBytes) {
      return res.status(413).json({ error: `zip exceeds ${CFG.maxZipBytes / 1024 / 1024}MB limit` });
    }

    const uploadId = crypto.randomUUID();
    const workDir  = join(tmpdir(), `arena-upload-${uploadId}`);
    const zipPath  = join(workDir, 'agent.zip');

    try {
      mkdirSync(workDir, { recursive: true });

      // 3. Stream zip to temp file with size guard
      await streamWithSizeLimit(req, zipPath, CFG.maxZipBytes);

      // 4. Extract and validate zip structure
      const files = await extractAndValidate(zipPath, workDir, lang);

      // 5. Syntax check
      await syntaxCheck(workDir, lang, files);

      // 6. ClamAV virus scan
      await clamScan(zipPath);

      // 7. Build Docker image
      const imageTag = `${CFG.registry}/arena/agent-${agentId}-${lang}:latest`;
      await buildImage(agentId, workDir, lang, imageTag);

      // 8. Push to registry
      await pushImage(imageTag);

      // 9. Copy code to persistent agent dir (for container mounts)
      const agentCodeDir = join(CFG.agentDir, agentId, lang);
      mkdirSync(agentCodeDir, { recursive: true });
      copyCodeFiles(workDir, agentCodeDir, lang, files);

      // 10. Record job in DB
      await query(
        `INSERT INTO sandbox_jobs
           (match_id, agent_id, container_id, runtime, status)
         VALUES (NULL, $1, $2, 'runsc', 'done')`,
        [agentId, imageTag]
      );

      recordUpload(agentId);

      return res.status(200).json({
        message: 'Agent code uploaded and image built successfully',
        uploadId,
        imageTag,
        lang,
        files: files.map(f => f.name),
      });

    } catch (err) {
      // Clean up any partial image
      try {
        await execFileAsync('docker', ['rmi', '--force',
          `${CFG.registry}/arena/agent-${agentId}-${lang}:latest`], { timeout: 10_000 });
      } catch { /* ignore */ }

      const statusCode = err.code === 'VIRUS_FOUND'     ? 422
                       : err.code === 'SYNTAX_ERROR'    ? 422
                       : err.code === 'INVALID_ZIP'     ? 400
                       : err.code === 'FILE_TOO_LARGE'  ? 413
                       : 500;

      return res.status(statusCode).json({ error: err.message });

    } finally {
      // Always clean temp dir
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });
}

// ── Stream with size limit ────────────────────────────────────────────────────

async function streamWithSizeLimit(readable, destPath, maxBytes) {
  let received = 0;
  const out = createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    readable.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        readable.destroy();
        out.destroy();
        const err = new Error(`Upload exceeds ${maxBytes / 1024 / 1024}MB limit`);
        err.code = 'FILE_TOO_LARGE';
        reject(err);
      }
    });
    readable.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    readable.on('error', reject);
  });
}

// ── Zip extraction + structure validation ─────────────────────────────────────

const REQUIRED_FILES = {
  python: ['agent.py'],
  node:   ['agent.mjs'],
};

const OPTIONAL_FILES = {
  python: ['requirements.txt', 'README.md'],
  node:   ['package.json', 'README.md'],
};

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.sh', '.bash', '.zsh', '.fish',
  '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.class',
]);

async function extractAndValidate(zipPath, workDir, lang) {
  const extractDir = join(workDir, 'code');
  mkdirSync(extractDir, { recursive: true });

  const files = [];
  let totalSize = 0;

  await new Promise((resolve, reject) => {
    const extract = UnzipExtract.Parse();
    const zip     = createReadStream(zipPath);

    zip.pipe(extract);

    extract.on('entry', (entry) => {
      const name = entry.path;

      // Reject directories (we flatten the structure)
      if (entry.type === 'Directory') { entry.autodrain(); return; }

      // Path traversal protection
      const safeName = basename(name);   // strip any directory components
      const safePath = resolve(extractDir, safeName);
      if (!safePath.startsWith(extractDir)) {
        entry.autodrain();
        return;
      }

      // Blocked extensions
      if (BLOCKED_EXTENSIONS.has(extname(safeName).toLowerCase())) {
        entry.autodrain();
        return;
      }

      // Max file count
      if (files.length >= CFG.maxFiles) {
        const err = new Error(`Zip contains more than ${CFG.maxFiles} files`);
        err.code = 'INVALID_ZIP';
        extract.destroy(err);
        return;
      }

      // Size tracking
      let fileSize = 0;
      entry.on('data', (chunk) => {
        fileSize += chunk.length;
        totalSize += chunk.length;
        if (totalSize > CFG.maxUnzipBytes) {
          const err = new Error(`Unzipped size exceeds ${CFG.maxUnzipBytes / 1024 / 1024}MB`);
          err.code = 'FILE_TOO_LARGE';
          extract.destroy(err);
        }
      });

      entry.pipe(createWriteStream(safePath));
      files.push({ name: safeName, path: safePath });
    });

    extract.on('finish', resolve);
    extract.on('error', (err) => {
      if (!err.code) err.code = 'INVALID_ZIP';
      reject(err);
    });
    zip.on('error', reject);
  });

  // Validate required files are present
  const fileNames = new Set(files.map(f => f.name));
  for (const req of REQUIRED_FILES[lang]) {
    if (!fileNames.has(req)) {
      const err = new Error(`Missing required file: ${req}`);
      err.code = 'INVALID_ZIP';
      throw err;
    }
  }

  return files;
}

// ── Syntax check ──────────────────────────────────────────────────────────────

async function syntaxCheck(workDir, lang, files) {
  const codeDir = join(workDir, 'code');

  if (lang === 'python') {
    const agentFile = join(codeDir, 'agent.py');
    try {
      await execFileAsync('python3', ['-m', 'py_compile', agentFile], { timeout: 10_000 });
    } catch (err) {
      const e = new Error(`Python syntax error: ${err.stderr ?? err.message}`);
      e.code = 'SYNTAX_ERROR';
      throw e;
    }
  } else if (lang === 'node') {
    const agentFile = join(codeDir, 'agent.mjs');
    try {
      await execFileAsync('node', ['--input-type=module', '--check'],
        { input: readFileSync(agentFile, 'utf8'), timeout: 10_000 });
    } catch (err) {
      const e = new Error(`Node.js syntax error: ${err.stderr ?? err.message}`);
      e.code = 'SYNTAX_ERROR';
      throw e;
    }
  }
}

// ── ClamAV scan ───────────────────────────────────────────────────────────────

async function clamScan(filePath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(CFG.clamavSocket);
    let response = '';

    sock.on('connect', () => {
      sock.write(`zSCAN ${filePath}\0`);
    });

    sock.on('data', (data) => {
      response += data.toString();
    });

    sock.on('end', () => {
      if (response.includes('FOUND')) {
        const err = new Error(`Virus detected: ${response.trim()}`);
        err.code = 'VIRUS_FOUND';
        reject(err);
      } else if (response.includes('ERROR')) {
        // Fail open on ClamAV errors (it may be updating DB)
        console.warn(`[upload] ClamAV error (proceeding): ${response.trim()}`);
        resolve();
      } else {
        resolve();   // OK or empty response
      }
    });

    sock.on('error', (err) => {
      // If ClamAV socket unavailable, warn but don't block upload
      // (set CLAMAV_REQUIRED=true to change this behaviour)
      if (process.env.CLAMAV_REQUIRED === 'true') {
        const e = new Error(`ClamAV unavailable: ${err.message}`);
        e.code = 'SCAN_UNAVAILABLE';
        reject(e);
      } else {
        console.warn(`[upload] ClamAV unavailable (${err.message}) — scan skipped`);
        resolve();
      }
    });

    // Timeout ClamAV after 15s
    sock.setTimeout(15_000, () => {
      sock.destroy();
      console.warn('[upload] ClamAV scan timed out — proceeding');
      resolve();
    });
  });
}

// ── Docker image build ────────────────────────────────────────────────────────

async function buildImage(agentId, workDir, lang, imageTag) {
  const baseImage = lang === 'python'
    ? `${process.env.DOCKER_REGISTRY ?? 'localhost:5000'}/arena/sandbox-python:latest`
    : `${process.env.DOCKER_REGISTRY ?? 'localhost:5000'}/arena/sandbox-node:latest`;

  const codeDir = join(workDir, 'code');

  // Write a minimal agent-specific Dockerfile that layers code on base image.
  // The base image already contains the harness, approved deps, and non-root user.
  const dockerfile = lang === 'python'
    ? `FROM ${baseImage}
COPY --chown=agent:agent agent.py /agent/agent.py
${existsRequirements(codeDir, 'requirements.txt') ? 'COPY --chown=agent:agent requirements.txt /agent/requirements.txt' : ''}
`
    : `FROM ${baseImage}
COPY --chown=agent:agent agent.mjs /agent/agent.mjs
${existsRequirements(codeDir, 'package.json') ? 'COPY --chown=agent:agent package.json /agent/package.json' : ''}
`;

  writeFileSync(join(codeDir, 'Dockerfile'), dockerfile);

  try {
    await execFileAsync('docker', [
      'build',
      '--no-cache',                    // always rebuild agent layer
      '--network=none',                // no network during build
      `--tag=${imageTag}`,
      `--label=arena.agent=${agentId}`,
      `--label=arena.built=${new Date().toISOString()}`,
      '--memory=1g',                   // build-time memory cap
      codeDir,
    ], {
      timeout: 120_000,               // 2 minute build timeout
    });
  } catch (err) {
    const e = new Error(`Image build failed: ${err.stderr ?? err.message}`);
    e.code = 'BUILD_FAILED';
    throw e;
  }
}

async function pushImage(imageTag) {
  try {
    await execFileAsync('docker', ['push', imageTag], { timeout: 60_000 });
  } catch (err) {
    const e = new Error(`Image push failed: ${err.stderr ?? err.message}`);
    e.code = 'PUSH_FAILED';
    throw e;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function existsRequirements(dir, filename) {
  try {
    readFileSync(join(dir, filename));
    return true;
  } catch {
    return false;
  }
}

function copyCodeFiles(srcDir, destDir, lang, files) {
  const codeDir = join(srcDir, 'code');
  for (const f of files) {
    const src  = join(codeDir, f.name);
    const dest = join(destDir, f.name);
    writeFileSync(dest, readFileSync(src));
  }
}

import { createReadStream } from 'node:fs';
