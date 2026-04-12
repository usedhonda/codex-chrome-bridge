#!/usr/bin/env node

/**
 * generate-docs.mjs — Extract tool definitions from bridge.js and update
 * the MCP Tools table in README.md between TOOLS_START / TOOLS_END markers.
 *
 * Usage:  node scripts/generate-docs.mjs
 *         npm run docs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.join(ROOT, 'src', 'bridge.js');
const README_PATH = path.join(ROOT, 'README.md');

const START_MARKER = '<!-- TOOLS_START -->';
const END_MARKER = '<!-- TOOLS_END -->';

function extractToolDefinitions(source) {
  // Find the toolDefinitions() function body
  const fnStart = source.indexOf('function toolDefinitions()');
  if (fnStart === -1) throw new Error('toolDefinitions() not found in bridge.js');

  // Find the return array
  const returnStart = source.indexOf('return [', fnStart);
  if (returnStart === -1) throw new Error('return [ not found in toolDefinitions()');

  // Find the matching closing bracket by counting brackets
  let depth = 0;
  let arrayStart = -1;
  for (let i = returnStart; i < source.length; i++) {
    if (source[i] === '[') {
      if (depth === 0) arrayStart = i;
      depth++;
    } else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        const arrayStr = source.slice(arrayStart, i + 1);
        // Convert JS object notation to JSON-parseable form
        // Replace unquoted keys with quoted keys
        const jsonStr = arrayStr
          .replace(/\/\/[^\n]*/g, '')               // strip line comments
          .replace(/\/\*[\s\S]*?\*\//g, '')          // strip block comments
          .replace(/,(\s*[}\]])/g, '$1')             // strip trailing commas
          .replace(/(\{|\,)\s*(\w+)\s*:/g, '$1"$2":') // quote keys
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"') // single to double quotes
          .replace(/\bundefined\b/g, 'null');
        try {
          return JSON.parse(jsonStr);
        } catch (e) {
          throw new Error(`Failed to parse tool definitions: ${e.message}`);
        }
      }
    }
  }
  throw new Error('Could not find closing bracket of toolDefinitions array');
}

function requiredArgs(tool) {
  const req = tool.inputSchema?.required;
  if (!req || req.length === 0) return '\u2014';
  return req.map(r => `\`${r}\``).join(', ');
}

function shortDescription(desc) {
  let short = desc
    .replace(/ through the local Claude in Chrome bridge\.?/g, '')
    .replace(/ via the local Claude in Chrome bridge\.?/g, '')
    .replace(/ via the local bridge,.*$/, '')
    .replace(/ exposed by the local Claude in Chrome bridge/g, '')
    .replace(/ from the CiC bridge/g, '')
    .replace(/Discover the live Claude Code Chrome native-host socket and report bridge health/g, 'Check bridge connectivity and health')
    .replace(/the live Claude Code Chrome native-host socket and report/g, 'Check')
    .replace(/the current MCP tab-group context, optionally creating it if no session tab group exists/g, 'MCP tab-group context (optionally auto-create)')
    .replace(/, creating the group first when needed/g, '')
    .replace(/ and return the remaining browser context/g, '')
    .replace(/, and return the current browser context/g, '')
    .replace(/Run the underlying CiC computer tool directly for browser-facing actions such as/g, 'Unified action dispatch:')
    .replace(/ for later browser_upload_image calls/g, '')
    .replace(/from browser_screenshot\(imageId\) or a local image path to a file input ref, CSS selector, or viewport coordinate in a specific tab/g, 'from cache or local path to a target element')
    .replace(/one or more local files to a file input ref or CSS selector in a specific tab/g, 'local files to a file input')
    .replace(/the browser window that contains a specific tab/g, 'the browser window')
    .replace(/ in a specific tab/g, '')
    .replace(/ from a specific tab/g, '')
    .replace(/ for a specific tab/g, '')
    .replace(/ by tabId/g, '')
    .replace(/ or exact URL/g, '')
    .replace(/\. Optional coordinates will click first/g, ' (optional click-first coordinates)')
    .replace(/a specific tab to a URL/g, 'a tab to a URL')
    .replace(/a specific tab or subtree/g, 'a tab or subtree')
    .replace(/the current focused target/g, 'the focused element')
    .replace(/\.$/, '');
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function generateTable(tools) {
  const header = '| Tool | Required args | Description |';
  const sep = '|------|---------------|-------------|';
  const rows = tools.map(t =>
    `| \`${t.name}\` | ${requiredArgs(t)} | ${shortDescription(t.description)} |`
  );
  return [header, sep, ...rows].join('\n');
}

// Main
const source = fs.readFileSync(BRIDGE_PATH, 'utf8');
const tools = extractToolDefinitions(source);
const table = generateTable(tools);

const readme = fs.readFileSync(README_PATH, 'utf8');
const startIdx = readme.indexOf(START_MARKER);
const endIdx = readme.indexOf(END_MARKER);

if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: TOOLS_START / TOOLS_END markers not found in README.md');
  process.exit(1);
}

const before = readme.slice(0, startIdx + START_MARKER.length);
const after = readme.slice(endIdx);
const updated = before + '\n' + table + '\n' + after;

if (updated === readme) {
  console.log('README.md is up to date (%d tools)', tools.length);
} else {
  fs.writeFileSync(README_PATH, updated);
  console.log('README.md updated with %d tools', tools.length);
}
