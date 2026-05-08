// PagerMon - reader.js
// Modernized version

import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import chalk from 'chalk'; // Modern replacement for colors
import moment from 'moment-timezone'; // Updated to include timezone support
import fetch from 'node-fetch'; // Modern replacement for request
import path from 'node:path';

// Configuration handling
const DEFAULT_CONFIG = {
  hostname: 'http://localhost:3000/',
  apikey: 'CHANGEME',
  identifier: 'Default',
  sendFunctionCode: false,
  useTimestamp: true
};

const FRAGMENT_TTL_MS = 10 * 1000; // F→C always within 2s; 10s is safe margin

class PagerMonReader {
  #config;
  #uri;
  #fragments = new Map();

  constructor() {
    this.readline = createInterface({
      input: process.stdin,
      terminal: true
    });
    this.readline.pause(); // hold input until config is loaded
  }

  async initialize() {
    await this.loadConfig();
    this.setupEventHandlers();
    this.readline.resume(); // start processing input
  }

  async loadConfig() {
    const configPath = path.join(process.cwd(), 'config', 'config.json');

    try {
      const configFile = await fs.readFile(configPath, 'utf8');
      this.#config = { ...DEFAULT_CONFIG, ...JSON.parse(configFile) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
        console.log(chalk.blue(`Created config file - set your API key in ${configPath}`));
        process.exit(0);
      }
      throw error;
    }

    this.#uri = new URL('/api/messages', this.#config.hostname).toString();
  }

  setupEventHandlers() {
    this.readline.on('line', this.handleLine.bind(this));
    this.readline.on('close', () => console.log(chalk.red('Input terminated')));
  }

  handleLine(line) {
    const lineObj = {
      time: moment().format('YYYY-MM-DD HH:mm:ss'),
      datetime: moment().unix(),
      line
    };

    try {
      let newMessages = [];
      if (/POCSAG(\d+): Address: /.test(line)) {
        newMessages = this.handlePocsag(lineObj);
      } else if (/FLEX[:|]/.test(line)) {
        newMessages = this.handleFlex(lineObj);
      } else {
        console.log(chalk.red(`${lineObj.time} - No protocol found: `) + chalk.gray(lineObj.line));
        return;
      }

      this.processMessages(newMessages, lineObj);
    } catch (error) {
      console.error(chalk.red('Error processing line:'), error);
    }
  }

  handlePocsag(lineObj) {
    const matches = lineObj.line.match(/POCSAG(\d+): Address:(.*?)Function: (\d)/);
    if (!matches) return [];

    const message = {
      protocol: 'POCSAG',
      address: this.padAddress(matches[2].trim()),
      datetime: lineObj.datetime,
      time: lineObj.time,
      functionCode: matches[3]
    };

    if (this.#config.sendFunctionCode) {
      message.address += message.functionCode;
    }

    return this.extractPocsagMessage(lineObj, message);
  }

  handleFlex(lineObj) {
    const pipeFields = lineObj.line.split('|');
    const isPipe = pipeFields[0] === 'FLEX' && pipeFields.length >= 7;
    const frameField = isPipe ? pipeFields[2] : null;
    const fragFlagMatch = frameField ? frameField.match(/\/([KFC])\//) : null;
    const fragFlag = fragFlagMatch ? fragFlagMatch[1] : null;

    let addressString;
    if (isPipe) {
      addressString = pipeFields[4].trim();
    } else {
      const addressMatch = lineObj.line.match(/FLEX[:|] ?.*?[\[|]([\d ]*)[\]| ]/);
      if (!addressMatch) return [];
      addressString = addressMatch[1].trim();
    }
    if (!addressString) return [];

    const addresses = addressString.split(' ').filter(Boolean);

    const tempMessage = {
      protocol: 'FLEX',
      datetime: lineObj.datetime,
      time: lineObj.time
    };

    if (this.#config.useTimestamp) {
      const flexTimestampMatch = lineObj.line.match(/FLEX\|(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|/);
      if (flexTimestampMatch) {
        const parsedMoment = moment.utc(flexTimestampMatch[1], 'YYYY-MM-DD HH:mm:ss');
        if (parsedMoment.isValid()) {
          tempMessage.timestamp = parsedMoment.local().unix();
          delete tempMessage.datetime;
        }
      }
    }

    const messageMatch = lineObj.line.match(/FLEX\|.*?\|.*?\|.*?\|.*?\|.*?\|(.+)/) ||
                         lineObj.line.match(/FLEX[:|].*[|\[][0-9 ]*[|\]] ?...[ |](.+)/);
    if (!messageMatch) return [];

    const rawMessage = messageMatch[1].trim();

    this.#purgeStaleFragments();

    // --- F: First fragment — store per capcode, wait for continuation ---
    if (fragFlag === 'F') {
      for (const addr of addresses) {
        this.#fragments.set(addr, { message: rawMessage, _addedAt: Date.now() });
      }
      console.log(chalk.cyan(`[${lineObj.time}] PAGERMON: [FRAG F] ${addresses.join(' ')} | wacht op vervolg...`));
      return [];
    }

    // --- C: Terminal fragment — combine with prior F if available, send immediately ---
    if (fragFlag === 'C') {
      let storedMessage = null;
      for (const addr of addresses) {
        const entry = this.#fragments.get(addr);
        if (entry) { storedMessage = entry.message; break; }
      }
      let finalMessage;
      if (storedMessage !== null) {
        finalMessage = storedMessage + rawMessage;
        for (const addr of addresses) {
          this.#fragments.delete(addr);
        }
        console.log(chalk.cyan(`[${lineObj.time}] PAGERMON: [FRAG C] ${addresses.join(' ')} | vervolg ontvangen`));
      } else {
        finalMessage = rawMessage;
        console.log(chalk.cyan(`[${lineObj.time}] PAGERMON: [FRAG C orphan] ${addresses.join(' ')} | ${finalMessage}`));
      }
      if (addresses.length > 1) tempMessage.groupedMessage = true;
      tempMessage.wasFragmented = true;
      return addresses.map(address => ({
        ...tempMessage,
        address: this.padAddress(address),
        message: finalMessage
      }));
    }

    // --- K or null: standalone, no fragment store interaction ---
    if (addresses.length > 1) tempMessage.groupedMessage = true;

    return addresses.map(address => ({
      ...tempMessage,
      address: this.padAddress(address),
      message: rawMessage
    }));
  }

  // FIX: remove fragments that never received their continuation
  #purgeStaleFragments() {
    const cutoff = Date.now() - FRAGMENT_TTL_MS;
    for (const [key, fragment] of this.#fragments) {
      if (fragment._addedAt < cutoff) {
        this.#fragments.delete(key);
      }
    }
  }

  extractPocsagMessage(lineObj, message) {
    if (lineObj.line.includes('Alpha:')) {
      return this.handleAlphanumeric(lineObj, message);
    } else if (lineObj.line.includes('Numeric:')) {
      return this.handleNumeric(lineObj, message);
    }

    return [{
      ...message,
      type: 'Empty',
      message: null
    }];
  }

  handleAlphanumeric(lineObj, baseMessage) {
    const alphaMatch = lineObj.line.match(/Alpha:(.*?)$/);
    if (!alphaMatch) return [];
    let message = this.cleanMessage(alphaMatch[1].trim());

    const result = {
      ...baseMessage,
      type: 'Alphanumeric',
      message
    };

    if (this.#config.useTimestamp) {
      return this.processTimestamp(result);
    }

    return [result];
  }

  handleNumeric(lineObj, baseMessage) {
    const numericMatch = lineObj.line.match(/Numeric:(.*?)$/);
    if (!numericMatch) return [];
    let message = this.cleanMessage(numericMatch[1].trim());

    return [{
      ...baseMessage,
      type: 'Numeric',
      message
    }];
  }

  async processMessages(messages, lineObj) {
    const valid = messages.filter(m => m.address.length > 2 && m.message);
    if (valid.length > 0) {
      const first = valid[0];
      const addresses = valid.map(m => m.address).join(' ');
      const tags = [];
      if (first.groupedMessage) tags.push('GROUP');
      if (first.wasFragmented) tags.push('FRAGMENTED');
      const suffix = tags.length ? ` - ${tags.join(' ')}` : '';
      console.log(chalk.green(`[${first.time}] PAGERMON: ${addresses} | ${first.message}${suffix}`));
    }
    for (const message of messages) {
      if (message.address.length > 2 && message.message) {
        await this.sendMessage({
          ...message,
          source: this.#config.identifier
        });
      } else {
        console.log(chalk.red(`${message.time}: `) + chalk.gray(lineObj.line));
      }
    }
  }

  async sendMessage(message, retries = 0) {
    try {
      const response = await fetch(this.#uri, {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'PagerMon reader.js',
          'apikey': this.#config.apikey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        const err = new Error(`HTTP error! status: ${response.status}`);
        err.status = response.status;
        throw err;
      }
    } catch (error) {
      if (retries < 10 && !(error.status >= 400 && error.status < 500)) {
        const retryTime = Math.pow(2, retries) * 1000;
        console.log(chalk.yellow(`Message delivery failed. Retrying in ${retryTime}ms`));
        await new Promise(resolve => setTimeout(resolve, retryTime));
        return this.sendMessage(message, retries + 1);
      }
      console.error(chalk.red('Message failed to deliver after 10 retries, giving up'));
    }
  }

  // Helper methods
  padAddress(address) {
    return address.padStart(7, '0');
  }

  cleanMessage(message) {
    return message
      .replace(/<(ETX|EOT)>.*/g, '')
      .replace(/<(CR)>/g, '\r')
      .replace(/<(LF)>/g, '\n')
      .replace(/Ä/g, '[')
      .replace(/Ü/g, ']')
      .trim();
  }

  processTimestamp(message) {
    const timeFormats = [
      'DD MMMM YYYY HH:mm:ss',
      'YYYY-MM-DD HH:mm:ss'
    ];

    const match = message.message.match(/\d+.*?\d+.*?\d+ \d{2}:\d{2}:\d{2}/);
    if (match) {
      for (const format of timeFormats) {
        const parsed = moment(match[0], format, true); // strict mode
        if (parsed.isValid()) {
          return [{
            ...message,
            datetime: parsed.unix(),
            message: message.message.replace(match[0], '').trim()
          }];
        }
      }
    }

    return [message];
  }
}

// Start the application
try {
  const reader = new PagerMonReader();
  await reader.initialize();
} catch (error) {
  console.error(chalk.red('Failed to start PagerMon reader:'), error);
  process.exit(1);
}
