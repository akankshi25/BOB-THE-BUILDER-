// CodeCity API: clone a repo, analyze its full history, return City Timeline
// JSON. Long clones run as async jobs the frontend polls; results are cached
// in MongoDB (when available) so a repo is only ever analyzed once.

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// MongoDB rejects documents over 16 MB; stay clear of the ceiling.
const MAX_CACHE_BYTES = 15 * 1024 * 1024;

import { connectDb, isDbConnected } from './db.js';
import { City, CITY_SCHEMA } from './models/City.js';
import { parseRepoInput, cloneRepo, headSha } from './lib/repo.js';
import { buildCity } from './engine/buildCity.js';

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/codecity';

const SERVER_STARTED_AT = new Date().toISOString(); //current date stored when server started
const SERVER_START_TIME = Date.now();              //current time stored when server started

await connectDb(MONGO_URI);

const app = express();
app.use(cors());
// City JSON is large and highly repetitive — gzip cuts it by roughly 10x.
app.use(compression());
app.use(express.json());

/** jobId -> { status: 'running'|'done'|'error', message?, city?, error? } */
const jobs = new Map();

app.get('/api/health', (req, res) => {  //displays this information when you open the health-check URL in your browser. just shows since how many seconds the server is running from
  res.json({
    status: 'ok',                 
    db: isDbConnected(),
    startedAt: SERVER_STARTED_AT,
    uptimeSeconds: Math.floor(
      (Date.now() - SERVER_START_TIME) / 1000
    ),
  });
});

app.post('/api/analyze', async (req, res) => {
  let info;
  try {
    info = parseRepoInput(req.body.repo);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Serve straight from cache when we can.
  if (isDbConnected()) {
    try {
      const cached = await City.findOne({ key: info.key }).lean();
      if (cached?.dataGz && cached.schema === CITY_SCHEMA) {
        const json = await gunzipAsync(toBuffer(cached.dataGz));
        return res.type('application/json').send(`{"city":${json.toString('utf8')}}`);
      }
    } catch (e) {
      console.warn(`[cache] read failed for ${info.key}: ${e.message}`);
    }
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: 'running', message: `Cloning ${info.name}…` });
  res.json({ jobId });

  runJob(jobId, info); // fire-and-forget; progress tracked in `jobs`
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

async function runJob(jobId, info) {
  let tmp = null;
  try {
    const repoPath = info.kind === 'local' ? info.path : (tmp = await cloneRepo(info.url));

    jobs.set(jobId, { status: 'running', message: `Analyzing ${info.name}…` });
    const city = await buildCity(repoPath, {
      // Long histories take a while — keep the UI honest about progress.
      onProgress: (n) =>
        jobs.set(jobId, {
          status: 'running',
          message: `Replaying ${info.name} — ${n.toLocaleString()} commits…`,
        }),
    });
    city.repo = info.name;
    // The repo's web page, so the UI can link files back to their host. The
    // name alone can't: GitHub and GitLab both shorten to `owner/repo`.
    city.webUrl = info.kind === 'url' ? info.url.replace(/\.git$/, '') : null;
    city.generatedAt = new Date().toISOString();

    if (isDbConnected()) {
      try {
        const json = Buffer.from(JSON.stringify(city), 'utf8');
        if (json.byteLength > MAX_CACHE_BYTES) {
          console.warn(`[cache] ${info.name} too large to cache (${mb(json.byteLength)})`);
        } else {
          const sha = await headSha(repoPath);
          const dataGz = await gzipAsync(json);
          await City.updateOne(
            { key: info.key },
            { $set: { key: info.key, schema: CITY_SCHEMA, repo: info.name, headSha: sha, dataGz, bytes: json.byteLength, createdAt: new Date() } },
            { upsert: true }
          );
          console.log(`[cache] stored ${info.name} — ${mb(json.byteLength)} -> ${mb(dataGz.byteLength)} gzipped`);
        }
      } catch (e) {
        console.warn(`[cache] write failed for ${info.name}: ${e.message}`);
      }
    }

    jobs.set(jobId, { status: 'done', city });
  } catch (e) {
    jobs.set(jobId, { status: 'error', error: friendlyError(e) });
  } finally {
    if (tmp) rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A lean() read hands back BSON Binary, not a Node Buffer — normalize both. */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v?.buffer) return Buffer.from(v.buffer);
  return Buffer.from(v);
}

function friendlyError(e) {
  const msg = e.message || String(e);
  if (/not found|repository .* not found|could not read/i.test(msg)) {
    return 'Repository not found (is it private or misspelled?)';
  }
  if (/timed out|timeout/i.test(msg)) return 'Clone timed out — the repo may be very large';
  return msg;
}

app.listen(PORT, () => {
  console.log(`[codecity] API listening on http://localhost:${PORT}`);
});
