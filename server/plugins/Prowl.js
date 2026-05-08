const Prowl = require('node-prowl');
const logger = require('../log');

function run(trigger, scope, data, config, callback) {
    const pConf = data.pluginconf?.Prowl;
    if (pConf && pConf.enable) {
        //ensure key has been entered before trying to push
        if (pConf.group == 0 || pConf.group == '0' || !pConf.group) {
          logger.main.error('Prowl: ' + data.address + ' No User/Group key set. Please enter User/Group Key.');
            callback();
          } else {
            const prowl = new Prowl(pConf.group);

            const payload = {};

            if (pConf.url) {
              payload.url = pConf.url;
            }

            if (pConf.priority) {
              payload.priority = pConf.priority;
            }

            if (pConf.providerkey) {
              payload.providerkey = pConf.providerkey;
            }

            const event = data.agency+' - '+data.alias;
            payload.description = data.message + ' \nTime: '+ new Date().toLocaleString();

            if (pConf.priority == 2 || pConf.priority == '2') {
              //emergency message
              logger.main.info("SENDING EMERGENCY MESSAGE: PROWL");
            }

            prowl.push(event, config.application, payload, function (err, remaining) {
              if (err) { logger.main.error('Prowl:' + err); }
              logger.main.debug('Prowl: Message sent. ' + remaining + ' messages remaining for this hour.');
              callback();
            });
          }
    } else {
        callback();
    }

}

module.exports = {
    run: run
};
