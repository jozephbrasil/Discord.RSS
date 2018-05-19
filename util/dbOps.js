const fs = require('fs')
const Discord = require('discord.js')
const storage = require('./storage.js')
const config = require('../config.json')
const currentGuilds = storage.currentGuilds
const models = storage.models
const log = require('./logger.js')
const UPDATE_SETTINGS = { overwrite: true, upsert: true, strict: true }
const FAIL_LIMIT = config.feeds.failLimit
// const WARN_LIMIT = Math.floor(FAIL_LIMIT * 0.75) < FAIL_LIMIT ? Math.floor(FAIL_LIMIT * 0.75) : Math.floor(FAIL_LIMIT * 0.5) < FAIL_LIMIT ? Math.floor(FAIL_LIMIT * 0.5) : 0

exports.guildRss = {
  update: (guildRss, callback, skipProcessSend) => {
    if (storage.bot.shard && !skipProcessSend) {
      process.send({ type: 'guildRss.update', guildRss: guildRss, _loopback: true })
      return callback ? callback() : null
    }
    models.GuildRss().update({ id: guildRss.id }, guildRss, UPDATE_SETTINGS, (err, res) => {
      if (err) return callback ? callback(err) : log.general.error(`(G: ${guildRss.id}) Unable to update profile`, err)
      currentGuilds.set(guildRss.id, guildRss)
      exports.guildRss.empty(guildRss, false, skipProcessSend)
      if (callback) callback()
    })
  },
  remove: (guildRss, callback, skipProcessSend) => {
    const guildId = guildRss.id
    if (storage.bot && storage.bot.shard && !skipProcessSend) {
      process.send({ type: 'guildRss.remove', guildRss: guildRss, _loopback: true })
      return callback ? callback() : null
    }
    if (guildRss && guildRss.sources && Object.keys(guildRss.sources).length > 0) exports.guildRss.backup(guildRss)
    models.GuildRss().find({ id: guildId }).remove((err, res) => {
      if (err && err.code !== 26) return callback ? callback(err) : log.general.warning(`Unable to remove GuildRss document ${guildId}`, err)
      const rssList = guildRss ? guildRss.sources : undefined
      if (rssList) {
        for (let rssName in rssList) {
          exports.linkList.decrement(rssList[rssName].link, err => {
            if (err) log.general.warning(`Unable to decrement linkTracker for ${rssList[rssName].link}`, err)
          })
        }
      }
      currentGuilds.delete(guildId)
      return callback ? callback() : log.general.info(`Removed GuildRss document ${guildId}`)
    })
  },
  disableFeed: (guildRss, rssName, callback, skipProcessSend) => {
    const link = guildRss.sources[rssName].link
    if (storage.bot && storage.bot.shard && !skipProcessSend) {
      process.send({ type: 'guildRss.disableFeed', guildRss: guildRss, rssName: rssName, _loopback: true })
      return callback ? callback(null, link) : log.general.warning(`Feed named ${rssName} has been disabled in guild ${guildRss.id}`)
    }
    if (guildRss.sources[rssName].disabled === true) return callback ? callback(null, link) : log.general.warning(`Feed named ${rssName} has been disabled in guild ${guildRss.id}`)
    guildRss.sources[rssName].disabled = true
    exports.guildRss.update(guildRss)
  },
  enableFeed: (guildRss, rssName, callback, skipProcessSend) => {
    const link = guildRss.sources[rssName].link
    if (storage.bot && storage.bot.shard && !skipProcessSend) {
      process.send({ type: 'guildRss.enableFeed', guildRss: guildRss, rssName: rssName, _loopback: true })
      return callback ? callback(null, link) : log.general.info(`Feed named ${rssName} has been enabled in guild ${guildRss.id}`)
    }
    if (guildRss.sources[rssName].disabled == null) return callback ? callback(null, link) : log.general.info(`Feed named ${rssName} has been enabled in guild ${guildRss.id}`)
    delete guildRss.sources[rssName].disabled
    exports.guildRss.update(guildRss)
  },
  removeFeed: (guildRss, rssName, callback, skipProcessSend) => {
    const link = guildRss.sources[rssName].link
    if (storage.bot && storage.bot.shard && !skipProcessSend) {
      process.send({ type: 'guildRss.removeFeed', guildRss: guildRss, rssName: rssName, _loopback: true })
      return callback ? callback(null, link) : null
    }
    delete guildRss.sources[rssName]
    exports.guildRss.update(guildRss)
    storage.deletedFeeds.push(rssName)
    exports.linkList.decrement(link, err => {
      if (err) log.general.warning('Unable to decrement link for guildRss.removeFeed dbOps', err)
      return callback ? callback(null, link) : !skipProcessSend ? log.general.info(`Feed ${link} has been removed from guild ${guildRss.id} (${guildRss.name})`) : null
    })
  },
  backup: (guildRss, callback) => {
    if (!guildRss || exports.guildRss.empty(guildRss, true)) return callback ? callback() : null
    models.GuildRssBackup().update({ id: guildRss.id }, guildRss, UPDATE_SETTINGS, (err, res) => {
      return callback ? callback(err) : err ? log.general.warning(`Unable to guildRss.backup guild ${guildRss.id}`, err) : log.general.info(`Backed up guild ${guildRss.id}`)
    })
  },
  restore: (guildId, callback, skipProcessSend) => {
    models.GuildRssBackup().find({ id: guildId }, (err, docs) => {
      if (err) return callback ? callback(err) : null
      if (docs.length === 0 || exports.guildRss.empty(docs[0], true)) return callback ? callback(null, false) : null
      exports.guildRss.update(docs[0], err => {
        if (err) return callback ? callback(err) : null
        const rssList = docs[0].sources
        if (rssList) {
          for (var rssName in rssList) {
            const source = rssList[rssName]
            if (!storage.bot.channels.get(source.channel)) {
              exports.guildRss.removeFeed(docs[0], rssName, err => {
                if (err) return log.general.warning(`Could not remove feed ${source.link} due to missing channel ${source.channel}`, storage.bot.guilds.get(docs[0].id), err)
                log.general.info(`Removed feed ${source.link} due to missing channel ${source.channel}`, storage.bot.guilds.get(docs[0].id))
              }, skipProcessSend)
            } else {
              exports.linkList.increment(source.link, err => {
                if (err) log.general.warning(`Unable to increment linkList for ${source.link}`, err)
              })
            }
          }
        }
        models.GuildRssBackup().find({ id: guildId }).remove((err, res) => {
          if (err) log.general.warning(`(G: ${guildId}) Unable to remove backup for guild after restore`, err)
        })
        if (callback) callback(null, docs[0])
      }, skipProcessSend)
    })
  },
  empty: (guildRss, skipRemoval, skipProcessSend) => { // Used on the beginning of each cycle to check for empty sources per guild
    if (guildRss.sources && Object.keys(guildRss.sources).length > 0) return false
    if (!guildRss.timezone && !guildRss.dateFormat && !guildRss.dateLanguage) { // Delete only if server-specific special settings are not found
      if (!skipRemoval) {
        exports.guildRss.remove(guildRss, err => {
          if (err) return log.general.error(`(G: ${guildRss.id}) Could not delete guild due to 0 sources`, err)
          log.general.info(`(G: ${guildRss.id}) 0 sources found with no custom settings deleted`)
        }, skipProcessSend)
      }
    } else log.general.info(`(G: ${guildRss.id}) 0 sources found, skipping`)
    return true
  }
}

class LinkList {
  constructor (docs) {
    this.list = {}
    this.shardId = storage.bot && storage.bot.shard ? storage.bot.shard.id : undefined
    if (docs) for (var i in docs) this.set(docs[i].link, docs[i].count, docs[i].shard)
  }

  get (link) {
    return !this.shardId ? this.list[link] : this.list[this.shardId] ? this.list[this.shardId][link] : null
  }

  set (link, count, shardId) {
    if (shardId) {
      if (!this.list[shardId]) this.list[shardId] = {}
      this.list[shardId][link] = count
    } else this.list[link] = count
  }

  increment (link) {
    if (this.shardId) {
      if (!this.list[this.shardId]) this.list[this.shardId] = {}
      this.list[this.shardId][link] = this.list[this.shardId][link] ? this.list[this.shardId][link] + 1 : 1
      return this.list[this.shardId][link]
    } else {
      this.list[link] = this.list[link] ? this.list[link] + 1 : 1
      return this.list[link]
    }
  }

  decrement (link) {
    if (this.shardId) {
      if (this.list[this.shardId] == null || this.list[this.shardId][link] == null) return
      this.list[this.shardId][link] = this.list[this.shardId][link] - 1 < 0 ? 0 : this.list[this.shardId][link] - 1
      if (!this.list[this.shardId][link]) delete this.list[this.shardId][link]
      return this.list[this.shardId][link]
    } else {
      if (this.list[link] == null) return
      this.list[link] = this.list[link] - 1 < 0 ? 0 : this.list[link] - 1
      if (!this.list[link]) delete this.list[link]
      return this.list[link]
    }
  }

  toArray () {
    const arr = []
    for (var s in this.list) {
      const shardLinks = this.list[s]
      if (typeof shardLinks === 'number') {
        if (!arr.includes(s)) arr.push(s)
        continue
      }
      for (var l in shardLinks) if (!arr.includes(l)) arr.push(l)
    }
    return arr
  }

  toDocs () {
    const arr = []
    for (var s in this.list) {
      const shardLinks = this.list[s]
      if (typeof shardLinks === 'number') {
        arr.push({ link: s, count: shardLinks })
        continue
      }
      for (var l in shardLinks) {
        arr.push({ link: l, count: shardLinks[l], shard: parseInt(s, 10) })
      }
    }
    return arr
  }
}

exports.LinkList = LinkList
exports.linkList = {
  write: (linkList, callback) => {
    if (!(linkList instanceof LinkList)) return callback ? callback(new Error('Argument is not instance of LinkList')) : log.general.warning('Unable to linkList.write due to linkList argument not being an instance of LinkList')
    models.LinkTracker().collection.drop(err => {
      if (err && err.code !== 26) return callback(err)
      const docs = linkList.toDocs()
      if (docs.length === 0) return callback ? callback() : undefined
      models.LinkTracker().collection.insert(docs, callback)
    })
  },
  get: callback => {
    models.LinkTracker().find({}, (err, docs) => {
      if (err) return callback(err)
      callback(null, new LinkList(docs))
    })
  },
  update: (link, count, callback) => {
    const shardId = storage.bot.shard ? storage.bot.shard.id : undefined
    if (count > 0) models.LinkTracker().update({ link: link, shard: shardId }, { link: link, count: count, shard: shardId }, UPDATE_SETTINGS, callback)
    else {
      models.LinkTracker().find({ link, shard: shardId }).remove(err => {
        if (err && err.code !== 26) return callback(err)
        callback()
      })
    }
  },
  decrement: (link, callback) => {
    exports.linkList.get((err, linkList) => {
      if (err) return callback(err)
      if (!linkList.get(link)) return callback()

      if (!linkList.decrement(link)) {
        models.Feed(link, linkList.shardId).collection.drop(err => {
          if (err && err.code !== 26) log.general.warning(`Could not drop collection ${storage.collectionId(link, linkList.shardId)} after decrementing linkTracker`, err)
        })
        exports.failedLinks.reset(link)
      }
      exports.linkList.update(link, linkList.get(link), callback)
    })
  },
  increment: (link, callback) => {
    exports.linkList.get((err, linkList) => {
      if (err) return callback(err)
      linkList.increment(link)
      exports.linkList.update(link, linkList.get(link), callback)
    })
  }
}

exports.failedLinks = {
  uniformize: (failedLinks, callback, skipProcessSend) => {
    if (!skipProcessSend && storage.bot.shard) process.send({ type: 'failedLinks.uniformize', failedLinks: failedLinks, _loopback: true })
    else if (skipProcessSend) storage.failedLinks = failedLinks // skipProcessSend indicates that this method was called on another shard, otherwise it was already updated in the methods below
    if (callback) callback()
  },
  _sendAlert: (link, message, skipProcessSend) => {
    if (storage.bot.shard && !skipProcessSend) return process.send({ type: 'failedLinks._sendAlert', link: link, message: message, _loopback: true })
    currentGuilds.forEach(guildRss => {
      const rssList = guildRss.sources
      if (!rssList) return
      for (var i in rssList) {
        const source = rssList[i]
        const channel = storage.bot.channels.get(source.channel)
        if (source.link === link && channel && config._skipMessages !== true) {
          const attach = channel.guild.me.permissionsIn(channel).has('ATTACH_FILES')
          const m = attach ? `${message}\n\nA backup for this server at this point in time has been attached in case this feed is subjected to forced removal in the future.` : message
          if (config._skipMessages !== true) channel.send(m, attach && currentGuilds.has(channel.guild.id) ? new Discord.Attachment(Buffer.from(JSON.stringify(currentGuilds.get(channel.guild.id), null, 2)), `${channel.guild.id}.json`) : null).catch(err => log.general.warning(`Unable to send limit notice for feed ${link}`, channel.guild, channel, err))
        }
      }
    })
  },
  initalize: (callback, skipProcessSend) => {
    storage.models.FailedLink().find({}, (err, docs) => {
      if (err) return callback ? callback(err) : log.general.error('Unable to get failedLinks', err)
      const temp = {}
      for (var i = 0; i < docs.length; ++i) temp[docs[i].link] = docs[i].failed || docs[i].count
      storage.failedLinks = temp
      exports.failedLinks.uniformize(storage.failedLinks, callback, skipProcessSend)
    })
  },
  increment: (link, callback, skipProcessSend) => {
    if (FAIL_LIMIT === 0) return
    if (typeof storage.failedLinks[link] === 'string') return storage.initialized ? log.general.warning(`Cannot increment failed link ${link} since it has already failed.`) : null
    storage.failedLinks[link] = storage.failedLinks[link] == null ? 1 : storage.failedLinks[link] + 1
    if (storage.failedLinks[link] >= FAIL_LIMIT) {
      exports.failedLinks.fail(link, err => {
        if (err) return log.general.warning(`Unable to mark failed link ${link}`, err)
        log.cycle.error(`${link} has passed the fail limit (${FAIL_LIMIT}). Will no longer retrieve.`)
        if (config.feeds.notifyFail === true) exports.failedLinks._sendAlert(link, `**ATTENTION** - Feed link <${link}> has reached the connection failure limit and will not be retried until it is manually refreshed by this server, or another server using this feed. See \`${config.bot.prefix}rsslist\` for more information.`)
      })
    } else {
      storage.models.FailedLink().update({ link: link }, { link: link, count: storage.failedLinks[link] }, UPDATE_SETTINGS, (err, res) => {
        if (err) log.general.error('Unable to increment failed feed document in collection', err)
      })
    }
    exports.failedLinks.uniformize(storage.failedLinks, callback, skipProcessSend)
  },
  fail: (link, callback, skipProcessSend) => {
    const now = new Date().toString()
    storage.failedLinks[link] = now
    storage.models.FailedLink().update({ link: link }, { link: link, failed: now }, UPDATE_SETTINGS, (err, res) => {
      if (err) return callback ? callback(err) : log.general.error(`Unable to update document to mark failed for link ${link}`, err)
      exports.failedLinks.uniformize(storage.failedLinks, callback, skipProcessSend)
    })
  },
  reset: (link, callback, skipProcessSend) => {
    if (storage.failedLinks[link] == null) return callback ? callback() : null
    delete storage.failedLinks[link]
    storage.models.FailedLink().find({ link: link }).remove(err => {
      if (err && err.code !== 26) return callback ? callback(err) : log.general.error(`Unable to remove document to reset status for failed link ${link}`, err)
      exports.failedLinks.uniformize(storage.failedLinks, callback, skipProcessSend)
    })
  }
}

exports.blacklists = {
  uniformize: (blacklistGuilds, blacklistUsers, callback, skipProcessSend) => {
    if (!skipProcessSend && storage.bot.shard) process.send({ type: 'blacklists.uniformize', blacklistGuilds: blacklistGuilds, blacklistUsers: blacklistUsers, _loopback: true })
    else if (skipProcessSend) {
      storage.blacklistGuilds = blacklistGuilds
      storage.blacklistUsers = blacklistUsers
    }
    if (callback) callback()
  },
  get: callback => models.Blacklist().find(callback),
  add: (settings, callback) => {
    models.Blacklist().update({ id: settings.id }, settings, UPDATE_SETTINGS, err => {
      if (err) return callback ? callback(err) : log.general.error(`Unable to add blacklist for id ${settings.id}`, err)
      if (settings.isGuild) storage.blacklistGuilds.push(settings.id)
      else storage.blacklistUsers.push(settings.id)
      exports.blacklists.uniformize(storage.blacklistGuilds, storage.blacklistUsers, callback)
    })
  },
  remove: (id, callback) => {
    models.Blacklist().find({ id: id }).remove((err, doc) => {
      if (err) return callback ? callback(err) : log.general.error(`Unable to remove blacklist for id ${id}`, err)
      if (storage.blacklistGuilds.includes(id)) storage.blacklistGuilds.splice(storage.blacklistGuilds.indexOf(doc.id), 1)
      else storage.blacklistUsers.splice(storage.blacklistUsers.indexOf(doc.id), 1)
      exports.blacklists.uniformize(storage.blacklistGuilds, storage.blacklistUsers, callback)
    })
  },
  refresh: callback => {
    exports.blacklists.get((err, docs) => {
      if (err) return callback ? callback(err) : log.general.error('Unable to refresh blacklists', err)
      for (var x = 0; x < docs.length; ++x) {
        const doc = docs[x]
        if (doc.isGuild) storage.blacklistGuilds.push(doc.id)
        else storage.blacklistUsers.push(doc.id)
      }
      exports.blacklists.uniformize(storage.blacklistGuilds, storage.blacklistUsers, callback)
    })
  }
}

exports.vips = {
  uniformize: (vipUsers, vipServers, callback, skipProcessSend) => {
    if (!skipProcessSend && storage.bot.shard) process.send({ type: 'vips.uniformize', vipUsers: vipUsers, vipServers: vipServers, _loopback: true })
    else if (skipProcessSend) {
      storage.vipUsers = vipUsers
      storage.vipServers = vipServers
    }
    if (callback) callback()
  },
  get: callback => models.VIP().find(callback),
  update: (settings, callback, skipAddServers) => {
    const servers = settings.servers
    if (!storage.vipUsers[settings.id]) storage.vipUsers[settings.id] = settings
    if (servers && !skipAddServers) exports.vips.addServers({ ...settings, serversToAdd: servers }, null, true)
    exports.vips.uniformize(storage.vipUsers, storage.vipServers, callback)
    if (!settings.name) {
      const dUser = storage.bot.users.get(settings.id)
      settings.name = dUser ? dUser.username : null
    }
    delete settings.__v // Deleting this automatically solves an annoying error "Updating the path '__v' would create a conflict at '__v'"
    models.VIP().update({ id: settings.id }, settings, { upsert: true, strict: true }, err => {
      if (err) return callback ? callback(err) : log.general.error(`Unable to add VIP for id ${settings.id}`, err)
      if (callback) callback()
      log.general.success(`Updated VIP ${settings.id} (${settings.name})`)
    })
  },
  updateBulk: (settingsMultiple, callback) => {
    let complete = 0
    const total = Object.keys(settingsMultiple).length
    let errored = false
    for (var e in settingsMultiple) {
      const settings = settingsMultiple[e]
      if (!settings.name) {
        const dUser = storage.bot.users.get(settings.id)
        settings.name = dUser ? dUser.username : null
      }
      if (!storage.vipUsers[settings.id]) storage.vipUsers[settings.id] = settings
    }
    exports.vips.uniformize(storage.vipUsers, storage.vipServers)

    for (var q in settingsMultiple) {
      const settings = settingsMultiple[q]
      const servers = settings.servers
      if (servers) exports.vips.addServers({ ...settings, serversToAdd: servers }, null, true)
      delete settings.__v
      models.VIP().update({ id: settings.id }, settings, { upsert: true, strict: true }, err => {
        if (err) {
          log.general.error(`Unable to add VIP for id ${settings.id}`, err)
          errored = true
        } else log.general.success(`Bulk updated VIP ${settings.id} (${settings.name})`)
        if (++complete === total && callback) callback(errored ? new Error('Errors encountered with vips.updateBulk logged') : null)
      })
    }
  },
  remove: (id, callback, skipProcessSend) => {
    models.VIP().find({ id: id }).remove((err, doc) => {
      if (err) return callback ? callback(err) : log.general.error(`Unable to remove VIP for id ${id}`, err)
      const settings = { ...storage.vipUsers[id] }
      delete storage.vipUsers[id]
      const servers = doc.servers
      if (servers) exports.vips.removeServers({ ...settings, serversToRemove: servers }, null, true)
    })
  },
  addServers: (settings, callback, skipUpdateVIP) => {
    const servers = settings.serversToAdd
    if (storage.bot.shard) {
      storage.bot.shard.broadcastEval(`
        const ids = ${JSON.stringify(servers)};
        const info = {}
        for (var x = 0; x < ids.length; ++x) {
          const guild = this.guilds.get(ids[x]);
          if (guild) info[guild.id] = guild.name
        }
        if (Object.keys(info).length > 0) info
      `).then(results => {
        let validServers = {}
        const invalidServers = []
        for (var x = 0; x < results.length; ++x) {
          if (results[x]) validServers = { ...validServers, ...results[x] }
        }
        for (var y = 0; y < servers.length; ++y) {
          const id = servers[y]
          if (!validServers[id]) {
            invalidServers.push(id)
            log.general.warning(`Failed to add VIP backing to server ${id} due to missing guild`)
          }
        }
        delete settings.serversToAdd
        write(validServers, invalidServers)
      }).catch(err => {
        if (callback) callback(err)
        log.general.error('Failed to broadcast eval for addServer', err)
      })
    } else {
      const validServers = {}
      const invalidServers = []
      for (var x = 0; x < servers.length; ++x) {
        const id = servers[x]
        const guild = storage.bot.guilds.get(id)
        if (guild) validServers[id] = { id: id, name: guild.name }
        else invalidServers.push(id)
      }
      delete settings.serversToAdd
      write(validServers, invalidServers)
    }
    function write (validServers, invalidServers) {
      for (var id in validServers) {
        const guildName = validServers[id]
        storage.vipServers[id] = {
          name: guildName,
          benefactor: settings
        }
        if (settings.expireAt) storage.vipServers[id].expireAt = new Date(settings.expireAt)
        if (!storage.vipUsers[settings.id].servers.includes(id)) storage.vipUsers[settings.id].servers.push(id)
        log.general.success(`Added VIP backing to server ${id} (${guildName}). Benefactor ID ${settings.id} (${settings.name}).`)
      }
      if (skipUpdateVIP) {
        exports.vips.uniformize(storage.vipUsers, storage.vipServers)
      } else exports.vips.update(storage.vipUsers[settings.id], null, true) // Uniformize is called by vips.update so no need to explicitly call it here
      if (callback) callback(null, validServers, invalidServers)
    }
  },
  removeServers: (settings, callback, skipUpdateVIP) => {
    const servers = settings.serversToRemove
    const success = {}
    const successIds = []
    const failed = []
    for (var x = 0; x < servers.length; ++x) {
      const id = servers[x]
      if (!storage.vipServers[id]) {
        failed.push(id)
        continue
      }
      const benefactor = storage.vipServers[id] ? storage.vipServers[id].benefactor : null
      if (!benefactor || !storage.vipUsers[benefactor.id] || !storage.vipUsers[benefactor.id].servers) {
        failed.push(id)
        continue
      }
      const index = storage.vipUsers[benefactor.id].servers.indexOf(id)
      if (index === -1) {
        failed.push(id)
        continue
      }
      success[id] = storage.vipServers[id].name
      successIds.push(id)
      delete storage.vipServers[id]
      storage.vipUsers[benefactor.id].servers.splice(index, 1)
      if (skipUpdateVIP) exports.vips.uniformize(storage.vipUsers, storage.vipServers)
      else exports.vips.update(storage.vipUsers[benefactor.id], null, true)
      // No need to call uniformize since exports.vips.update does this
    }
    if (callback) callback(null, success, failed)
    log.general.success(`VIP servers have been successfully removed: ${successIds}.${failed.length > 0 ? ` The following were not removed due to incorrect backing: ${failed}` : ``}`)
  },
  refresh: callback => {
    if (!fs.existsSync('./settings/vips.js')) return callback ? callback(new Error('Missing VIP module')) : null
    require('../settings/vips.js')(storage.bot, callback)
  }
}
