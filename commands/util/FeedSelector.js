const config = require('../../config.json')
const commands = require('../../util/commands.json')
const channelTracker = require('../../util/channelTracker.js')
const pageControls = require('../../util/pageControls.js')
const storage = require('../../util/storage.js')
const currentGuilds = storage.currentGuilds
const FAIL_LIMIT = config.feeds.failLimit
const log = require('../../util/logger.js')
const Menu = require('./MenuUtils.js').Menu
const MULTI_SELECT = ['rssremove']
const GLOBAL_SELECT = ['rssmove']
const SINGLE_NUMBER_REGEX = /^\d+$/

function parseNumbers (str) {
  if (SINGLE_NUMBER_REGEX.test(str)) return [parseInt(str, 10)]
  const multi = /^(\d+)-(\d+)$/.exec(str)
  if (!multi) return
  const min = parseInt(multi[1], 10)
  const max = parseInt(multi[2], 10)
  if (min > max) return
  const arr = []
  for (var i = min; i <= max; ++i) arr.push(i)
  return arr
}

function selectFeed (m, data, callback) {
  const currentRSSList = this._currentRSSList
  const chosenOption = m.content

  // Return an array of selected indices for feed removal
  if (this.multiSelect) {
    let chosenOptionList = chosenOption.split(',').map(item => item.trim()).filter((item, index, self) => item && index === self.indexOf(item)) // Trim items, remove duplicates and empty items
    let valid = []
    let invalid = []

    // Validate user choices
    for (var i = 0; i < chosenOptionList.length; ++i) {
      const input = chosenOptionList[i]
      const numbers = parseNumbers(input)
      if (!numbers) invalid.push(input)
      else {
        for (var j = 0; j < numbers.length; ++j) {
          const num = numbers[j]
          if (num < 1) invalid.push(num) // Do not push in any numbers greater than the currentRSSList length
          else if (num <= currentRSSList.length && !valid.includes(num - 1)) valid.push(num - 1) // Push the index to be used
        }
      }
    }

    // Replace the indices in valid with their respective rssNames in currentRSSList
    if (invalid.length > 0) return callback(new SyntaxError(`The number(s) \`${invalid}\` are invalid. Try again, or type \`exit\` to cancel.`))
    else if (valid.length === 0) return callback(new SyntaxError(`You did not choose any valid numbers. Try again, or type \`exit\` to cancel.`))
    else {
      for (var q = 0; q < valid.length; ++q) valid[q] = currentRSSList[valid[q]].rssName
      return this.passoverFn(m, { ...data, guildRss: this.guildRss, rssNameList: valid }, callback)
    }
  }

  // Return a single index for non feed removal actions
  const index = parseInt(chosenOption, 10) - 1
  if (isNaN(index) || index + 1 > currentRSSList.length || index + 1 < 1) return callback(new SyntaxError('That is not a valid number. Try again, or type `exit` to cancel.'))

  // Data is pre-passed into a FeedSelector's fn, merged with the previous Menu's data
  this.passoverFn(m, { ...data, guildRss: this.guildRss, rssName: currentRSSList[index].rssName }, callback)
}

/**
 * A menu with predefined passover data with feed information, merged with any previous menu's data.
 *
 * @extends {Menu}
 */
class FeedSelector extends Menu {
  /**
   * Creates an instance of FeedSelector.
   * @param {Oject} message Instance of a Discord.js Message
   * @param {Function} [passoverFn]  Function with predefined passover data in the second parameter
   * @param {Object} [cmdInfo] Command information
   * @param {String} [cmdInfo.command] Command name
   * @param {String} [cmdInfo.miscOption] Description of the miscoption by rssoptions
   * @param {Boolean} [cmdInfo.multiSelect] Whether to allow multiple feeds to be selected
   * @param {Boolean} [cmdInfo.globalSelect] Whether to allow feeds from other channels to be selected
   * @param {String} [cmdInfo.prependDescription] Additional information in the description, before the FeedSelector's default instructions
   * @memberof FeedSelector
   */
  constructor (message, passoverFn, cmdInfo) {
    super(message)
    if (!passoverFn) passoverFn = (m, data, callback) => callback(null, data)
    this.passoverFn = passoverFn
    this.guildRss = currentGuilds.get(message.guild.id)
    if (!this.guildRss || !this.guildRss.sources || Object.keys(this.guildRss.sources).length === 0) {
      this.text = 'There are no existing feeds.'
      return
    }
    const { command, miscOption, multiSelect, prependDescription, globalSelect } = cmdInfo
    this.command = command
    this.miscOption = miscOption
    this.multiSelect = MULTI_SELECT.includes(command) || multiSelect
    this.globalSelect = GLOBAL_SELECT.includes(command) || globalSelect

    const rssList = this.guildRss.sources
    const maxFeedsAllowed = storage.vipServers[message.guild.id] && storage.vipServers[message.guild.id].benefactor.maxFeeds ? storage.vipServers[message.guild.id].benefactor.maxFeeds : !config.feeds.max || isNaN(parseInt(config.feeds.max)) ? 0 : config.feeds.max
    this._currentRSSList = []

    for (var rssName in rssList) { // Generate the info for each feed as an object, and push into array to be used in pages that are sent
      const source = rssList[rssName]
      if (message.channel.id !== source.channel && !this.globalSelect) continue
      let o = { link: source.link, rssName: rssName, title: source.title }
      if (commands[command].action === 'Refresh Feed') {
        const failCount = storage.failedLinks[source.link]
        o.status = !failCount || (typeof failCount === 'number' && failCount <= FAIL_LIMIT) ? `Status: OK ${failCount > Math.ceil(FAIL_LIMIT / 10) ? '(' + failCount + '/' + FAIL_LIMIT + ')' : ''}\n` : `Status: FAILED\n`
      }

      if (miscOption === 'imagePreviews' || miscOption === 'imageLinksExistence' || miscOption === 'checkTitles' || miscOption === 'checkDates' || miscOption === 'formatTables') {
        const statusText = miscOption === 'imagePreviews' ? 'Image Link Previews: ' : miscOption === 'imageLinksExistence' ? 'Image Links Existence: ' : miscOption === 'checkTitles' ? 'Title Checks: ' : miscOption === 'checkDates' ? 'Date Checks: ' : 'Table Formatting: '
        let decision = ''

        const globalSetting = config.feeds[miscOption]
        decision = globalSetting ? `${statusText} Enabled\n` : `${statusText} Disabled\n`
        const specificSetting = source[miscOption]
        decision = typeof specificSetting !== 'boolean' ? decision : specificSetting === true ? `${statusText} Enabled\n` : `${statusText} Disabled\n`

        o.miscOption = decision
      }
      if (this.globalSelect) o.channel = source.channel
      this._currentRSSList.push(o)
    }

    if (this._currentRSSList.length === 0) {
      this.text = 'No feeds assigned to this channel.'
      return
    }
    let desc = maxFeedsAllowed === 0 ? '' : `**Server Limit:** ${Object.keys(rssList).length}/${maxFeedsAllowed}\n`
    desc += (this.globalSelect ? '' : `**Channel:** #${message.channel.name}\n`) + `**Action**: ${command === 'rssoptions' ? commands[command].options[miscOption] : commands[command].action}\n\n${prependDescription ? `${prependDescription}\n\n` : ''}Choose a feed to from this channel by typing the number to execute your requested action on. ${this.multiSelect ? 'You may select multiple feeds by separation with commas, and/or with hyphens (for example `1,3,4-6,8`). ' : ''}Type **exit** to cancel.\u200b\n\u200b\n`
    this.setAuthor('Feed Selection Menu')
    this.setDescription(desc)

    this._currentRSSList.forEach(item => {
      const channel = item.channel ? message.client.channels.has(item.channel) ? `Channel: #${message.client.channels.get(item.channel).name}\n` : undefined : undefined
      const link = item.link
      const title = item.title
      const status = item.status || ''

      // const miscOption = item.checkTitles || item.imagePreviews || item.imageLinksExistence || item.checkDates || item.formatTables || ''
      const miscOption = item.miscOption || ''
      this.addOption(`${title.length > 200 ? title.slice(0, 200) + ' ...' : title}`, `${channel || ''}${miscOption}${status}Link: ${link.length > 500 ? '*Exceeds 500 characters*' : link}`)
    })

    this.fn = selectFeed.bind(this)
  }

  /**
   * Callback function for sending a Menu
   *
   * @callback sendCallback
   * @param {Error} err SyntaxError if incorrect input for retry, or other Error to stop the collector.
   * @param {Object} data Data at the end of a Menu passed over
   * @param {MessageCleaner} msgCleaner MessageCleaner containing the messages collected thus far
   * @param {Boolean} endPrematurely Prematurely end a MenuSeries if it exists, calling its callback
   */

  /**
   * Send the text and/or embed with pagination if needed
   *
   * @param {Object} data
   * @param {sendCallback} callback
   * @override
   * @memberof FeedSelector
   */
  async send (data, callback) {
    if (this.pages.length > 1) this.pages[0].setFooter(`Page 1/${this.pages.length}`)

    try {
      const m = await this.channel.send(this.text, { embed: this.pages[0] })
      this._msgCleaner.add(m)
      if (this.pages.length > 1) {
        await m.react('◀')
        await m.react('▶')
        pageControls.add(m.id, this.pages)
      }

      if (!this.fn) return

      const collector = this.channel.createMessageCollector(m => m.author.id === this.message.author.id, {time: 60000})
      // Add a channel tracker to prohibit any other commands while the Menu is in use
      channelTracker.add(this.channel.id)

      collector.on('collect', m => {
        this._msgCleaner.add(m)
        if (m.content.toLowerCase() === 'exit') return collector.stop('Menu closed.')

        // Call the function defined in the constructor
        this.fn(m, data, (err, passover, endPrematurely) => {
          // SyntaxError allows input retries for this collector due to incorrect input
          if (err instanceof SyntaxError) return m.channel.send(err.message).then(m => this._msgCleaner.add(m))
          collector.stop()
          // Callback and pass over the data to the next function (if a MenuSeries, then to the next Menu's function)
          callback(err, passover, this._msgCleaner, endPrematurely)
        })
      })

      collector.on('end', (collected, reason) => { // Reason is the parameter inside collector.stop(reason)
        // Remove the channel tracker to allow commands in this channel again
        channelTracker.remove(this.channel.id)
        if (reason === 'user') return
        if (reason === 'time') this.channel.send(`I have closed the menu due to inactivity.`).catch(err => log.command.warning(`Unable to send expired menu message`, this.channel.guild, err))
        else this.channel.send(reason).then(m => m.delete(6000))
      })
    } catch (err) {
      log.command.warning(`Failed to send Menu`, this.channel.guild, err)
      return this._series ? callback(err, { __end: true }) : null
    }
  }
}

module.exports = FeedSelector
