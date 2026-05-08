const logger = require('../log');
function run(trigger, scope, data, config, callback) {
    function setIgnore() { if (data.pluginData) data.pluginData.ignore = true; }
    try {
        if (config.ignoreallbutAddress) {
            if (!data.address.match(new RegExp(config.ignoreallbutAddress))) {
                setIgnore();
                logger.main.info('Filter: ignoring message due to no regex match on address');
            }
        }
        if (config.ignoreallbutMessage) {
            if (!data.message.match(new RegExp(config.ignoreallbutMessage))) {
                setIgnore();
                logger.main.info('Filter: ignoring message due to no regex match on message');
            }
        }
        if (config.ignoreAddress) {
            if (data.address.match(new RegExp(config.ignoreAddress))) {
                setIgnore();
                logger.main.info('Filter: ignoring message due to regex match on address');
            }
        }
        if (config.ignoreMessage) {
            if (data.message.match(new RegExp(config.ignoreMessage))) {
                setIgnore();
                logger.main.info('Filter: ignoring message due to regex match on content');
            }
        }
    } catch(e) {
        logger.main.error('Filter: invalid regex in config: ' + e.message);
    }
    callback(data);
}

module.exports = {
    run: run
}
