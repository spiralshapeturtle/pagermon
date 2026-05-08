const { WebhookClient, EmbedBuilder } = require('discord.js');
const toHex = require('colornames');
const logger = require('../log');
const util = require('util');

function run(trigger, scope, data, config, callback) {
    const dConf = data.pluginconf?.Discord;
    if (dConf && dConf.enable) {
        const hostname = process.env.HOSTNAME || '';
        // Ensure webhook URL has been entered into the alias.
        if (dConf.webhook == 0 || !dConf.webhook) {
            logger.main.error('Discord: ' + data.address + ' No Webhook URL set. Please enter Webhook URL.');
            callback();
        } else {
            // discord.js v14: WebhookClient accepts { url } options object
            const webhookClient = new WebhookClient({ url: dConf.webhook });

            // toHex doesn't support putting HEX in, needs to check and skip over if already hex.
            const isHex = /^#[0-9A-F]{6}$/i.test(data.color);
            let discordcolor;
            if (!isHex) {
                discordcolor = toHex(data.color) || '#000000';
            } else {
                discordcolor = data.color;
            }

            // discord.js v14 uses EmbedBuilder instead of RichEmbed
            const notificationEmbed = new EmbedBuilder()
                .setTimestamp(new Date())
                .setColor(discordcolor)
                .setTitle(`**${data.agency} - ${data.alias}**`)
                .setDescription(`${data.message}`);

            if (hostname) {
                notificationEmbed.setAuthor({ name: 'PagerMon', url: hostname });
            } else {
                logger.main.debug('Discord: Hostname not set in config file, using pagermon github');
                notificationEmbed.setAuthor({ name: 'PagerMon', url: 'https://github.com/davidmckenzie/pagermon' });
            }

            logger.main.debug(util.format('%o', notificationEmbed));

            webhookClient.send({ embeds: [notificationEmbed] })
                .then(function() {
                    logger.main.info('Discord: Message Sent');
                    webhookClient.destroy();
                })
                .catch(function(err) {
                    logger.main.error('Discord: ' + err);
                    webhookClient.destroy();
                });
            callback();
        }
    } else {
        callback();
    }
}

module.exports = {
    run: run
}
