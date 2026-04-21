#!/usr/bin/env node
/**
 * Happy Class image generator — KIE AI / Nano Banana Pro.
 *
 * Usage:
 *   node scripts/generate-images.mjs                  generate all missing
 *   node scripts/generate-images.mjs --all            regenerate every image
 *   node scripts/generate-images.mjs hero paper-pink  regenerate specific images
 *
 * Reads prompts from scripts/image-prompts.json.
 * Reads KIE_API_KEY from .env (at repo root).
 * Writes PNGs to public/images/<name>.png.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROMPTS_FILE = path.join(__dirname, 'image-prompts.json');
const OUTPUT_DIR = path.join(ROOT, 'public', 'images');
const ENV_FILE = path.join(ROOT, '.env');

const API_BASE = 'https://api.kie.ai';
const CREATE_URL = `${API_BASE}/api/v1/jobs/createTask`;
const POLL_URL = `${API_BASE}/api/v1/jobs/recordInfo`;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function loadEnv() {
  const raw = await fs.readFile(ENV_FILE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m) process.env[m[1]] ??= m[2].replace(/^"|"$/g, '');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function uploadLocalToLitterbox(localPath) {
  const absPath = path.isAbsolute(localPath) ? localPath : path.join(ROOT, localPath);
  const buf = await fs.readFile(absPath);
  const filename = path.basename(absPath);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';

  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '24h');
  form.append('fileToUpload', new Blob([buf], { type: mime }), filename);

  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok || !text.startsWith('http')) {
    throw new Error(`litterbox upload failed: ${res.status} ${text}`);
  }
  return text;
}

async function resolveImageInput(spec) {
  const urls = [...(spec.image_input ?? [])];
  for (const localPath of spec.image_input_local ?? []) {
    const url = await uploadLocalToLitterbox(localPath);
    urls.push(url);
  }
  return urls;
}

async function submitTask(apiKey, spec) {
  const { prompt, aspect_ratio, resolution } = spec;
  const imageUrls = await resolveImageInput(spec);
  const input = {
    prompt,
    aspect_ratio: aspect_ratio ?? '1:1',
    resolution: resolution ?? '1K',
    output_format: 'png',
  };
  if (imageUrls.length) input.image_input = imageUrls;

  const res = await fetch(CREATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'nano-banana-pro', input }),
  });
  const json = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(`createTask failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data.taskId;
}

async function pollTask(apiKey, taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${POLL_URL}?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = await res.json();
    if (!res.ok || json.code !== 200) {
      throw new Error(`poll failed: ${res.status} ${JSON.stringify(json)}`);
    }
    const state = json.data?.state;
    if (state === 'success') {
      const parsed = JSON.parse(json.data.resultJson);
      const url = parsed.resultUrls?.[0];
      if (!url) throw new Error(`no resultUrls in: ${json.data.resultJson}`);
      return url;
    }
    if (state === 'fail') {
      throw new Error(`task failed: ${json.data.failCode} ${json.data.failMsg}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`poll timeout after ${POLL_TIMEOUT_MS}ms`);
}

async function downloadPng(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
  return buf.length;
}

async function generateOne(apiKey, name, spec) {
  const outPath = path.join(OUTPUT_DIR, `${name}.png`);
  const t0 = Date.now();
  try {
    console.log(`[${name}] submitting…`);
    const taskId = await submitTask(apiKey, spec);
    console.log(`[${name}] taskId=${taskId} polling…`);
    const url = await pollTask(apiKey, taskId);
    const bytes = await downloadPng(url, outPath);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${name}] ✓ saved ${outPath} (${(bytes / 1024).toFixed(0)} KB, ${secs}s)`);
    return { name, ok: true };
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[${name}] ✗ failed after ${secs}s: ${err.message}`);
    return { name, ok: false, error: err.message };
  }
}

async function main() {
  await loadEnv();
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    console.error('Missing KIE_API_KEY in .env');
    process.exit(1);
  }

  const prompts = JSON.parse(await fs.readFile(PROMPTS_FILE, 'utf8'));
  const allNames = Object.keys(prompts).filter((k) => !k.startsWith('_'));

  const args = process.argv.slice(2);
  const force = args.includes('--all');
  const names = args.filter((a) => !a.startsWith('--'));

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let targets;
  if (names.length > 0) {
    targets = names;
    const unknown = targets.filter((n) => !prompts[n]);
    if (unknown.length) {
      console.error(`Unknown image names: ${unknown.join(', ')}`);
      console.error(`Known names: ${allNames.join(', ')}`);
      process.exit(1);
    }
  } else if (force) {
    targets = allNames;
  } else {
    targets = [];
    for (const name of allNames) {
      try {
        await fs.access(path.join(OUTPUT_DIR, `${name}.png`));
      } catch {
        targets.push(name);
      }
    }
    if (targets.length === 0) {
      console.log('All images already present. Use --all to regenerate or pass specific names.');
      return;
    }
  }

  console.log(`Generating ${targets.length} image(s) in parallel: ${targets.join(', ')}`);
  const results = await Promise.all(
    targets.map((name) => generateOne(apiKey, name, prompts[name]))
  );

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nDone. ${ok}/${results.length} succeeded.`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
