#!/usr/bin/env node
// Contact & Impressum discovery utility:
// Scans corporate domains and legal notice (Impressum/Contact) pages to discover
// general contact email addresses and registered headquarters addresses.
//
// Usage:
//   node crawler/contacts.mjs                 # Process companies missing email
//   node crawler/contacts.mjs --limit 20      # Process in batches of 20 (slow stretch goal)
//   node crawler/contacts.mjs --company isar  # Process a specific company
//   node crawler/contacts.mjs --dry-run       # Test discovery without modifying JSON

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProfile } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);

const PROFILE = opt('profile') ? loadProfile(opt('profile')) : null;
const SITE_CFG = resolve(opt('catalogue') ?? PROFILE?.companiesCatalogue ?? resolve(HERE, '../site/content/companies.json'));

const DRY_RUN = flag('dry-run');
const ONLY_COMPANY = opt('company')?.toLowerCase();
const LIMIT = opt('limit') ? parseInt(opt('limit'), 10) : Infinity;

const UA = PROFILE?.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const IGNORE_EMAILS = [
  'sentry', 'wixpress', 'example.com', 'domain.com', 'youremail', 'user@',
  'email@email.com', 'test@', 'support@github.com', 'contact@domain', 'contact@example',
  'name@email.com', 'email@domain.com', 'info@domain.com', 'username@', 'wordpress@'
];

function cleanEmail(raw) {
  if (!raw) return null;
  const e = raw.toLowerCase().trim();
  if (e.length > 80 || e.length < 5) return null;
  if (IGNORE_EMAILS.some((ign) => e.includes(ign))) return null;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf)$/i.test(e)) return null;
  return e;
}

function scoreEmail(email) {
  if (/^(info|contact|kontakt)@/i.test(email)) return 100;
  if (/^(hello|office|inquiries|mail|reception)@/i.test(email)) return 80;
  if (/^(career|careers|jobs|recruiting|bewerbung)@/i.test(email)) return 70;
  if (/^(press|media|pr)@/i.test(email)) return 50;
  return 10;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,de;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function findContact(company) {
  let domain = company.domain;
  if (!domain && company.website) {
    try { domain = new URL(company.website).hostname.replace(/^www\./, ''); } catch {}
  }
  if (!domain && company.careers_url) {
    try {
      const u = new URL(company.careers_url);
      if (!u.hostname.includes('greenhouse') && !u.hostname.includes('ashby') && !u.hostname.includes('personio') && !u.hostname.includes('myworkday')) {
        domain = u.hostname.replace(/^www\./, '');
      }
    } catch {}
  }
  if (!domain) return null;

  const origin = `https://${domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
  const endpoints = [
    `${origin}/`,
    `${origin}/contact`,
    `${origin}/contact-us`,
    `${origin}/kontakt`,
    `${origin}/impressum`,
    `${origin}/imprint`,
    `${origin}/legal`,
    `${origin}/legal-notice`
  ];

  const foundEmails = new Map();

  for (const url of endpoints) {
    const html = await fetchPage(url);
    if (!html) continue;

    // Check mailto: links
    const mailtos = [...html.matchAll(/mailto:([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/gi)].map(m => cleanEmail(m[1])).filter(Boolean);
    for (const m of mailtos) {
      if (!foundEmails.has(m)) foundEmails.set(m, scoreEmail(m) + 20);
    }

    // Check body text for emails
    const raw = [...html.matchAll(EMAIL_REGEX)].map(m => cleanEmail(m[0])).filter(Boolean);
    for (const r of raw) {
      if (!foundEmails.has(r)) foundEmails.set(r, scoreEmail(r));
    }

    // If high-priority email found, we can stop early
    const best = [...foundEmails.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 100) break;
  }

  const sorted = [...foundEmails.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
}

async function main() {
  const data = JSON.parse(readFileSync(SITE_CFG, 'utf8'));
  let candidates = data.companies.filter(c => !c.is_aggregator);

  if (ONLY_COMPANY) {
    candidates = candidates.filter(c => c.name.toLowerCase().includes(ONLY_COMPANY) || c.slug.includes(ONLY_COMPANY));
  } else {
    // Priority: companies missing email
    candidates = candidates.filter(c => !c.email);
  }

  candidates = candidates.slice(0, LIMIT);

  console.log(`Auditing contacts for ${candidates.length} companies (limit: ${LIMIT})...`);

  let discovered = 0;
  for (let i = 0; i < candidates.length; i++) {
    const co = candidates[i];
    const email = await findContact(co);
    if (email) {
      discovered++;
      co.email = email;
      console.log(`[${i + 1}/${candidates.length}] ${co.name.padEnd(30)} -> ${email}`);
    } else {
      console.log(`[${i + 1}/${candidates.length}] ${co.name.padEnd(30)} -> not found`);
    }

    // Polite 250ms spacing
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nDiscovered contacts for ${discovered} / ${candidates.length} companies.`);

  if (!DRY_RUN && discovered > 0) {
    writeFileSync(SITE_CFG, JSON.stringify(data, null, 2) + '\n');
    console.log(`Saved discovered contacts to ${SITE_CFG}`);
  }
}

main().catch(console.error);
