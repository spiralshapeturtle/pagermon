#!/usr/bin/env node
// analyze_fragments.js
// Analyzes flex_debug_*.log files for fragmentation patterns.
// Usage:
//   node analyze_fragments.js               -> analyze all log files
//   node analyze_fragments.js 2026-03-08    -> analyze one specific date
//   node analyze_fragments.js 2026-03-01 2026-03-08  -> analyze date range

import fsSync from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const LOG_DIR = path.join(process.cwd(), 'logs');

// ---- Group capcode range ----
const GROUP_MIN = 2029568;
const GROUP_MAX = 2029583;

function isGroupCapcode(addr) {
  const n = parseInt(addr, 10);
  return !isNaN(n) && n >= GROUP_MIN && n <= GROUP_MAX;
}

function parseAddresses(addressMatch) {
  if (!addressMatch) return [];
  return addressMatch.trim().split(/\s+/).filter(a => /^\d+$/.test(a));
}

// ---- Argument parsing ----
const args = process.argv.slice(2);
let dateFilter = null; // null = all files

if (args.length === 1) {
  dateFilter = { from: args[0], to: args[0] };
} else if (args.length === 2) {
  dateFilter = { from: args[0], to: args[1] };
}

// ---- Collect log files ----
function getLogFiles() {
  if (!fsSync.existsSync(LOG_DIR)) {
    console.error(`Log directory not found: ${LOG_DIR}`);
    process.exit(1);
  }

  const files = fsSync.readdirSync(LOG_DIR)
    .filter(f => /^flex_debug_\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();

  if (dateFilter) {
    return files.filter(f => {
      const date = f.replace('flex_debug_', '').replace('.log', '');
      return date >= dateFilter.from && date <= dateFilter.to;
    });
  }
  return files;
}

// ---- Parse a single log file line by line ----
async function parseFile(filePath) {
  const entries = [];
  const rl = createInterface({
    input: fsSync.createReadStream(filePath),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ---- Analyse entries ----
function analyzeEntries(entries, date) {
  const stats = {
    date,
    total_flex_lines: 0,
    pipe_format: 0,
    has_aln: 0,
    has_gpn: 0,
    has_num: 0,
    flag_K: 0,
    flag_F: 0,
    flag_C: 0,
    flag_missing: 0,
    fragments_stored: 0,
    fragments_completed: 0,
    fragments_C_without_F: 0,
    no_address_match: 0,
    no_message_match: 0,
  };

  // Per-address tracking
  const byAddress = {};
  const missedGroupcalls = [];   // multi-capcode zonder groepscode
  const missedInstructions = []; // groepscode alleen, geen individuele capcodes

  function ensureAddr(addr) {
    if (!byAddress[addr]) byAddress[addr] = { stored: 0, completed: 0, orphaned: 0 };
  }

  for (const e of entries) {
    if (e.event === 'flex_line') {
      stats.total_flex_lines++;
      if (e.pipe_format) stats.pipe_format++;
      if (e.has_aln) stats.has_aln++;
      if (e.has_gpn) stats.has_gpn++;
      if (e.has_num) stats.has_num++;
      if (e.frag_flag === 'K') stats.flag_K++;
      if (e.frag_flag === 'F') stats.flag_F++;
      if (e.frag_flag === 'C') stats.flag_C++;
      if (e.frag_flag === null && e.pipe_format) stats.flag_missing++;

      // Groupcall / missed instructions check
      const addrs = parseAddresses(e.address_match);
      if (addrs.length > 0) {
        const groupCodes = addrs.filter(isGroupCapcode);
        const realCodes  = addrs.filter(a => !isGroupCapcode(a));

        if (addrs.length > 1 && groupCodes.length === 0) {
          // Meerdere capcodes maar GEEN groepscode → missed groupcall
          missedGroupcalls.push({ ts: e.ts, addresses: addrs, raw: e.raw });
        } else if (groupCodes.length > 0 && realCodes.length === 0) {
          // Alleen groepscode, geen individuele capcodes → missed instructions
          missedInstructions.push({ ts: e.ts, addresses: addrs, raw: e.raw });
        }
      }
    } else if (e.event === 'flex_no_address') {
      stats.no_address_match++;
    } else if (e.event === 'flex_no_message_match') {
      stats.no_message_match++;
    } else if (e.event === 'fragment_stored') {
      stats.fragments_stored++;
      ensureAddr(e.address);
      byAddress[e.address].stored++;
    } else if (e.event === 'fragment_completed') {
      stats.fragments_completed++;
      ensureAddr(e.address);
      byAddress[e.address].completed++;
    } else if (e.event === 'fragment_C_without_F') {
      stats.fragments_C_without_F++;
      ensureAddr(e.address);
      byAddress[e.address].orphaned++;
    }
  }

  return { stats, byAddress, missedGroupcalls, missedInstructions };
}

// ---- Print report ----
function printReport(date, stats, byAddress) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Date: ${date}`);
  console.log('='.repeat(60));
  console.log(`  Total FLEX lines logged   : ${stats.total_flex_lines}`);
  console.log(`  Pipe-format (FLEX|...)    : ${stats.pipe_format}`);
  console.log(`  Has ALN                   : ${stats.has_aln}`);
  console.log(`  Has GPN                   : ${stats.has_gpn}`);
  console.log(`  Has NUM                   : ${stats.has_num}`);
  console.log('  ---');
  console.log(`  Flag K (complete)         : ${stats.flag_K}`);
  console.log(`  Flag F (first fragment)   : ${stats.flag_F}`);
  console.log(`  Flag C (continuation)     : ${stats.flag_C}`);
  console.log(`  Flag missing (pipe, no KFC): ${stats.flag_missing}`);
  console.log('  ---');
  console.log(`  Fragments stored (F)      : ${stats.fragments_stored}`);
  console.log(`  Fragments completed (F+C) : ${stats.fragments_completed}`);
  console.log(`  C without prior F         : ${stats.fragments_C_without_F}`);
  console.log(`  No address match          : ${stats.no_address_match}`);
  console.log(`  No message match          : ${stats.no_message_match}`);

  const addresses = Object.entries(byAddress);
  if (addresses.length > 0) {
    console.log('\n  Per-address fragment breakdown:');
    console.log(`  ${'Address'.padEnd(12)} ${'Stored(F)'.padEnd(12)} ${'Completed'.padEnd(12)} ${'Orphaned C'}`);
    console.log(`  ${'-'.repeat(50)}`);
    for (const [addr, counts] of addresses.sort((a, b) => b[1].stored - a[1].stored)) {
      console.log(`  ${addr.padEnd(12)} ${String(counts.stored).padEnd(12)} ${String(counts.completed).padEnd(12)} ${counts.orphaned}`);
    }
  } else {
    console.log('\n  No per-address fragmentation data found.');
  }
}

// ---- Print groupcall / missed instructions report ----
function printGroupcallReport(missedGroupcalls, missedInstructions) {
  if (missedGroupcalls.length > 0) {
    console.log(`\n  MISSED GROUPCALLS (${missedGroupcalls.length}) — meerdere capcodes zonder groepscode ${GROUP_MIN}-${GROUP_MAX}:`);
    console.log(`  ${'Tijdstip'.padEnd(26)} Capcodes`);
    console.log(`  ${'-'.repeat(60)}`);
    for (const e of missedGroupcalls) {
      console.log(`  ${e.ts.padEnd(26)} ${e.addresses.join(', ')}`);
      console.log(`    └─ ${e.raw}`);
    }
  } else {
    console.log('\n  Geen missed groupcalls gevonden.');
  }

  if (missedInstructions.length > 0) {
    console.log(`\n  MISSED INSTRUCTIONS (${missedInstructions.length}) — groepscode zonder individuele capcodes:`);
    console.log(`  ${'Tijdstip'.padEnd(26)} Groepscode(s)`);
    console.log(`  ${'-'.repeat(60)}`);
    for (const e of missedInstructions) {
      console.log(`  ${e.ts.padEnd(26)} ${e.addresses.join(', ')}`);
      console.log(`    └─ ${e.raw}`);
    }
  } else {
    console.log('\n  Geen missed instructions gevonden.');
  }
}

// ---- Sample raw lines for unmatched cases ----
function printSamples(entries) {
  const noAddr = entries.filter(e => e.event === 'flex_no_address').slice(0, 3);
  const noMsg  = entries.filter(e => e.event === 'flex_no_message_match').slice(0, 3);

  if (noAddr.length > 0) {
    console.log('\n  Sample lines with NO address match:');
    noAddr.forEach(e => console.log(`    ${e.raw}`));
  }
  if (noMsg.length > 0) {
    console.log('\n  Sample lines with NO message match:');
    noMsg.forEach(e => console.log(`    ${e.raw}`));
  }
}

// ---- Main ----
const files = getLogFiles();

if (files.length === 0) {
  console.log('No log files found matching the criteria.');
  process.exit(0);
}

console.log(`\nAnalyzing ${files.length} log file(s) from: ${LOG_DIR}`);

let grandTotal = {
  total_flex_lines: 0,
  flag_K: 0,
  flag_F: 0,
  flag_C: 0,
  flag_missing: 0,
  fragments_stored: 0,
  fragments_completed: 0,
  fragments_C_without_F: 0,
  missed_groupcalls: 0,
  missed_instructions: 0,
};

for (const file of files) {
  const date = file.replace('flex_debug_', '').replace('.log', '');
  const filePath = path.join(LOG_DIR, file);
  const entries = await parseFile(filePath);
  const { stats, byAddress, missedGroupcalls, missedInstructions } = analyzeEntries(entries, date);

  printReport(date, stats, byAddress);
  printGroupcallReport(missedGroupcalls, missedInstructions);
  printSamples(entries);

  grandTotal.total_flex_lines      += stats.total_flex_lines;
  grandTotal.flag_K                += stats.flag_K;
  grandTotal.flag_F                += stats.flag_F;
  grandTotal.flag_C                += stats.flag_C;
  grandTotal.flag_missing          += stats.flag_missing;
  grandTotal.fragments_stored      += stats.fragments_stored;
  grandTotal.fragments_completed   += stats.fragments_completed;
  grandTotal.fragments_C_without_F += stats.fragments_C_without_F;
  grandTotal.missed_groupcalls     += missedGroupcalls.length;
  grandTotal.missed_instructions   += missedInstructions.length;
}

if (files.length > 1) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  TOTALS ACROSS ALL ANALYZED DAYS');
  console.log('='.repeat(60));
  console.log(`  Total FLEX lines       : ${grandTotal.total_flex_lines}`);
  console.log(`  Flag K (complete)      : ${grandTotal.flag_K}`);
  console.log(`  Flag F (fragment)      : ${grandTotal.flag_F}`);
  console.log(`  Flag C (continuat.)    : ${grandTotal.flag_C}`);
  console.log(`  Flag missing           : ${grandTotal.flag_missing}`);
  console.log(`  Fragments stored       : ${grandTotal.fragments_stored}`);
  console.log(`  Fragments completed    : ${grandTotal.fragments_completed}`);
  console.log(`  Orphaned C (no F)      : ${grandTotal.fragments_C_without_F}`);
  console.log('  ---');
  console.log(`  Missed groupcalls      : ${grandTotal.missed_groupcalls}`);
  console.log(`  Missed instructions    : ${grandTotal.missed_instructions}`);
}

console.log('');
