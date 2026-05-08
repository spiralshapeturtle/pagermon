const push = require('pushover-notifications');
const logger = require('../log');

function run(trigger, scope, data, config, callback) {
    const pConf = data.pluginconf?.Pushover;
    if (pConf && pConf.enable) {
        //ensure key has been entered before trying to push
        if (pConf.group == 0 || pConf.group == '0' || !pConf.group) {
          logger.main.error('Pushover: ' + data.address + ' No User/Group key set. Please enter User/Group Key.');
            callback();
          } else {
            const p = new push({
              user: pConf.group,
              token: config.pushAPIKEY,
            });

            let pushSound;
            if (pConf.sound) {
              pushSound = pConf.sound;
            }

            let pushPri = 0; // default
            if (pConf.priority) {
              pushPri = pConf.priority;
            }

            const msg = {
              message: data.message,
              title: data.agency+' - '+data.alias,
              sound: pushSound,
              priority: pushPri,
              onerror: function(err) {
                logger.main.error('Pushover:', err);
                }
            };

            if (pushPri == 2 || pushPri == '2') {
              //emergency message
              msg.retry = 60;
              msg.expire = 240;
              logger.main.info("SENDING EMERGENCY PUSH NOTIFICATION")
            }

            p.send(msg, function (err, result) {
              if (err) { logger.main.error('Pushover:' + err); }
              logger.main.debug('Pushover:' + result);
              callback();
            });
          }
    } else {
        callback();
    }

}

module.exports = {
    run: run
}
