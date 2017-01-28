const getRSS = require('../rss/rss.js')
const checkValidConfig = require('../util/configCheck.js')
const sqlCmds = require('../rss/sql/commands.js')
const sqlConnect = require('../rss/sql/connect.js')

module.exports = function (message, rssIndex) {

  var con = sqlConnect(getTestMsg)

  var grabbing = message.channel.sendMessage(`Grabbing a random feed...`)

  function getTestMsg() {
    getRSS(con, message.channel, rssIndex, true, function () {
      sqlCmds.end(con, function(err) {
        if (err) throw err;
      })
      grabbing.then(m => m.delete())
    });
  }

}
