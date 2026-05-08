/*
Regex Replace
Allows matching and replacing
*/
const logger = require('../log');
function run(trigger, scope, data, config, callback) {
    if (config.regexReplaceMatchRegex) {
        try {
            const re = new RegExp(config.regexReplaceMatchRegex);
            if (data.message.match(re)) {
                logger.main.info('RegexReplace: Found a match, replacing it');
                data.message = data.message.replace(re, config.regexReplaceString);
                logger.main.debug('RegexReplace: Message has changed to: ' + data.message);
            }
        } catch(e) {
            logger.main.error('RegexReplace: invalid regex in config: ' + e.message);
        }
    }
    callback(data);
}

module.exports = {
    run: run
}
