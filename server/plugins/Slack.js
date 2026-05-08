const Slack = require('slack');
const logger = require('../log');

function run(trigger, scope, data, config, callback) {
    const slConf = data.pluginconf?.Slack;
    if (slConf && slConf.enable) {
        //Ensure webhook ID and Token have been entered into the alias.
        if(config.bottoken == 0 || !config.bottoken || slConf.channel == 0 || !slConf.channel) {
            logger.main.error('Slack: ' + data.address + ' No Bot Token or Channel Set.');
            callback();
        } else {
            const token = config.bottoken
            const bot = new Slack({token})
            const messageData = `*${data.agency} - ${data.alias}*\n` +
                `Message: ${data.message}`;
            
            bot.chat.postMessage({
                channel: slConf.channel,
                text: messageData
            }, function(err, data, response) {
                if (err) { logger.main.error('Slack: ' + err); } else { logger.main.info('Slack: ' + 'Message Sent') }
                callback();
            })
        }
    } else {
        callback();
    }
}

module.exports = {
    run: run
}
