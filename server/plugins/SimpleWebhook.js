const axios = require('axios').default;
const logger = require('../log');

// Buffer for grouping capcodes from the same alert
const pending = {};

function buildPayload(data, addressStr, config) {
  if (config.haFormat) {
    return {
      payload: data.message,
      data: {
        new_state: {
          state: data.message,
          attributes: { address: addressStr }
        }
      }
    };
  }
  let message = {};
  if (config.sendAddress)   message.address   = addressStr;
  if (config.sendMessage)   message.message   = data.message;
  if (config.sendSource)    message.source    = data.source;
  if (config.sendTimestamp) message.timestamp = data.timestamp;
  if (config.sendAliasId)   message.alias_id  = data.alias_id;
  if (config.sendAlias)     message.alias     = data.alias;
  if (config.sendAgency)    message.agency    = data.agency;
  if (config.sendIcon)      message.icon      = data.icon;
  if (config.sendColor)     message.color     = data.color;
  return message;
}

function sendWebhook(key, config) {
  const entry = pending[key];
  if (!entry) return;
  delete pending[key];

  const addressStr = entry.addresses.join(' ');
  const payload = buildPayload(entry.data, addressStr, config);

  logger.main.debug('SimpleWebhook: Sending to ' + config.URL + ': ' + JSON.stringify(payload));

  axios.post(config.URL, payload, {
    headers: { 'User-Agent': 'Pagermon - Simple Webhook Plugin' },
    timeout: 5000,
  }).then(() => {
    logger.main.info('SimpleWebhook: Message Sent');
  }).catch(error => {
    if (error.response) {
      logger.main.error('SimpleWebhook: Headers: ' + JSON.stringify(error.response.headers));
      logger.main.error('SimpleWebhook: Data: ' + error.response.data);
      logger.main.error('SimpleWebhook: Status Code: ' + error.response.status);
    } else if (error.request) {
      logger.main.error('SimpleWebhook: No response:' + error.request);
    } else {
      logger.main.error('SimpleWebhook: Error:' + error.message);
    }
  });
}

function run(trigger, scope, data, config, callback) {
  let pConf = data.pluginconf?.SimpleWebhook;
  // Conditions for sending - alias enabled, sending all messages, sending defined aliases and this message has an alias
  if ((pConf && pConf.enable) || (config.filterMode == "2") || (config.filterMode == "1" && data.alias_id)) {

    if (config.groupCapcodes) {
      const key = data.timestamp + '::' + data.message;
      if (pending[key]) {
        // Add capcode to existing entry, reset timer
        clearTimeout(pending[key].timer);
        pending[key].addresses.push(data.address);
      } else {
        // First capcode for this alert
        pending[key] = { addresses: [data.address], data: data };
      }
      pending[key].timer = setTimeout(() => sendWebhook(key, config), 300);
    } else {
      // No grouping — send immediately (no buffer)
      const payload = buildPayload(data, data.address, config);
      logger.main.debug('SimpleWebhook: Sending to ' + config.URL + ': ' + JSON.stringify(payload));
      axios.post(config.URL, payload, {
        headers: { 'User-Agent': 'Pagermon - Simple Webhook Plugin' },
        timeout: 5000,
      }).then(() => {
        logger.main.info('SimpleWebhook: Message Sent');
      }).catch(error => {
        if (error.response) {
          logger.main.error('SimpleWebhook: Headers: ' + JSON.stringify(error.response.headers));
          logger.main.error('SimpleWebhook: Data: ' + error.response.data);
          logger.main.error('SimpleWebhook: Status Code: ' + error.response.status);
        } else if (error.request) {
          logger.main.error('SimpleWebhook: No response:' + error.request);
        } else {
          logger.main.error('SimpleWebhook: Error:' + error.message);
        }
      });
    }

    callback();
  } else {
    callback();
  }
}

module.exports = {
  run: run
}
